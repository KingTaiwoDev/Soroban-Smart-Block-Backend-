import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const scriptPath = path.resolve(__dirname, '../../scripts/postgres-backup-restore-drill.sh');
const temporaryDirectories: string[] = [];
const encryptionKey = 'drill-test-key-0123456789abcdef0123456789';

function createCommandBin(failCommand?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'postgres-drill-test-'));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, 'commands.log');

  for (const command of ['pg_dump', 'pg_restore', 'psql']) {
    const log = `printf '%s\\n' "$*" >> "$MOCK_LOG"`;
    const source =
      command === 'pg_dump'
        ? `${log}\nfor arg in "$@"; do case "$arg" in --file=*) printf 'PGDMP-fake-archive' > "\${arg#--file=}" ;; esac; done`
        : command === 'psql'
          ? `${log}\ncase "$*" in *count*) echo "\${MOCK_PSQL_COUNT:-0}" ;; *) echo 1 ;; esac`
          : `${log}\nfor arg in "$@"; do case "$arg" in --dbname=*|--list) ;; *) [ -f "$arg" ] && head -c 5 "$arg" >> "$MOCK_LOG.restored" ;; esac; done`;
    const failure =
      command === 'pg_restore'
        ? `if [ "\${FAIL_COMMAND:-}" = "pg_restore" ] && [ "$1" != "--list" ]; then exit 17; fi`
        : `if [ "\${FAIL_COMMAND:-}" = "${command}" ]; then exit 17; fi`;
    writeFileSync(
      path.join(directory, command),
      `#!/bin/sh\n${source}\n${failure}\n`,
    );
    chmodSync(path.join(directory, command), 0o755);
  }

  return { directory, logPath };
}

function runDrill(
  directory: string,
  logPath: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
) {
  return spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      MOCK_LOG: logPath,
      BACKUP_ENCRYPTION_KEY: encryptionKey,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PostgreSQL backup-restore drill', () => {
  const sourceUrl = 'postgresql://source-user:source-password@db.example/source';
  const restoreUrl = 'postgresql://restore-user:restore-password@localhost/drill';

  it('backs up, restores, checks connectivity, and removes the temporary archive', () => {
    const { directory, logPath } = createCommandBin();
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl]);
    const calls = readFileSync(logPath, 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PostgreSQL backup-restore drill passed.');
    expect(result.stdout).not.toContain('source-password');
    expect(calls).toContain(`--format=custom --no-owner --no-privileges --file=`);
    expect(calls).toContain(`--exit-on-error --no-owner --no-privileges --dbname=${restoreUrl}`);
    expect(calls).toContain('--command=SELECT 1');
    const archivePath = calls.match(/--file=(\S+)/)?.[1];
    expect(archivePath).toBeDefined();
    expect(archivePath && existsSync(archivePath)).toBe(false);
  });

  it('rejects missing arguments and source/target collisions', () => {
    const { directory, logPath } = createCommandBin();

    expect(runDrill(directory, logPath, []).status).toBe(2);
    expect(runDrill(directory, logPath, [sourceUrl, sourceUrl]).stderr).toContain(
      'must be different databases',
    );
  });

  it.each(['pg_dump', 'pg_restore', 'psql'])('fails when %s reports an error', (command) => {
    const { directory, logPath } = createCommandBin(command);
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl], {
      FAIL_COMMAND: command,
    });

    expect(result.status).toBe(17);
    expect(result.stdout).not.toContain('drill passed');
  });

  it('encrypts the archive with owner-only permissions and restores the decrypted copy', () => {
    const { directory, logPath } = createCommandBin();
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verifying backup encryption and file permissions.');
    expect(result.stdout).toContain('Verifying restored object ownership and privileges.');
    expect(result.stdout + result.stderr).not.toContain(encryptionKey);
    // pg_restore received the decrypted archive, not the ciphertext.
    expect(readFileSync(`${logPath}.restored`, 'utf8')).toBe('PGDMPPGDMP');
    const calls = readFileSync(logPath, 'utf8');
    expect(calls).toMatch(/--list \S+\/restore\.dump/);
    expect(calls).not.toContain(encryptionKey);
  });

  it.each([
    ['unset', undefined],
    ['too short', 'short-key'],
  ])('refuses to run when the encryption key is %s', (_name, key) => {
    const { directory, logPath } = createCommandBin();
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl], {
      BACKUP_ENCRYPTION_KEY: key,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BACKUP_ENCRYPTION_KEY');
    expect(existsSync(logPath)).toBe(false);
  });

  it('fails before restoring when the archive is left unencrypted', () => {
    const { directory, logPath } = createCommandBin();
    // An openssl stand-in that copies the plaintext archive through unchanged.
    writeFileSync(
      path.join(directory, 'openssl'),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -in) in=$2; shift ;; -out) out=$2; shift ;; esac; shift; done\ncp "$in" "$out"\n',
    );
    chmodSync(path.join(directory, 'openssl'), 0o755);
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Encryption check failed');
    expect(readFileSync(logPath, 'utf8')).not.toContain('--dbname=');
  });

  it('fails when restored objects are owned by another role or granted to PUBLIC', () => {
    const { directory, logPath } = createCommandBin();
    const result = runDrill(directory, logPath, [sourceUrl, restoreUrl], {
      MOCK_PSQL_COUNT: '2',
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Restore permission check failed');
    expect(result.stdout).not.toContain('drill passed');
  });
});
