# PitLore

**Executable pit lore for coding agents.**

Turn past bugs into versioned **Lessons** that any coding agent (Codex, Claude Code, Cursor, …) can **retrieve** before writing code and **check** before you ship.

[![CI](https://github.com/Hardboiled98k/pitlore/actions/workflows/ci.yml/badge.svg)](https://github.com/Hardboiled98k/pitlore/actions/workflows/ci.yml)

> _The lore of pits your agents must not fall into again._

Brand is provisional (`PitLore`). Domain purchase is deferred until the project proves useful.

---

## Why

Coding agents forget. Teams re-hit the same traps. Wiki pages are not enforceable.

PitLore is:

| Layer         | Role                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| **Lesson**    | One abstract anti-pattern + safer pattern (+ optional regex detectors) |
| **Lore**      | A local Git-friendly folder of lessons (private by default)            |
| **MCP / CLI** | Runtime tools every agent can call                                     |
| **Hard path** | `pitlore check` / CI — not only soft prompts                           |

See the [current project status](./docs/STATUS.md), [adoption and dogfood evidence](./docs/DOGFOOD.md),
[documentation map](./docs/README.md), and full product intent in
[`docs/PRD.md`](./docs/PRD.md).

---

## Install and quick start

PitLore requires Node.js 22+ and Git. Consumer CI is configured for the current
Node.js 22 and 24 LTS lines; the public Actions run must pass before a release.

### Install from GitHub

Until the first npm registry release, install the public repository directly:

```bash
cd your-project
npm install --save-dev "git+https://github.com/Hardboiled98k/pitlore.git#main"
npx --no-install pitlore --version
npx --no-install pitlore init --name my-project
npx --no-install pitlore retrieve -i "async array iteration" -l typescript
```

For a reproducible installation, replace `main` with an exact commit SHA or a release tag
when one is available. A Git installation intentionally runs the repository's `prepare`
build and therefore does not support `--ignore-scripts`; the packed npm artifact does.
Global installation is supported for the packed tarball and future registry package, not
for the Git dependency path.

### Work from a source checkout

```bash
git clone https://github.com/Hardboiled98k/pitlore.git
cd pitlore
npm ci

# Use the bundled seed lore (20+ classic L1/L2 lessons)
npm run -s pitlore -- search async
npm run -s pitlore -- retrieve -i "async array iteration" -l typescript

# Scan demo fixtures
npm run -s pitlore -- check demo/fixtures/bad-foreach-async.js || test "$?" -eq 2
npm run -s pitlore -- check demo/fixtures/good-foreach-async.js   # clean

# Initialize a writable lore in this project (copies seed)
npm run -s pitlore -- init --name demo-lore
npm run -s pitlore -- distill -d "Forgot to await Promise.all in batch job" --id batch-promise-all
npm run -s pitlore -- approve batch-promise-all
```

`npm ci` runs the `prepare` build. To inspect the exact future npm artifact locally:

```bash
npm pack
npm install --global ./pitlore-0.1.0.tgz
pitlore --help
```

`npm run test:package` installs the packed artifact with scripts disabled, then also
executes ordinary temporary `npm exec` and global-install CLI paths. The consumer CI is
configured to run the same tarball on Ubuntu, macOS, and Windows; its public Actions result
must be green before release. The artifact includes a bundled MCP stdio runtime and does
not depend on the repository's `src/`, `tsx`, existing `node_modules`, or a separately
installed MCP SDK. The package has not yet been published to the npm registry, so
`npm install pitlore` and registry-backed `npx pitlore` are not available yet. PitLore is
developed in public at
[`Hardboiled98k/pitlore`](https://github.com/Hardboiled98k/pitlore). The source repository
is public, while every local `.pitlore/` store, candidate, review, and evidence ledger
remains private by default and is excluded from Git.

For a team-owned lore in a separate private Git repository:

POSIX shell:

```bash
npm run -s pitlore -- init --path ../team-lore --name your-org/your-project
PITLORE_LORE="$PWD/../team-lore" npm run -s pitlore -- search async
```

PowerShell uses the same CLI with its environment syntax:

```powershell
npm run -s pitlore -- init --path ../team-lore --name your-org/your-project
$env:PITLORE_LORE = (Resolve-Path ../team-lore)
npm run -s pitlore -- search async
Remove-Item Env:PITLORE_LORE
```

---

## CLI

| Command                                                                | Purpose                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pitlore init`                                                         | Create `./.pitlore` (`--home` or `--path <team-lore>`)                                                                                     |
| `pitlore add <file>`                                                   | Validate and store a Lesson YAML/JSON file as a candidate                                                                                  |
| `pitlore search [q]`                                                   | Search lessons; use `--status rejected` to audit tombstones                                                                                |
| `pitlore get <id>`                                                     | Show lesson JSON, including an explicitly selected tombstone                                                                               |
| `pitlore retrieve -i <intent> [-f <file> ... \| --files <file> ...]`   | Top-K ranked lessons + prompt block                                                                                                        |
| `pitlore check <file>`                                                 | Heuristic pattern scan (exit `1` on findings, `2` if `block`)                                                                              |
| `pitlore distill -d "..."`                                             | Create **candidate** lesson (uses `OPENAI_API_KEY` if set)                                                                                 |
| `pitlore review <id>`                                                  | Print an untrusted-data packet for an LLM, or record strict review JSON with `--input`                                                     |
| `pitlore review-queue`                                                 | Show unreviewed/current/stale LLM recommendations for human review                                                                         |
| `pitlore approve <id>`                                                 | Promote candidate → approved                                                                                                               |
| `pitlore reject <id>`                                                  | Move candidate → rejected and retain a non-consumable tombstone                                                                            |
| `pitlore deprecate <id>`                                               | Retire a previously approved Lesson → deprecated                                                                                           |
| `pitlore evidence …`                                                   | Explicitly record local human judgments and summarize real dogfood evidence                                                                |
| `pitlore signal ingest\|ci\|sentry …`                                  | Turn bounded resolved CI/Sentry metadata plus operator-written one-line abstractions into a private candidate; never paste raw logs/source |
| `pitlore export-public <id>`                                           | Sanitize one explicitly selected approved Lesson for public export; never publishes automatically                                          |
| `pitlore install <path\|https-url>`                                    | Verify, checksum, cache, and lock a public Pack (`--ref` pins a Git branch/tag; `--subdir` selects a Pack inside a repository)             |
| `pitlore install --frozen-lockfile`                                    | Verify every locked Pack and dependency without changing the lock                                                                          |
| `pitlore uninstall <name>`                                             | Remove an unneeded Pack from the lock (fails if another Pack depends on it)                                                                |
| `pitlore pack verify <path>`                                           | Validate public/approved policy, detector safety, fixtures, files, and canonical SHA-256                                                   |
| `pitlore pack sign <path> --private-key <key.pem>`                     | Add an Ed25519 signature over the canonical Pack payload                                                                                   |
| `pitlore pack list` / `pitlore pack verify-installed`                  | Inspect or fail-closed verify the effective Pack catalog                                                                                   |
| `pitlore pack artifact export\|verify\|install …`                      | Move one canonical verified Pack through an air-gapped JSON artifact                                                                       |
| `pitlore pack artifact bundle-export\|bundle-verify\|bundle-install …` | Move and atomically lock one root Pack's exact dependency closure                                                                          |
| `pitlore registry search`                                              | Search anonymous public Registry Packs by name or verified `--language` / `--ecosystem` / `--tag` facets; `--facets` returns metadata       |
| `pitlore registry install <name@version>`                              | Download, verify, cache, and lock one exact public/private Registry release                                                                |
| `pitlore registry sync`                                                | Revalidate exact Registry locks and fail when a release was yanked                                                                         |
| `pitlore registry provision-member …`                                  | Let a verified human admin/owner pre-bind one exact OIDC subject and organization role                                                     |
| `pitlore registry create-package\|publish\|approve\|reject\|yank …`    | Run the governed Registry publication lifecycle                                                                                            |
| `pitlore registry report-usage`                                        | Explicitly submit one strict, privacy-safe usage event with an idempotency key                                                             |
| `pitlore registry migrate\|bootstrap\|bootstrap-token\|serve …`        | Operate the durable PostgreSQL self-hosted Registry                                                                                        |
| `pitlore registry reindex-discovery`                                   | Migration-owner-only, bounded rebuild of missing discovery rows from reverified immutable artifacts                                       |
| `pitlore export-agents`                                                | Print AGENTS.md snippet                                                                                                                    |
| `pitlore serve`                                                        | MCP server on **stdio**                                                                                                                    |
| `pitlore path`                                                         | Print resolved lore root                                                                                                                   |

For multiple paths, either repeat `--file` or use the space-separated plural alias:
`pitlore retrieve -i "task" --files src/a.ts src/b.ts`. A comma remains part of a
literal filename; it is not a list separator.

Installed Packs use a commit-friendly `pitlore.lock.yaml` beside the project
`.pitlore/` directory and an ignored content-addressed cache under
`.pitlore/packs/sha256/`. Runtime search/retrieve/check/export read only locked,
checksum-verified Packs. Pack IDs may not collide with local or other Pack Lessons.
Local Pack sources must live inside the project; remote sources must be credential-free
HTTPS Git URLs, and `--subdir` can select a Pack nested inside a Git repository. A Git
URL/commit/subdirectory is recorded provenance. Before parsing any Pack YAML, verification
enumerates the allowed payload, applies per-file/count/aggregate size budgets, and rejects
symlink or realpath escapes. Public Packs must carry a non-empty UTF-8 `LICENSE`. Signed
Packs verify Ed25519 payload integrity; embedded keys remain `self-asserted` unless
installation explicitly pins their fingerprint with `--trust-key sha256-…`.

Environment:

| Var                                   | Meaning                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `PITLORE_LORE`                        | Override lore root                                                                    |
| `OPENAI_API_KEY`                      | Enable LLM distill                                                                    |
| `PITLORE_MODEL` / `OPENAI_MODEL`      | Model id (default `gpt-5.6`)                                                          |
| `PITLORE_PACK_GIT_TIMEOUT_MS`         | Bound HTTPS Git clone time; 250–300000 ms (default 120000)                            |
| `PITLORE_PACK_GIT_MAX_TRANSFER_BYTES` | Fail-closed disk-growth budget for the clone; 65536–1073741824 bytes (default 64 MiB) |
| `PITLORE_REGISTRY_URL`                | Base URL for Registry HTTP clients such as search/install/sync unless `--url` is used |
| `PITLORE_REGISTRY_TOKEN`              | Optional bearer token for protected Registry operations; never commit it              |

---

## Self-hosted Registry engineering baseline

The optional Phase 3 service reuses the exact Pack artifact and lock contract above. It
ships a Fastify REST API, PostgreSQL migrations/repositories with fail-closed row-level
security on org-scoped tables, public search and exact version comparison Web UI,
tenant-isolated organizations, viewer/publisher/admin/owner RBAC,
two-independent-reviewer publication, member/token revocation, canonical audit events,
explicit privacy-safe usage aggregates, opaque cursor pagination for public and
tenant-scoped collections, yank propagation, and Docker Compose. Its nine ordered
migrations include public-release RLS (`006`), database-enforced append-only and approval
integrity (`007`), indexed SemVer keyset pagination (`008`), and the append-only,
RLS-protected public discovery projection (`009`).

Exact comparison is a bounded semantic artifact diff, not a metadata-only table. The
public `/v1/public/diff` endpoint fully re-verifies two published or yanked artifacts and
returns only counts, Lesson IDs, and changed field names. It never returns Lesson values,
manifest values, fixture paths, or fixture bodies; each change category returns at most
100 details and the diff JSON is capped at 128 KiB. Yanked artifacts remain comparable for
incident analysis even though direct artifact download continues to return `410`.

Browser login uses an `HttpOnly`/`Secure` `__Host-` session cookie, a session-bound CSRF
token for unsafe requests, and `Cache-Control: no-store` on protected responses. Each
cookie-authenticated request resolves the exact provider/issuer/subject again and uses the
current active user, membership, and role rather than a stale login-time snapshot. Six
independent in-process rate-limit budgets isolate semantic diffs, ordinary public reads,
browser auth, billing webhooks, protected API authentication, and release uploads. Small
JSON routes, billing webhooks, and the overall request/release path are capped at 64 KiB,
256 KiB, and 30 MiB;
forwarding headers affect client identity only when `PITLORE_TRUST_PROXY` explicitly
allow-lists the reverse proxy.

The public package-list endpoint keeps its legacy default wire contract: each result has
exactly `name`, `visibility`, and `created_at`. Only `include=facets` (CLI `--facets`)
adds `latest_version`, availability, description, approved-Lesson count, and
language/ecosystem/tag facets. Repeat `language`, `ecosystem`, or `tag` at most four times;
values within one dimension are OR, while populated dimensions are AND. Facet filters in
the CLI request the expanded result automatically.

Discovery metadata is derived by the server only after fully verifying the immutable Pack
artifact, and only active `approved` Lessons contribute facets or counts. The projection
selects the highest published strict-SemVer release and falls back to the next published
release after a yank. Historical releases without a verified discovery row remain honestly
marked unavailable until a migration owner reindexes them; the migration never fabricates
metadata. The RLS-protected search index uses normalized, append-only facet rows with exact
text equality rather than array overlap, so rare filters can use a B-tree without bypassing
tenant/public isolation. Reputation data and reputation-based ranking remain future product
work.

The following local secret setup is for a POSIX shell on macOS/Linux or WSL.
Windows Docker Desktop users should run it inside WSL so the documented file-mode
boundary is preserved.

```bash
cp .env.example .env
install -d -m 700 secrets
umask 077
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-admin-password
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-migrator-password
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-runtime-password
chmod 644 secrets/postgres-*-password
docker compose --env-file .env up -d --build --wait
curl -fsS http://127.0.0.1:8787/readyz
```

Then open `http://127.0.0.1:8787` in a browser.

Keep the `secrets/` directory at mode `0700`. Local Compose uses host bind mounts for
file-backed secrets on Linux, so its non-root service users must be able to read the files;
the private parent directory remains the host boundary, and Compose grants each read-only
mount only to the services listed in `compose.yaml`.

The default binds only to loopback. See the complete [self-hosting runbook](./docs/SELF-HOSTING.md)
for owner bootstrap, OIDC/JWT boundaries, the optional environment-gated PKCE browser
login (mock-IdP engineering baseline only), row-level security and rate-limiter
boundaries, air-gap transfer, backup/restore, upgrades, and the still-external production
gaps. This repository does not ship OIDC discovery, SAML, SCIM, durable multi-instance
sessions, or a real checkout provider. Billing is off by default, the browser flow has not
been validated against a real IdP, and missing production providers fail closed.

Owner bootstrap and bootstrap-token issuance bind the exact OIDC provider, issuer, and
subject; pass `--issuer` explicitly or set `PITLORE_OIDC_ISSUER`. Existing identities created
before migration `004` need the runbook's explicit issuer-rebinding step after upgrade.

Resolved GitHub Actions/generic CI and Sentry payloads can also be converted locally into
private candidates with `pitlore signal`. This is a bounded adapter/CLI, not a hosted
webhook receiver: it requires an operator-written abstract failure and fix summary,
discards raw Sentry event/user/stack content, and uses the local heuristic unless
`--use-openai` is explicitly selected.

---

## MCP (Codex / Claude / Cursor)

Start:

```bash
# Project-local Git install
npx --no-install pitlore serve

# Source checkout
npm run -s pitlore -- serve

# Global packed tarball or future registry install
pitlore serve
```

This repository checks in project-scoped configs for both clients:

- Claude Code reads
  [`.mcp.json`](https://github.com/Hardboiled98k/pitlore/blob/main/.mcp.json).
  On first use, review and approve the project server in `/mcp`; repository config
  cannot approve itself.
- Codex reads
  [`.codex/config.toml`](https://github.com/Hardboiled98k/pitlore/blob/main/.codex/config.toml)
  only after the project is trusted. Approved-only retrieve/check/export tools are
  pre-approved; candidate-aware search/get, candidate review, and the writing
  `pitlore_remember` keep prompting.

Both configs use `npm run -s pitlore -- serve`, so run `npm ci` first. A writable
project lore remains local under ignored `.pitlore/`.

Example Cursor / Claude MCP config fragment:

```json
{
  "mcpServers": {
    "pitlore": {
      "command": "node",
      "args": [
        "/absolute/path/to/your-project/node_modules/pitlore/dist/cli.js",
        "serve"
      ],
      "env": {
        "PITLORE_LORE": "/absolute/path/to/your/.pitlore"
      }
    }
  }
}
```

For a source checkout, replace the first argument with
`/absolute/path/to/pitlore/dist/cli.js`. For a global packed/registry install, keep Node
as `command` and use this complete shape:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/global-node_modules/pitlore/dist/cli.js",
    "serve"
  ]
}
```

Obtain the global module root with `npm root --global`. Resolve Node with
`command -v node` on POSIX or `(Get-Command node).Source` in PowerShell. Desktop clients
often do not inherit the shell's global `PATH`; using absolute paths avoids that and also
avoids relying on Windows `.cmd` shims.

### Tools

| Tool                    | Description                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `pitlore_retrieve`      | Top-K approved lessons + injectable prompt for the current task                                     |
| `pitlore_search`        | Search catalog, including candidates/rejected tombstones when explicitly requested                  |
| `pitlore_get`           | Full lesson JSON; may reveal a private candidate or rejected tombstone                              |
| `pitlore_check`         | Scan code text against approved detectors                                                           |
| `pitlore_remember`      | Distill + save a candidate lesson                                                                   |
| `pitlore_review`        | Prepare or record an advisory LLM review; may reveal a private candidate, never approves or rejects |
| `pitlore_export_prompt` | Short constraint block                                                                              |

**Suggested agent workflow**

1. Before large edits → `pitlore_retrieve` with intent + files
2. After edits → `pitlore_check` on the diff/file
3. After a real bugfix → `pitlore_remember` → LLM records `pitlore_review` → human runs `pitlore approve <id>` or `pitlore reject <id>`

### LLM review without LLM approval

PitLore does not silently send a private candidate to another provider. An approved MCP
call lets the current Codex/Claude/Cursor model request the packet, review the candidate
as untrusted data, then call `pitlore_review` again with its structured submission. The
equivalent provider-neutral CLI flow is:

```bash
pitlore review <id> > review-packet.json
# Give the packet to a reviewer LLM and save only required_review_envelope.
pitlore review <id> --input review-submission.json
pitlore review-queue
pitlore approve <id>  # separate human action; or: pitlore reject <id>
```

The private sidecar at `.pitlore/reviews/<id>.yaml` is advisory and records a
self-reported reviewer identity. It is bound to the full candidate, fixture contents,
approved catalog, actual instructions/rubric, related lessons, and deterministic checks.
Any change marks the review `stale`; review files are never consumed by retrieve/check
and cannot approve or reject a Lesson. MCP intentionally exposes no lifecycle transition.

### Local dogfood evidence (explicit CLI only)

PitLore does not silently turn a read-only retrieve/check call into a disk write, and an
agent does not grade its own usefulness. After a person evaluates a real task, record one
strict observation in ignored `.pitlore/evidence/events.jsonl`:

```bash
# Text and MCP responses always include the hash. JSON callers opt into an envelope.
pitlore retrieve --intent "refresh auth tokens" --json --with-context
```

```json
{
  "type": "retrieve_observation",
  "observation_id": "auth-refresh-2026-07-17-retrieve",
  "task_id": "auth-refresh-2026-07-17",
  "client": "codex",
  "sample_kind": "real",
  "observed_catalog_hash": "<hash copied from the retrieve response>",
  "returned_lesson_ids": ["http-no-timeout"],
  "used_lesson_ids": ["http-no-timeout"],
  "irrelevant_lesson_ids": [],
  "missed_existing_lesson_ids": [],
  "coverage_gap": false,
  "reason": "The timeout Lesson changed the implementation plan"
}
```

```bash
pitlore evidence record --input observation.json
pitlore evidence summary --catalog current
pitlore evidence summary --catalog all --json
pitlore evidence summary --catalog <historical-catalog-hash> --json
```

`used_lesson_ids` includes relevant Lessons that changed, prevented, or materially
confirmed the implementation plan; together with `irrelevant_lesson_ids`, it must exactly
classify every returned Lesson. This makes the reported retrieve precision/recall a
human-rated utility/relevance proxy. `observation_id` is a stable idempotency key;
retrying the exact same observation
counts once. Identical lines left by concurrent CLI writers are logically coalesced without
rewriting append-only history, while reusing the id with different data fails closed.
`missed_existing_lesson_ids` means an approved Lesson existed but retrieval missed it;
`coverage_gap` means no approved Lesson existed. `observed_catalog_hash` must be copied
from the original retrieve/check response and must still match when the observation is
recorded; if approvals changed meanwhile, PitLore refuses the event instead of inventing a
historical false negative. Detector observations use
`classification: tp|fp|fn` and never infer a true negative from a clean scan. Only
`sample_kind: real` contributes to usefulness, precision, and recall; empty denominators
remain `null`. The schema stores only ids, relative targets, and an abstract reason; it has
no dedicated fields for raw prompts, source content, credentials, or private Lesson bodies.
Callers must keep `reason` abstract; PitLore rejects common credential and email patterns on
both record and load. There is intentionally no MCP evidence writer in Phase 1.
The backward-compatible summary default is `--catalog all`; when more than one catalog
hash is present, text and JSON output disclose that the result is a cross-catalog
aggregate. Use `--catalog current` for the quality of the currently approved effective
catalog (including installed Packs), and an explicit hash for a historical version.
An explicit unknown hash fails instead of silently falling back to all events.

---

## Lesson shape (YAML)

```yaml
id: js-foreach-async-await-miss
title: "forEach does not await async callbacks"
languages: [javascript, typescript]
category: concurrency
symptom: "..."
root_cause: "..."
forbid_pattern_abstract: "..."
safe_pattern_abstract: "..."
severity: block # info | warn | block
status: approved # candidate | approved | rejected | deprecated
visibility: public # private | public
enforcement:
  test_idea: "..."
  patterns:
    - "\\.forEach\\s*\\(\\s*async\\s*\\("
  fixtures: # required before a block candidate can be approved
    bad: [fixtures/bad/foreach-async.js]
    good: [fixtures/good/promise-all.js]
```

Public lessons must stay **abstract** (no business source, no secrets).
Every public Pack must also carry a non-empty UTF-8 `LICENSE`; private Packs may omit it.
The three official Packs include the complete Apache-2.0 text so installed, cached,
Registry, and air-gap artifacts keep their content terms without relying on this README.
`rejected` means a candidate was not accepted and remains only as an auditable tombstone;
`deprecated` is reserved for a Lesson that was previously active and later retired.
New local lore directories and private files use owner-only permissions on POSIX systems.
Lifecycle locks are deliberately fail-closed and are never removed automatically; if a
process crashes, inspect the PID recorded in the reported lock and remove it only after
verifying that process has exited.

---

## Demo

Classic detector smoke fixtures:

```bash
npm run -s pitlore -- check demo/fixtures/bad-foreach-async.js
npm run -s pitlore -- check demo/fixtures/bad-mutable-default.py
npm run -s pitlore -- check demo/fixtures/bad-sql-concat.ts
```

Repository-specific full loop: [multi-tenant `tenantId` isolation demo](./demo/tenant-isolation/README.md).
It runs a private candidate through bad/good fixtures, explicit human approval,
default retrieval, and the blocking check without modifying the repository template.
Run the entire verified flow with `npm run demo:tenant`.

---

## Architecture and phases

```text
Phase 1 — local personal/team
seed/ + .pitlore/     local/private Git lore
        │
        ▼
  pitlore CLI  ──► retrieve / check / distill
        │
        ▼
  MCP stdio    ──► Codex / Claude / Cursor / …

Phase 2 — open sharing
  Git/GitHub Packs ──► install / lock / sign / verify / air-gap

Phase 3 — website evolution
  Self-host Registry ──► search / orgs / RBAC / audit / usage
```

Phase 1 still has no required server, account, or purchased domain. Teams may share a lore
with an ordinary private Git repository. Phase 2 Packs and the Phase 3 self-hosted Registry
are optional layers. Missing real usage, community, or production evidence remains an
explicit product limitation, but it no longer blocks open-source development, releases,
or work across phases.

---

## Development

```bash
npm ci
npm run verify
npm run demo:tenant
npm run test:install
# Disposable Docker fresh/backup/restore drill (requires Docker + Bash)
npm run test:self-host
```

At this local engineering snapshot, `npm test` covers 376 automated tests. The separate
self-host smoke exercises fresh install, upgrade, least-privilege runtime access,
backup/restore, and restart across all nine migrations; these checks are not evidence of
a production-hosted service or real external-provider operation.

---

## Contributing and security

Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md), use
[`SUPPORT.md`](./SUPPORT.md) for the right public help channel, and copy the
[Pack-specific pull-request checklist](https://github.com/Hardboiled98k/pitlore/blob/main/.github/PULL_REQUEST_TEMPLATE/pack.md)
for public Lesson or Pack changes. Never submit a local `.pitlore/`, private
Lessons/reviews/evidence, credentials, PII, customer data, or proprietary source.

Report suspected vulnerabilities privately through the process in
[`SECURITY.md`](./SECURITY.md), not through a public issue.

---

## Built with Codex & GPT-5.6

PitLore is developed as an independent open-source developer tool:

- Core implementation and iteration via **Codex**
- Lesson distillation path targets **GPT-5.6** when `OPENAI_API_KEY` is set
- The same local-first CLI/MCP, human approval, and privacy boundaries remain in force
- Real dogfood and human evidence remain useful quality signals, not release gates

---

## License

Apache-2.0 applies to this repository's code, documentation, and official public
Lesson/Pack content. Each official Pack includes its own complete `LICENSE`. Third-party
public Packs must carry their own applicable license terms. The generated MCP runtime's
bundled dependencies and their permissive license texts are listed in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

---

## Status

**Active engineering: a local Lesson loop, an implemented Pack supply-chain baseline, and
a self-hosted Registry engineering baseline.** Core CLI/MCP, governance, immutable Packs,
Registry/API/Web, tenant permissions, audit, usage, revocation, and local Docker Compose
operation are implemented. Independent external use, retrieval/detector precision,
community adoption, and production integrations remain unproven product signals rather
than test fixtures; those gaps do not block open-source development or releases.

The dated verification evidence and next-session checklist live in
[`docs/STATUS.md`](./docs/STATUS.md); ongoing adoption and dogfood evidence lives in
[`docs/DOGFOOD.md`](./docs/DOGFOOD.md); durable rationale lives in
[`docs/DECISIONS.md`](./docs/DECISIONS.md).

Not yet proven or shipped externally: npm registry publication, independent community
installs/contributions, a public hosted deployment, production browser SSO, real payment
collection, real Sentry/CI provider credentials, reputation data, or compliance
certification. Repository availability and isolated consumer smokes are engineering
delivery facts, not evidence of community adoption.
