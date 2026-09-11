/* Onboarding Assistant - front end.
 * One screen: ask a question, get a summary, citations you can open, and
 * copy-ready setup commands.
 */

const STARTERS = [
  "Where does transaction validation logic live across our services, and how do I run the service locally?",
  "How do I run the test suite for the validation service?",
  "What happens to a payment request from the gateway to the ledger?",
  "Which service owns idempotency, and where is it enforced?",
];

const state = {
  userId: null,
  repos: [],
  history: [],
  busy: false,
  graph: null,
};

const el = {
  indexLine: document.getElementById("indexLine"),
  userSelect: document.getElementById("userSelect"),
  repoCards: document.getElementById("repoCards"),
  starterList: document.getElementById("starterList"),
  intro: document.getElementById("intro"),
  thread: document.getElementById("thread"),
  composer: document.getElementById("composer"),
  question: document.getElementById("question"),
  askButton: document.getElementById("askButton"),
  viewer: document.getElementById("viewer"),
  viewerPath: document.getElementById("viewerPath"),
  viewerMeta: document.getElementById("viewerMeta"),
  viewerBody: document.getElementById("viewerBody"),
  viewerRepoLink: document.getElementById("viewerRepoLink"),
  viewerClose: document.getElementById("viewerClose"),
  mapPanel: document.getElementById("mapPanel"),
  mapBody: document.getElementById("mapBody"),
  mapNote: document.getElementById("mapNote"),
  mapEdgeList: document.getElementById("mapEdgeList"),
  pathButton: document.getElementById("pathButton"),
  pathRole: document.getElementById("pathRole"),
};

