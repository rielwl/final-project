/**
 * Cross-service architecture graph.
 *
 * Derived from the index rather than from a second walk of the repositories,
 * which means it inherits the secrets policy for free: a file the indexer
 * excluded has no chunk, so it cannot contribute a node or an edge, and values
 * the indexer masked are already masked here.
 *
 * Nothing is inferred from service names alone. Every node and every edge
 * carries a `source` citation in the same `file:line` form the setup extractor
 * uses, so the UI can open the evidence and the model can cite it.
 */

/** A URL literal: scheme, host, optional port, optional path. */
const URL_LITERAL = /https?:\/\/([A-Za-z0-9_.-]+)(?::(\d+))?([A-Za-z0-9/_{}$.-]*)/g;

/** `PORT: "8082"` or `PORT=8082`, a service declaring the port it listens on. */
const OWN_PORT = /^\s*PORT\s*[:=]\s*"?(\d+)"?/;

/** `- "8081:8081"` under a compose `ports:` key. */
const COMPOSE_PORT = /^\s*-\s*"?(\d+):(\d+)"?\s*$/;

/** Inbound route declarations, one pattern per framework in the pilot repos. */
const ROUTE_PATTERNS = [
  // Go 1.22 mux: mux.HandleFunc("POST /v1/postings", …)
  /HandleFunc\(\s*"(GET|POST|PUT|PATCH|DELETE)\s+(\/[^"]*)"/g,
  // FastAPI / Flask decorator: @app.post("/v1/validate")
  /@\w+\.(get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/g,
  // Express: app.use("/v1/payments", router) or app.get("/healthz", …)
  /\b(?:app|router|[A-Za-z0-9_]*Router)\.(use|get|post|put|patch|delete)\(\s*["'](\/[^"']*)["']/g,
];

/** An outbound call path, e.g. the `/v1/validate` in fetch(`${base}/v1/validate`). */
const CALL_PATH = /\/v1\/[A-Za-z0-9/_{}$.-]*/g;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"]);

function citation(chunkPath, line) {
  return `${chunkPath}:${line}`;
}

/** Compose names the target service outright; an env example only configures it. */
function evidenceRank(source) {
  if (/docker-compose\.ya?ml:/.test(source)) return 0;
  if (/\.env\.(example|sample|template):/.test(source)) return 2;
  return 1;
}

/**
 * Walk the indexed chunks of one repo line by line.
 *
 * Chunks overlap, so the same line can be visited twice; callers dedupe on the
 * citation. Line numbers come from the chunk's own `startLine`, which the
 * indexer keeps accurate, so they point at real lines in the real file.
 */
function eachLine(chunks, visit) {
  for (const chunk of chunks) {
    const lines = chunk.text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      visit(lines[i], chunk.path, chunk.startLine + i, chunk);
    }
  }
}

/**
 * Which port each service listens on, so a `localhost:8081` literal in one repo
 * can be resolved to the repo that owns 8081.
 *
 * Both signals are the repo talking about itself: a `PORT` declaration, or a
 * compose port mapping on the compose service whose name matches the repo id.
 */
function buildPortMap(byRepo) {
  const portToRepo = new Map();

  for (const [repoId, chunks] of byRepo) {
    let inOwnService = false;
    eachLine(chunks, (line, filePath) => {
      const own = OWN_PORT.exec(line);
      if (own) {
        portToRepo.set(own[1], repoId);
        return;
      }
      if (!/docker-compose\.ya?ml$/.test(filePath)) return;

      // Track whether we are inside the compose service that *is* this repo,
      // so redis/postgres port mappings are not mistaken for the repo's own.
      const service = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (service) {
        inOwnService = service[1] === repoId;
        return;
      }
      const port = inOwnService ? COMPOSE_PORT.exec(line) : null;
      if (port) portToRepo.set(port[1], repoId);
    });
  }

  return portToRepo;
}

