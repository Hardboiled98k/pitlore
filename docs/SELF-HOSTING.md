# Self-hosting PitLore Registry

This runbook covers the Docker Compose baseline shipped in this repository. It is a
locally verifiable self-hosted deployment, not evidence of a managed PitLore SaaS,
production browser SSO, real payment collection, public TLS operation, or compliance.

## 1. Prerequisites and trust boundary

- Git and Node.js 22+ for the source checkout and CLI commands below.
- Docker Engine with Compose v2 and a persistent Docker volume.
- `openssl` for generating three independent PostgreSQL passwords.
- `curl` for the health, readiness, and authenticated HTTP probes.
- An operator-controlled `.env`; never commit `.env`, `secrets/`, dumps, or bearer tokens.
- An owner-only `operator-artifacts/` directory for temporary bearer and dump output.
- A TLS reverse proxy and firewall before any non-loopback exposure.
- An OIDC provider capable of issuing JWTs if humans will administer the Registry.

Password, permission, and bootstrap shell blocks assume a POSIX shell on macOS/Linux.
On Windows Docker Desktop, run them inside WSL so the documented file-mode boundary is
preserved.

Run this guide from a public source checkout:

```bash
git clone https://github.com/Hardboiled98k/pitlore.git
cd pitlore
npm ci
```

Commands written as `pitlore ...` require the GitHub or future npm CLI installation from
the main README. From this source checkout, the equivalent form is
`npm run -s pitlore -- ...`.

The default publishes Registry only on `127.0.0.1:8787`. PostgreSQL is reachable only on
the internal Compose network and has no host port. Keep the loopback default unless a
reviewed TLS proxy is ready.

## 2. Start a fresh instance

Create three different single-line base64url-safe secrets inside an owner-only directory.
Each must be 32–256 characters; the commands below produce 64 characters without a
trailing newline.

```bash
cp .env.example .env
install -d -m 700 secrets
umask 077
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-admin-password
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-migrator-password
openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > secrets/postgres-runtime-password
chmod 644 secrets/postgres-*-password

docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait
docker compose --env-file .env ps
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/readyz
```

Do not loosen the `0700` directory. Docker Compose implements a file-backed secret as a
host bind mount on Linux and cannot remap its owner to each non-root container UID, so the
files themselves must be readable (`0644`). Other host users still cannot traverse the
private parent directory, while Compose exposes each file read-only only to the services
explicitly granted that secret. If your platform provides managed/external secrets with
UID remapping, an operator override may use a stricter in-container mode.

The roles are intentionally separate:

