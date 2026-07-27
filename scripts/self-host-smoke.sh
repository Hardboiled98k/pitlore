#!/usr/bin/env bash
set -euo pipefail

unset CDPATH
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly PROJECT_ROOT
WORK_ROOT="$(mktemp -d /tmp/pitlore-self-host.XXXXXX)"
readonly WORK_ROOT
readonly STAGE_ROOT="$WORK_ROOT/source"
readonly SOURCE_SECRETS="$WORK_ROOT/source-secrets"
readonly RESTORE_SECRETS="$WORK_ROOT/restore-secrets"
readonly SOURCE_PROJECT="pitlore_smoke_${$}_${RANDOM}"
readonly RESTORE_PROJECT="pitlore_restore_${$}_${RANDOM}"
SOURCE_PORT=""
RESTORE_PORT=""
TOKEN_EXPIRY="$(node -e 'process.stdout.write(new Date(Date.now() + 60 * 60 * 1000).toISOString())')"
readonly TOKEN_EXPIRY

log() {
  printf '[self-host-smoke] %s\n' "$*"
}

die() {
  printf '[self-host-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

source_compose() {
  PITLORE_POSTGRES_ADMIN_PASSWORD_FILE="$SOURCE_SECRETS/postgres-admin-password" \
    PITLORE_POSTGRES_MIGRATOR_PASSWORD_FILE="$SOURCE_SECRETS/postgres-migrator-password" \
    PITLORE_POSTGRES_RUNTIME_PASSWORD_FILE="$SOURCE_SECRETS/postgres-runtime-password" \
    PITLORE_REGISTRY_PORT="$SOURCE_PORT" \
    docker compose \
      --project-directory "$STAGE_ROOT" \
      -f "$STAGE_ROOT/compose.yaml" \
      -p "$SOURCE_PROJECT" \
      "$@"
}

restore_compose() {
  PITLORE_POSTGRES_ADMIN_PASSWORD_FILE="$RESTORE_SECRETS/postgres-admin-password" \
    PITLORE_POSTGRES_MIGRATOR_PASSWORD_FILE="$RESTORE_SECRETS/postgres-migrator-password" \
    PITLORE_POSTGRES_RUNTIME_PASSWORD_FILE="$RESTORE_SECRETS/postgres-runtime-password" \
    PITLORE_REGISTRY_PORT="$RESTORE_PORT" \
    docker compose \
      --project-directory "$STAGE_ROOT" \
      -f "$STAGE_ROOT/compose.yaml" \
      -p "$RESTORE_PROJECT" \
      "$@"
}

cleanup() {
  local status=$?
  set +e
  if [[ -f "$STAGE_ROOT/compose.yaml" ]]; then
    if (( status != 0 )); then
      log "failure diagnostics: source Compose state"
      source_compose ps -a >&2
      source_compose logs --no-color --tail=200 postgres migrate registry >&2
      log "failure diagnostics: restore Compose state"
      restore_compose ps -a >&2
      restore_compose logs --no-color --tail=200 postgres migrate registry >&2
    fi
    source_compose down -v --remove-orphans --rmi local >/dev/null 2>&1
    restore_compose down -v --remove-orphans --rmi local >/dev/null 2>&1
  fi
  rm -rf -- "$WORK_ROOT"
  return "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

choose_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.unref();
    server.on("error", () => process.exit(1));
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  '
}

write_secret_set() {
  local directory=$1
  local name
  mkdir -p -- "$directory"
  chmod 700 "$directory"
  for name in admin migrator runtime; do
    node -e \
      'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' \
      > "$directory/postgres-$name-password"
    # Local Compose implements file-backed secrets as bind mounts on Linux and
    # cannot remap the host UID. The 0700 parent remains the host confidentiality
    # boundary; 0644 lets only services granted the read-only mount use a
    # different non-root container UID.
    chmod 644 "$directory/postgres-$name-password"
  done
}

wait_for_status() {
  local url=$1
  local expected=$2
  local body=""
  local _
  for _ in {1..60}; do
    body="$(curl --fail --silent --show-error --max-time 3 "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]] && \
      printf '%s' "$body" | node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const parsed = JSON.parse(input);
            process.exit(parsed?.data?.status === process.argv[1] ? 0 : 1);
          } catch {
            process.exit(1);
          }
        });
      ' "$expected"
    then
      return 0
    fi
    sleep 1
  done
  die "$url did not report $expected"
}

source_sql() {
  source_compose exec -T postgres \
    psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
      --username pitlore_admin --dbname pitlore --tuples-only --no-align \
      --command "$1"
}

restore_sql() {
  restore_compose exec -T postgres \
    psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
      --username pitlore_admin --dbname pitlore --tuples-only --no-align \
      --command "$1"
}

source_migrator_sql() {
  # The dollar expansion intentionally belongs to the nested container shell.
  # shellcheck disable=SC2016
  source_compose exec -T postgres sh -ec '
    PGPASSWORD="$(cat /run/secrets/postgres_migrator_password)"
    export PGPASSWORD
    exec psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
      --host 127.0.0.1 --username pitlore_migrator --dbname pitlore \
      --tuples-only --no-align --command "$1"
  ' sh "$1"
}

restore_migrator_sql() {
  # The dollar expansion intentionally belongs to the nested container shell.
  # shellcheck disable=SC2016
  restore_compose exec -T postgres sh -ec '
    PGPASSWORD="$(cat /run/secrets/postgres_migrator_password)"
    export PGPASSWORD
    exec psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
      --host 127.0.0.1 --username pitlore_migrator --dbname pitlore \
      --tuples-only --no-align --command "$1"
  ' sh "$1"
}

assert_equal() {
  local actual=$1
  local expected=$2
  local label=$3
  [[ "$actual" == "$expected" ]] || \
    die "$label: expected '$expected', received '$actual'"
}