/** Compose services that run a prebuilt image are infrastructure, not source. */
function collectInfra(byRepo) {
  const infra = new Map();

  for (const [repoId, chunks] of byRepo) {
    let current = null;
    let dependsOn = false;

    eachLine(chunks, (line, filePath, lineNo) => {
      if (!/docker-compose\.ya?ml$/.test(filePath)) return;

      const service = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (service) {
        current = service[1];
        dependsOn = false;
        return;
      }

      const image = /^\s+image:\s*(.+?)\s*$/.exec(line);
      if (image && current && current !== repoId) {
        const existing = infra.get(current) ?? { id: current, image: image[1], usedBy: [], source: null };
        existing.image = image[1];
        existing.source ??= citation(filePath, lineNo);
        infra.set(current, existing);
        return;
      }

      if (/^\s+depends_on:\s*$/.test(line)) {
        dependsOn = true;
        return;
      }
      if (dependsOn) {
        const dep = /^\s+-\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
        if (dep) {
          const entry = infra.get(dep[1]) ?? { id: dep[1], image: null, usedBy: [], source: null };
          if (!entry.usedBy.includes(repoId)) {
            entry.usedBy.push(repoId);
            entry.dependsOnSource ??= citation(filePath, lineNo);
          }
          infra.set(dep[1], entry);
          return;
        }
        if (/^\s{0,4}\S/.test(line)) dependsOn = false;
      }
    });
  }

  // Only keep compose services we actually saw an image for: a depends_on
  // pointing at a service built from source is a service edge, not infra.
  return [...infra.values()].filter((entry) => entry.image !== null);
}

/** Inbound routes a service declares, used to label edges and order reading. */
function collectEndpoints(chunks) {
  const endpoints = new Map();

  eachLine(chunks, (line, filePath, lineNo) => {
    for (const pattern of ROUTE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const method = match[1].toUpperCase();
        const routePath = match[2];
        if (routePath === "/" || routePath.startsWith("/healthz")) continue;
        const key = `${method} ${routePath}`;
        if (!endpoints.has(key)) {
          endpoints.set(key, {
            method: method === "USE" ? "MOUNT" : method,
            path: routePath,
            source: citation(filePath, lineNo),
          });
        }
      }
    }
  });

  return [...endpoints.values()];
}

function isRouteLine(line) {
  return ROUTE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(line);
  });
}

/**
 * Outbound HTTP references from one repo, resolved to a target.
 *
 * Only `http(s)://` literals are considered, which is also what keeps database
 * URLs out: a `postgresql://user:password@host` value never matches.
 */
