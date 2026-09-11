import fs from "node:fs";
import path from "node:path";
import express from "express";
import { ROOT, loadRepos, loadUsers, findUser, allowedRepoIds } from "./config.mjs";
import { buildIndex, loadIndex, redactSecrets } from "./indexer.mjs";
import { prepare, search } from "./retriever.mjs";
import {
  buildContext,
  buildPathContext,
  streamAnswer,
  PATH_PROMPT,
  MAX_TOKENS_LONG,
  LLM_REASONING_EFFORT,
  MODEL,
} from "./llm.mjs";
import { scopeGraph } from "./graph.mjs";
import {
  readRepos,
  readUsers,
  validateRepos,
  validateUsers,
  saveRepos,
  saveUsers,
  resolveRepoPath,
} from "./admin-store.mjs";

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // No .env file: fall back to the ambient environment.
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

// Index once at boot. v1 indexing is static, so a restart is the refresh path.
let index;
try {
  index = loadIndex();
} catch {
  console.log("No index on disk, building one now:");
  index = buildIndex();
}
let prepared = prepare(index);

// Rebuilt whenever the admin dashboard changes the project list.
let repoById = new Map(loadRepos().map((r) => [r.id, r]));

function refreshFromDisk() {
  repoById = new Map(loadRepos().map((r) => [r.id, r]));
  index = buildIndex({ quiet: true });
  prepared = prepare(index);
}

function scopeFor(userId) {
  const user = findUser(userId);
  const repoIds = allowedRepoIds(user, index.repos);
  const repos = repoIds.map((id) => ({ ...repoById.get(id), ...index.repos.find((r) => r.id === id) }));
  // Narrowed here, so an unauthorised service never reaches the browser or the
  // model: it is absent from the diagram rather than hidden in it.
  const graph = scopeGraph(index.graph, repoIds);
  return { user, repoIds, repos, graph };
}

/* ----------------------------- API ----------------------------- */

app.get("/api/context", (req, res) => {
  const { user, repoIds, repos, graph } = scopeFor(req.query.user);
  res.json({
    model: MODEL,
    user,
    graph,
    users: loadUsers().map(({ id, name, repos: r }) => ({ id, name, repoCount: r.length })),
    repos: repos.map((r) => ({
      id: r.id,
      language: r.language,
      summary: r.summary,
      url: r.url,
      indexedFiles: r.indexedFiles,
    })),
    stats: {
      generatedAt: index.generatedAt,
      indexedFiles: index.files.filter((f) => repoIds.includes(f.repo)).length,
      indexedChunks: index.chunks.filter((c) => repoIds.includes(c.repo)).length,
      excludedForSecrets: index.skipped.filter(
        (s) => repoIds.includes(s.repo) && s.reason.startsWith("secrets policy"),
      ),
    },
  });
});

app.post("/api/reindex", (_req, res) => {
  refreshFromDisk();
  res.json({ ok: true, generatedAt: index.generatedAt, files: index.files.length });
});

/* --------------------------- admin API --------------------------- */

/**
 * The dashboard edits config/repos.json and config/users.json. It is
 * unauthenticated unless ADMIN_TOKEN is set in .env, in which case every admin
 * call must send it as `x-admin-token`. The assistant binds to localhost, so an
 * unset token means "trusted local operator", which is what a v1 demo wants.
 */
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return next();
  if (req.header("x-admin-token") === expected) return next();
  return res.status(401).json({ error: "admin_token_required" });
}

/** Per-project state the dashboard shows next to each row. */
function repoStatus(repo) {
  const indexed = index.repos.find((r) => r.id === repo.id);
  const absolute = resolveRepoPath(repo.path);
  return {
    absolutePath: absolute,
    exists: fs.existsSync(absolute),
    indexedFiles: indexed?.indexedFiles ?? 0,
    maskedValues: indexed?.redactions ?? 0,
    excluded: index.skipped.filter(
      (s) => s.repo === repo.id && s.reason.startsWith("secrets policy"),
    ),
  };
}

app.get("/api/admin/config", requireAdmin, (_req, res) => {
  const repos = readRepos();
  res.json({
    protected: Boolean(process.env.ADMIN_TOKEN),
    generatedAt: index.generatedAt,
    repos,
    users: readUsers().users,
    status: Object.fromEntries(repos.map((repo) => [repo.id, repoStatus(repo)])),
  });
});

app.put("/api/admin/repos", requireAdmin, (req, res) => {
  const repos = req.body?.repos;
  const problems = validateRepos(repos);
  if (problems.length > 0) return res.status(400).json({ problems });

  const saved = saveRepos(repos);

  // Dropping a project must also drop it from everyone's access list, or a
  // stale id would quietly grant nothing and confuse the next editor.
  const known = new Set(saved.map((r) => r.id));
  const users = readUsers().users.map((user) => ({
    ...user,
    repos: user.repos.filter((id) => known.has(id)),
  }));
  saveUsers(users);

  refreshFromDisk();
  res.json({
    ok: true,
    repos: saved,
    users,
    status: Object.fromEntries(saved.map((repo) => [repo.id, repoStatus(repo)])),
    generatedAt: index.generatedAt,
  });
});