| Role               | Intended use                                            | Effective boundary                                                                  |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pitlore_admin`    | PostgreSQL initialization, backup, and isolated restore | superuser; never used by Registry                                                   |
| `pitlore_migrator` | one-shot schema migration                               | owns schema objects; no superuser/createdb/createrole                               |
| `pitlore_runtime`  | Registry requests                                       | scoped business writes and sequence use; migration/evidence ledgers are not mutable |

The migrator takes a global advisory lock, verifies applied-file checksums and append-only
history, applies each new migration transactionally, then reconciles runtime grants. This
baseline ships nine migrations (`001`–`009`): `004_registry_identity_issuer.sql` adds the
exact OIDC issuer namespace to external identity bindings, `005` enables tenant RLS, and
`006` limits anonymous public release/approval rows to published or yanked releases.
`007` makes release payloads and lifecycle terminal states immutable, validates approval
eligibility at insert time, keeps release/approval/audit/usage/quota/billing facts
append-only, and fixes two-person approval to the mandatory policy the application already
enforces. Reconciliation first revokes all current table/sequence grants and the migrator's
future-object defaults, then applies an explicit per-table/per-column allow-list. A new
table or sequence therefore stays inaccessible until the allow-list is deliberately updated.
`SELECT` and `INSERT` are intentionally table-level for the existing application tables, so
a column added to one of those tables is not a new privilege boundary; every such migration
must review whether that column is safe for the runtime role. Routine privileges are outside
this reconciler. Do not add a `SECURITY DEFINER` routine without an explicit `PUBLIC` revoke
and a named-role grant in the same migration.
Runtime receives only `USAGE` on the audit sequence; it cannot read it or call `setval`.
`008` stores a strict, C-collated SemVer precedence/tie key and an indexed PostgreSQL
keyset, so release pages select only the requested rows plus one lookahead instead of
loading and sorting a catalog in Node.js.
`009` adds one append-only discovery snapshot per verified release, an exact normalized
facet table with a C-collated B-tree lookup, public/tenant RLS on both tables, and a
constrained package pointer to the highest strict-SemVer `published` release. New writers
must insert the server-derived snapshot and its exact facet rows with the release; the
database rejects missing or injected facets, rejects a new release without a snapshot, and
validates projection refreshes after publish or yank. The normalized lookup is deliberate:
PostgreSQL cannot safely push the non-leakproof array-overlap operator through this RLS
boundary, so a GIN-on-array design degenerates for rare or absent runtime filters.
A changed, removed, backfilled, or duplicate-version migration fails closed. These guards
prevent application-role and accidental owner mutations, but a database owner can still
alter/drop schema objects; this is not WORM storage or a compliance claim.
The smoke drill verifies the roles and grants created by this project. Operator-added role
memberships or global default privileges are external database drift and require separate
configuration monitoring.

Initialization scripts run only when PostgreSQL creates an empty data directory. Editing a
secret file later does not rotate an existing database role. Rotate existing roles through
an operator-controlled PostgreSQL procedure; never use `docker compose down -v` as a
password-rotation shortcut on data you need.

If Docker Desktop fails while building from a path containing non-ASCII characters, use the
verified ASCII staging workaround in [Troubleshooting](./TROUBLESHOOTING.md).

For a disposable end-to-end proof, the repository includes an automated drill:

```bash
npm run test:self-host
```

It copies the current working-tree build input into an ASCII temporary context, creates two independent
secret sets and random loopback ports, starts a fresh source stack, probes roles and actual
privileges, bootstraps/token-authenticates, backs up non-empty data, restores into a second
Compose project, compares normalized data, restarts Registry, then removes only those
temporary projects and files. It does not operate on the caller's named Compose project.

## 3. Bootstrap the first owner

Bootstrap binds one external identity to one organization by provider id, exact OIDC issuer,
and subject. `--issuer` must equal the JWT `iss` namespace and `--subject` its `sub` claim.
Save the returned organization UUID; the default OIDC tenant claim, `org_id`, must contain
that exact UUID.

```bash
docker compose --env-file .env exec -T registry \
  node dist/cli.js registry bootstrap \
  --provider company-oidc \
  --issuer https://id.example.com/ \
  --subject owner-subject-from-idp \
  --display-name "Registry Owner" \
  --org-slug acme \
  --org-name "Acme Engineering"
```

Before OIDC is connected, a database operator may issue one short-lived bootstrap service
token for that existing owner:

```bash
TOKEN_EXPIRY="$(node -e 'console.log(new Date(Date.now()+24*60*60*1000).toISOString())')"
install -d -m 700 operator-artifacts
umask 077
docker compose --env-file .env exec -T registry \
  node dist/cli.js registry bootstrap-token \
  --provider company-oidc \
  --issuer https://id.example.com/ \
  --subject owner-subject-from-idp \
  --org-slug acme \
  --expires-at "$TOKEN_EXPIRY" \
  > operator-artifacts/bootstrap-token.json