/* --------------------------- markdown --------------------------- */

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CITATION = /^([a-z0-9][a-z0-9._-]*)\/([^\s:`]+):(\d+)(?:-(\d+))?$/i;

/** Inline code that looks like repo/path:line becomes a clickable citation. */
function renderInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const match = CITATION.exec(code);
    if (match && state.repos.some((r) => r.id === match[1])) {
      const [, repo, filePath, start, end] = match;
      return `<button class="citation" data-repo="${repo}" data-path="${filePath}" data-start="${start}" data-end="${end ?? start}">${code}</button>`;
    }
    return `<code>${code}</code>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

/** Small, deliberate markdown subset: headings, lists, fences, paragraphs. */
function renderMarkdown(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let listType = null;
  let fence = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    // Any info string opens or closes a fence. Matching only [A-Za-z0-9_]
    // silently dropped ```docker-compose and ```bash title="x", which broke
    // the copy-ready command blocks.
    if (line.trimEnd().startsWith('```')) {
      if (fence === null) {
        closeList();
        fence = [];
      } else {
        const code = escapeHtml(fence.join("\n"));
        out.push(
          `<div class="codeblock"><button class="copy" type="button">Copy</button><pre><code>${code}</code></pre></div>`,
        );
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(line);
      continue;
    }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (fence !== null) {
    out.push(`<div class="codeblock"><pre><code>${escapeHtml(fence.join("\n"))}</code></pre></div>`);
  }
  closeList();
  return out.join("\n");
}

/* --------------------------- architecture map --------------------------- */

const BOX_H = 64;
const MARGIN = 16;
// Monospace advance widths at the sizes the map uses, for sizing boxes and gaps
// to their actual text instead of guessing. A service id like
// "transaction-validation-service" is 30 characters and overflows any fixed box.
const ID_CHAR_W = 7.3;
const LABEL_CHAR_W = 6.1;
const ARC_LANE = 58;
const BOTTOM_Y = 176;
const BOTTOM_H = 40;

/** The citation an edge or node should open when clicked. */
function edgeCitation(edge) {
  const source = edge.calls[0]?.source ?? edge.evidence[0]?.source ?? null;
  if (!source) return null;
  const match = /^(.*):(\d+)$/.exec(source);
  if (!match) return null;
  return { repo: edge.from, path: match[1], start: match[2], end: match[2] };
}

/**
 * A compact edge label. Path parameters collapse to `*` and only the first
 * endpoint is named, because two full paths never fit between two boxes; the
 * expandable list below the diagram carries the full detail.
 */
function edgeLabel(edge) {
  const paths = edge.calls.map((call) => call.path.replace(/\{[^}]*\}/g, "*"));
  if (paths.length === 0) return "";
  const first = paths[0].length > 24 ? `${paths[0].slice(0, 23)}…` : paths[0];
  return paths.length > 1 ? `${first} +${paths.length - 1}` : first;
}

function citationAttrs(citation) {
  if (!citation) return "";
  return `data-repo="${escapeHtml(citation.repo)}" data-path="${escapeHtml(citation.path)}" data-start="${citation.start}" data-end="${citation.end}"`;
}

/**
 * Draw the service graph.
 *
 * Services sit left to right in the graph's own topological order, so the
 * picture reads the way a request travels. Calls between neighbours are drawn
 * straight; a call that skips a service arcs over the top. Infrastructure and
 * external dependencies sit underneath on dashed lines, because they are not
 * part of the reading path.
 */
function renderGraph(graph) {
  if (!graph || graph.services.length === 0) {
    el.mapPanel.hidden = true;
    return;
  }
  el.mapPanel.hidden = false;

  const order = graph.order.filter((id) => graph.services.some((s) => s.id === id));
  const at = new Map(order.map((id, i) => [id, i]));

  // Size the geometry to the longest text it has to hold, so a long service id
  // or endpoint path widens the diagram instead of spilling over a box.
  const longestId = Math.max(...order.map((id) => id.length));
  const longestLabel = Math.max(
    0,
    ...graph.edges
      .filter((e) => at.has(e.to) && Math.abs(at.get(e.to) - at.get(e.from)) === 1)
      .map((e) => edgeLabel(e).length),
  );
  const boxW = Math.max(196, Math.ceil(longestId * ID_CHAR_W) + 26);
  const gap = Math.max(120, Math.ceil(longestLabel * LABEL_CHAR_W) + 30);

  const xOf = (id) => MARGIN + at.get(id) * (boxW + gap);
  const midY = ARC_LANE + BOX_H / 2;

  const width = Math.max(MARGIN * 2 + order.length * boxW + (order.length - 1) * gap, 340);
  // Infra is addressed by its repo-scoped key but labelled with its plain name,
  // so two services each owning a `postgres` get two distinct boxes.
  const bottomNodes = [
    ...graph.infra.map((i) => ({ key: i.key, name: i.id, label: i.image ?? i.id, kind: "infra" })),
    ...graph.external.map((x) => ({ key: x.id, name: x.id, label: "external", kind: "external" })),
  ];
  const height = bottomNodes.length > 0 ? BOTTOM_Y + BOTTOM_H + MARGIN : ARC_LANE + BOX_H + MARGIN;

  const bottomX = new Map();
  const slot = bottomNodes.length > 0 ? (width - MARGIN * 2) / bottomNodes.length : 0;
  bottomNodes.forEach((node, i) => {
    bottomX.set(node.key, MARGIN + slot * i + slot / 2 - boxW / 2.6);
  });

  const parts = [];

  for (const edge of graph.edges) {
    const from = at.get(edge.from);
    const citation = edgeCitation(edge);
    const label = edgeLabel(edge);

    if (edge.kind === "infra" || !at.has(edge.to)) {
      // Downwards, dashed: infrastructure or something outside the repositories.
      const bx = bottomX.get(edge.to);
      if (bx === undefined || from === undefined) continue;
      const x1 = xOf(edge.from) + boxW / 2;
      const x2 = bx + boxW / 2.6;
      parts.push(
        `<path class="map-link map-link-infra" d="M ${x1} ${ARC_LANE + BOX_H} C ${x1} ${BOTTOM_Y - 20}, ${x2} ${ARC_LANE + BOX_H + 20}, ${x2} ${BOTTOM_Y}" marker-end="url(#arrow-soft)" />`,
      );
      continue;
    }

    const to = at.get(edge.to);
    const span = to - from;

    if (span === 1) {
      const x1 = xOf(edge.from) + boxW;
      const x2 = xOf(edge.to);
      parts.push(
        `<line class="map-link" x1="${x1}" y1="${midY}" x2="${x2 - 9}" y2="${midY}" marker-end="url(#arrow)" />`,
      );
      if (label) {
        parts.push(
          `<text class="map-link-label" x="${(x1 + x2) / 2}" y="${midY - 9}" text-anchor="middle">${escapeHtml(label)}</text>`,
        );
      }
    } else {
      // Arc over the intervening service(s).
      const x1 = xOf(edge.from) + boxW / 2;
      const x2 = xOf(edge.to) + boxW / 2;
      const peak = 12;
      parts.push(
        `<path class="map-link" d="M ${x1} ${ARC_LANE} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${ARC_LANE - 9}" marker-end="url(#arrow)" />`,
      );
      if (label) {
        parts.push(
          `<text class="map-link-label" x="${(x1 + x2) / 2}" y="${peak + 4}" text-anchor="middle">${escapeHtml(label)}</text>`,
        );
      }
    }

    if (citation) {
      // A wide, invisible hit target over the link, so it is clickable.
      const x1 = xOf(edge.from) + boxW / 2;
      const x2 = xOf(edge.to) + boxW / 2;
      parts.push(
        `<rect class="map-hit" ${citationAttrs(citation)} x="${Math.min(x1, x2)}" y="${span === 1 ? midY - 14 : 0}" width="${Math.abs(x2 - x1)}" height="${span === 1 ? 28 : ARC_LANE}"><title>${escapeHtml(`${edge.from} → ${edge.to} — declared in ${citation.path}:${citation.start}`)}</title></rect>`,
      );
    }
  }

  for (const id of order) {
    const service = graph.services.find((s) => s.id === id);
    const x = xOf(id);
    const endpoint = service.endpoints[0];
    const citation = endpoint ? /^(.*):(\d+)$/.exec(endpoint.source) : null;
    const attrs = citation
      ? citationAttrs({ repo: id, path: citation[1], start: citation[2], end: citation[2] })
      : "";
    const sub = service.port ? `:${service.port}` : "";
    const routes = service.endpoints.length
      ? `${service.endpoints.length} route${service.endpoints.length === 1 ? "" : "s"}`
      : "no routes found";

    parts.push(`<g class="map-node" data-service="${escapeHtml(id)}" ${attrs}>
      <rect x="${x}" y="${ARC_LANE}" width="${boxW}" height="${BOX_H}" rx="9" />
      <text class="map-node-id" x="${x + 12}" y="${ARC_LANE + 26}">${escapeHtml(id)}</text>
      <text class="map-node-sub" x="${x + 12}" y="${ARC_LANE + 46}">${escapeHtml(`${sub} · ${routes}`)}</text>
      <title>${escapeHtml(service.summary ?? id)}</title>
    </g>`);
  }

  for (const node of bottomNodes) {
    const x = bottomX.get(node.key);
    parts.push(`<g class="map-node map-node-${node.kind}">
      <rect x="${x}" y="${BOTTOM_Y}" width="${boxW / 1.3}" height="${BOTTOM_H}" rx="9" />
      <text class="map-node-id" x="${x + 12}" y="${BOTTOM_Y + 17}">${escapeHtml(node.name)}</text>
      <text class="map-node-sub" x="${x + 12}" y="${BOTTOM_Y + 32}">${escapeHtml(node.label)}</text>
    </g>`);
  }

  el.mapBody.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Service dependency diagram" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" />
      </marker>
      <marker id="arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 1 L 10 5 L 0 9 z" />
      </marker>
    </defs>
    ${parts.join("\n")}
  </svg>`;

  const hidden = graph.hiddenServiceCount ?? 0;
  el.mapNote.textContent = hidden > 0
    ? `${graph.services.length} of ${graph.services.length + hidden} services — the rest are outside your access`
    : `${graph.services.length} services, extracted from the repositories themselves`;

  el.mapEdgeList.innerHTML = graph.edges
    .map((edge) => {
      const citation = edgeCitation(edge);
      const via = edge.calls.map((c) => c.path).join(", ");
      const kind = edge.kind === "infra" ? "depends on" : edge.kind === "external" ? "calls external" : "calls";
      return `<button class="map-edge-row" type="button" ${citationAttrs(citation)}>
        <span class="map-edge-pair">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</span>
        <span class="map-edge-kind">${kind}${via ? ` ${escapeHtml(via)}` : ""}</span>
        <span class="map-edge-src">${escapeHtml(citation ? `${citation.path}:${citation.start}` : "")}</span>
      </button>`;
    })
    .join("");
}

/** Mark the services an answer actually drew on. */
function highlightServices(repoIds) {
  const cited = new Set(repoIds);
  for (const node of el.mapBody.querySelectorAll("[data-service]")) {
    node.classList.toggle("cited", cited.has(node.dataset.service));
  }
}

/* --------------------------- bootstrap --------------------------- */

async function loadContext() {
  const url = state.userId ? `/api/context?user=${encodeURIComponent(state.userId)}` : "/api/context";
  const data = await fetch(url).then((r) => r.json());

  state.userId = data.user.id;
  state.repos = data.repos;
  state.graph = data.graph ?? null;
  renderGraph(state.graph);

  el.userSelect.innerHTML = data.users
    .map((u) => `<option value="${u.id}" ${u.id === data.user.id ? "selected" : ""}>${escapeHtml(u.name)}</option>`)
    .join("");

  const excluded = data.stats.excludedForSecrets.length;
  el.indexLine.textContent =
    `${data.stats.indexedFiles} files across ${data.repos.length} ${data.repos.length === 1 ? "repo" : "repos"}` +
    ` · ${excluded} excluded by secrets policy · ${data.model}`;
  el.indexLine.title = data.stats.excludedForSecrets
    .map((s) => `${s.repo}/${s.path} — ${s.reason}`)
    .join("\n");

  el.repoCards.innerHTML = data.repos
    .map(
      (repo) => `
      <div class="repo-card">
        <h3>${escapeHtml(repo.id)}</h3>
        <p>${escapeHtml(repo.summary)}</p>
        <span class="lang">${escapeHtml(repo.language)} · ${repo.indexedFiles} files indexed</span>
      </div>`,
    )
    .join("");

  el.starterList.innerHTML = STARTERS.map(
    (text, i) =>
      `<button class="starter ${i === 0 ? "primary" : ""}" type="button" data-q="${escapeHtml(text)}">${escapeHtml(text)}</button>`,
  ).join("");
}

/* --------------------------- asking --------------------------- */

function setBusy(busy) {
  state.busy = busy;
  el.askButton.disabled = busy;
  el.askButton.textContent = busy ? "Thinking…" : "Ask";
}

function ask(question) {
  if (!question.trim()) return undefined;
  return run({
    label: question,
    endpoint: "/api/ask",
    body: { question, userId: state.userId, history: state.history },
    remember: true,
  });
}

/**
 * Onboarding path mode. Not remembered in history: it is a standalone briefing,
 * not a turn in a conversation, and replaying it would crowd out real context.
 */
function askPath(role) {
  return run({
    label: role ? `Plan my first week — ${role}` : "Plan my first week",
    endpoint: "/api/path",
    body: { role, userId: state.userId },
    remember: false,
    status: "Ordering the services by dependency…",
  });
}

async function run({ label, endpoint, body, remember, status }) {
  if (state.busy) return;
  setBusy(true);
  el.intro.hidden = true;
  el.thread.hidden = false;

  const turn = document.createElement("article");
  turn.className = "turn";
  turn.innerHTML = `
    <p class="question">${escapeHtml(label)}</p>
    <p class="scope-note"></p>
    <div class="answer"><p class="status">${escapeHtml(status ?? "Searching the indexed repositories…")}</p></div>
    <details class="sources" hidden><summary>Sources searched</summary><div class="source-list"></div></details>`;
  el.thread.appendChild(turn);
  turn.scrollIntoView({ behavior: "smooth", block: "start" });

  const answerEl = turn.querySelector(".answer");
  const scopeEl = turn.querySelector(".scope-note");
  const sourcesEl = turn.querySelector(".sources");
  const sourceListEl = turn.querySelector(".source-list");

  let markdown = "";
  let truncated = false;
  let pending = false;
  const paint = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      answerEl.innerHTML = renderMarkdown(markdown);
    });
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error ?? `request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames may be LF- or CRLF-separated depending on what sits between
      // the server and the browser.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const eventLine = /^event:[ \t]*(.+?)[ \t\r]*$/m.exec(frame);
        const dataLine = /^data:[ \t]*(.+?)[ \t\r]*$/m.exec(frame);
        if (!eventLine || !dataLine) continue;
        const payload = JSON.parse(dataLine[1]);

        if (eventLine[1] === "sources") {
          scopeEl.textContent = payload.order
            ? `Reading order ${payload.order.join(" → ")} — derived from the service graph.`
            : `Searching ${payload.scope.join(", ")} — the repositories you can read.`;
          highlightServices([...new Set(payload.results.map((r) => r.repo))]);
          sourcesEl.hidden = false;
          sourceListEl.innerHTML = payload.results
            .map(
              (r) =>
                `<button class="source-chip" data-repo="${r.repo}" data-path="${escapeHtml(r.path)}" data-start="${r.startLine}" data-end="${r.endLine}">${escapeHtml(r.repo)}/${escapeHtml(r.path)}:${r.startLine}</button>`,
            )
            .join("");
        } else if (eventLine[1] === "delta") {
          markdown += payload.text;
          paint();
        } else if (eventLine[1] === "done" && payload.truncated) {
          // The model ran out of output budget. Say so rather than letting a
          // half-written answer look finished.
          truncated = true;
        } else if (eventLine[1] === "error") {
          throw new Error(payload.message);
        }
      }
    }

    answerEl.innerHTML = renderMarkdown(markdown);
    if (truncated) {
      answerEl.insertAdjacentHTML(
        "beforeend",
        '<p class="notice">This answer was cut short by the model\'s output limit. Ask a narrower question for the rest.</p>',
      );
    }
    if (remember) {
      state.history.push({ role: "user", content: label });
      state.history.push({ role: "assistant", content: markdown });
    }
  } catch (error) {
    // Keep whatever already streamed. A timeout part-way through a long answer
    // used to replace the whole thing with an error, throwing away the work the
    // user was reading.
    const message = `<p class="error">${escapeHtml(error.message ?? String(error))}</p>`;
    if (markdown.trim()) {
      answerEl.innerHTML = renderMarkdown(markdown);
      answerEl.insertAdjacentHTML("beforeend", message);
    } else {
      answerEl.innerHTML = message;
    }
  } finally {
    setBusy(false);
  }
}