assert_database_contract() {
  local target=$1
  local roles owners migrations privileges evidence_privileges fact_privileges sequence_privileges guards approval_policy semver_contract discovery_contract table_acl column_acl future_acl
  local table_acl_query column_acl_query
  table_acl_query="
    WITH expected(table_name, privilege_type) AS (
      VALUES
        ('registry_schema_migrations', 'SELECT'),
        ('registry_users', 'SELECT'), ('registry_users', 'INSERT'),
        ('registry_organizations', 'SELECT'), ('registry_organizations', 'INSERT'),
        ('registry_memberships', 'SELECT'), ('registry_memberships', 'INSERT'),
        ('registry_memberships', 'DELETE'),
        ('registry_api_tokens', 'SELECT'), ('registry_api_tokens', 'INSERT'),
        ('registry_packages', 'SELECT'), ('registry_packages', 'INSERT'),
        ('registry_releases', 'SELECT'), ('registry_releases', 'INSERT'),
        ('registry_release_discovery', 'SELECT'), ('registry_release_discovery', 'INSERT'),
        ('registry_release_discovery_facets', 'SELECT'), ('registry_release_discovery_facets', 'INSERT'),
        ('registry_release_approvals', 'SELECT'), ('registry_release_approvals', 'INSERT'),
        ('registry_audit_events', 'SELECT'), ('registry_audit_events', 'INSERT'),
        ('registry_usage_events', 'SELECT'), ('registry_usage_events', 'INSERT'),
        ('registry_usage_reservations', 'SELECT'), ('registry_usage_reservations', 'INSERT'),
        ('registry_subscriptions', 'SELECT'), ('registry_subscriptions', 'INSERT'),
        ('registry_billing_webhook_events', 'SELECT'), ('registry_billing_webhook_events', 'INSERT')
    ), actual AS (
      SELECT c.relname AS table_name, upper(acl.privilege_type) AS privilege_type
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
        JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND grantee.rolname = 'pitlore_runtime'
    )
    SELECT
      (SELECT count(*) FROM expected),
      (SELECT count(*) FROM expected AS e LEFT JOIN actual AS a USING (table_name, privilege_type) WHERE a.table_name IS NULL),
      (SELECT count(*) FROM actual AS a LEFT JOIN expected AS e USING (table_name, privilege_type) WHERE e.table_name IS NULL);"
  column_acl_query="
    WITH expected(table_name, column_name, privilege_type) AS (
      VALUES
        ('registry_users', 'identity_issuer', 'UPDATE'),
        ('registry_organizations', 'owner_user_id', 'UPDATE'),
        ('registry_memberships', 'role', 'UPDATE'),
        ('registry_api_tokens', 'revoked_at', 'UPDATE'),
        ('registry_packages', 'discovery_release_id', 'UPDATE'),
        ('registry_releases', 'status', 'UPDATE'),
        ('registry_releases', 'published_at', 'UPDATE'),
        ('registry_releases', 'rejected_at', 'UPDATE'),
        ('registry_releases', 'rejection_reason', 'UPDATE'),
        ('registry_releases', 'yanked_at', 'UPDATE'),
        ('registry_releases', 'yank_reason', 'UPDATE'),
        ('registry_subscriptions', 'provider', 'UPDATE'),
        ('registry_subscriptions', 'plan', 'UPDATE'),
        ('registry_subscriptions', 'status', 'UPDATE'),
        ('registry_subscriptions', 'provider_event_created_at', 'UPDATE'),
        ('registry_subscriptions', 'provider_event_id', 'UPDATE'),
        ('registry_subscriptions', 'updated_at', 'UPDATE')
    ), actual AS (
      SELECT c.relname AS table_name, attribute.attname AS column_name,
             upper(acl.privilege_type) AS privilege_type
        FROM pg_attribute AS attribute
        JOIN pg_class AS c ON c.oid = attribute.attrelid
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
        JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND grantee.rolname = 'pitlore_runtime'
    )
    SELECT
      (SELECT count(*) FROM expected),
      (SELECT count(*) FROM expected AS e LEFT JOIN actual AS a USING (table_name, column_name, privilege_type) WHERE a.table_name IS NULL),
      (SELECT count(*) FROM actual AS a LEFT JOIN expected AS e USING (table_name, column_name, privilege_type) WHERE e.table_name IS NULL);"
  if [[ "$target" == source ]]; then
    roles="$(source_sql "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('pitlore_admin', 'pitlore_migrator', 'pitlore_runtime') ORDER BY rolname;")"
    owners="$(source_sql "SELECT count(*), count(*) FILTER (WHERE tableowner <> 'pitlore_migrator') FROM pg_tables WHERE schemaname = 'public';")"
    migrations="$(source_sql "SELECT count(*), count(*) FILTER (WHERE length(checksum) <> 64) FROM registry_schema_migrations;")"
    privileges="$(source_sql "SELECT has_schema_privilege('pitlore_runtime', 'public', 'USAGE'), has_schema_privilege('pitlore_runtime', 'public', 'CREATE'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'DELETE');")"
    evidence_privileges="$(source_sql "SELECT has_table_privilege('pitlore_runtime', 'public.registry_releases', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_releases', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_releases', 'DELETE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'artifact_integrity', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'status', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'published_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'rejected_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'rejection_reason', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'yanked_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'yank_reason', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'DELETE');")"
    fact_privileges="$(source_sql "SELECT has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'DELETE');")"
    sequence_privileges="$(source_sql "SELECT has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'USAGE'), has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'SELECT'), has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'UPDATE');")"
    guards="$(source_sql "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('registry_releases_immutable_payload', 'registry_release_approvals_integrity', 'registry_release_approvals_append_only', 'registry_release_discovery_append_only', 'registry_release_discovery_facets_append_only', 'registry_audit_events_append_only', 'registry_usage_events_append_only', 'registry_usage_reservations_append_only', 'registry_billing_webhook_events_append_only', 'registry_releases_reject_truncate', 'registry_release_approvals_reject_truncate', 'registry_release_discovery_reject_truncate', 'registry_release_discovery_facets_reject_truncate', 'registry_audit_events_reject_truncate', 'registry_usage_events_reject_truncate', 'registry_usage_reservations_reject_truncate', 'registry_billing_webhook_events_reject_truncate');")"
    approval_policy="$(source_sql "SELECT (SELECT count(*) FROM pg_constraint WHERE conname = 'registry_organizations_two_person_approval_required' AND contype = 'c' AND convalidated), (SELECT column_default LIKE '%true%' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_organizations' AND column_name = 'two_person_approval');")"
    semver_contract="$(source_sql "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_releases' AND column_name IN ('semver_sort_key', 'semver_version_tie_key') AND is_generated = 'ALWAYS'), (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'registry_releases_package_semver_keyset_idx'), (SELECT provolatile = 'i' AND proparallel = 's' AND proisstrict FROM pg_proc WHERE proname = 'registry_semver_sort_key');")"
    discovery_contract="$(source_sql "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('registry_release_discovery', 'registry_release_discovery_facets')), (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_packages' AND column_name = 'discovery_release_id'), (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'registry_release_discovery_facets_lookup_idx' AND indexdef LIKE '%USING btree (dimension, value, release_id, package_id)%'), (SELECT count(*) FROM pg_constraint WHERE conname IN ('registry_release_discovery_release_fk', 'registry_release_discovery_facets_release_fk', 'registry_packages_discovery_release_fk')), (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('registry_release_discovery', 'registry_release_discovery_facets')), (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('registry_release_discovery_facets_validate', 'registry_release_discovery_require_facets', 'registry_packages_discovery_projection', 'registry_releases_discovery_projection', 'registry_releases_require_discovery'));")"
    table_acl="$(source_sql "$table_acl_query")"
    column_acl="$(source_sql "$column_acl_query")"
    future_acl="$(source_migrator_sql "BEGIN; CREATE TABLE registry_future_acl_probe (id text); CREATE SEQUENCE registry_future_acl_probe_seq; SELECT has_table_privilege('pitlore_runtime', 'registry_future_acl_probe', 'SELECT'), has_table_privilege('pitlore_runtime', 'registry_future_acl_probe', 'INSERT'), has_sequence_privilege('pitlore_runtime', 'registry_future_acl_probe_seq', 'USAGE'), has_sequence_privilege('pitlore_runtime', 'registry_future_acl_probe_seq', 'UPDATE'); ROLLBACK;")"
  else
    roles="$(restore_sql "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('pitlore_admin', 'pitlore_migrator', 'pitlore_runtime') ORDER BY rolname;")"
    owners="$(restore_sql "SELECT count(*), count(*) FILTER (WHERE tableowner <> 'pitlore_migrator') FROM pg_tables WHERE schemaname = 'public';")"
    migrations="$(restore_sql "SELECT count(*), count(*) FILTER (WHERE length(checksum) <> 64) FROM registry_schema_migrations;")"
    privileges="$(restore_sql "SELECT has_schema_privilege('pitlore_runtime', 'public', 'USAGE'), has_schema_privilege('pitlore_runtime', 'public', 'CREATE'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_schema_migrations', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_organizations', 'DELETE');")"
    evidence_privileges="$(restore_sql "SELECT has_table_privilege('pitlore_runtime', 'public.registry_releases', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_releases', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_releases', 'DELETE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'artifact_integrity', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'status', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'published_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'rejected_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'rejection_reason', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'yanked_at', 'UPDATE'), has_column_privilege('pitlore_runtime', 'public.registry_releases', 'yank_reason', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_release_approvals', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_audit_events', 'DELETE');")"
    fact_privileges="$(restore_sql "SELECT has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_events', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_usage_reservations', 'DELETE'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'SELECT'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'INSERT'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'UPDATE'), has_table_privilege('pitlore_runtime', 'public.registry_billing_webhook_events', 'DELETE');")"
    sequence_privileges="$(restore_sql "SELECT has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'USAGE'), has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'SELECT'), has_sequence_privilege('pitlore_runtime', 'public.registry_audit_events_sequence_seq', 'UPDATE');")"
    guards="$(restore_sql "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('registry_releases_immutable_payload', 'registry_release_approvals_integrity', 'registry_release_approvals_append_only', 'registry_release_discovery_append_only', 'registry_release_discovery_facets_append_only', 'registry_audit_events_append_only', 'registry_usage_events_append_only', 'registry_usage_reservations_append_only', 'registry_billing_webhook_events_append_only', 'registry_releases_reject_truncate', 'registry_release_approvals_reject_truncate', 'registry_release_discovery_reject_truncate', 'registry_release_discovery_facets_reject_truncate', 'registry_audit_events_reject_truncate', 'registry_usage_events_reject_truncate', 'registry_usage_reservations_reject_truncate', 'registry_billing_webhook_events_reject_truncate');")"
    approval_policy="$(restore_sql "SELECT (SELECT count(*) FROM pg_constraint WHERE conname = 'registry_organizations_two_person_approval_required' AND contype = 'c' AND convalidated), (SELECT column_default LIKE '%true%' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_organizations' AND column_name = 'two_person_approval');")"
    semver_contract="$(restore_sql "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_releases' AND column_name IN ('semver_sort_key', 'semver_version_tie_key') AND is_generated = 'ALWAYS'), (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'registry_releases_package_semver_keyset_idx'), (SELECT provolatile = 'i' AND proparallel = 's' AND proisstrict FROM pg_proc WHERE proname = 'registry_semver_sort_key');")"
    discovery_contract="$(restore_sql "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('registry_release_discovery', 'registry_release_discovery_facets')), (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'registry_packages' AND column_name = 'discovery_release_id'), (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'registry_release_discovery_facets_lookup_idx' AND indexdef LIKE '%USING btree (dimension, value, release_id, package_id)%'), (SELECT count(*) FROM pg_constraint WHERE conname IN ('registry_release_discovery_release_fk', 'registry_release_discovery_facets_release_fk', 'registry_packages_discovery_release_fk')), (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('registry_release_discovery', 'registry_release_discovery_facets')), (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('registry_release_discovery_facets_validate', 'registry_release_discovery_require_facets', 'registry_packages_discovery_projection', 'registry_releases_discovery_projection', 'registry_releases_require_discovery'));")"
    table_acl="$(restore_sql "$table_acl_query")"
    column_acl="$(restore_sql "$column_acl_query")"
    future_acl="$(restore_migrator_sql "BEGIN; CREATE TABLE registry_future_acl_probe (id text); CREATE SEQUENCE registry_future_acl_probe_seq; SELECT has_table_privilege('pitlore_runtime', 'registry_future_acl_probe', 'SELECT'), has_table_privilege('pitlore_runtime', 'registry_future_acl_probe', 'INSERT'), has_sequence_privilege('pitlore_runtime', 'registry_future_acl_probe_seq', 'USAGE'), has_sequence_privilege('pitlore_runtime', 'registry_future_acl_probe_seq', 'UPDATE'); ROLLBACK;")"
  fi

  assert_equal "$roles" $'pitlore_admin|t|t|t\npitlore_migrator|f|f|f\npitlore_runtime|f|f|f' "$target role flags"
  [[ "$owners" =~ ^[1-9][0-9]*\|0$ ]] || die "$target table ownership contract failed: $owners"
  assert_equal "$migrations" "9|0" "$target migration ledger"
  assert_equal "$privileges" "t|f|t|f|f|f|t|t|f|f" "$target runtime grants"
  assert_equal "$evidence_privileges" "t|t|f|f|t|t|t|t|t|t|t|t|f|f|t|t|f|f" "$target append-only runtime grants"
  assert_equal "$fact_privileges" "t|t|f|f|t|t|f|f|t|t|f|f" "$target append-only fact grants"
  assert_equal "$sequence_privileges" "t|f|f" "$target audit sequence grants"
  assert_equal "$table_acl" "30|0|0" "$target exact runtime table ACL"
  assert_equal "$column_acl" "17|0|0" "$target exact runtime column ACL"
  assert_equal "$future_acl" "f|f|f|f" "$target fail-closed future object ACL"
  assert_equal "$guards" "17" "$target append-only database guards"
  assert_equal "$approval_policy" "1|t" "$target mandatory two-person approval policy"
  assert_equal "$semver_contract" "2|1|t" "$target SemVer keyset schema"
  assert_equal "$discovery_contract" "2|1|1|3|4|5" "$target public discovery schema"

  # This is an actual privilege probe, not only a catalog assertion. If the
  # insert is ever allowed it is still rolled back before this branch fails.
  if [[ "$target" == source ]]; then
    # The dollar expansion intentionally belongs to the nested container shell.
    # shellcheck disable=SC2016
    if source_compose exec -T postgres sh -ec '
      PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"
      export PGPASSWORD
      exec psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
        --host 127.0.0.1 --username pitlore_runtime --dbname pitlore \
        --command "$1"
    ' sh "BEGIN; INSERT INTO registry_schema_migrations (name, checksum) VALUES ('999_forbidden_probe.sql', repeat('0', 64)); ROLLBACK;" >/dev/null 2>&1
    then
      die "$target runtime unexpectedly wrote the migration ledger"
    fi
  else
    # The dollar expansion intentionally belongs to the nested container shell.
    # shellcheck disable=SC2016
    if restore_compose exec -T postgres sh -ec '
      PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"
      export PGPASSWORD
      exec psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
        --host 127.0.0.1 --username pitlore_runtime --dbname pitlore \
        --command "$1"
    ' sh "BEGIN; INSERT INTO registry_schema_migrations (name, checksum) VALUES ('999_forbidden_probe.sql', repeat('0', 64)); ROLLBACK;" >/dev/null 2>&1
    then
      die "$target runtime unexpectedly wrote the migration ledger"
    fi
  fi
}

