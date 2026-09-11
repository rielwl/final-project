import { randomUUID } from "node:crypto";

/**
 * Model call for the onboarding assistant.
 *
 * OpenCode Go, an OpenAI-compatible endpoint, the same provider and key as the
 * other course projects. callModel appends /chat/completions, so no trailing
 * slash on the base URL. Change these two defaults (or set LLM_BASE_URL and
 * LLM_MODEL in .env) to point at a different OpenAI-compatible provider.
 */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_MODEL = "deepseek-v4.1-flash";

// Read lazily, not at module scope: server.mjs loads .env after its imports
// have already been evaluated, so a module-scope read would only ever see
// shell variables and would silently ignore everything in .env.
const baseUrl = () => process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
export const currentModel = () => process.env.LLM_MODEL || DEFAULT_MODEL;

const LLM_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 4000;

/** Client-supplied history is untrusted: plain user and assistant text only. */
const HISTORY_ROLES = new Set(["user", "assistant"]);
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 4_000;

const SYSTEM_PROMPT = [
  "You are the Internal Developer Onboarding Assistant for a financial-systems engineering team.",
  "Your user is a newly hired engineer who does not yet know the codebase. You answer questions about where things live across the pilot repositories and how to run the services locally.",
  "",
  "GROUND RULES",
  "1. Answer only from the REPOSITORY CONTEXT and SETUP FACTS supplied in the user message. They are the complete set of material this user is authorised to see.",
  "2. Never invent a file path, function name, line number, command or environment variable. If the context does not contain the answer, say exactly what is missing and name the repository or person to ask next.",
  "3. Cite every factual claim about the code with an inline citation in this exact form: `repo-name/path/to/file.ext:12-40` (or `:12` for a single line). Use only paths and line numbers that appear in the REPOSITORY CONTEXT headers. Citations must be inside backticks.",
  "4. Setup commands must come from the SETUP FACTS or from a cited file. Put them in a fenced code block, one command per line, ready to paste into a terminal. Cite the file the steps came from.",
  "5. If the user's permitted repositories do not cover part of the question, say so plainly rather than guessing about the missing service.",
  "",
  "ANSWER SHAPE (use these exact markdown headings, omit a section only when the question clearly does not call for it)",
  "## Summary",
  "Two to five sentences of plain English explaining the architecture or behaviour, naming the services involved and how they interact. No code in this section.",
  "## Where it lives",
  "A short bullet per location: what the file does, then its citation. Group by service, in request order where there is one.",
  "## Run it locally",
  "Numbered steps with fenced command blocks, taken from the setup facts. Include the test command when the question mentions tests. Note any prerequisite (runtime version, Docker) that the repo states.",
  "## Next steps",
  "At most three short bullets: the obvious follow-up questions or files to read.",
  "",
  "STYLE",
  "Write for someone on their first week: concrete, calm, no filler, no praise, no restating the question. Prefer short sentences.",
].join("\n");

/** Render retrieved chunks and setup facts into the single user turn. */
export function buildContext({ question, results, setupFacts, repos, user }) {
  const parts = [];

  parts.push("ACCESS SCOPE");
  parts.push(
    `Signed in as ${user.name}. Authorised repositories: ${repos.map((r) => r.id).join(", ")}.`,
  );
  parts.push("");

  parts.push("PILOT REPOSITORIES");
  for (const repo of repos) {
    parts.push(`- ${repo.id} (${repo.language}): ${repo.summary}`);
  }
  parts.push("");

  parts.push("REPOSITORY CONTEXT");
  parts.push("Each excerpt is headed by the citation you must use for it.");
  parts.push("");
  for (const result of results) {
    parts.push(`--- ${result.repo}/${result.path}:${result.startLine}-${result.endLine} ---`);
    parts.push(result.text);
    parts.push("");
  }

  parts.push("SETUP FACTS");
  parts.push("Extracted verbatim from each repository's own configuration files.");
  parts.push(JSON.stringify(setupFacts, null, 1));
  parts.push("");

  parts.push("QUESTION");
  parts.push(question);

  return parts.join("\n");
}

/** Keep only well-formed user and assistant turns, newest last. */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        HISTORY_ROLES.has(m.role) &&
        typeof m.content === "string",
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_HISTORY_CHARS) }));
}

/**
 * Stream an answer, calling onText for each delta.
 *
 * The endpoint is asked to stream; if it answers with a plain JSON completion
 * instead, the whole message is delivered in one call to onText.
 */
export async function streamAnswer({ system = SYSTEM_PROMPT, history = [], context, onText }) {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENCODE_API_KEY is not set. Copy .env.example to .env, add your key, and restart the server.",
    );
  }

  const messages = [
    { role: "system", content: system },
    ...sanitizeHistory(history),
    { role: "user", content: context },
  ];

  // One session id per question, as the OpenCode Go endpoint expects.
  const sessionId = randomUUID();

  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: currentModel(),
      messages,
      max_tokens: MAX_TOKENS,
      stream: true,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`The model endpoint returned ${response.status}: ${detail}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Provider ignored stream:true and returned a single completion.
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    if (text) onText(text);
    return text;
  }

  return await readSseStream(response.body, onText);
}

/**
 * Read an OpenAI-style SSE completion stream.
 *
 * Frames may be separated by LF or CRLF: a proxy that normalises line endings
 * would otherwise make every frame unparseable, and the failure is silent -
 * zero deltas, a clean finish, and a blank answer in the browser.
 */
export async function readSseStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  const consumeFrame = (frame) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // keep-alive or comment frame
      }

      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? "";
      if (delta) {
        full += delta;
        onText(delta);
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) consumeFrame(frame);
  }

  // A stream that ends without a trailing blank line still has one frame in
  // hand; dropping it silently truncates the answer.
  buffer += decoder.decode();
  if (buffer.trim() !== "") consumeFrame(buffer);

  return full;
}