```

The clear bearer is printed once; PostgreSQL stores only its SHA-256 digest. Move the file
to a secret manager and safely delete the local copy. `operator-artifacts/` and the common
token/dump filename patterns are excluded by both `.gitignore` and `.dockerignore`, but that
is only source/build-context hygiene: the directory is still plaintext local storage, not
encryption, access control beyond its filesystem mode, retention, or secure deletion. The
command accepts only `pack:read` and `pack:publish` scopes (the defaults) and records issuance
in the audit log. A service token cannot stand in for a human reviewer or manage members,
billing, or organization policy.

Without OIDC, Registry still serves public reads and accepts previously issued service
tokens, but human-only approval and administration paths are unavailable.

## 4. Configure OIDC JWT verification

For the Compose baseline, configure all values together and use an HTTPS JWKS URL:

```dotenv
PITLORE_OIDC_PROVIDER=company-oidc
PITLORE_OIDC_ISSUER=https://id.example.com/
PITLORE_OIDC_AUDIENCE=pitlore-registry
PITLORE_OIDC_ALGORITHMS=RS256
PITLORE_OIDC_JWKS_URL=https://id.example.com/.well-known/jwks.json
PITLORE_OIDC_TENANT_CLAIM=org_id
```

Audience and algorithm fields may be comma-separated allow-lists. A custom deployment may
mount a bounded local JWKS file and set `PITLORE_OIDC_JWKS_FILE` instead of
`PITLORE_OIDC_JWKS_URL`; exactly one source is required.

The verifier checks the signature, explicit algorithm allow-list, issuer, audience,
expiration/not-before, locally bound provider + exact issuer + subject, and tenant claim.
An invalid bearer returns 401; a temporary JWKS/IdP verification failure returns 503.

### Provision the publisher and independent reviewer identities

The first owner must pre-provision each additional IdP subject before that subject's first
Registry request. Keep the owner, release submitter, and independent reviewer as three
different users. With the mandatory two-person policy, the submitter cannot approve their own
release. A practical minimum is the bootstrapped owner, a distinct publisher who submits,
and a distinct admin who reviews.

Bind the publisher and admin while authenticated as the owner:

```bash
export PITLORE_REGISTRY_URL=http://127.0.0.1:8787
export PITLORE_REGISTRY_TOKEN='<short-lived-owner-jwt-from-your-idp>'
pitlore registry provision-member \
  --org <organization-uuid-from-bootstrap> \
  --subject publisher-subject-from-idp \
  --display-name "Release Publisher" \
  --role publisher
pitlore registry provision-member \
  --org <organization-uuid-from-bootstrap> \
  --subject reviewer-subject-from-idp \
  --display-name "Release Reviewer" \
  --role admin