assert_container_contract() {
  local target=$1
  local container_id user runtime_uid readonly_rootfs host_ip published_db_port db_internal
  if [[ "$target" == source ]]; then
    container_id="$(source_compose ps -q registry)"
    runtime_uid="$(source_compose exec -T registry id -u)"
    published_db_port="$(source_compose port postgres 5432 2>/dev/null || true)"
    db_internal="$(docker network inspect --format '{{.Internal}}' "${SOURCE_PROJECT}_db")"
  else
    container_id="$(restore_compose ps -q registry)"
    runtime_uid="$(restore_compose exec -T registry id -u)"
    published_db_port="$(restore_compose port postgres 5432 2>/dev/null || true)"
    db_internal="$(docker network inspect --format '{{.Internal}}' "${RESTORE_PROJECT}_db")"
  fi
  [[ -n "$container_id" ]] || die "$target Registry container is missing"
  user="$(docker inspect --format '{{.Config.User}}' "$container_id")"
  readonly_rootfs="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container_id")"
  host_ip="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostIp}}' "$container_id")"
  [[ -n "$user" && "$user" != 0 && "$user" != root ]] || \
    die "$target Registry container must declare a non-root user"
  [[ "$runtime_uid" != 0 ]] || die "$target Registry process is running as root"
  assert_equal "$readonly_rootfs" "true" "$target read-only root filesystem"
  assert_equal "$host_ip" "127.0.0.1" "$target Registry host binding"
  assert_equal "$db_internal" "true" "$target internal database network"
  [[ -z "$published_db_port" ]] || die "$target PostgreSQL port is published: $published_db_port"
}

normalize_data_dump() {
  local target=$1
  local output=$2
  if [[ "$target" == source ]]; then
    source_compose exec -T postgres \
      pg_dump --username pitlore_admin --dbname pitlore \
        --data-only --no-owner --no-privileges --column-inserts \
      | sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' > "$output"
  else
    restore_compose exec -T postgres \
      pg_dump --username pitlore_admin --dbname pitlore \
        --data-only --no-owner --no-privileges --column-inserts \
      | sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' > "$output"
  fi
}

require_command docker
require_command node
require_command npm
require_command curl
require_command tar
require_command sed
require_command cmp
docker info >/dev/null
docker compose version >/dev/null

log "copying the working tree into an ASCII-only Docker build context"
mkdir -p -- "$STAGE_ROOT"
tar -C "$PROJECT_ROOT" \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./.pitlore' \
  --exclude='./secrets' \
  --exclude='./operator-artifacts' \
  --exclude='./.env' \
  --exclude='./coverage' \
  --exclude='bootstrap-token*.json' \
  --exclude='*.dump' \
  --exclude='*.dump.sha256' \
  -cf - . | tar -C "$STAGE_ROOT" -xf -
node -e 'process.exit(/[^\x20-\x7e]/u.test(process.argv[1]) ? 1 : 0)' "$STAGE_ROOT" || \
  die "temporary Docker build context is not ASCII-only"

write_secret_set "$SOURCE_SECRETS"
write_secret_set "$RESTORE_SECRETS"
for secret_name in admin migrator runtime; do
  if cmp -s \
    "$SOURCE_SECRETS/postgres-$secret_name-password" \
    "$RESTORE_SECRETS/postgres-$secret_name-password"
  then
    die "source and restore $secret_name secrets unexpectedly match"
  fi
done

SOURCE_PORT="$(choose_port)"
RESTORE_PORT="$(choose_port)"
while [[ "$RESTORE_PORT" == "$SOURCE_PORT" ]]; do
  RESTORE_PORT="$(choose_port)"
done

log "verifying optional browser-auth values survive Compose rendering"
BROWSER_AUTH_COMPOSE_JSON="$(
  PITLORE_BROWSER_AUTH_AUTHORIZE_URL=https://identity.smoke.invalid/authorize \
  PITLORE_BROWSER_AUTH_TOKEN_URL=https://identity.smoke.invalid/token \
  PITLORE_BROWSER_AUTH_CLIENT_ID=pitlore-smoke-web \
  PITLORE_BROWSER_AUTH_REDIRECT_URI=https://registry.smoke.invalid/auth/callback \
    source_compose config --format json
)"
printf '%s' "$BROWSER_AUTH_COMPOSE_JSON" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const environment = JSON.parse(input)?.services?.registry?.environment;
    const expected = {
      PITLORE_BROWSER_AUTH_AUTHORIZE_URL: "https://identity.smoke.invalid/authorize",
      PITLORE_BROWSER_AUTH_TOKEN_URL: "https://identity.smoke.invalid/token",
      PITLORE_BROWSER_AUTH_CLIENT_ID: "pitlore-smoke-web",
      PITLORE_BROWSER_AUTH_REDIRECT_URI: "https://registry.smoke.invalid/auth/callback",
    };
    if (!environment || Object.entries(expected).some(([key, value]) => environment[key] !== value)) {
      process.exit(1);
    }
  });
'
unset BROWSER_AUTH_COMPOSE_JSON

source_compose config --quiet
restore_compose config --quiet

readonly DISCOVERY_MIGRATION="$STAGE_ROOT/migrations/009_registry_public_discovery.sql"
readonly HELD_DISCOVERY_MIGRATION="$WORK_ROOT/009_registry_public_discovery.sql"
readonly FIRST_REINDEX_JSON="$WORK_ROOT/first-reindex.json"
readonly SECOND_REINDEX_JSON="$WORK_ROOT/second-reindex.json"
readonly RUNTIME_REINDEX_ERROR="$WORK_ROOT/runtime-reindex.error"

log "staging a real 008-to-009 source upgrade on loopback port $SOURCE_PORT"
mv -- "$DISCOVERY_MIGRATION" "$HELD_DISCOVERY_MIGRATION"
source_compose up -d --wait --wait-timeout 180 postgres
source_compose build migrate
# The old 008-era schema cannot receive grants for objects introduced by 009.
# Reconcile the current runtime ACL only after the current migration is present.
source_compose run --rm migrate sh -ec '
  unset PITLORE_REGISTRY_RUNTIME_ROLE
  exec node dist/cli.js registry migrate
'
assert_equal \
  "$(source_sql "SELECT count(*) FROM registry_schema_migrations;")" \
  "8" \
  "pre-discovery migration ledger"
assert_equal \
  "$(source_sql "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'registry_release_discovery';")" \
  "0" \
  "pre-discovery schema"