/* --------------------------- file viewer --------------------------- */

async function openFile({ repo, path: filePath, start, end }) {
  el.viewer.hidden = false;
  el.viewerPath.textContent = `${repo}/${filePath}`;
  el.viewerMeta.textContent = `lines ${start}-${end}`;
  el.viewerBody.textContent = "Loading…";

  const url = `/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&user=${encodeURIComponent(state.userId)}`;
  const data = await fetch(url).then((r) => r.json());

  if (data.error) {
    el.viewerBody.textContent = data.error === "not_authorised_for_repository"
      ? "You do not have read access to this repository."
      : "That file is not in the index.";
    return;
  }

  el.viewerRepoLink.href = `${data.url}#L${start}`;
  el.viewerBody.innerHTML = data.content
    .split("\n")
    .map((line, i) => {
      const n = i + 1;
      const hit = n >= Number(start) && n <= Number(end) ? " hit" : "";
      return `<div class="row${hit}"><span class="num">${n}</span><span>${escapeHtml(line) || " "}</span></div>`;
    })
    .join("");

  const firstHit = el.viewerBody.querySelector(".row.hit");
  if (firstHit) firstHit.scrollIntoView({ block: "center" });
}

/* --------------------------- events --------------------------- */

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = el.question.value;
  el.question.value = "";
  ask(question);
});