unset PITLORE_REGISTRY_TOKEN
```

The server derives the provider from the already verified owner assertion; clients cannot
choose a different provider in the request body. Only a verified human admin/owner may
provision a member, and only an owner may grant `owner`. Service tokens are rejected. The
new member's later JWT must carry the exact provisioned `sub` and organization tenant
claim. Repeating the same identity and role is idempotent; role changes use the separate
member-role endpoint.

This command does not create an account in the IdP, send an invitation, or obtain a JWT.
Those remain the operator's identity-lifecycle responsibilities. Have the provisioned
publisher submit with their own human JWT; then the owner and admin can approve
independently. If an owner-bound service token submits instead, that owner is still the
submitter and cannot count as a reviewer, so provision two other admin/owner reviewers.

This is a JWT verifier, not a complete enterprise identity product. The repository does not
implement OIDC discovery, SAML, or SCIM. The Web UI prefers the optional browser session
below and retains a manually supplied bearer only in the current page's memory as a fallback.

### Optional browser login (authorization code + PKCE)

An engineering-baseline browser login exists behind an all-or-none environment group and
requires the `PITLORE_OIDC_*` verifier above to be configured:

```dotenv
PITLORE_BROWSER_AUTH_AUTHORIZE_URL=https://id.example.com/oauth/authorize
PITLORE_BROWSER_AUTH_TOKEN_URL=https://id.example.com/oauth/token
PITLORE_BROWSER_AUTH_CLIENT_ID=pitlore-web
PITLORE_BROWSER_AUTH_REDIRECT_URI=https://registry.example.com/auth/callback
```

When set, `registry serve` exposes `/auth/login?org_id=…` (302 to the IdP with a
single-use server-side state and an S256 PKCE challenge), `/auth/callback` (bounded token
exchange with a 10-second deadline and 256 KiB response cap, nonce verification through the
same allow-listed-algorithm verifier, then an HttpOnly/Secure/SameSite=Strict session cookie
plus a readable Secure/SameSite=Strict session-bound CSRF cookie), `/auth/session`, and
`POST /auth/logout`. State is additionally bound to a short-lived login cookie. All
configured endpoints must be credential-free HTTPS; misconfiguration fails at startup.

Each cookie-authenticated organization request resolves the exact provider + issuer +
subject to the current active local user and membership again; role changes, suspension, or
membership removal therefore take effect without waiting for session expiry. An
`Authorization` header conclusively selects bearer authentication, so malformed or weaker
bearers never fall back to a stronger cookie. Unsafe cookie requests require the exact
configured redirect origin and a CSRF token whose hash is stored with that session. All
protected responses, including auth failures, use `Cache-Control: no-store`.

Honest limits: pending logins and sessions live in per-process memory (a restart logs
everyone out and multiple instances do not share sessions); the flow has been verified
against local mock IdPs and source-contract Web tests only, so real browser/IdP onboarding
evidence is still outstanding. A durable multi-instance session service remains external.

## 5. Registry, private Packs, and air-gap transfer

Keep bearer material in an environment variable rather than a command-line argument:

```bash
export PITLORE_REGISTRY_URL=http://127.0.0.1:8787
export PITLORE_REGISTRY_TOKEN='pit_...'

pitlore registry search async
pitlore registry install acme/node-reliability@1.0.0
pitlore registry install acme/private-rules@1.0.0 --org <organization-uuid>
pitlore registry sync
```

Public search is anonymous. Private release access requires both `--org` and an authorized
bearer. Package visibility must match the Pack manifest. Publication sends one immutable
canonical artifact and records a credential-free HTTPS source URL plus exact commit; it
does not clone that URL on the server. Approval always requires two distinct active human
admin/owner reviewers, neither of whom may be the submitter. This safety gate cannot be
disabled by plan or organization configuration.

Public package/release lists and authenticated token/package/release/member/audit lists are
bounded cursor APIs: the default page is 50 items and the maximum is 100. Cursors are opaque,
canonical, and bound to the relevant query, package, and organization; changing those inputs
requires starting a new page sequence. The CLI/client follows continuation pages with a
repeated-cursor guard, while the Web review queue and audit views expose explicit `Load More`
controls and discard stale in-flight results after logout or context changes. Release ordering
uses the PostgreSQL `008` SemVer keyset rather than loading a catalog into Node.js.

The public package-list API keeps its legacy default item exact: `name`, `visibility`, and
`created_at`. Add `include=facets` (CLI `--facets`) to receive `latest_version`,
`discovery_available`, description, approved-Lesson count, and language/ecosystem/tag
arrays. Each filter is repeatable at most four times; alternatives within one dimension are
OR, while non-empty dimensions are AND:

```bash
pitlore registry search async --facets
pitlore registry search --language typescript --language javascript \
  --ecosystem node --tag reliability