# Seed one release exactly as an older Registry writer could have left it. The
# artifact is real and immutable; only the post-009 discovery projection is
# intentionally absent.
# The dollar expressions below are node-postgres parameter placeholders.
# shellcheck disable=SC2016
source_compose run --rm --no-deps migrate \
  node --input-type=module -e '
    import { createRegistryPackArtifact } from "./dist/registry-artifact.js";
    import { createRegistryPostgresPoolFromEnvironment } from "./dist/registry-runtime.js";
    const pool = createRegistryPostgresPoolFromEnvironment(process.env);
    const artifact = createRegistryPackArtifact("./packs/node-reliability");
    const createdAt = "2026-07-27T00:00:00.000Z";
    try {
      await pool.query("BEGIN");
      await pool.query(
        "INSERT INTO registry_users (id, issuer, subject, display_name, status, created_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)",
        ["legacy-reindex-owner", "legacy-smoke", "legacy-owner", "Legacy Reindex Owner", "active", createdAt],
      );
      await pool.query(
        "INSERT INTO registry_organizations (id, slug, name, owner_user_id, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
        ["legacy-reindex-org", "legacy-reindex", "Legacy Reindex", "legacy-reindex-owner", createdAt],
      );
      await pool.query(
        "INSERT INTO registry_memberships (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4::timestamptz)",
        ["legacy-reindex-org", "legacy-reindex-owner", "owner", createdAt],
      );
      await pool.query(
        "INSERT INTO registry_packages (id, org_id, name, visibility, description, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)",
        ["legacy-reindex-package", "legacy-reindex-org", artifact.name, "public", "Legacy release awaiting verified discovery", "legacy-reindex-owner", createdAt],
      );
      await pool.query(
        "INSERT INTO registry_releases (id, package_id, version, status, artifact_integrity, artifact, manifest, provenance, submitted_by, created_at, published_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::timestamptz, $10::timestamptz)",
        [
          "legacy-reindex-release",
          "legacy-reindex-package",
          artifact.version,
          "published",
          artifact.integrity,
          JSON.stringify(artifact),
          JSON.stringify({ name: artifact.name, version: artifact.version }),
          JSON.stringify({ kind: "self-host-upgrade-smoke" }),
          "legacy-reindex-owner",
          createdAt,
        ],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    } finally {
      await pool.end();
    }
  '

mv -- "$HELD_DISCOVERY_MIGRATION" "$DISCOVERY_MIGRATION"
source_compose build migrate registry
source_compose run --rm migrate
assert_equal \
  "$(source_sql "SELECT p.discovery_release_id, count(d.release_id) FROM registry_packages AS p LEFT JOIN registry_release_discovery AS d ON d.release_id = p.discovery_release_id AND d.package_id = p.id WHERE p.id = 'legacy-reindex-package' GROUP BY p.discovery_release_id;")" \
  "legacy-reindex-release|0" \
  "post-009 pre-reindex unavailable discovery"

source_compose run --rm --no-deps migrate \
  node dist/cli.js registry reindex-discovery \
    --use-split-migration-owner-env \
    --max-releases 1 \
  > "$FIRST_REINDEX_JSON"
node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.indexed !== 1 || result.complete !== true) process.exit(1);
' "$FIRST_REINDEX_JSON"
assert_equal \
  "$(source_sql "SELECT p.discovery_release_id, d.lesson_count, count(f.release_id) FROM registry_packages AS p JOIN registry_release_discovery AS d ON d.release_id = p.discovery_release_id AND d.package_id = p.id LEFT JOIN registry_release_discovery_facets AS f ON f.release_id = d.release_id AND f.package_id = d.package_id WHERE p.id = 'legacy-reindex-package' GROUP BY p.discovery_release_id, d.lesson_count;")" \
  "legacy-reindex-release|3|11" \
  "reindexed artifact-derived discovery"

source_compose run --rm --no-deps migrate \
  node dist/cli.js registry reindex-discovery \
    --use-split-migration-owner-env \
    --max-releases 1 \
  > "$SECOND_REINDEX_JSON"
node -e '
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.indexed !== 0 || result.complete !== true) process.exit(1);
' "$SECOND_REINDEX_JSON"

if source_compose run --rm --no-deps registry \
  node dist/cli.js registry reindex-discovery \
    --use-split-migration-owner-env \
    --max-releases 1 \
  > /dev/null 2> "$RUNTIME_REINDEX_ERROR"
then
  die "runtime credentials unexpectedly executed discovery reindex"
fi
grep -Fq "migration-owner" "$RUNTIME_REINDEX_ERROR" || \
  die "runtime discovery reindex rejection did not identify the owner boundary"

source_compose up -d --wait --wait-timeout 180
wait_for_status "http://127.0.0.1:$SOURCE_PORT/healthz" "ok"
wait_for_status "http://127.0.0.1:$SOURCE_PORT/readyz" "ready"
assert_container_contract source
assert_database_contract source

readonly BOOTSTRAP_JSON="$WORK_ROOT/bootstrap.json"
readonly TOKEN_JSON="$WORK_ROOT/bootstrap-token.json"
readonly AUTH_CONFIG="$WORK_ROOT/auth.curl"
readonly ME_JSON="$WORK_ROOT/me.json"
readonly PACKAGE_JSON="$WORK_ROOT/package.json"
readonly PUBLIC_DISCOVERY_JSON="$WORK_ROOT/public-discovery.json"
readonly PUBLIC_LEGACY_JSON="$WORK_ROOT/public-legacy.json"
readonly BACKUP_DUMP="$WORK_ROOT/pitlore-registry.dump"
readonly SOURCE_DATA="$WORK_ROOT/source-data.sql"
readonly RESTORE_DATA="$WORK_ROOT/restore-data.sql"

log "bootstrapping one owner and one short-lived service token"
source_compose run --rm migrate \
  node dist/cli.js registry bootstrap \
    --provider smoke-oidc \
    --issuer https://identity.smoke.invalid/ \
    --subject self-host-smoke-owner \
    --display-name "Self-host Smoke Owner" \
    --org-slug self-host-smoke \
    --org-name "Self-host Smoke" \
  > "$BOOTSTRAP_JSON"

ORG_ID="$(node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof parsed.organizationId !== "string" || parsed.organizationId.length === 0) process.exit(1);
  process.stdout.write(parsed.organizationId);
' "$BOOTSTRAP_JSON")"
readonly ORG_ID
source_compose run --rm migrate \
  node dist/cli.js registry bootstrap-token \
    --provider smoke-oidc \
    --issuer https://identity.smoke.invalid/ \
    --subject self-host-smoke-owner \
    --org-slug self-host-smoke \
    --scope pack:read \
    --scope pack:publish \
    --expires-at "$TOKEN_EXPIRY" \
  > "$TOKEN_JSON"

SERVICE_TOKEN="$(node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof parsed.token !== "string" || !parsed.token.startsWith("pit_")) process.exit(1);
  process.stdout.write(parsed.token);
' "$TOKEN_JSON")"
printf 'header = "Authorization: Bearer %s"\n' "$SERVICE_TOKEN" > "$AUTH_CONFIG"
chmod 600 "$AUTH_CONFIG"
unset SERVICE_TOKEN

curl --config "$AUTH_CONFIG" --fail --silent --show-error \
  "http://127.0.0.1:$SOURCE_PORT/v1/me?org_id=$ORG_ID" > "$ME_JSON"
node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const actor = parsed?.data;
  if (actor?.kind !== "service" || actor?.tenant_id !== process.argv[2] ||
      !Array.isArray(actor?.scopes) || !actor.scopes.includes("pack:read")) {
    process.exit(1);
  }
' "$ME_JSON" "$ORG_ID"

PACKAGE_STATUS="$(curl --config "$AUTH_CONFIG" --silent --show-error \
  --output "$PACKAGE_JSON" --write-out '%{http_code}' \
  --header 'content-type: application/json' \
  --request POST \
  --data '{"name":"self-host-smoke/backup-pack","visibility":"public"}' \
  "http://127.0.0.1:$SOURCE_PORT/v1/orgs/$ORG_ID/packages")"
assert_equal "$PACKAGE_STATUS" "201" "service-token package creation status"

# Seed reviewers through the owner connection, then exercise the real
# repository flow as the runtime role. This proves approval-integrity triggers
# preserve normal pending/publish/reject/yank behavior.
source_sql "
  INSERT INTO registry_users
    (id, issuer, subject, display_name, status, created_at)
  VALUES
    ('10000000-0000-4000-8000-000000000001', 'smoke-fixture', 'reviewer-a', 'Smoke Reviewer A',
     'active', now()),
    ('10000000-0000-4000-8000-000000000002', 'smoke-fixture', 'reviewer-b', 'Smoke Reviewer B',
     'active', now()),
    ('10000000-0000-4000-8000-000000000003', 'smoke-fixture', 'viewer', 'Smoke Viewer', 'active', now()),
    ('10000000-0000-4000-8000-000000000004', 'smoke-fixture', 'inactive-admin',
     'Smoke Inactive Admin', 'suspended', now()),
    ('10000000-0000-4000-8000-000000000005', 'smoke-fixture', 'reviewer-c', 'Smoke Reviewer C',
     'active', now());

  INSERT INTO registry_memberships (org_id, user_id, role, created_at)
  VALUES
    ('$ORG_ID', '10000000-0000-4000-8000-000000000001', 'admin', now()),
    ('$ORG_ID', '10000000-0000-4000-8000-000000000002', 'admin', now()),
    ('$ORG_ID', '10000000-0000-4000-8000-000000000003', 'viewer', now()),
    ('$ORG_ID', '10000000-0000-4000-8000-000000000004', 'admin', now()),
    ('$ORG_ID', '10000000-0000-4000-8000-000000000005', 'admin', now());
"

