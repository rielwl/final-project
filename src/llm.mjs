import { randomUUID } from "node:crypto";
import { describeGraph } from "./graph.mjs";

/**
 * Model call for the onboarding assistant.
 *
 * OpenCode Go, an OpenAI-compatible endpoint, the same provider and key as the
 * other course projects. callModel appends /chat/completions, so no trailing
 * slash on the base URL. Change these two constants (or set LLM_BASE_URL and
 * LLM_MODEL in .env) to point at a different OpenAI-compatible provider.
 */
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-v4.1-flash";

const LLM_TIMEOUT_MS = 120_000;

/**
 * Output budget. The configured model is a reasoning model: it streams its
 * thinking in a separate `reasoning_content` field and that spends the same
 * budget, routinely 3000+ tokens before any visible answer. A long answer
 * therefore needs headroom well above the visible text it produces, or the
 * stream stops with finish_reason "length" part-way through.
 */
const MAX_TOKENS = 8000;
const MAX_TOKENS_LONG = 16_000;

/**
 * Reasoning budget hint. Measured against the configured model: "low" cut
 * reasoning from ~2600 tokens to ~1100 and produced a *more* complete answer,
 * faster, because the budget went to the answer instead of the thinking. Sent
 * only when non-empty, so pointing LLM_BASE_URL at a provider that rejects the
 * field stays a matter of setting LLM_REASONING_EFFORT to an empty value.
 */
const LLM_REASONING_EFFORT = process.env.LLM_REASONING_EFFORT ?? "low";

/** Client-supplied history is untrusted: plain user and assistant text only. */
const HISTORY_ROLES = new Set(["user", "assistant"]);
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS = 4_000;

export const MODEL = LLM_MODEL;

/**
 * Shared by both modes, so the grounding guarantee cannot drift between the
 * question answerer and the onboarding path generator.
 */
const GROUND_RULES = [
  "GROUND RULES",
  "1. Answer only from the REPOSITORY CONTEXT, SERVICE TOPOLOGY and SETUP FACTS supplied in the user message. They are the complete set of material this user is authorised to see.",
  "2. Never invent a file path, function name, line number, command or environment variable. If the context does not contain the answer, say exactly what is missing and name the repository or person to ask next.",
  "3. Cite every factual claim about the code with an inline citation in this exact form: `repo-name/path/to/file.ext:12-40` (or `:12` for a single line). Use only paths and line numbers that appear in the REPOSITORY CONTEXT headers or in a SERVICE TOPOLOGY bracket. Citations must be inside backticks.",
  "4. Setup commands must come from the SETUP FACTS or from a cited file. Put them in a fenced code block, one command per line, ready to paste into a terminal. Cite the file the steps came from.",
  "5. If the user's permitted repositories do not cover part of the question, say so plainly rather than guessing about the missing service.",
];

const SYSTEM_PROMPT = [
  "You are the Internal Developer Onboarding Assistant for a financial-systems engineering team.",
  "Your user is a newly hired engineer who does not yet know the codebase. You answer questions about where things live across the pilot repositories and how to run the services locally.",
  "",
  ...GROUND_RULES,
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

/**
 * Onboarding path mode.
 *
 * The reading order is not the model's decision: it is the topological order of
 * the extracted service graph, handed over in READING ORDER. The model explains
 * why each step matters and what to run, which is the part it is good at.
 */
const PATH_PROMPT = [
  "You are the Internal Developer Onboarding Assistant for a financial-systems engineering team.",
  "Your user has just joined and wants to know what to read first. You produce an ordered first-week reading path over the repositories they can access.",
  "",
  ...GROUND_RULES,
  "6. Follow READING ORDER exactly. It is derived from the service dependency graph: the entry-point service first, then the services it calls. Do not reorder it or add a service that is not in it.",
  "",
  "ANSWER SHAPE (use these exact markdown headings)",
  "## Your path through the code",
  "Two to four sentences: what these services do together, and why this order. Name the entry point and where a request ends up.",
  "## Step 1 — <service id>",
  "One step per service, in READING ORDER, numbered from 1. For each: a bullet for what the service is responsible for; two to four bullets naming the specific files to read in order, each with its citation and one line on why that file; then a fenced block with the commands to get it running locally, taken from the setup facts and cited.",
  "## What to ask your team",
  "At most four bullets: the things these repositories genuinely do not answer, such as ownership, deploy process, on-call, or why a rule exists. Do not invent answers to them.",
  "",
  "STYLE",
  "Write for someone on their first week: concrete, calm, no filler, no praise. Prefer short sentences. Name real files, never 'the relevant file'.",
].join("\n");

/** Render retrieved chunks and setup facts into the single user turn. */
export function buildContext({ question, results, setupFacts, repos, user, graph }) {
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

  if (graph) {
    parts.push("SERVICE TOPOLOGY");
    parts.push(
      "Extracted from the repositories' own compose files, clients and route declarations. The citation in brackets is the evidence for that line; cite it the same way you cite an excerpt.",
    );
    parts.push(describeGraph(graph));
    parts.push("");
  }

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

/**
 * Context for the onboarding path: the same repository excerpts and setup
 * facts, plus the graph-derived order the answer must follow.
 */
export function buildPathContext({ role, results, setupFacts, repos, user, graph }) {
  const parts = [];

  parts.push("ACCESS SCOPE");
  parts.push(
    `Signed in as ${user.name}. Authorised repositories: ${repos.map((r) => r.id).join(", ")}.`,
  );
  if (graph?.hiddenServices?.length > 0) {
    parts.push(
      `This user cannot read ${graph.hiddenServices.length} further service(s) in the system. Say that the path is limited to what they can read; do not name or describe the services they cannot read.`,
    );
  }
  parts.push("");

  parts.push("READING ORDER");
  parts.push(graph.order.join(" -> "));
  parts.push("");

  parts.push("SERVICE TOPOLOGY");
  parts.push(describeGraph(graph));
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

  parts.push("REQUEST");
  parts.push(
    role
      ? `Build the first-week reading path for a new engineer joining: ${role}.`
      : "Build the first-week reading path for a new engineer on this team.",
  );

  return parts.join("\n");
}

export { PATH_PROMPT, MAX_TOKENS_LONG, LLM_REASONING_EFFORT };

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
 *
 * Returns the full text and whether the model ran out of output budget, so the
 * caller can tell the user the answer is cut short instead of presenting a
 * truncated answer as a complete one.
 */
export async function streamAnswer({
  system = SYSTEM_PROMPT,
  history = [],
  context,
  onText,
  maxTokens = MAX_TOKENS,
  reasoningEffort = LLM_REASONING_EFFORT,
}) {
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

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: maxTokens,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
    return { text, truncated: data.choices?.[0]?.finish_reason === "length" };
  }

  return await readSseStream(response.body, onText);
}

/**
 * Read an OpenAI-style SSE completion stream.
 *
 * Reasoning models put their thinking in `delta.reasoning_content` and leave
 * `delta.content` null on those chunks, so skipping empty deltas is what keeps
 * the thinking out of the answer.
 */
async function readSseStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let finishReason = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // keep-alive or comment frame
        }

        finishReason = parsed.choices?.[0]?.finish_reason ?? finishReason;

        const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? "";
        if (delta) {
          full += delta;
          onText(delta);
        }
      }
    }
  }

  return { text: full, truncated: finishReason === "length" };
}