app.put("/api/admin/users", requireAdmin, (req, res) => {
  const users = req.body?.users;
  const problems = validateUsers(users, readRepos().map((r) => r.id));
  if (problems.length > 0) return res.status(400).json({ problems });

  res.json({ ok: true, users: saveUsers(users) });
});

/** Open a Server-Sent Events response and return its writer. */
function openStream(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The retrieved excerpts, trimmed to what the sources panel shows. */
function sourcesPayload(repoIds, results) {
  return {
    scope: repoIds,
    results: results.slice(0, 12).map(({ repo, path: filePath, startLine, endLine, score }) => ({
      repo,
      path: filePath,
      startLine,
      endLine,
      score,
    })),
  };
}

/** Streaming answer over Server-Sent Events. */
app.post("/api/ask", async (req, res) => {
  const { question, userId, history = [] } = req.body ?? {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }

  const { user, repoIds, repos, graph } = scopeFor(userId);
  if (repoIds.length === 0) {
    return res.status(403).json({ error: "no_authorised_repositories" });
  }

  const results = search(prepared, question, { allowedRepos: repoIds });
  const setupFacts = Object.fromEntries(repoIds.map((id) => [id, index.setup[id]]));

  const send = openStream(res);
  send("sources", sourcesPayload(repoIds, results));

  try {
    const context = buildContext({ question, results, setupFacts, repos, user, graph });
    const { truncated } = await streamAnswer({
      context,
      history: history.slice(-6),
      onText: (text) => send("delta", { text }),
    });
    send("done", { ok: true, truncated });
  } catch (error) {
    console.error("ask failed:", error);
    send("error", { message: error?.message ?? "The assistant could not answer that." });
  }
  res.end();
});

/**
 * Onboarding path: an ordered first-week reading route through the services the
 * user can read. The order comes from the service graph, not from the model.
 */
app.post("/api/path", async (req, res) => {
  const { role, userId } = req.body ?? {};
  const { user, repoIds, repos, graph } = scopeFor(userId);
  if (repoIds.length === 0) {
    return res.status(403).json({ error: "no_authorised_repositories" });
  }

  // Retrieval is steered at the material a reading path is built from: entry
  // points, architecture docs and setup instructions. The doc boost in
  // retriever.mjs already favours READMEs and docs/ for this kind of query.
  const seed = [
    "architecture overview entry point request flow",
    "readme local setup run tests",
    graph.order.join(" "),
    graph.services.flatMap((s) => s.endpoints.map((e) => e.path)).join(" "),
    typeof role === "string" ? role : "",
  ].join(" ");

  const results = search(prepared, seed, { allowedRepos: repoIds, limit: 30, perRepoFloor: 8 });
  const setupFacts = Object.fromEntries(repoIds.map((id) => [id, index.setup[id]]));

  const send = openStream(res);
  send("sources", { ...sourcesPayload(repoIds, results), order: graph.order });

  try {
    const context = buildPathContext({
      role: typeof role === "string" ? role : "",
      results,
      setupFacts,
      repos,
      user,
      graph,
    });
    // A first-week path covers every service in scope, so it needs far more
    // output budget than a single answer: see MAX_TOKENS_LONG in llm.mjs.
    const { truncated } = await streamAnswer({
      system: PATH_PROMPT,
      context,
      maxTokens: MAX_TOKENS_LONG,
      reasoningEffort: LLM_REASONING_EFFORT,
      onText: (text) => send("delta", { text }),
    });
    send("done", { ok: true, truncated });
  } catch (error) {
    console.error("path failed:", error);
    send("error", { message: error?.message ?? "The assistant could not build a path." });
  }
  res.end();
});

/** File viewer: serves an indexed file, access-checked, for citation links. */
app.get("/api/file", (req, res) => {
  const { repo: repoId, path: filePath } = req.query;
  const { repoIds } = scopeFor(req.query.user);

  if (!repoIds.includes(repoId)) {
    return res.status(403).json({ error: "not_authorised_for_repository" });
  }
  const known = index.files.find((f) => f.repo === repoId && f.path === filePath);
  if (!known) {
    // Only indexed files can be read back: never an excluded secret file.
    return res.status(404).json({ error: "file_not_indexed" });
  }

  const repo = repoById.get(repoId);
  const absolute = path.resolve(ROOT, repo.path, filePath);
  if (!absolute.startsWith(path.resolve(ROOT, repo.path))) {
    return res.status(400).json({ error: "invalid_path" });
  }

  // Same masking as the index, so a credential-shaped value is never served.
  const { text, redactions } = redactSecrets(fs.readFileSync(absolute, "utf8"));

  res.json({
    repo: repoId,
    path: filePath,
    url: `${repo.url}/${filePath}`,
    redactions,
    content: text,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Onboarding assistant on http://localhost:${port}`);
  console.log(`Indexed ${index.files.length} files across ${index.repos.length} repositories.`);
  if (!process.env.OPENCODE_API_KEY) {
    console.warn("OPENCODE_API_KEY is not set: questions will fail until it is.");
  }
});
