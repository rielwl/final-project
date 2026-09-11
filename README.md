# Internal Developer Onboarding Assistant (v1)

Conversational code navigation for engineers joining a multi-repo financial
system. Ask where business logic lives across services and how to run those
services locally; get a plain-English answer with exact file paths, line
numbers, and copy-ready setup commands taken from the repositories themselves.

Built to the v1 PRD: static multi-repo indexing, a conversational search
interface powered by an LLM, architectural mapping, direct code citations, and
setup guidance extracted from existing configuration files.

## Run it

```bash
npm install
cp .env.example .env      # add your OPENCODE_API_KEY
npm run index             # build the static index over the pilot repos
npm start                 # http://localhost:3000
```

`npm run index` prints what was indexed and what was excluded by the secrets
policy. The server rebuilds the index automatically if `data/index.json` is
missing.

## The demo path

1. Open `http://localhost:3000`. The first screen shows how the three services
   call each other, the pilot repos, the current user's access scope, and the
   PRD's key question as the first starter prompt.
2. Click **"Where does transaction validation logic live across our services,
   and how do I run the service locally?"**
3. The answer streams in four sections: *Summary* (how the gateway, the
   validation service and the ledger interact), *Where it lives* (one bullet per
   location, each with a citation), *Run it locally* (numbered steps with copy
   buttons), *Next steps*.
4. Click any citation chip, for example `transaction-validation-service/app/engine.py:70-78`,
   to open the file at that line, with a link out to the repository.
5. Click **"Plan my first week"** for an ordered reading path through the
   services, entry point first, every step citing real files and the commands
   to run them.
6. Switch the user in the top right to *Devi (contractor)* and ask the same
   question. The answer is built only from the two repositories that user can
   read, and says so — and the diagram loses the service they cannot read.

## Admin dashboard

`http://localhost:3000/admin.html` (linked from the top right of the assistant)
configures the two things that change as a team onboards:

- **Projects.** The repositories to index: id, path, repository link, language
  and summary. A path may be relative to this project or an absolute path to a
  clone anywhere on disk. Each row shows how many files are indexed, how many
  credential-shaped values were masked, and what the secrets policy excluded.
  Saving re-indexes immediately, so the next question uses the new set.
- **People.** Who may use the assistant and, per person, which projects they can
  read. Those tick boxes are the access boundary: retrieval, citations and the
  file viewer all honour them.

Edits are validated before anything is written, so a rejected save leaves both
files exactly as they were. Removing a project also removes it from every
person's access list rather than leaving a dangling id. Everything is stored in
`config/repos.json` and `config/users.json`, which remain hand-editable.

The dashboard is unauthenticated for local use. Set `ADMIN_TOKEN` in `.env` to
require an `x-admin-token` header on every admin call before exposing the
server beyond localhost.

## The architecture map

The panel at the top of the assistant is not drawn by hand or written into a
config file: it is extracted from the repositories every time the index is
built, by `src/graph.mjs`. Three independent signals, in order of strength:

1. **Compose environment values** — `VALIDATION_SERVICE_URL:
   "http://transaction-validation-service:8081"` names the target service
   outright, because the compose hostname *is* the repository id.
2. **URL literals in code** — `"http://localhost:8081"` in a client class,
   resolved through a port map built from each repo's own `ports:` and `PORT`.
3. **Endpoint paths** — the `/v1/validate` in ``fetch(`${this.baseUrl}/v1/validate`)``
   becomes the arrow's label.

Route declarations are read too, in all three frameworks the pilots use
(`mux.HandleFunc`, FastAPI decorators, Express mounts), so each service shows
what it serves. Docs are deliberately excluded when looking for outbound calls:
a README saying "called by api-gateway on POST /v1/validate" describes an
inbound route, and reading it as a call would label the edge backwards.

Every node and edge carries a `file:line` citation, so clicking an arrow — or a
row under *Where each connection is declared* — opens the exact line the
connection was inferred from. Nothing is guessed: a call path that cannot be
attributed to one target is dropped rather than assigned, because a wrong label
is worse than a missing one.

The graph is filtered by access before it reaches the browser or the model, so
switching to a user with narrower permissions removes those services from the
diagram entirely rather than grey them out.

## Plan my first week

`Plan my first week` produces an ordered reading path instead of an answer to a
question. The **order is not the model's choice**: it is the topological order
of the service graph — entry point first, then what it calls — handed to the
model as `READING ORDER`, which it is forbidden to reorder. The model supplies
the rationale, the specific files to read, and the commands to get each service
running, all cited. It closes with what the repositories genuinely cannot
answer, rather than inventing ownership or deploy details.

