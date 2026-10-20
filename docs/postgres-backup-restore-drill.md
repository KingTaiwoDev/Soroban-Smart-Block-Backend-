# PostgreSQL Backup-Restore Release Drill

The release workflow runs a PostgreSQL custom-format backup and restores it into
an isolated, disposable PostgreSQL 16/pgvector service before a production
release. The restore target is not the source database. The job fails closed
when the backup, encryption, permission, archive validation, restore, or
restored-database checks fail, and its temporary files are removed when the job
exits.

## Encryption and permission checks

The drill verifies the same controls production backups must meet:

| Check | Failure |
| --- | --- |
| `BACKUP_ENCRYPTION_KEY` is set and at least 32 characters | exit 2 before any database command runs |
| The plaintext dump is encrypted (AES-256-CBC, PBKDF2, salted) and deleted; the encrypted archive starts with the OpenSSL `Salted__` header and contains no `PGDMP` plaintext magic | exit 3, no restore attempted |
| The work directory is mode `700` and the encrypted and decrypted archives are mode `600` (`umask 077`) | exit 3 |
| Restore uses the decrypted copy with `--no-owner --no-privileges` | — |
| No restored relation is owned by a role other than the restoring role | exit 3 |
| No restored table grants privileges to `PUBLIC` | exit 3 |

The key is passed to `openssl` with `-pass env:` so it never appears in process
arguments or logs.

This logical backup/restore check does not demonstrate point-in-time recovery
or satisfy the service RPO by itself. See the
[disaster recovery objectives and exercise](disaster-recovery.md) for RPO/RTO
targets and the separate PITR validation procedure.

## GitHub configuration

Configure a `DATABASE_URL` secret on the `staging` GitHub Environment. It must
allow the GitHub-hosted runner to connect to the staging PostgreSQL database
with read access to the objects included in `pg_dump`. The release drill is
gated by that environment and blocks production promotion if the secret is
missing or the database is unreachable. Do not use a production database URL
for this drill. No backup artifact is uploaded or retained by the workflow.

Optionally configure a `BACKUP_ENCRYPTION_KEY` secret (32+ characters) on the
same environment to exercise the production backup key. When it is absent the
workflow generates a masked per-run key, which still proves the
encrypt/decrypt/restore path because the drill archive is never retained.

The isolated restore target uses `pgvector/pgvector:pg16`, matching the
PostgreSQL major version and extension used by CI. The drill does not alter
Stellar network/indexer configuration or write to the source database.

## Run locally

Install PostgreSQL client tools (`pg_dump`, `pg_restore`, and `psql`) and
`openssl`, and use
an empty, disposable target database on a compatible PostgreSQL major version:

```sh
export BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)"
bash scripts/postgres-backup-restore-drill.sh \
  "$STAGING_DATABASE_URL" \
  "$DISPOSABLE_RESTORE_DATABASE_URL"
```

The script accepts PostgreSQL URLs only and refuses an identical source and
target URL. Keep credentials in environment variables or a secret manager; do
not put them in shell history or logs. The restore target must be isolated and
empty because the procedure intentionally does not drop or clean existing
objects.

## Failure handling

A failed release drill stops promotion. Check the GitHub Actions step output
for the failing PostgreSQL client command without copying database credentials
into logs. Resolve connectivity, permissions, extension/version compatibility,
encryption, or restore errors, then rerun the release workflow. Because the
restore runs with `--no-owner --no-privileges`, an ownership or `PUBLIC` grant
failure points at the restore target (default privileges, event triggers or a
non-empty database) leaking access; fix the target rather than relaxing the
check. Never bypass the restore
failure by restoring into the source database.