# The dollar expressions below belong to the embedded JavaScript template literals.
# shellcheck disable=SC2016
source_compose exec -T \
  -e SMOKE_ORG_ID="$ORG_ID" \
  registry node --input-type=module -e '
    import fs from "node:fs";
    import { Pool } from "pg";
    import { comparePublicReleaseVersions } from "./dist/registry-domain.js";
    import { PostgresRegistryRepository } from "./dist/registry-postgres.js";
    import { emptyPublicPackDiscoveryDocument } from "./dist/registry-search.js";
    const pool = new Pool({
      host: process.env.PITLORE_REGISTRY_DATABASE_HOST,
      port: Number(process.env.PITLORE_REGISTRY_DATABASE_PORT),
      database: process.env.PITLORE_REGISTRY_DATABASE_NAME,
      user: process.env.PITLORE_REGISTRY_DATABASE_USER,
      password: fs.readFileSync(
        process.env.PITLORE_REGISTRY_DATABASE_PASSWORD_FILE,
        "utf8",
      ),
    });
    const repository = new PostgresRegistryRepository(pool);
    const orgId = process.env.SMOKE_ORG_ID;
    const packageName = "self-host-smoke/backup-pack";
    try {
      const ownerResult = await pool.query(
        "SELECT owner_user_id FROM registry_organizations WHERE id = $1",
        [orgId],
      );
      const submittedBy = ownerResult.rows[0]?.owner_user_id;
      if (typeof submittedBy !== "string") throw new Error("smoke owner missing");
      const startedAt = new Date();
      const at = (offset) => new Date(startedAt.getTime() + offset).toISOString();
      const create = (
        tx,
        id,
        version,
        offset,
        targetPackageName = packageName,
        discovery = emptyPublicPackDiscoveryDocument(),
      ) => tx.createRelease({
        id,
        org_id: orgId,
        package_name: targetPackageName,
        version,
        artifact_integrity: "sha256:rls-public-release-probe",
        artifact: {},
        manifest: {},
        provenance: {},
        discovery,
        submitted_by: submittedBy,
        created_at: at(offset),
      });
      const approve = (
        tx,
        id,
        version,
        reviewer,
        offset,
        targetPackageName = packageName,
      ) => tx.approveRelease({
        org_id: orgId,
        package_name: targetPackageName,
        version,
        reviewer_user_id: reviewer,
        request_id: `smoke-approve-${id}`,
        approved_at: at(offset),
        approval_id: id,
      });
      await repository.tenantTransaction(orgId, async (tx) => {
        const privatePackageName = "self-host-smoke/private-discovery";
        await tx.createPackage({
          id: "private-discovery-package",
          org_id: orgId,
          name: privatePackageName,
          visibility: "private",
          description: "private fixture",
          created_by: submittedBy,
          created_at: at(-1_000),
        });
        await create(
          tx,
          "private-discovery-published",
          "1.0.0",
          -500,
          privatePackageName,
          {
            version: 1,
            description: "private discovery must remain tenant-only",
            languages: ["secretlang"],
            ecosystems: ["secret-runtime"],
            tags: ["private-only"],
            lesson_count: 1,
          },
        );
        await approve(
          tx,
          "approval-private-discovery-a",
          "1.0.0",
          "10000000-0000-4000-8000-000000000001",
          -400,
          privatePackageName,
        );
        await approve(
          tx,
          "approval-private-discovery-b",
          "1.0.0",
          "10000000-0000-4000-8000-000000000002",
          -300,
          privatePackageName,
        );

        await create(tx, "rls-public-pending", "0.0.1-pending", 0, packageName, {
          version: 1,
          description: "pending discovery must remain tenant-only",
          languages: ["pendinglang"],
          ecosystems: ["pending-runtime"],
          tags: ["pending-only"],
          lesson_count: 1,
        });
        await approve(
          tx,
          "approval-rls-public-pending",
          "0.0.1-pending",
          "10000000-0000-4000-8000-000000000001",
          1_000,
        );

        await create(
          tx,
          "rls-public-published",
          "0.0.2-published",
          2_000,
          packageName,
          {
            version: 1,
            description: "Published discovery from a verified artifact",
            languages: ["typescript"],
            ecosystems: ["node"],
            tags: ["reliability", "security"],
            lesson_count: 2,
          },
        );
        await approve(
          tx,
          "approval-rls-public-published-a",
          "0.0.2-published",
          "10000000-0000-4000-8000-000000000001",
          3_000,
        );
        await approve(
          tx,
          "approval-rls-public-published-b",
          "0.0.2-published",
          "10000000-0000-4000-8000-000000000002",
          4_000,
        );

        await create(
          tx,
          "rls-public-rejected",
          "0.0.3-rejected",
          5_000,
          packageName,
          {
            version: 1,
            description: "rejected discovery must remain tenant-only",
            languages: ["rejectedlang"],
            ecosystems: ["rejected-runtime"],
            tags: ["rejected-only"],
            lesson_count: 1,
          },
        );
        await tx.rejectRelease({
          org_id: orgId,
          package_name: packageName,
          version: "0.0.3-rejected",
          reviewer_user_id: "10000000-0000-4000-8000-000000000001",
          reason: "RLS probe rejection",
          request_id: "smoke-reject",
          rejected_at: at(6_000),
          approval_id: "approval-rls-public-rejected",
        });

        await create(
          tx,
          "rls-public-yanked",
          "0.0.4-yanked",
          7_000,
          packageName,
          {
            version: 1,
            description: "yanked discovery remains revocation-visible only",
            languages: ["yankedlang"],
            ecosystems: ["yanked-runtime"],
            tags: ["yanked-only"],
            lesson_count: 1,
          },
        );
        await approve(
          tx,
          "approval-rls-public-yanked-a",
          "0.0.4-yanked",
          "10000000-0000-4000-8000-000000000001",
          8_000,
        );
        await approve(
          tx,
          "approval-rls-public-yanked-b",
          "0.0.4-yanked",
          "10000000-0000-4000-8000-000000000002",
          9_000,
        );
        await tx.yankRelease({
          org_id: orgId,
          package_name: packageName,
          version: "0.0.4-yanked",
          reviewer_user_id: "10000000-0000-4000-8000-000000000001",
          reason: "RLS probe yank",
          request_id: "smoke-yank",
          yanked_at: at(10_000),
        });

        await create(tx, "integrity-no-approval", "0.0.5-no-approval", 11_000);

        const boundaryVersions = [
          "9007199254740991.0.0",
          "2.0.0",
          "1.0.0+build.2",
          "1.0.0+build.10",
          "1.0.0",
          "1.0.0-rc.10",
          "1.0.0-rc.2",
          "1.0.0-alpha.1",
          "1.0.0-alpha",
          "1.0.0-1000000000000000000000000000000",
          "1.0.0-999999999999999999999999999999",
          "1.0.0-2",
          "1.0.0-1",
        ];
        for (const [index, version] of boundaryVersions.entries()) {
          await create(
            tx,
            `semver-boundary-${String(index).padStart(2, "0")}`,
            version,
            12_000 + index,
          );
        }

        const expected = (await tx.listReleases(orgId, packageName))
          .map((release) => release.version)
          .sort(comparePublicReleaseVersions);
        const seen = [];
        let after;
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          const page = await tx.listReleasePage(orgId, {
            packageName,
            ...(after === undefined ? {} : { after }),
            limit: 4,
          });
          const items = page.slice(0, 3);
          seen.push(...items.map((release) => release.version));
          if (page.length <= 3) break;
          const last = items.at(-1);
          if (!last) throw new Error("SemVer keyset page made no progress");
          after = { packageName, version: last.version };
        }
        if (JSON.stringify(seen) !== JSON.stringify(expected)) {
          throw new Error(
            `SemVer keyset pagination drifted: ${JSON.stringify({ expected, seen })}`,
          );
        }
      });
    } finally {
      await pool.end();
    }
  '

DISCOVERY_PROJECTION="$(source_sql "SELECT p.discovery_release_id, r.version, d.lesson_count FROM registry_packages AS p JOIN registry_releases AS r ON r.id = p.discovery_release_id AND r.package_id = p.id JOIN registry_release_discovery AS d ON d.release_id = r.id AND d.package_id = p.id WHERE p.name = 'self-host-smoke/backup-pack';")"
assert_equal "$DISCOVERY_PROJECTION" "rls-public-published|0.0.2-published|2" "highest published discovery projection with yank fallback"

curl --fail --silent --show-error --get \
  --data-urlencode 'query=self-host-smoke/backup-pack' \
  --data-urlencode 'include=facets' \
  "http://127.0.0.1:$SOURCE_PORT/v1/public/packages" > "$PUBLIC_DISCOVERY_JSON"
node -e '
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const page = body?.data;
  const item = page?.packages?.[0];
  const exact = (value, keys) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  if (!exact(page, ["packages", "next_cursor"]) || page.packages.length !== 1 || page.next_cursor !== null ||
      !exact(item, ["name", "visibility", "created_at", "latest_version", "discovery_available", "description", "lesson_count", "facets"]) ||
      item.name !== "self-host-smoke/backup-pack" || item.latest_version !== "0.0.2-published" ||
      item.discovery_available !== true ||
      item.description !== "Published discovery from a verified artifact" ||
      item.lesson_count !== 2 ||
      JSON.stringify(item.facets) !== JSON.stringify({
        languages: ["typescript"],
        ecosystems: ["node"],
        tags: ["reliability", "security"],
      })) {
    process.exit(1);
  }
' "$PUBLIC_DISCOVERY_JSON"

curl --fail --silent --show-error --get \
  --data-urlencode 'query=self-host-smoke/backup-pack' \
  "http://127.0.0.1:$SOURCE_PORT/v1/public/packages" > "$PUBLIC_LEGACY_JSON"
node -e '
  const fs = require("node:fs");
  const item = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.data?.packages?.[0];
  if (!item || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["created_at", "name", "visibility"])) {
    process.exit(1);
  }
' "$PUBLIC_LEGACY_JSON"

curl --fail --silent --show-error --get \
  --data-urlencode 'query=self-host-smoke/backup-pack' \
  --data-urlencode 'language=absentlang' \
  --data-urlencode 'language=typescript' \
  --data-urlencode 'ecosystem=node' \
  --data-urlencode 'tag=security' \
  --data-urlencode 'include=facets' \
  "http://127.0.0.1:$SOURCE_PORT/v1/public/packages" > "$PUBLIC_DISCOVERY_JSON"
node -e '
  const fs = require("node:fs");
  const page = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.data;
  if (!page || page.next_cursor !== null || page.packages?.length !== 1 ||
      page.packages[0]?.name !== "self-host-smoke/backup-pack") {
    process.exit(1);
  }
' "$PUBLIC_DISCOVERY_JSON"

curl --fail --silent --show-error --get \
  --data-urlencode 'language=secretlang' \
  --data-urlencode 'include=facets' \
  "http://127.0.0.1:$SOURCE_PORT/v1/public/packages" > "$PUBLIC_DISCOVERY_JSON"
node -e '
  const fs = require("node:fs");
  const page = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.data;
  if (!page || page.next_cursor !== null || !Array.isArray(page.packages) || page.packages.length !== 0) {
    process.exit(1);
  }
' "$PUBLIC_DISCOVERY_JSON"

