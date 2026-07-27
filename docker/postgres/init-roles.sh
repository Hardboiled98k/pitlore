#!/bin/sh
set -eu

read_secret() {
  file="$1"
  label="$2"
  if [ ! -f "$file" ]; then
    echo "missing $label secret file" >&2
    exit 1
  fi
  if [ ! -r "$file" ]; then
    echo "$label secret file is not readable by the PostgreSQL process" >&2
    exit 1
  fi
  {
    value=""
    if IFS= read -r value; then
      :
    elif [ -z "$value" ]; then
      echo "$label secret must not be empty" >&2
      exit 1
    fi
    remainder=""
    if IFS= read -r remainder || [ -n "$remainder" ]; then
      echo "$label secret must contain exactly one line" >&2
      exit 1
    fi
  } < "$file"
  value="${value%"$(printf '\r')"}"
  length="${#value}"
  case "$value" in
    *[!A-Za-z0-9_-]*) valid=false ;;
    *) valid=true ;;
  esac
  if [ "$valid" != true ] || [ "$length" -lt 32 ] || [ "$length" -gt 256 ]; then
    echo "$label secret must contain 32-256 base64url-safe characters" >&2
    exit 1
  fi
  printf '%s' "$value"
}

MIGRATOR_PASSWORD="$(read_secret /run/secrets/postgres_migrator_password migrator)"
RUNTIME_PASSWORD="$(read_secret /run/secrets/postgres_runtime_password runtime)"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
SELECT format(
  'CREATE ROLE pitlore_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  '$MIGRATOR_PASSWORD'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pitlore_migrator') \gexec
ALTER ROLE pitlore_migrator PASSWORD '$MIGRATOR_PASSWORD';

SELECT format(
  'CREATE ROLE pitlore_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  '$RUNTIME_PASSWORD'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pitlore_runtime') \gexec
ALTER ROLE pitlore_runtime PASSWORD '$RUNTIME_PASSWORD';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE pitlore TO pitlore_migrator, pitlore_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO pitlore_migrator;
GRANT USAGE ON SCHEMA public TO pitlore_runtime;

-- Runtime object grants are reconciled from the application's explicit
-- allow-list after every migration. New tables and sequences intentionally
-- receive no runtime privileges until that allow-list changes.
ALTER DEFAULT PRIVILEGES FOR ROLE pitlore_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM pitlore_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pitlore_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM pitlore_runtime;
SQL
