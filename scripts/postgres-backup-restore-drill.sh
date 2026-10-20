#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <source-postgresql-url> <empty-restore-postgresql-url>" >&2
  exit 2
fi

source_url=$1
restore_url=$2

if [[ $source_url != postgres://* && $source_url != postgresql://* ]]; then
  echo "Source must be a PostgreSQL URL." >&2
  exit 2
fi

if [[ $restore_url != postgres://* && $restore_url != postgresql://* ]]; then
  echo "Restore target must be a PostgreSQL URL." >&2
  exit 2
fi

if [[ $source_url == "$restore_url" ]]; then
  echo "Source and restore target must be different databases." >&2
  exit 2
fi

# Backups must be encrypted at rest. The key is read from the environment and
# handed to openssl via `-pass env:` so it never appears in argv or logs.
backup_key=${BACKUP_ENCRYPTION_KEY:-}
if [[ ${#backup_key} -lt 32 ]]; then
  echo "BACKUP_ENCRYPTION_KEY must be set to at least 32 characters." >&2
  exit 2
fi

for command_name in pg_dump pg_restore psql openssl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 127
  fi
done

# Owner-only permissions for every file the drill creates.
umask 077
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
dump_file="$work_dir/backup.dump"
encrypted_file="$work_dir/backup.dump.enc"
restore_file="$work_dir/restore.dump"

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

require_mode() {
  local mode
  mode=$(file_mode "$1")
  if [[ $mode != "$2" ]]; then
    echo "Permission check failed: $(basename "$1") has mode $mode, expected $2." >&2
    exit 3
  fi
}

run_sql() {
  psql "$restore_url" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="$1"
}

echo "Creating custom-format PostgreSQL backup."
pg_dump --format=custom --no-owner --no-privileges --file="$dump_file" "$source_url"

echo "Encrypting backup archive."
openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$dump_file" -out "$encrypted_file"
rm -f "$dump_file"

echo "Verifying backup encryption and file permissions."
require_mode "$work_dir" 700
require_mode "$encrypted_file" 600
if [[ $(head -c 8 "$encrypted_file") != "Salted__" ]] || grep -q "PGDMP" "$encrypted_file"; then
  echo "Encryption check failed: backup archive is not encrypted." >&2
  exit 3
fi

echo "Decrypting backup archive for restore."
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$encrypted_file" -out "$restore_file"
require_mode "$restore_file" 600

echo "Validating backup archive."
pg_restore --list "$restore_file" >/dev/null

echo "Restoring backup into the isolated target database."
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$restore_url" "$restore_file"

echo "Checking restored database connectivity."
run_sql 'SELECT 1'

echo "Verifying restored object ownership and privileges."
foreign_owned=$(run_sql \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)")
public_grants=$(run_sql \
  "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema NOT IN ('pg_catalog', 'information_schema')")
if [[ ${foreign_owned//[[:space:]]/} != "0" ]]; then
  echo "Restore permission check failed: ${foreign_owned//[[:space:]]/} restored relations are owned by another role." >&2
  exit 3
fi
if [[ ${public_grants//[[:space:]]/} != "0" ]]; then
  echo "Restore permission check failed: ${public_grants//[[:space:]]/} table privileges granted to PUBLIC." >&2
  exit 3
fi

echo "PostgreSQL backup-restore drill passed."
