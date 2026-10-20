import { prismaWrite } from '../src/db';
import { config } from '../src/config';
import { reprocessDeadLetterItemAudited } from '../src/indexer/errorQueue';

export interface ReplayCommand {
  id: string;
  actor: string;
  reason: string;
  dryRun: boolean;
}

/** Parse the deliberately small, auditable operator CLI surface. */
export function parseReplayCommand(argv: string[]): ReplayCommand {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--id' || token === '--actor' || token === '--reason') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
      values.set(token, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  const id = values.get('--id');
  const actor = values.get('--actor');
  const reason = values.get('--reason');
  if (!id || !actor || !reason) {
    throw new Error('Usage: npm run admin:dead-letter-replay -- --id <id> --actor <operator> --reason <reason> [--dry-run]');
  }
  return { id, actor, reason, dryRun };
}

export async function replayDeadLetter(command: ReplayCommand): Promise<'replayed' | 'not-found' | 'dry-run'> {
  if (command.dryRun) return 'dry-run';
  const replayed = await reprocessDeadLetterItemAudited(command.id, {
    actor: command.actor,
    reason: command.reason,
  });
  return replayed ? 'replayed' : 'not-found';
}

async function main(): Promise<void> {
  const command = parseReplayCommand(process.argv.slice(2));
  const result = await replayDeadLetter(command);
  console.log(
    JSON.stringify({
      command: 'dead-letter-replay',
      network: config.stellarNetwork,
      id: command.id,
      actor: command.actor,
      result,
    }),
  );
  if (result === 'not-found') process.exitCode = 2;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => prismaWrite.$disconnect());
}
