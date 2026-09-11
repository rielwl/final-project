import fs from "node:fs";
import path from "node:path";
import express from "express";
import { ROOT, loadRepos, loadUsers, findUser, allowedRepoIds } from "./config.mjs";
import { buildIndex, loadIndex, redactSecrets } from "./indexer.mjs";
import { prepare, search } from "./retriever.mjs";
import { buildContext, streamAnswer, MODEL } from "./llm.mjs";

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

const repoById = new Map(loadRepos().map((r) => [r.id, r]));

function scopeFor(userId) {
  const user = findUser(userId);
  const repoIds = allowedRepoIds(user, index.repos);
  const repos = repoIds.map((id) => ({ ...repoById.get(id), ...index.repos.find((r) => r.id === id) }));
  return { user, repoIds, repos };
}

/* ----------------------------- API ----------------------------- */

app.get("/api/context", (req, res) => {
  const { user, repoIds, repos } = scopeFor(req.query.user);
  res.json({
    model: MODEL,
    user,
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
  index = buildIndex({ quiet: true });
  prepared = prepare(index);
  res.json({ ok: true, generatedAt: index.generatedAt, files: index.files.length });
});

/** Streaming answer over Server-Sent Events. */
app.post("/api/ask", async (req, res) => {
  const { question, userId, history = [] } = req.body ?? {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }

  const { user, repoIds, repos } = scopeFor(userId);
  if (repoIds.length === 0) {
    return res.status(403).json({ error: "no_authorised_repositories" });
  }

  const results = search(prepared, question, { allowedRepos: repoIds });
  const setupFacts = Object.fromEntries(repoIds.map((id) => [id, index.setup[id]]));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("sources", {
    scope: repoIds,
    results: results.slice(0, 12).map(({ repo, path: filePath, startLine, endLine, score }) => ({
      repo,
      path: filePath,
      startLine,
      endLine,
      score,
    })),
  });

  try {
    const context = buildContext({ question, results, setupFacts, repos, user });
    await streamAnswer({
      context,
      history: history.slice(-6),
      onText: (text) => send("delta", { text }),
    });
    send("done", { ok: true });
  } catch (error) {
    console.error("ask failed:", error);
    send("error", { message: error?.message ?? "The assistant could not answer that." });
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
