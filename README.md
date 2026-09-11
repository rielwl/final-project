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

1. Open `http://localhost:3000`. The first screen shows the three pilot repos,
   the current user's access scope, and the PRD's key question as the first
   starter prompt.
2. Click **"Where does transaction validation logic live across our services,
   and how do I run the service locally?"**
3. The answer streams in four sections: *Summary* (how the gateway, the
   validation service and the ledger interact), *Where it lives* (one bullet per
   location, each with a citation), *Run it locally* (numbered steps with copy
   buttons), *Next steps*.
4. Click any citation chip, for example `transaction-validation-service/app/engine.py:70-78`,
   to open the file at that line, with a link out to the repository.
5. Switch the user in the top right to *Devi (contractor)* and ask the same
   question. The answer is built only from the two repositories that user can
   read, and says so.

## What is in the box

| Path | Purpose |
|---|---|
| `repos/` | Three pilot repositories: `api-gateway` (Node), `transaction-validation-service` (Python), `ledger-service` (Go) |
| `src/indexer.mjs` | Static indexing, secrets policy, line-accurate chunking |
| `src/setup-extractor.mjs` | Pulls setup facts from README blocks, Makefile targets, package scripts, docker-compose, runtime manifests, `.env.example` keys |
| `src/retriever.mjs` | Dependency-free BM25-style keyword search with code-aware boosts |
| `src/llm.mjs` | Model call: system prompt, context assembly, streaming |
| `src/server.mjs` | Express API: `/api/context`, `/api/ask` (SSE), `/api/file`, `/api/reindex` |
| `public/` | Single-screen UI: composer, streaming answer, citation chips, file viewer |
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