function collectOutbound(repoId, chunks, repoIds, portToRepo, ownEndpoints) {
  const refs = [];
  const calls = [];
  const seen = new Set();
  const ownPaths = new Set(ownEndpoints.map((e) => e.path));

  eachLine(chunks, (line, filePath, lineNo, chunk) => {
    URL_LITERAL.lastIndex = 0;
    let match;
    while ((match = URL_LITERAL.exec(line)) !== null) {
      const [, host, port] = match;
      let target = null;
      let kind = "external";

      if (repoIds.has(host)) {
        // The compose hostname is the repo id: the strongest signal there is.
        target = host;
        kind = "service";
      } else if (LOCAL_HOSTS.has(host) && port && portToRepo.has(port)) {
        target = portToRepo.get(port);
        kind = "service";
      }

      if (target === repoId) continue; // a service describing its own address

      const id = target ?? `${host}${port ? `:${port}` : ""}`;
      const key = `${filePath}:${lineNo}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      refs.push({ target: id, kind, host, port: port ?? null, file: filePath, line: lineNo });
    }

    // Endpoint paths on non-route lines are calls this repo makes outwards.
    // Docs are excluded: a README describing "called by api-gateway on POST
    // /v1/validate" documents an inbound route, and reading it as an outbound
    // call would label an edge with the caller's own endpoint.
    if (chunk.kind !== "code" || isRouteLine(line)) return;
    CALL_PATH.lastIndex = 0;
    let call;
    while ((call = CALL_PATH.exec(line)) !== null) {
      if (ownPaths.has(call[0])) continue; // this service's own route, not a call
      calls.push({ path: call[0], file: filePath, line: lineNo });
    }
  });

  return { refs, calls };
}

/**
 * Attach each outbound call path to a target.
 *
 * A call is attributed to the nearest preceding URL literal in the same file.
 * When the file holds no URL literal at all — a client class that takes its
 * base URL as a constructor argument, as `app/clients/ledger.py` does — the
 * call is attributed to the repo's target only if there is exactly one service
 * it could mean. Anything more ambiguous is dropped rather than guessed at,
 * because a wrong edge label is worse than a missing one.
 */
function attributeCalls(refs, calls) {
  const byFile = new Map();
  for (const ref of refs) {
    if (!byFile.has(ref.file)) byFile.set(ref.file, []);
    byFile.get(ref.file).push(ref);
  }

  const serviceTargets = [...new Set(refs.filter((r) => r.kind === "service").map((r) => r.target))];
  const soleTarget = serviceTargets.length === 1 ? serviceTargets[0] : null;

  const attributed = new Map();
  for (const call of calls) {
    const candidates = byFile.get(call.file);
    let target;

    if (candidates && candidates.length > 0) {
      const preceding = candidates
        .filter((ref) => ref.line <= call.line)
        .sort((a, b) => b.line - a.line)[0];
      target = preceding?.target ?? (candidates.length === 1 ? candidates[0].target : null);
    } else {
      target = soleTarget;
    }
    if (!target) continue;

    if (!attributed.has(target)) attributed.set(target, new Map());
    const forTarget = attributed.get(target);
    if (!forTarget.has(call.path)) {
      forTarget.set(call.path, { path: call.path, source: citation(call.file, call.line) });
    }
  }

  return attributed;
}

/**
 * Reading order for the onboarding path: entry points first, then downstream.
 *
 * Kahn's algorithm over the service edges. Any node left in a cycle is appended
 * in id order so the result always covers every service.
 */
function topologicalOrder(serviceIds, edges) {
  const inbound = new Map(serviceIds.map((id) => [id, 0]));
  const outgoing = new Map(serviceIds.map((id) => [id, []]));

  for (const edge of edges) {
    if (!inbound.has(edge.from) || !inbound.has(edge.to) || edge.from === edge.to) continue;
    inbound.set(edge.to, inbound.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }

  const ready = serviceIds.filter((id) => inbound.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      inbound.set(next, inbound.get(next) - 1);
      if (inbound.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  for (const id of serviceIds) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

/**
 * Build the graph from a partially-built index: `chunks` and `repos` must be
 * populated. Called from buildIndex once chunking is done.
 */
export function buildGraph(index) {
  const byRepo = new Map();
  for (const repo of index.repos) byRepo.set(repo.id, []);
  for (const chunk of index.chunks) byRepo.get(chunk.repo)?.push(chunk);

  const repoIds = new Set(byRepo.keys());
  const portToRepo = buildPortMap(byRepo);

  const services = index.repos.map((repo) => ({
    id: repo.id,
    language: repo.language,
    summary: repo.summary,
    port: [...portToRepo.entries()].find(([, id]) => id === repo.id)?.[0] ?? null,
    endpoints: collectEndpoints(byRepo.get(repo.id)),
  }));

  const edges = [];
  const external = new Map();

  for (const repo of index.repos) {
    const own = services.find((s) => s.id === repo.id)?.endpoints ?? [];
    const { refs, calls } = collectOutbound(repo.id, byRepo.get(repo.id), repoIds, portToRepo, own);
    const attributed = attributeCalls(refs, calls);

    const grouped = new Map();
    for (const ref of refs) {
      if (!grouped.has(ref.target)) grouped.set(ref.target, { kind: ref.kind, evidence: [] });
      grouped.get(ref.target).evidence.push({
        source: citation(ref.file, ref.line),
        value: `${ref.host}${ref.port ? `:${ref.port}` : ""}`,
      });
      if (ref.kind === "external" && !external.has(ref.target)) {
        external.set(ref.target, {
          id: ref.target,
          host: ref.host,
          port: ref.port,
          source: citation(ref.file, ref.line),
        });
      }
    }

    for (const [target, { kind, evidence }] of grouped) {
      edges.push({
        from: repo.id,
        to: target,
        kind: kind === "service" ? "http" : "external",
        calls: [...(attributed.get(target)?.values() ?? [])],
        // Strongest evidence first, so the UI shows the compose hostname (where
        // the target names itself) ahead of a localhost default in code.
        evidence: evidence.sort((a, b) => evidenceRank(a.source) - evidenceRank(b.source)),
      });
    }
  }

  const infra = collectInfra(byRepo);
  for (const entry of infra) {
    for (const repoId of entry.usedBy) {
      edges.push({
        from: repoId,
        to: entry.id,
        kind: "infra",
        calls: [],
        evidence: [{ source: entry.dependsOnSource ?? entry.source, value: entry.image ?? entry.id }],
      });
    }
  }

  const serviceIds = services.map((s) => s.id);
  return {
    services,
    infra,
    external: [...external.values()],
    edges,
    order: topologicalOrder(serviceIds, edges.filter((e) => e.kind === "http")),
  };
}

/**
 * Narrow the graph to the repositories a user may read.
 *
 * Applied before the graph reaches the browser or the model, so an
 * unauthorised service is absent rather than greyed out.
 */
export function scopeGraph(graph, allowedRepoIds) {
  const allowed = new Set(allowedRepoIds);
  const services = graph.services.filter((s) => allowed.has(s.id));
  const edges = graph.edges.filter(
    (e) => allowed.has(e.from) && (allowed.has(e.to) || e.kind !== "http"),
  );
  const reachable = new Set(edges.map((e) => e.to));

  return {
    services,
    infra: graph.infra
      .map((i) => ({ ...i, usedBy: i.usedBy.filter((id) => allowed.has(id)) }))
      .filter((i) => i.usedBy.length > 0),
    external: graph.external.filter((x) => reachable.has(x.id)),
    edges,
    order: graph.order.filter((id) => allowed.has(id)),
    hiddenServices: graph.services.filter((s) => !allowed.has(s.id)).map((s) => s.id),
  };
}

/** Render the graph as the prompt's SERVICE TOPOLOGY block. */
export function describeGraph(graph) {
  const lines = [];

  for (const id of graph.order) {
    const service = graph.services.find((s) => s.id === id);
    if (!service) continue;
    const port = service.port ? ` listens on :${service.port}` : "";
    lines.push(`- ${service.id}${port}`);
    for (const endpoint of service.endpoints) {
      lines.push(`    serves ${endpoint.method} ${endpoint.path}  [${service.id}/${endpoint.source}]`);
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind === "infra") {
      lines.push(`- ${edge.from} depends on ${edge.to} (${edge.evidence[0]?.value ?? "infrastructure"})  [${edge.from}/${edge.evidence[0]?.source}]`);
      continue;
    }
    const label = edge.kind === "external" ? "calls external" : "calls";
    const paths = edge.calls.map((c) => c.path).join(", ");
    const where = edge.calls[0]?.source ?? edge.evidence[0]?.source;
    lines.push(`- ${edge.from} ${label} ${edge.to}${paths ? ` via ${paths}` : ""}  [${edge.from}/${where}]`);
  }

  if (graph.hiddenServices?.length > 0) {
    lines.push(
      `- Not shown: ${graph.hiddenServices.length} service(s) this user may not read.`,
    );
  }

  return lines.join("\n");
}
