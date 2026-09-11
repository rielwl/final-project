import fs from "node:fs";
import path from "node:path";
import { ROOT, INDEX_PATH, loadRepos } from "./config.mjs";
import { resolveRepoPath } from "./admin-store.mjs";
import { buildGraph } from "./graph.mjs";
import { extractSetupFacts } from "./setup-extractor.mjs";

/* ------------------------------------------------------------------ *
 * Secrets hygiene (PRD: exclude .env files, credential stores, secrets)
 * ------------------------------------------------------------------ */

/** Credential stores: excluded and reported, never read. */
const SECRET_DIRS = new Set(["secrets", "credentials", ".secrets", ".aws", ".ssh", ".gnupg"]);

/** Build output and dependency trees: excluded quietly, nothing to cite there. */
const BUILD_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "vendor",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
]);

/** Filenames and patterns that must never enter the index. */
const SECRET_FILE_PATTERNS = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$)/i,
  /(^|[._-])secrets?([._-]|$)/i,
  /credential/i,
  /^service-account.*\.json$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|pypirc|netrc|htpasswd)$/i,
];

/** Key material and live tokens: the whole file is dropped from the index. */
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
];

/**
 * Credential-shaped values that appear inside otherwise useful files, such as a
 * connection string in docker-compose. The file stays indexed (a new engineer
 * needs it to start the service) but the value itself is masked before it is
 * ever stored or sent to the model.
 */
const REDACTION_PATTERNS = [
  // scheme://user:password@host
  [/(:\/\/[^\s:@/]+:)([^\s:@/]+)(@)/g, "$1***REDACTED***$3"],
  // PASSWORD=..., API_TOKEN: ..., client_secret = ...
  [/\b([A-Za-z_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY)[A-Za-z_]*\s*[:=]\s*)(["']?)([^\s"']{3,})\2/gi, "$1$2***REDACTED***$2"],
];

/** Mask credential-shaped values. Returns the text and how many were masked. */
export function redactSecrets(text) {
  let redactions = 0;
  let output = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    output = output.replace(pattern, (...args) => {
      redactions += 1;
      const groups = args.slice(1, -2);
      return replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? "");
    });
  }
  return { text: output, redactions };
}

/* ------------------------------------------------------------------ *
 * What counts as indexable source
 * ------------------------------------------------------------------ */

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".java", ".kt",
  ".rb", ".rs", ".sql", ".sh", ".yml", ".yaml", ".json", ".toml", ".ini", ".cfg",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const NAMED_FILES = new Set([
  "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "go.mod", "go.sum", "requirements.txt", "Procfile", ".env.example",
  ".env.sample", ".env.template",
]);

const MAX_FILE_BYTES = 512 * 1024;
const CHUNK_LINES = 70;
const CHUNK_OVERLAP = 15;

function classify(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (CODE_EXTENSIONS.has(ext) || NAMED_FILES.has(fileName)) return "code";
  return null;
}

function isSecretFile(fileName) {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

function hasSecretContent(text) {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function walk(dir, relativeBase, out) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, dirent.name);
    const relative = path.posix.join(relativeBase, dirent.name);
    if (dirent.isDirectory()) {
      if (SECRET_DIRS.has(dirent.name)) {
        out.skipped.push({ path: relative + "/", reason: "secrets policy: credential store directory" });
        continue;
      }
      if (BUILD_DIRS.has(dirent.name)) continue;
      walk(absolute, relative, out);
    } else if (dirent.isFile()) {
      out.files.push({ absolute, relative, name: dirent.name });
    }
  }
}

/** Split a file into overlapping line windows so citations keep real line numbers. */
function chunkFile({ repo, relative, kind, text }) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    if (slice.join("").trim() === "") continue;
    chunks.push({
      repo,
      path: relative,
      kind,
      startLine: start + 1,
      endLine: Math.min(start + slice.length, lines.length),
      text: slice.join("\n"),
    });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

/**
 * Static index of the pilot repositories: code files, READMEs and architecture
 * docs. Returns the index object and also writes it to data/index.json.
 */
export function buildIndex({ quiet = false } = {}) {
  const repos = loadRepos();
  const index = {
    generatedAt: new Date().toISOString(),
    repos: [],
    files: [],
    chunks: [],
    skipped: [],
    setup: {},
  };

  for (const repo of repos) {
    const repoRoot = resolveRepoPath(repo.path);
    if (!fs.existsSync(repoRoot)) {
      throw new Error(`Configured repo path does not exist: ${repo.path}`);
    }

    const found = { files: [], skipped: [] };
    walk(repoRoot, "", found);

    let fileCount = 0;
    let redactionCount = 0;
    for (const file of found.files) {
      // The secrets check runs before anything else so that an excluded file is
      // always reported as excluded rather than quietly ignored.
      if (isSecretFile(file.name)) {
        index.skipped.push({ repo: repo.id, path: file.relative, reason: "secrets policy: credential file" });
        continue;
      }
      const kind = classify(file.name);
      if (!kind) {
        continue; // binaries, lockfiles, images: not useful to cite
      }
      const stat = fs.statSync(file.absolute);
      if (stat.size > MAX_FILE_BYTES) {
        index.skipped.push({ repo: repo.id, path: file.relative, reason: "file too large to index" });
        continue;
      }
      const raw = fs.readFileSync(file.absolute, "utf8");
      if (raw.indexOf(String.fromCharCode(0)) !== -1) continue; // skip binary content
      if (hasSecretContent(raw)) {
        index.skipped.push({ repo: repo.id, path: file.relative, reason: "secrets policy: key material or live token" });
        continue;
      }

      // Redaction preserves line numbers, so citations stay accurate.
      const { text, redactions } = redactSecrets(raw);
      redactionCount += redactions;

      const lineCount = text.split(/\r?\n/).length;
      index.files.push({ repo: repo.id, path: file.relative, kind, lines: lineCount, redactions });
      index.chunks.push(...chunkFile({ repo: repo.id, relative: file.relative, kind, text }));
      fileCount += 1;
    }

    for (const skipped of found.skipped) {
      index.skipped.push({ repo: repo.id, ...skipped });
    }

    index.setup[repo.id] = extractSetupFacts(repoRoot, repo);
    index.repos.push({ ...repo, indexedFiles: fileCount, redactions: redactionCount });

    if (!quiet) {
      const masked = redactionCount > 0 ? `, ${redactionCount} values masked` : "";
      console.log(`  ${repo.id.padEnd(32)} ${String(fileCount).padStart(3)} files${masked}`);
    }
  }

  // Derived from the finished chunks, so the graph inherits the secrets policy:
  // an excluded file has no chunk and therefore cannot contribute an edge.
  index.graph = buildGraph(index);

  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  return index;
}

export function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error("No index found. Run `npm run index` first.");
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
}