el.question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

el.starterList.addEventListener("click", (event) => {
  const button = event.target.closest(".starter");
  if (button) ask(button.dataset.q);
});

el.pathButton.addEventListener("click", () => askPath(el.pathRole.value.trim()));
el.pathRole.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    askPath(el.pathRole.value.trim());
  }
});

document.addEventListener("click", (event) => {
  // Map links and rows carry the same citation attributes as a citation chip,
  // so they reuse the file viewer without any extra plumbing.
  const citation = event.target.closest(".citation, .source-chip, .map-edge-row, .map-hit, .map-node[data-path]");
  if (citation && citation.dataset.path) {
    openFile({
      repo: citation.dataset.repo,
      path: citation.dataset.path,
      start: citation.dataset.start,
      end: citation.dataset.end,
    });
    return;
  }

  const copy = event.target.closest(".copy");
  if (copy) {
    const code = copy.parentElement.querySelector("code").textContent;
    navigator.clipboard.writeText(code);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1400);
  }
});

el.viewerClose.addEventListener("click", () => (el.viewer.hidden = true));
el.viewer.addEventListener("click", (event) => {
  if (event.target === el.viewer) el.viewer.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") el.viewer.hidden = true;
});

el.userSelect.addEventListener("change", async () => {
  state.userId = el.userSelect.value;
  state.history = [];
  el.thread.innerHTML = "";
  el.thread.hidden = true;
  el.intro.hidden = false;
  // loadContext redraws the map, which is scoped to the new user: a service
  // they cannot read disappears from the diagram entirely.
  await loadContext();
});

loadContext();