curl --fail --silent --show-error --get \
  --data-urlencode 'language=yankedlang' \
  --data-urlencode 'include=facets' \
  "http://127.0.0.1:$SOURCE_PORT/v1/public/packages" > "$PUBLIC_DISCOVERY_JSON"
node -e '
  const fs = require("node:fs");
  const page = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.data;
  if (!page || page.next_cursor !== null || !Array.isArray(page.packages) || page.packages.length !== 0) {
    process.exit(1);
  }
' "$PUBLIC_DISCOVERY_JSON"

source_sql "

  INSERT INTO registry_audit_events
    (event_id, request_id, org_id, actor_id, actor_kind, action, target_type,
     target_id, metadata, occurred_at)
  VALUES
    ('00000000-0000-4000-8000-000000000007', 'append-only-probe', '$ORG_ID', NULL, 'system',
     'organization.created', 'organization', '$ORG_ID', '{\"fixture\":true}'::jsonb,
     now());
"

log "probing calendar-date quota idempotency in a non-UTC Node process"
source_compose exec -T \
  -e TZ=Asia/Shanghai \
  -e SMOKE_ORG_ID="$ORG_ID" \
  registry node --input-type=module -e '
    import fs from "node:fs";
    import { Pool } from "pg";
    import { PostgresRegistryEntitlementService } from "./dist/registry-postgres-telemetry.js";
    const pool = new Pool({
      host: process.env.PITLORE_REGISTRY_DATABASE_HOST,
      port: Number(process.env.PITLORE_REGISTRY_DATABASE_PORT),
      database: process.env.PITLORE_REGISTRY_DATABASE_NAME,
      user: process.env.PITLORE_REGISTRY_DATABASE_USER,
      password: fs.readFileSync(
        process.env.PITLORE_REGISTRY_DATABASE_PASSWORD_FILE,
        "utf8",
      ),
    });
    try {
      const entitlements = new PostgresRegistryEntitlementService(pool, "off");
      const input = {
        idempotencyKey: "self-host-non-utc-quota",
        occurredAt: new Date().toISOString(),
      };
      const first = await entitlements.consume(process.env.SMOKE_ORG_ID, 1, input);
      const duplicate = await entitlements.consume(process.env.SMOKE_ORG_ID, 1, input);
      if (first.used !== 1 || first.duplicate || duplicate.used !== 1 || !duplicate.duplicate) {
        process.exitCode = 1;
      }
    } finally {
      await pool.end();
    }
  '

SOURCE_COUNTS="$(source_sql "SELECT (SELECT count(*) FROM registry_organizations), (SELECT count(*) FROM registry_memberships), (SELECT count(*) FROM registry_api_tokens), (SELECT count(*) FROM registry_packages), (SELECT count(*) FROM registry_release_discovery), (SELECT count(*) FROM registry_release_discovery_facets), (SELECT count(*) FROM registry_audit_events);")"
[[ "$SOURCE_COUNTS" =~ ^[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*\|[1-9][0-9]*$ ]] || \
  die "source database is not meaningfully populated: $SOURCE_COUNTS"
TOKEN_STORAGE="$(source_sql "SELECT count(*), count(*) FILTER (WHERE length(token_hash) = 64) FROM registry_api_tokens;")"
assert_equal "$TOKEN_STORAGE" "1|1" "hashed service-token persistence"

log "probing row-level security as the non-owner runtime role"
runtime_source_sql() {
  # The dollar expansion intentionally belongs to the nested container shell.
  # shellcheck disable=SC2016
  source_compose exec -T postgres sh -ec '
    PGPASSWORD="$(cat /run/secrets/postgres_runtime_password)"
    export PGPASSWORD
    exec psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
      --host 127.0.0.1 --username pitlore_runtime --dbname pitlore \
      --tuples-only --no-align --command "$1"
  ' sh "$1"
}

assert_runtime_source_sql_fails() {
  local sql=$1
  local label=$2
  if runtime_source_sql "$sql" >/dev/null 2>&1; then
    die "runtime unexpectedly allowed $label"
  fi
}

assert_runtime_source_sql_guard_rejects() {
  local sql=$1
  local expected=$2
  local label=$3
  local output
  if output="$(runtime_source_sql "$sql" 2>&1)"; then
    die "runtime unexpectedly allowed $label"
  fi
  [[ "$output" == *"$expected"* ]] || \
    die "$label failed outside the expected database guard: $output"
}

assert_owner_source_sql_fails() {
  local sql=$1
  local label=$2
  if source_sql "$sql" >/dev/null 2>&1; then
    die "database guard unexpectedly allowed $label"
  fi
}

assert_owner_source_sql_guard_rejects() {
  local sql=$1
  local expected=$2
  local label=$3
  local output
  if output="$(source_sql "$sql" 2>&1)"; then
    die "database guard unexpectedly allowed $label"
  fi
  [[ "$output" == *"$expected"* ]] || \
    die "$label failed outside the expected database guard: $output"
}

RLS_NO_CONTEXT="$(runtime_source_sql "SELECT count(*) FROM registry_memberships;")"
assert_equal "$RLS_NO_CONTEXT" "0" "RLS hides memberships without tenant context"
RLS_WRONG_TENANT="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', 'org-that-does-not-exist', false); SELECT count(*) FROM registry_memberships;" | tail -1)"
assert_equal "$RLS_WRONG_TENANT" "0" "RLS hides memberships under a foreign tenant"
RLS_RIGHT_TENANT="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', '$ORG_ID', false); SELECT count(*) >= 1 FROM registry_memberships WHERE org_id = '$ORG_ID';" | tail -1)"
assert_equal "$RLS_RIGHT_TENANT" "t" "RLS reveals memberships under the owning tenant"
RLS_PACKAGES="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', '$ORG_ID', false); SELECT count(*) >= 1 FROM registry_packages WHERE org_id = '$ORG_ID';" | tail -1)"
assert_equal "$RLS_PACKAGES" "t" "RLS reveals packages under the owning tenant"
RLS_PUBLIC_RELEASES="$(runtime_source_sql "SELECT string_agg(status, ',' ORDER BY status) FROM registry_releases WHERE id LIKE 'rls-public-%';")"
assert_equal "$RLS_PUBLIC_RELEASES" "published,yanked" "RLS exposes only published/yanked public releases without tenant context"
RLS_PUBLIC_APPROVALS="$(runtime_source_sql "SELECT string_agg(DISTINCT release_id, ',' ORDER BY release_id) FROM registry_release_approvals WHERE release_id LIKE 'rls-public-%';")"
assert_equal "$RLS_PUBLIC_APPROVALS" "rls-public-published,rls-public-yanked" "RLS hides approval metadata for non-public release states"
RLS_PUBLIC_DISCOVERY="$(runtime_source_sql "SELECT string_agg(release_id, ',' ORDER BY release_id) FROM registry_release_discovery WHERE release_id LIKE 'rls-public-%';")"
assert_equal "$RLS_PUBLIC_DISCOVERY" "rls-public-published,rls-public-yanked" "RLS exposes discovery only for published/yanked public releases"
RLS_PUBLIC_DISCOVERY_FACETS="$(runtime_source_sql "SELECT string_agg(release_id || ':' || facet_count, ',' ORDER BY release_id) FROM (SELECT release_id, count(*) AS facet_count FROM registry_release_discovery_facets WHERE release_id LIKE 'rls-public-%' GROUP BY release_id) AS visible_facets;")"
assert_equal "$RLS_PUBLIC_DISCOVERY_FACETS" "rls-public-published:4,rls-public-yanked:3" "RLS exposes normalized facets only for published/yanked public releases"
RLS_PRIVATE_DISCOVERY="$(runtime_source_sql "SELECT count(*) FROM registry_release_discovery WHERE release_id = 'private-discovery-published';")"
assert_equal "$RLS_PRIVATE_DISCOVERY" "0" "RLS hides private release discovery without tenant context"
RLS_PRIVATE_DISCOVERY_FACETS="$(runtime_source_sql "SELECT count(*) FROM registry_release_discovery_facets WHERE release_id = 'private-discovery-published';")"
assert_equal "$RLS_PRIVATE_DISCOVERY_FACETS" "0" "RLS hides private release discovery facets without tenant context"
RLS_TENANT_RELEASES="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', '$ORG_ID', false); SELECT string_agg(status, ',' ORDER BY status) FROM registry_releases WHERE id LIKE 'rls-public-%';" | tail -1)"
assert_equal "$RLS_TENANT_RELEASES" "pending,published,rejected,yanked" "RLS preserves all release states for the owning tenant"
RLS_TENANT_DISCOVERY="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', '$ORG_ID', false); SELECT (SELECT count(*) FROM registry_release_discovery WHERE release_id LIKE 'rls-public-%'), (SELECT count(*) FROM registry_release_discovery WHERE release_id = 'private-discovery-published');" | tail -1)"
assert_equal "$RLS_TENANT_DISCOVERY" "4|1" "RLS preserves pending/rejected/private discovery for the owning tenant"
RLS_TENANT_DISCOVERY_FACETS="$(runtime_source_sql "SELECT set_config('pitlore.tenant_id', '$ORG_ID', false); SELECT (SELECT count(*) FROM registry_release_discovery_facets WHERE release_id LIKE 'rls-public-%'), (SELECT count(*) FROM registry_release_discovery_facets WHERE release_id = 'private-discovery-published');" | tail -1)"
assert_equal "$RLS_TENANT_DISCOVERY_FACETS" "13|3" "RLS preserves pending/rejected/private discovery facets for the owning tenant"