```

The CLI automatically requests the expanded contract when a facet filter is present. The
server derives metadata only by fully verifying the immutable release artifact and
aggregating its active `approved` Lessons; request-supplied package metadata is never a
trusted discovery source. Search projects the highest strict-SemVer `published` release and
falls back to the next published release after a yank. A package with no verified historical
snapshot is still name-visible but returns `discovery_available=false` and empty metadata.
Reputation data and reputation ranking are not implemented.

`registry sync` revalidates the exact Registry versions recorded in the lock and exits
nonzero when a release was yanked. It never sends a bearer to a Registry URL different from
the URL recorded in that lock entry.

`GET /v1/public/diff?package_name=...&from_version=...&to_version=...` compares two
different public release records in `published` or `yanked` state. The handler retrieves and
fully re-verifies both stored artifacts, checks their release identity and integrity, and
returns only structural evidence: exact totals, up to 100 ASCII-sorted Lesson IDs per
added/removed/changed bucket, and allow-listed changed field names. It does not return
Lesson or manifest values, source references, detector patterns, fixture paths, or fixture
bodies. The serialized diff object is capped at 128 KiB; the Node client reserves only 1 KiB
of bounded envelope overhead and rejects a response for a different Pack/version pair.
Comparing a yanked release is intentional for incident analysis, but downloading that
artifact still returns `410` and the comparison does not increment download usage.

Use a single artifact only when its dependencies are already installed at compatible
versions:

```bash
pitlore pack artifact export ./pack --output pack.pitlore-artifact.json
pitlore pack artifact verify pack.pitlore-artifact.json
pitlore pack artifact install pack.pitlore-artifact.json --trust-key sha256-...
```

For a disconnected root Pack with dependencies, export and install the exact locked
dependency closure:

```bash
pitlore pack artifact bundle-export acme/app-rules --output app-rules.bundle.json
pitlore pack artifact bundle-verify app-rules.bundle.json
pitlore pack artifact bundle-install app-rules.bundle.json --trust-key sha256-...
```

Bundle verification rejects missing or extra Packs, duplicate names, dependency cycles,
and range/version mismatches. Installation verifies all artifacts before committing the
lock once. Public and private artifacts use the same checksum, signature, path, size,
fixture, and declarative-detector checks; private artifacts must still be transported and
stored as confidential data.

## 6. Back up the live database

Pack artifacts, organizations, memberships, token digests, audit events, usage events, and
entitlement state live in PostgreSQL. The dump can therefore contain private Pack content
and must be protected as a secret.

```bash
install -d -m 700 operator-artifacts
umask 077
docker compose --env-file .env exec -T postgres \
  pg_dump -U pitlore_admin -d pitlore \
  --format=custom --no-owner --no-acl \
  > operator-artifacts/pitlore-registry.dump
test -s operator-artifacts/pitlore-registry.dump
openssl dgst -sha256 operator-artifacts/pitlore-registry.dump | awk '{print $NF}' \
  > operator-artifacts/pitlore-registry.dump.sha256
```

`pg_dump` provides a transactionally consistent database snapshot. If the operational
cut must correspond to an exact no-write instant, stop Registry before the dump. Back up
the reverse-proxy configuration, `.env` policy, and secret-manager recovery material
separately; they are not in the database dump. Never place clear bearer tokens in backups.
The ignored owner-only directory reduces accidental disclosure, but operators must still
move retained backups to protected backup storage and safely delete expired local copies.

## 7. Prove restoration in isolation

Do not test a restore against the live project or volume. The following drill uses a new
Compose project, new passwords, and port `18787`:

```bash
test "$(openssl dgst -sha256 operator-artifacts/pitlore-registry.dump | awk '{print $NF}')" = \
  "$(cat operator-artifacts/pitlore-registry.dump.sha256)"