Both modes share one set of ground rules (`GROUND_RULES` in `src/llm.mjs`) so
the grounding guarantee cannot drift between them.

## What is in the box

| Path | Purpose |
|---|---|
| `repos/` | Three pilot repositories: `api-gateway` (Node), `transaction-validation-service` (Python), `ledger-service` (Go) |
| `src/indexer.mjs` | Static indexing, secrets policy, line-accurate chunking |
| `src/setup-extractor.mjs` | Pulls setup facts from README blocks, Makefile targets, package scripts, docker-compose, runtime manifests, `.env.example` keys |
| `src/retriever.mjs` | Dependency-free BM25-style keyword search with code-aware boosts |
| `src/graph.mjs` | Cross-service graph: nodes, calls, reading order, all with citations |
| `src/llm.mjs` | Model call: system prompt, context assembly, streaming |
| `src/server.mjs` | Express API: `/api/context`, `/api/ask` and `/api/path` (SSE), `/api/file`, `/api/reindex` |
| `public/` | Single-screen UI: composer, streaming answer, citation chips, file viewer |
| `public/admin.html` | Admin dashboard: configure projects and people |
| `src/admin-store.mjs` | Validates and writes the two configuration files |
| `config/repos.json` | The pilot repositories. Point `path` at real local clones to index those instead |
| `config/users.json` | Demo access-control table: which user may read which repo |

## Design notes

**Retrieval.** Files are split into overlapping 70-line windows that keep their
real line numbers, so every citation points at code that exists. Scoring is
BM25 with boosts for path matches, docs, and exact phrase hits, plus a floor of
results per repository so cross-service questions do not collapse onto whichever
repo happens to match the question's wording. No embedding service to run.

**Grounding.** The model only ever sees retrieved excerpts and extracted setup
facts, each labelled with the citation to use for it. The system prompt forbids
inventing a path, command or line number and requires the assistant to say what
is missing instead.

**Setup guidance.** Commands are synthesised from facts the repos state about
themselves (README fences under setup/run/test headings, `##`-documented Make
targets, npm scripts, compose services and ports, `engines.node` /
`requires-python` / `go` directives, and `.env.example` *keys* only).

**Output budget.** The default model is a reasoning model: it streams its
thinking in a separate `reasoning_content` field, and that spends the same
`max_tokens` budget as the answer. Left at a small budget it will use the whole
allowance thinking and stop mid-sentence, so `src/llm.mjs` asks for
`reasoning_effort: low` and a generous ceiling — measured, that produced a
*more* complete answer than a larger budget with unconstrained reasoning, and
faster. A truncated answer is reported as such rather than presented as
finished. Set `LLM_REASONING_EFFORT=` (empty) for a provider that rejects the
field.

**Model.** The same provider and key as the other course projects: OpenCode Go,
an OpenAI-compatible endpoint. `LLM_BASE_URL` (`https://opencode.ai/zen/go/v1`)
and `LLM_MODEL` (`deepseek-v4.1-flash`) are constants at the top of
`src/llm.mjs`; set either in `.env` to point at a different OpenAI-compatible
provider. Each question sends one `x-opencode-session` id and asks for a
streamed completion, falling back to a single JSON completion if the provider
does not stream.

## Data and privacy

- **Zero training retention.** The PRD requires that source code sent to the
  model is not retained or used to train third-party foundation models. That
  guarantee is a property of whichever provider `LLM_BASE_URL` points at, so
  confirm it in that provider's terms before pointing this at a real codebase.
  Locally, nothing is written to disk beyond the index built from your own files,
  and no question, answer or excerpt is logged.
- **Access controls.** Every request is scoped to the signed-in user's
  repositories: retrieval filters by repo before scoring, the file viewer
  refuses unauthorised repos and any file that is not in the index, and the
  answer states the scope it used. `config/users.json` stands in for the SCM
  provider's read permissions; replacing that lookup is the only change needed
  to mirror real permissions.
- **Secrets hygiene.** `.env` files, credential stores (`secrets/`,
  `credentials/`, `.ssh/`), key material and live-looking tokens are excluded
  from the index and reported by name. Credential-shaped values inside otherwise
  useful files (a password in a compose connection string) are masked before
  indexing, and masked again on the file-viewer path. `repos/api-gateway/.env`
  and `repos/transaction-validation-service/secrets/` exist in this demo
  precisely so you can see them being excluded.

## Out of scope for v1

No Confluence/Jira/Notion indexing, no code generation or editing, no database
schemas or production logs, and no repositories beyond the three pilots.