log "probing append-only grants and database guards"
runtime_source_sql "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-positive-publish-probe', 'rls-public-pending', '10000000-0000-4000-8000-000000000002', 'approved', now()); UPDATE registry_releases SET status = 'published', published_at = now() WHERE id = 'rls-public-pending'; ROLLBACK;" >/dev/null
runtime_source_sql "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-positive-reject-probe', 'rls-public-pending', '10000000-0000-4000-8000-000000000002', 'rejected', now()); UPDATE registry_releases SET status = 'rejected', rejected_at = now(), rejection_reason = 'lifecycle permission probe' WHERE id = 'rls-public-pending'; ROLLBACK;" >/dev/null
runtime_source_sql "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_releases SET status = 'yanked', yanked_at = now(), yank_reason = 'lifecycle permission probe' WHERE id = 'rls-public-published'; ROLLBACK;" >/dev/null
runtime_source_sql "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_releases SET status = status, published_at = published_at WHERE id = 'rls-public-published'; ROLLBACK;" >/dev/null
runtime_source_sql "BEGIN;
  SELECT set_config('pitlore.tenant_id', '$ORG_ID', true);
  INSERT INTO registry_usage_events
    (event_id, org_id, kind, consent, package_name, package_version,
     lesson_id, outcome, occurred_at)
  VALUES
    ('append-only-probe-usage', '$ORG_ID', 'retrieve', 'client-opt-in',
     'self-host-smoke/backup-pack', '0.0.2-published', NULL, 'used', now());
  INSERT INTO registry_usage_reservations
    (event_id, org_id, period_start, amount, claim_id, created_at)
  VALUES
    ('append-only-probe-reservation', '$ORG_ID', date_trunc('month', now())::date,
     1, 'append-only-probe-claim', now());
  INSERT INTO registry_billing_webhook_events
    (event_id, claim_id, payload_hash, provider_created_at, applied, received_at,
     org_id, provider, event_type)
  VALUES
    ('append-only-probe-billing', 'append-only-probe-billing-claim',
     repeat('0', 64), now(), false, now(), '$ORG_ID', 'smoke',
     'subscription.updated');
  COMMIT;" >/dev/null
assert_runtime_source_sql_guard_rejects "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) SELECT 'approval-forbidden-submitter', 'rls-public-pending', owner_user_id, 'approved', now() FROM registry_organizations WHERE id = '$ORG_ID'; ROLLBACK;" "registry release submitter cannot review their own release" "a submitter approval"
assert_runtime_source_sql_guard_rejects "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-forbidden-viewer', 'rls-public-pending', '10000000-0000-4000-8000-000000000003', 'approved', now()); ROLLBACK;" "registry release reviewer must be an active admin or owner" "a viewer approval"
assert_runtime_source_sql_guard_rejects "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-forbidden-inactive', 'rls-public-pending', '10000000-0000-4000-8000-000000000004', 'approved', now()); ROLLBACK;" "registry release reviewer must be an active admin or owner" "an inactive-admin approval"
assert_runtime_source_sql_guard_rejects "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_releases SET status = 'published', published_at = now() WHERE id = 'integrity-no-approval'; ROLLBACK;" "registry release publication requires exactly two distinct approvals" "publication without approvals"
assert_runtime_source_sql_guard_rejects "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-exactly-two-b', 'rls-public-pending', '10000000-0000-4000-8000-000000000002', 'approved', now()); INSERT INTO registry_release_approvals (id, release_id, reviewer_user_id, decision, created_at) VALUES ('approval-forbidden-third', 'rls-public-pending', '10000000-0000-4000-8000-000000000005', 'approved', now()); ROLLBACK;" "registry release accepts exactly two approved decisions" "a third approved decision"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_releases SET artifact_integrity = 'sha256:forbidden-runtime-rewrite' WHERE id = 'rls-public-pending'; ROLLBACK;" "a release payload rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_releases WHERE id = 'rls-public-pending'; ROLLBACK;" "a release deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_release_approvals SET created_at = now() WHERE id = 'approval-rls-public-pending'; ROLLBACK;" "an approval rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_release_approvals WHERE id = 'approval-rls-public-pending'; ROLLBACK;" "an approval deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_release_discovery SET description = 'forbidden' WHERE release_id = 'rls-public-published'; ROLLBACK;" "a discovery rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_release_discovery WHERE release_id = 'rls-public-published'; ROLLBACK;" "a discovery deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_release_discovery_facets SET value = 'forbidden' WHERE release_id = 'rls-public-published' AND dimension = 'language'; ROLLBACK;" "a discovery-facet rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_release_discovery_facets WHERE release_id = 'rls-public-published'; ROLLBACK;" "a discovery-facet deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_audit_events SET metadata = '{\"forbidden\":true}'::jsonb WHERE event_id = '00000000-0000-4000-8000-000000000007'; ROLLBACK;" "an audit rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_audit_events WHERE event_id = '00000000-0000-4000-8000-000000000007'; ROLLBACK;" "an audit deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_usage_events SET outcome = 'ignored' WHERE event_id = 'append-only-probe-usage' AND org_id = '$ORG_ID'; ROLLBACK;" "a usage-event rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_usage_events WHERE event_id = 'append-only-probe-usage' AND org_id = '$ORG_ID'; ROLLBACK;" "a usage-event deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_usage_reservations SET amount = 2 WHERE event_id = 'append-only-probe-reservation' AND org_id = '$ORG_ID'; ROLLBACK;" "a usage-reservation rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_usage_reservations WHERE event_id = 'append-only-probe-reservation' AND org_id = '$ORG_ID'; ROLLBACK;" "a usage-reservation deletion"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); UPDATE registry_billing_webhook_events SET applied = true WHERE event_id = 'append-only-probe-billing'; ROLLBACK;" "a billing-webhook rewrite"
assert_runtime_source_sql_fails "BEGIN; SELECT set_config('pitlore.tenant_id', '$ORG_ID', true); DELETE FROM registry_billing_webhook_events WHERE event_id = 'append-only-probe-billing'; ROLLBACK;" "a billing-webhook deletion"