(
  set -eu
  RESTORE_PROJECT="pitlore-restore-$(date +%s)"
  RESTORE_SECRETS="$(mktemp -d)"
  cleanup() {
    docker compose -p "$RESTORE_PROJECT" --env-file .env down -v >/dev/null 2>&1 || true
    if [ -d "$RESTORE_SECRETS" ]; then rm -r -- "$RESTORE_SECRETS"; fi
  }
  trap cleanup EXIT
  chmod 700 "$RESTORE_SECRETS"
  umask 077
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > "$RESTORE_SECRETS/admin"
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > "$RESTORE_SECRETS/migrator"
  openssl rand -base64 48 | tr '+/' '-_' | tr -d '\n' > "$RESTORE_SECRETS/runtime"
  chmod 644 "$RESTORE_SECRETS/admin" "$RESTORE_SECRETS/migrator" "$RESTORE_SECRETS/runtime"
  export PITLORE_POSTGRES_ADMIN_PASSWORD_FILE="$RESTORE_SECRETS/admin"
  export PITLORE_POSTGRES_MIGRATOR_PASSWORD_FILE="$RESTORE_SECRETS/migrator"
  export PITLORE_POSTGRES_RUNTIME_PASSWORD_FILE="$RESTORE_SECRETS/runtime"
  export PITLORE_REGISTRY_PORT=18787
  export PITLORE_BILLING_MODE=off
  export PITLORE_BILLING_PROVIDER=
  export PITLORE_OIDC_PROVIDER=
  export PITLORE_OIDC_ISSUER=
  export PITLORE_OIDC_AUDIENCE=
  export PITLORE_OIDC_ALGORITHMS=
  export PITLORE_OIDC_JWKS_URL=

  docker compose -p "$RESTORE_PROJECT" --env-file .env up -d --wait postgres
  docker compose -p "$RESTORE_PROJECT" --env-file .env exec -T postgres \
    pg_restore -U pitlore_admin --role=pitlore_migrator -d pitlore \
    --clean --if-exists --no-owner --no-acl --exit-on-error \
    < operator-artifacts/pitlore-registry.dump
  docker compose -p "$RESTORE_PROJECT" --env-file .env up -d --build --wait

  curl --fail http://127.0.0.1:18787/readyz
  docker compose -p "$RESTORE_PROJECT" --env-file .env exec -T postgres \
    psql -U pitlore_admin -d pitlore -c \
    'SELECT name, length(checksum) AS checksum_length FROM registry_schema_migrations ORDER BY name;'
  docker compose -p "$RESTORE_PROJECT" --env-file .env exec -T postgres \
    psql -U pitlore_admin -d pitlore -c \
    "SELECT has_table_privilege('pitlore_runtime','registry_schema_migrations','SELECT') AS ledger_read, has_table_privilege('pitlore_runtime','registry_schema_migrations','INSERT,UPDATE,DELETE') AS ledger_write;"

)
```

At this `0.1.0` snapshot the ledger must contain nine rows, and every migration checksum
length must be 64. `ledger_read` must be true and `ledger_write` false. Before accepting a
backup policy, also compare source/restored counts for critical tables and perform one
authenticated read after restarting the restored Registry. A file that has never completed
an isolated restore is only a prospective backup.

## 8. Upgrade safely

1. Complete a fresh backup and isolated restore drill.
2. Review new migration files. Never edit or remove an applied migration.
3. Build both services that share the application image.
4. Stop request traffic **and every old Registry writer** before applying migrations. An old
   pre-`009` writer does not create a verified discovery row and must not run against the new
   schema.
5. Apply migrations once. If this first applies `004`, complete the explicit issuer rebinding
   below before accepting human traffic.
6. If this first applies `009` to a database with releases, use the migration-owner connection
   to reverify and append missing discovery snapshots in bounded batches as described below.
7. Start the new Registry image.
8. Check readiness, migration checksums, logs, runtime privileges, and one authenticated read.

```bash
docker compose --env-file .env build --pull migrate registry
docker compose --env-file .env stop registry
docker compose --env-file .env up -d --wait postgres
docker compose --env-file .env run --rm migrate
```

Migration `009` intentionally does not invent discovery metadata for old rows. While old
writers and external traffic remain stopped, the shipped Compose stack can reuse the
`migrate` service's split host/user/password-file environment without exposing a
credential-bearing URL:

```bash
docker compose --env-file .env run --rm --no-deps migrate \
  node dist/cli.js registry reindex-discovery \
  --use-split-migration-owner-env \
  --max-releases 1000
