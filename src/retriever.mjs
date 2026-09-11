/**
 * Keyword retrieval over the static index.
 *
 * Deliberately dependency-free: BM25-style scoring with a few code-aware
 * boosts. It runs in milliseconds over the pilot repos and, unlike an embedding
 * index, needs no second service to demo.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "how", "do", "i", "we", "our", "does", "where", "what", "which", "it", "this",
  "that", "with", "can", "run", "my", "me", "you", "be", "at", "as", "from",
]);

const K1 = 1.5;
const B = 0.7;

/** Lowercase tokens, plus the parts of camelCase / snake_case / kebab-case identifiers. */
export function tokenize(text) {
  const tokens = [];
  for (const raw of String(text).toLowerCase().match(/[a-z0-9_./-]+/g) ?? []) {
    const bare = raw.replace(/^[./-]+|[./-]+$/g, "");
    if (!bare) continue;
    tokens.push(bare);
    for (const part of bare.split(/[_./-]+/)) {
      if (part && part !== bare) tokens.push(part);
    }
  }
  // camelCase split, on the original casing
  for (const raw of String(text).match(/[A-Za-z]+/g) ?? []) {
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])/);
    if (parts.length > 1) for (const part of parts) tokens.push(part.toLowerCase());
  }
  return tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFrequencies(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Precompute per-chunk term stats once per process. */
export function prepare(index) {
  const chunks = index.chunks.map((chunk, id) => {
    const tokens = tokenize(`${chunk.path} ${chunk.text}`);
    return { ...chunk, id, tf: termFrequencies(tokens), length: tokens.length };
  });

  const df = new Map();
  for (const chunk of chunks) {
    for (const term of chunk.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLength = chunks.reduce((sum, c) => sum + c.length, 0) / Math.max(chunks.length, 1);
  return { chunks, df, avgLength, total: chunks.length };
}

function idf(df, total, term) {
  const n = df.get(term) ?? 0;
  return Math.log(1 + (total - n + 0.5) / (n + 0.5));
}

/**
 * Rank chunks for a question, restricted to the repos the user may read.
 *
 * `perRepoFloor` guarantees a few results from every permitted repo so that
 * cross-service questions ("where does X live across our services") do not
 * collapse onto whichever repo happens to use the question's wording.
 */
export function search(prepared, question, { allowedRepos, limit = 26, perRepoFloor = 4 }) {
  const allowed = new Set(allowedRepos);
  const queryTerms = [...new Set(tokenize(question))];
  const phrase = question.toLowerCase();

  const scored = [];
  for (const chunk of prepared.chunks) {
    if (!allowed.has(chunk.repo)) continue;

    let score = 0;
    for (const term of queryTerms) {
      const f = chunk.tf.get(term);
      if (!f) continue;
      const norm = 1 - B + (B * chunk.length) / (prepared.avgLength || 1);
      score += idf(prepared.df, prepared.total, term) * ((f * (K1 + 1)) / (f + K1 * norm));
    }
    if (score === 0) continue;

    // Code-aware boosts.
    const pathLower = chunk.path.toLowerCase();
    for (const term of queryTerms) {
      if (pathLower.includes(term)) score *= 1.18;
    }
    if (chunk.kind === "doc") score *= 1.12;
    if (/readme|architecture|docs\//i.test(chunk.path)) score *= 1.1;
    if (chunk.text.toLowerCase().includes(phrase)) score *= 1.25;

    scored.push({ chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const seenPerRepo = new Map();
  const takeFrom = (list, cap) => {
    for (const entry of list) {
      if (picked.length >= limit) break;
      const used = seenPerRepo.get(entry.chunk.repo) ?? 0;
      if (used >= cap) continue;
      if (picked.some((p) => p.chunk.id === entry.chunk.id)) continue;
      picked.push(entry);
      seenPerRepo.set(entry.chunk.repo, used + 1);
    }
  };

  // Pass 1: a floor of results per repo. Pass 2: fill the rest by raw score.
  takeFrom(scored, perRepoFloor);
  seenPerRepo.clear();
  takeFrom(scored, limit);

  return picked.map(({ chunk, score }) => ({
    repo: chunk.repo,
    path: chunk.path,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: chunk.text,
    score: Number(score.toFixed(3)),
  }));
}