# Superuser probes bypass ACL and RLS, so these failures exercise the trigger
# invariant itself instead of merely proving the runtime grant boundary.
assert_owner_source_sql_fails "UPDATE registry_releases SET artifact_integrity = 'sha256:forbidden-owner-rewrite' WHERE id = 'rls-public-pending';" "a privileged release payload rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_releases WHERE id = 'rls-public-pending';" "a privileged release deletion"
assert_owner_source_sql_fails "UPDATE registry_release_approvals SET created_at = now() WHERE id = 'approval-rls-public-pending';" "a privileged approval rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_release_approvals WHERE id = 'approval-rls-public-pending';" "a privileged approval deletion"
assert_owner_source_sql_guard_rejects "UPDATE registry_release_discovery SET description = 'forbidden' WHERE release_id = 'rls-public-published';" "registry_release_discovery is append-only" "a privileged discovery rewrite"
assert_owner_source_sql_guard_rejects "DELETE FROM registry_release_discovery WHERE release_id = 'rls-public-published';" "registry_release_discovery is append-only" "a privileged discovery deletion"
assert_owner_source_sql_guard_rejects "UPDATE registry_release_discovery_facets SET value = 'forbidden' WHERE release_id = 'rls-public-published' AND dimension = 'language';" "registry_release_discovery_facets is append-only" "a privileged discovery-facet rewrite"
assert_owner_source_sql_guard_rejects "DELETE FROM registry_release_discovery_facets WHERE release_id = 'rls-public-published';" "registry_release_discovery_facets is append-only" "a privileged discovery-facet deletion"
assert_owner_source_sql_fails "UPDATE registry_audit_events SET metadata = '{\"forbidden\":true}'::jsonb WHERE event_id = '00000000-0000-4000-8000-000000000007';" "a privileged audit rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_audit_events WHERE event_id = '00000000-0000-4000-8000-000000000007';" "a privileged audit deletion"
assert_owner_source_sql_fails "UPDATE registry_usage_events SET outcome = 'ignored' WHERE event_id = 'append-only-probe-usage' AND org_id = '$ORG_ID';" "a privileged usage-event rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_usage_events WHERE event_id = 'append-only-probe-usage' AND org_id = '$ORG_ID';" "a privileged usage-event deletion"
assert_owner_source_sql_fails "UPDATE registry_usage_reservations SET amount = 2 WHERE event_id = 'append-only-probe-reservation' AND org_id = '$ORG_ID';" "a privileged usage-reservation rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_usage_reservations WHERE event_id = 'append-only-probe-reservation' AND org_id = '$ORG_ID';" "a privileged usage-reservation deletion"
assert_owner_source_sql_fails "UPDATE registry_billing_webhook_events SET applied = true WHERE event_id = 'append-only-probe-billing';" "a privileged billing-webhook rewrite"
assert_owner_source_sql_fails "DELETE FROM registry_billing_webhook_events WHERE event_id = 'append-only-probe-billing';" "a privileged billing-webhook deletion"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET status = 'pending', published_at = NULL WHERE id = 'rls-public-published';" "registry release lifecycle transition is not allowed" "a published-to-pending release transition"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET status = 'published', yanked_at = NULL, yank_reason = NULL WHERE id = 'rls-public-yanked';" "registry release lifecycle transition is not allowed" "a yanked-to-published release transition"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET status = 'pending', rejected_at = NULL, rejection_reason = NULL WHERE id = 'rls-public-rejected';" "registry release lifecycle transition is not allowed" "a rejected-to-pending release transition"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET status = 'yanked', published_at = now(), yanked_at = now(), yank_reason = 'forbidden jump' WHERE id = 'rls-public-pending';" "registry release lifecycle transition is not allowed" "a pending-to-yanked release transition"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET published_at = published_at + interval '1 second' WHERE id = 'rls-public-published';" "registry release lifecycle metadata is immutable without a state transition" "a same-state lifecycle rewrite"
assert_owner_source_sql_guard_rejects "UPDATE registry_releases SET status = 'yanked', published_at = published_at + interval '1 second', yanked_at = now(), yank_reason = 'forbidden metadata rewrite' WHERE id = 'rls-public-published';" "registry release lifecycle transition changed unrelated metadata" "an allowed transition with unrelated metadata changes"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_releases CASCADE; ROLLBACK;" "registry_releases is append-only" "a privileged release truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_release_approvals; ROLLBACK;" "registry_release_approvals is append-only" "a privileged approval truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_release_discovery; ROLLBACK;" "registry_release_discovery is append-only" "a privileged discovery truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_release_discovery_facets; ROLLBACK;" "registry_release_discovery_facets is append-only" "a privileged discovery-facet truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_audit_events; ROLLBACK;" "registry_audit_events is append-only" "a privileged audit truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_usage_events; ROLLBACK;" "registry_usage_events is append-only" "a privileged usage-event truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_usage_reservations; ROLLBACK;" "registry_usage_reservations is append-only" "a privileged usage-reservation truncate"
assert_owner_source_sql_guard_rejects "BEGIN; TRUNCATE registry_billing_webhook_events; ROLLBACK;" "registry_billing_webhook_events is append-only" "a privileged billing-webhook truncate"
assert_owner_source_sql_guard_rejects "UPDATE registry_organizations SET two_person_approval = false WHERE id = '$ORG_ID';" "registry_organizations_two_person_approval_required" "disabling mandatory two-person approval"
assert_owner_source_sql_guard_rejects "SELECT registry_semver_sort_key('1.0.0-01');" "numeric prerelease has a leading zero" "an invalid numeric prerelease"
assert_owner_source_sql_guard_rejects "SELECT registry_semver_sort_key('9007199254740992.0.0');" "exceeds Number.MAX_SAFE_INTEGER" "an unsafe SemVer core"
assert_owner_source_sql_guard_rejects "BEGIN; UPDATE registry_packages SET discovery_release_id = 'rls-public-yanked' WHERE name = 'self-host-smoke/backup-pack'; COMMIT;" "registry package discovery projection is stale" "a stale discovery projection"
assert_owner_source_sql_guard_rejects "INSERT INTO registry_release_discovery_facets (release_id, package_id, dimension, value) SELECT id, package_id, 'language', 'not-in-verified-snapshot' FROM registry_releases WHERE id = 'rls-public-published';" "registry discovery facet must match verified discovery metadata" "a discovery facet outside the verified snapshot"
assert_owner_source_sql_guard_rejects "BEGIN; INSERT INTO registry_releases (id, package_id, version, status, artifact_integrity, artifact, manifest, provenance, submitted_by, created_at) SELECT 'missing-facets-probe', id, '0.0.6-missing-facets', 'pending', 'sha256:missing-facets-probe', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, created_by, now() FROM registry_packages WHERE name = 'self-host-smoke/backup-pack'; INSERT INTO registry_release_discovery (release_id, package_id, schema_version, description, languages, ecosystems, tags, lesson_count, indexed_at) SELECT 'missing-facets-probe', id, 1, 'missing normalized facets', ARRAY['missinglang']::text[], ARRAY[]::text[], ARRAY[]::text[], 1, now() FROM registry_packages WHERE name = 'self-host-smoke/backup-pack'; COMMIT;" "registry discovery metadata requires an exact normalized facet index" "a non-empty discovery snapshot without normalized facets"
assert_owner_source_sql_guard_rejects "BEGIN; INSERT INTO registry_releases (id, package_id, version, status, artifact_integrity, artifact, manifest, provenance, submitted_by, created_at) SELECT 'missing-discovery-probe', id, '0.0.6-missing-discovery', 'pending', 'sha256:missing-discovery-probe', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, created_by, now() FROM registry_packages WHERE name = 'self-host-smoke/backup-pack'; COMMIT;" "registry release requires verified discovery metadata" "a release without verified discovery"
APPEND_ONLY_FIXTURES="$(source_sql "SELECT (SELECT status FROM registry_releases WHERE id = 'rls-public-pending'), (SELECT artifact_integrity FROM registry_releases WHERE id = 'rls-public-pending'), (SELECT count(*) FROM registry_release_approvals WHERE id = 'approval-rls-public-pending'), (SELECT count(*) FROM registry_audit_events WHERE event_id = '00000000-0000-4000-8000-000000000007'), (SELECT outcome FROM registry_usage_events WHERE event_id = 'append-only-probe-usage' AND org_id = '$ORG_ID'), (SELECT amount FROM registry_usage_reservations WHERE event_id = 'append-only-probe-reservation' AND org_id = '$ORG_ID'), (SELECT applied FROM registry_billing_webhook_events WHERE event_id = 'append-only-probe-billing'), (SELECT bool_and(two_person_approval) FROM registry_organizations);")"
assert_equal "$APPEND_ONLY_FIXTURES" "pending|sha256:rls-public-release-probe|1|1|used|1|f|t" "append-only probes preserve source evidence"
# Cross-tenant writes must fail closed: with a foreign tenant context the
# WITH CHECK policy rejects an audit insert that names the real organization.
if runtime_source_sql "BEGIN; SELECT set_config('pitlore.tenant_id', 'org-that-does-not-exist', true); INSERT INTO registry_audit_events (event_id, request_id, org_id, actor_id, actor_kind, action, target_type, target_id, metadata, occurred_at) VALUES ('rls-probe-event', 'rls-probe', '$ORG_ID', NULL, 'system', 'organization.created', 'organization', '$ORG_ID', '{}'::jsonb, now()); ROLLBACK;" >/dev/null 2>&1
then
  die "RLS unexpectedly allowed a cross-tenant audit insert"
fi
RLS_ADMIN_VISIBLE="$(source_sql "SELECT count(*) >= 1 FROM registry_memberships;")"
assert_equal "$RLS_ADMIN_VISIBLE" "t" "admin baseline still sees membership rows"

log "creating a non-empty custom-format backup"
source_compose exec -T postgres \
  pg_dump --username pitlore_admin --dbname pitlore --format=custom \
  > "$BACKUP_DUMP"
[[ -s "$BACKUP_DUMP" ]] || die "custom-format backup is empty"
normalize_data_dump source "$SOURCE_DATA"
[[ -s "$SOURCE_DATA" ]] || die "normalized source data dump is empty"

log "restoring into an isolated project with new secrets on port $RESTORE_PORT"
restore_compose up -d --wait --wait-timeout 120 postgres
restore_compose exec -T postgres \
  pg_restore --username pitlore_admin --dbname pitlore --exit-on-error \
  < "$BACKUP_DUMP"
restore_compose up -d --build --wait --wait-timeout 180
wait_for_status "http://127.0.0.1:$RESTORE_PORT/readyz" "ready"
assert_container_contract restore
assert_database_contract restore

normalize_data_dump restore "$RESTORE_DATA"
cmp -s "$SOURCE_DATA" "$RESTORE_DATA" || \
  die "normalized PostgreSQL data differs after isolated restore"
RESTORE_COUNTS="$(restore_sql "SELECT (SELECT count(*) FROM registry_organizations), (SELECT count(*) FROM registry_memberships), (SELECT count(*) FROM registry_api_tokens), (SELECT count(*) FROM registry_packages), (SELECT count(*) FROM registry_release_discovery), (SELECT count(*) FROM registry_release_discovery_facets), (SELECT count(*) FROM registry_audit_events);")"
assert_equal "$RESTORE_COUNTS" "$SOURCE_COUNTS" "restored critical-table row counts"

curl --config "$AUTH_CONFIG" --fail --silent --show-error \
  "http://127.0.0.1:$RESTORE_PORT/v1/me?org_id=$ORG_ID" > "$ME_JSON"
log "restarting the restored Registry and rechecking readiness/authentication"
restore_compose restart registry >/dev/null
wait_for_status "http://127.0.0.1:$RESTORE_PORT/readyz" "ready"
curl --config "$AUTH_CONFIG" --fail --silent --show-error \
  "http://127.0.0.1:$RESTORE_PORT/v1/me?org_id=$ORG_ID" > "$ME_JSON"
# The dollar expressions below belong to the embedded JavaScript template literals.
# shellcheck disable=SC2016
restore_compose exec -T \
  -e SMOKE_ORG_ID="$ORG_ID" \
  registry node --input-type=module -e '
    import fs from "node:fs";
    import { Pool } from "pg";
    import { PostgresRegistryApplication } from "./dist/registry-postgres-application.js";
    import { PostgresRegistryRepository } from "./dist/registry-postgres.js";
    const pool = new Pool({
      host: process.env.PITLORE_REGISTRY_DATABASE_HOST,
      port: Number(process.env.PITLORE_REGISTRY_DATABASE_PORT),
      database: process.env.PITLORE_REGISTRY_DATABASE_NAME,
      user: process.env.PITLORE_REGISTRY_DATABASE_USER,
      password: fs.readFileSync(
        process.env.PITLORE_REGISTRY_DATABASE_PASSWORD_FILE,
        "utf8",
      ),
    });
    try {
      const owner = await pool.query(
        "SELECT owner_user_id FROM registry_organizations WHERE id = $1",
        [process.env.SMOKE_ORG_ID],
      );
      const ownerUserId = owner.rows[0]?.owner_user_id;
      if (typeof ownerUserId !== "string") throw new Error("restore owner missing");
      const application = new PostgresRegistryApplication(
        new PostgresRegistryRepository(pool),
      );
      const page = await application.listAuditEventPage(ownerUserId, {
        org_id: process.env.SMOKE_ORG_ID,
        limit: 100,
      });
      if (!page.items.some((event) =>
        event.id === "00000000-0000-4000-8000-000000000007" &&
        event.action === "organization.created" &&
        event.metadata.fixture === true)) {
        throw new Error("restored typed audit fixture missing");
      }
    } finally {
      await pool.end();
    }
  '

log "passed: 008-to-009 reindex, least privilege, bootstrap token, backup, exact restore, restart"