```

For a non-Compose operator environment, omit `--use-split-migration-owner-env` and inject
the migration-owner PostgreSQL URL through the environment named by
`--database-url-env`; never place that URL on the command line or commit it. Split
credentials are accepted only after the explicit flag, and either mode verifies that the
connected role is the table owner or a superuser before reading artifacts. Runtime-role
credentials are deliberately rejected. The command returns `indexed` and `complete`;
repeat bounded runs until `complete=true`. Each missing row is appended only after the
immutable artifact is fully reverified. If any release cannot be verified, stop and
investigate that artifact—do not replace it with guessed or empty metadata. Until reindex
succeeds, that historical package remains explicitly `discovery_available=false`; a
missing row must not be represented as a verified empty snapshot. A genuinely verified
artifact with no active approved Lessons may still have a valid, available snapshot whose
facet arrays and count are empty.

When `004_registry_identity_issuer.sql` is first applied to an older database, existing
external users intentionally retain `identity_issuer = NULL`; they cannot authenticate as
issuer-bound OIDC humans until explicitly rebound. Before restarting request traffic,
re-run the owner bootstrap with the **original** provider, issuer, subject, organization,
and display values:

```bash
docker compose --env-file .env run --rm --no-deps registry \
  node dist/cli.js registry bootstrap \
  --provider company-oidc \
  --issuer https://id.example.com/ \
  --subject owner-subject-from-idp \
  --display-name "Registry Owner" \
  --org-slug acme \
  --org-name "Acme Engineering"
```

For a fresh deployment or after the owner issuer binding is complete, start Registry while
external reverse-proxy traffic remains stopped:

```bash
docker compose --env-file .env up -d --no-deps --wait registry

curl --fail http://127.0.0.1:8787/readyz
docker compose --env-file .env logs --tail=200 registry
docker compose --env-file .env exec -T postgres \
  psql -U pitlore_admin -d pitlore -c \
  'SELECT name, length(checksum) FROM registry_schema_migrations ORDER BY name;'
```

The rebound owner can now authenticate locally. Re-run `registry provision-member` for
every other legacy external subject with its existing role; the idempotent path binds the
same exact issuer without changing that role. A non-null different issuer is never replaced
by either command and fails closed. Check that no intended human identity remains unbound,
perform the authenticated read, and only then reopen external traffic:

```bash
docker compose --env-file .env exec -T postgres \
  psql -U pitlore_admin -d pitlore -c \
  'SELECT issuer, subject FROM registry_users WHERE identity_issuer IS NULL ORDER BY issuer, subject;'
