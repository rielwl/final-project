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

/* --------------------------- bootstrap --------------------------- */

async function loadContext() {
  const url = state.userId ? `/api/context?user=${encodeURIComponent(state.userId)}` : "/api/context";
  const data = await fetch(url).then((r) => r.json());

  state.userId = data.user.id;
  state.repos = data.repos;

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

async function ask(question) {
  if (state.busy || !question.trim()) return;
  setBusy(true);
  el.intro.hidden = true;
  el.thread.hidden = false;

  const turn = document.createElement("article");
  turn.className = "turn";
  turn.innerHTML = `
    <p class="question">${escapeHtml(question)}</p>
    <p class="scope-note"></p>
    <div class="answer"><p class="status">Searching the indexed repositories…</p></div>
    <details class="sources" hidden><summary>Sources searched</summary><div class="source-list"></div></details>`;
  el.thread.appendChild(turn);
  turn.scrollIntoView({ behavior: "smooth", block: "start" });

  const answerEl = turn.querySelector(".answer");
  const scopeEl = turn.querySelector(".scope-note");
  const sourcesEl = turn.querySelector(".sources");
  const sourceListEl = turn.querySelector(".source-list");

  let markdown = "";
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
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, userId: state.userId, history: state.history }),
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
          scopeEl.textContent = `Searching ${payload.scope.join(", ")} — the repositories you can read.`;
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
        } else if (eventLine[1] === "error") {
          throw new Error(payload.message);
        }
      }
    }

    answerEl.innerHTML = renderMarkdown(markdown);
    state.history.push({ role: "user", content: question });
    state.history.push({ role: "assistant", content: markdown });
  } catch (error) {
    answerEl.innerHTML = `<p class="error">${escapeHtml(error.message ?? String(error))}</p>`;
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

document.addEventListener("click", (event) => {
  const citation = event.target.closest(".citation, .source-chip");
  if (citation) {
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
  await loadContext();
});

loadContext();
