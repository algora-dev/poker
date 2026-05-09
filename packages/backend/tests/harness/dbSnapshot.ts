/**
 * On-failure DB snapshot — captures everything needed to reproduce a
 * harness failure without re-running. Writes a JSON file with full rows
 * from Game, GamePlayer, Hand, HandAction, HandEvent, ChipAudit, MoneyEvent,
 * SidePot, and ChipBalance for the bots involved.
 *
 * BigInt is serialized as decimal string.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';

function bigintReplacer(_k: string, v: any): any {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export async function snapshotFailure(opts: {
  prisma: PrismaClient;
  runDir: string;
  scenario: string;
  gameId?: string;
  botUserIds?: string[];
  errorMessage: string;
  invariantId?: string;
}) {
  const { prisma, runDir, scenario, gameId, botUserIds, errorMessage, invariantId } = opts;

  const snapshot: any = {
    scenario,
    invariantId,
    errorMessage,
    capturedAt: new Date().toISOString(),
    gameId,
    botUserIds,
  };

  try {
    if (gameId) {
      snapshot.game = await prisma.game.findUnique({ where: { id: gameId } });
      snapshot.players = await prisma.gamePlayer.findMany({ where: { gameId } });
      snapshot.hands = await prisma.hand.findMany({
        where: { gameId },
        orderBy: { handNumber: 'asc' },
      });
      const handIds = snapshot.hands.map((h: any) => h.id);
      if (handIds.length) {
        snapshot.handActions = await prisma.handAction.findMany({
          where: { handId: { in: handIds } },
          orderBy: [{ handId: 'asc' }, { sequenceNumber: 'asc' }],
        });
        snapshot.handEvents = await prisma.handEvent.findMany({
          where: { scopeId: { in: handIds } },
          orderBy: [{ scopeId: 'asc' }, { sequenceNumber: 'asc' }],
        });
        snapshot.sidePots = await prisma.sidePot.findMany({
          where: { handId: { in: handIds } },
        });
      }
    }

    if (botUserIds?.length) {
      snapshot.chipBalances = await prisma.chipBalance.findMany({
        where: { userId: { in: botUserIds } },
      });
      snapshot.chipAudit = await prisma.chipAudit.findMany({
        where: { userId: { in: botUserIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      try {
        snapshot.moneyEvents = await prisma.moneyEvent.findMany({
          where: { userId: { in: botUserIds } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
      } catch {
        // moneyEvent table may not exist on older schemas
      }
    }
  } catch (e: any) {
    snapshot.snapshotError = e?.message || String(e);
  }

  const file = path.join(runDir, `${scenario}.snapshot.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, bigintReplacer, 2));
  return file;
}

/**
 * Auto-file an issue under tests/harness/issues/ with a self-contained
 * markdown reproducer. Includes the error, invariant ID, and references to
 * the JSONL + snapshot.
 */
export function autoFileIssue(opts: {
  scenario: string;
  runId: string;
  runDir: string;
  errorMessage: string;
  invariantId?: string;
  snapshotPath?: string;
}) {
  const { scenario, runId, runDir, errorMessage, invariantId, snapshotPath } = opts;
  const issuesDir = path.resolve(__dirname, 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  const id = `${runId}__${scenario}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(issuesDir, `${id}.md`);
  const md = `# Harness failure: ${scenario}

- **runId:** \`${runId}\`
- **invariantId:** \`${invariantId ?? 'n/a'}\`
- **error:** ${errorMessage}
- **JSONL:** ${path.relative(issuesDir, path.join(runDir, scenario + '.jsonl'))}
- **snapshot:** ${snapshotPath ? path.relative(issuesDir, snapshotPath) : 'n/a'}

## Reproduce

\`\`\`bash
HARNESS_BASE_URL=http://localhost:3000 \\
HARNESS_ADMIN_SECRET=*** \\
HARNESS_SCENARIO=${scenario} \\
npm run --workspace=packages/backend harness
\`\`\`

## Triage checklist

- [ ] Compared snapshot to last green run
- [ ] Checked server log slice around failure ts
- [ ] Identified suspected commit / change
- [ ] Wrote failing unit test if reproducible in isolation
- [ ] Patched + re-ran scenario in loop mode
`;
  fs.writeFileSync(file, md);
  return file;
}