```

There is no automatic down-migration. Rollback means restoring a previously proven backup
and the matching application/configuration in an isolated, reviewed procedure.

## 9. Runtime hardening and remaining operations

The application image runs as a non-root user with a read-only root filesystem, bounded
`/tmp`, dropped Linux capabilities, and `no-new-privileges`. PostgreSQL and Node base images
are digest-pinned. `/healthz` is process liveness; `/readyz` verifies database readiness.

These controls do not provide TLS, host patching, encrypted disks, secret rotation, HA,
point-in-time recovery, external monitoring, incident response, or compliance
certification.

Tenant isolation is enforced at two layers. The application and repository queries scope
every org operation, and migration `005` additionally enables PostgreSQL row-level
security on the nine org-scoped tables (memberships, packages, releases, release
approvals, audit, usage events/reservations, subscriptions, billing webhook events) with
fail-closed tenant policies keyed on the per-transaction
`set_config('pitlore.tenant_id', …, true)` context. Migration `006` narrows the SELECT-only
public policies so anonymous readers can discover public packages but can read release and
approval rows only for `published` or `yanked` releases. Without tenant context the
non-owner `pitlore_runtime` role sees zero org rows and cross-tenant writes are rejected
by `WITH CHECK`; the self-host smoke probes exactly that against real PostgreSQL.
`registry_users`, `registry_organizations`, and `registry_api_tokens` deliberately stay
outside RLS because bootstrap, identity resolution, and hash-indexed token authentication
run before any tenant is known. RLS is defence in depth, not a replacement for the
application checks, and it is not a third-party security assessment.

The HTTP entry points ship with six independent in-process token buckets so expensive
semantic diffs and ordinary public browsing cannot consume browser-login, billing-webhook,
protected-API, or upload capacity. `/v1/public/diff` defaults to a burst of 4 and 0.2
requests/second sustained per client IP; both GET and Fastify's automatic HEAD route use
that bucket. Other public API, OpenAPI, and Web assets default to a burst of 60 and 5
requests/second; `/auth/*` defaults to 20 and 1/second; `/v1/billing/webhook` defaults to
30 and 2/second. Protected `/v1/me` and `/v1/orgs/*` requests pass through a wider
pre-authentication bucket (burst 120, 20/second) before any bearer, OIDC, session, or
database lookup, so an invalid credential cannot bypass every built-in bound merely by
targeting a protected route. Each bucket tracks at most 10k clients with
least-recently-seen eviction and returns 429 + `Retry-After`; health probes are exempt.
Small JSON mutation routes are additionally capped at 64 KiB and the signed billing
webhook at 256 KiB. Only release submission retains the 30 MiB envelope needed for a Pack
artifact, and that upload path has its own stricter pre-authentication bucket (burst 5,
0.2/second). The external gateway should impose the same path-specific distinction before
forwarding request bodies.

The Web client omits cookies for public and bearer requests. Only the explicit
`/auth/session` bootstrap probe and already-established cookie-session requests use
`credentials: same-origin`; this keeps public comparison anonymous without breaking SSO
restoration after a redirect or page refresh.

Forwarding headers are ignored by default. When, and only when, every request reaches
Registry through an operator-controlled reverse proxy, set `PITLORE_TRUST_PROXY` to a
comma-separated allow-list of the proxy's actual source IPs or bounded CIDRs, for example
`127.0.0.1/32,::1/128` for a verified same-host loopback proxy. Hostnames, wildcards,
`true`, `0.0.0.0/0`, `::/0`, and empty entries fail startup. Do not copy the example for a
container/network proxy without first verifying its source range, and use firewall rules
to prevent bypassing the proxy. The allow-list only decides which peer may supply the
forwarded client chain; it does not make arbitrary `X-Forwarded-For` values trustworthy.

These buckets are depth defence only. Before any public exposure, the TLS reverse
proxy/API gateway must still enforce reviewed rate, concurrency, body, and egress limits
and feed abuse monitoring/blocking. Usage telemetry is not a substitute for those
controls.

## 10. Billing and external production gaps

`PITLORE_BILLING_MODE=off` is the honest self-host default. It disables seat/event quota
enforcement and exposes the enterprise entitlement set without collecting payment. The
repository includes entitlement calculations, idempotent signed-webhook handling, and a
fail-closed provider interface, but it ships no real checkout/customer portal adapter.
Checkout and portal routes therefore return 503 by default.

Do not set `enforced` merely to make the UI look production-ready. It requires a mounted
webhook secret and provider name, plus a separately implemented and tested payment adapter,
real provider event mapping, operational replay policy, and legal/commercial review.
The generic ledger orders different timestamps by `created_at` and uses `event_id` only as
a deterministic tie-break when timestamps are equal. That tie is not evidence of provider
event chronology. Before enabling a real adapter, prove that the provider supplies a
monotonic ordering key or define and test an explicit same-timestamp conflict policy.

Still external and unproven: a public hosted deployment, domain/TLS operation, real IdP
onboarding, a real end-to-end browser login against a production IdP (the built-in PKCE
flow is mock-IdP engineering only), durable/multi-instance sessions, real payment
collection, live Sentry/GitHub webhook credentials and delivery, community Pack adoption,
reputation data, HA/monitoring, and any compliance claim. Edge rate limiting and
operational abuse response also remain external requirements; the built-in limiter is a
depth-defence floor, not the public boundary.
