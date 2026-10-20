import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ prismaWrite: { $disconnect: vi.fn() } }));
vi.mock('../../src/config', () => ({ config: { stellarNetwork: 'testnet' } }));
vi.mock('../../src/indexer/errorQueue', () => ({ reprocessDeadLetterItemAudited: vi.fn() }));

import { reprocessDeadLetterItemAudited } from '../../src/indexer/errorQueue';
import { parseReplayCommand, replayDeadLetter } from '../../scripts/replay-dead-letter';

describe('dead-letter replay command', () => {
  it('requires a specific item, named actor, and reason', () => {
    expect(() => parseReplayCommand(['--id', 'dlq-1'])).toThrow('Usage:');
    expect(
      parseReplayCommand(['--id', 'dlq-1', '--actor', 'oncall@example.test', '--reason', 'INC-1188', '--dry-run']),
    ).toEqual({ id: 'dlq-1', actor: 'oncall@example.test', reason: 'INC-1188', dryRun: true });
  });

  it('does not mutate on dry run and attaches actor/reason to a replay', async () => {
    const command = { id: 'dlq-1', actor: 'oncall@example.test', reason: 'INC-1188', dryRun: true };
    await expect(replayDeadLetter(command)).resolves.toBe('dry-run');
    expect(reprocessDeadLetterItemAudited).not.toHaveBeenCalled();

    vi.mocked(reprocessDeadLetterItemAudited).mockResolvedValueOnce(true);
    await expect(replayDeadLetter({ ...command, dryRun: false })).resolves.toBe('replayed');
    expect(reprocessDeadLetterItemAudited).toHaveBeenCalledWith('dlq-1', {
      actor: 'oncall@example.test',
      reason: 'INC-1188',
    });
  });
});
