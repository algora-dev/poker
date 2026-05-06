/**
 * tests/sim/world.ts
 *
 * In-memory Prisma stub used by the match simulator. This mirrors the real
 * Prisma client API surface that the game code touches (game, gamePlayer,
 * hand, handAction, handEvent, sidePot, chipBalance, chipAudit, user) and
 * implements `$transaction` with snapshot/rollback semantics so a thrown
 * error inside a transaction restores prior state — exactly like Postgres.
 *
 * Goal: zero DB, zero sockets, deterministic, fast. A full hand runs in
 * single-digit milliseconds.
 */

export type Json = string;

export interface UserRow {
  id: string;
  username: string;
  walletAddress: string | null;
}
export interface ChipBalanceRow {
  userId: string;
  chips: bigint;
}
export interface GameRow {
  id: string;
  name: string;
  createdBy: string;
  maxPlayers: number;
  autoStart: boolean;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  smallBlind: bigint;
  bigBlind: bigint;
  status: string;
  currentHandId: string | null;
  dealerIndex: number;
  blindLevel: number;
  handsAtLevel: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}
export interface GamePlayerRow {
  id: string;
  gameId: string;
  userId: string;
  seatIndex: number;
  chipStack: bigint;
  holeCards: Json;
  position: string;
  joinedAt: Date;
  leftAt: Date | null;
}
export interface HandRow {
  id: string;
  gameId: string;
  handNumber: number;
  deck: Json;
  board: Json;
  pot: bigint;
  currentBet: bigint;
  activePlayerIndex: number;
  turnStartedAt: Date | null;
  version: number;
  winnerIds: Json;
  stage: string;
  createdAt: Date;
  completedAt: Date | null;
}
export interface HandActionRow {
  id: string;
  handId: string;
  userId: string;
  action: string;
  amount: bigint | null;
  stage: string;
  timestamp: Date;
}
export interface HandEventRow {
  id: string;
  gameId: string;
  handId: string | null;
  userId: string | null;
  scopeId: string;
  sequenceNumber: number;
  eventType: string;
  payload: Json;
  correlationId: string | null;
  serverTime: Date;
}

export interface MoneyEventRow {
  id: string;
  userId: string;
  eventType: string;
  amount: bigint;
  balanceBefore: bigint | null;
  balanceAfter: bigint | null;
  gameId: string | null;
  handId: string | null;
  txHash: string | null;
  withdrawalId: string | null;
  depositId: string | null;
  authorizationId: string | null;
  payload: Json;
  correlationId: string | null;
  serverTime: Date;
}

export interface PendingDepositChallengeRow {
  id: string;
  userId: string;
  walletAddress: string;
  nonce: string;
  chainId: number;
  contractAddress: string;
  amount: bigint | null;
  issuedAt: Date;
  expiresAt: Date;
  used: boolean;
  usedAt: Date | null;
  createdAt: Date;
}
export interface SidePotRow {
  id: string;
  handId: string;
  potNumber: number;
  amount: bigint;
  cappedAt: bigint;
  eligiblePlayerIds: Json;
  winnerId: string | null;
  createdAt: Date;
}
export interface ChipAuditRow {
  id: string;
  userId: string;
  operation: string;
  amountDelta: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  reference: string | null;
  notes: string | null;
  createdAt: Date;
}

interface Snapshot {
  users: UserRow[];
  balances: ChipBalanceRow[];
  games: GameRow[];
  gamePlayers: GamePlayerRow[];
  hands: HandRow[];
  handActions: HandActionRow[];
  handEvents: HandEventRow[];
  moneyEvents: MoneyEventRow[];
  pendingChallenges: PendingDepositChallengeRow[];
  sidePots: SidePotRow[];
  chipAudits: ChipAuditRow[];
}

let nextId = 1;
function id(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

function deepCloneRow<T>(row: T): T {
  // Fast-path: BigInt and Date survive structuredClone where available.
  // Otherwise fall back to manual shallow clone (rows are flat).
  return { ...(row as any) };
}
function snapshotState(s: Snapshot): Snapshot {
  return {
    users: s.users.map(deepCloneRow),
    balances: s.balances.map(deepCloneRow),
    games: s.games.map(deepCloneRow),
    gamePlayers: s.gamePlayers.map(deepCloneRow),
    hands: s.hands.map(deepCloneRow),
    handActions: s.handActions.map(deepCloneRow),
    handEvents: s.handEvents.map(deepCloneRow),
    moneyEvents: s.moneyEvents.map(deepCloneRow),
    pendingChallenges: s.pendingChallenges.map(deepCloneRow),
    sidePots: s.sidePots.map(deepCloneRow),
    chipAudits: s.chipAudits.map(deepCloneRow),
  };
}

function matchWhere<T extends Record<string, any>>(row: T, where: any): boolean {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    const w = where[k];
    const v = row[k];
    if (w && typeof w === 'object' && !(w instanceof Date)) {
      if ('equals' in w) {
        if (v !== w.equals) return false;
      } else if ('not' in w) {
        if (v === w.not) return false;
      } else if ('in' in w) {
        if (!Array.isArray(w.in) || !w.in.includes(v)) return false;
      } else if ('lt' in w || 'gt' in w || 'lte' in w || 'gte' in w) {
        const dv = v instanceof Date ? v.getTime() : (v as any);
        if (w.lt != null) {
          const t = w.lt instanceof Date ? w.lt.getTime() : w.lt;
          if (!(dv < t)) return false;
        }
        if (w.gt != null) {
          const t = w.gt instanceof Date ? w.gt.getTime() : w.gt;
          if (!(dv > t)) return false;
        }
        if (w.lte != null) {
          const t = w.lte instanceof Date ? w.lte.getTime() : w.lte;
          if (!(dv <= t)) return false;
        }
        if (w.gte != null) {
          const t = w.gte instanceof Date ? w.gte.getTime() : w.gte;
          if (!(dv >= t)) return false;
        }
      } else {
        // Nested object — fail closed, callers should not rely on this.
        return false;
      }
    } else {
      if (v !== w) return false;
    }
  }
  return true;
}

/**
 * Build an in-memory Prisma client. Returns the client + helpers to inspect
 * raw state (used by the simulator and assertions).
 */
export function buildSimWorld(initial?: Partial<Snapshot>) {
  let state: Snapshot = {
    users: initial?.users ?? [],
    balances: initial?.balances ?? [],
    games: initial?.games ?? [],
    gamePlayers: initial?.gamePlayers ?? [],
    hands: initial?.hands ?? [],
    handActions: initial?.handActions ?? [],
    handEvents: initial?.handEvents ?? [],
    moneyEvents: initial?.moneyEvents ?? [],
    pendingChallenges: initial?.pendingChallenges ?? [],
    sidePots: initial?.sidePots ?? [],
    chipAudits: initial?.chipAudits ?? [],
  };

  // Build a tx-like client that operates on `state`. The same shape is used
  // both as the top-level prisma client and as the inner `tx` argument of
  // $transaction — they share the same backing rows, with snapshot/rollback
  // applied at the $transaction boundary.
  const buildClient = () => ({
    user: {
      findUnique: async (args: any) =>
        state.users.find((r) => matchWhere(r, args.where)) ?? null,
      create: async (args: any) => {
        const row: UserRow = {
          id: args.data.id ?? id('u'),
          username: args.data.username,
          walletAddress: args.data.walletAddress ?? null,
        };
        state.users.push(row);
        return row;
      },
    },
    chipBalance: {
      findUnique: async (args: any) =>
        state.balances.find((r) => matchWhere(r, args.where)) ?? null,
      upsert: async (args: any) => {
        const existing = state.balances.find((r) => matchWhere(r, args.where));
        if (existing) {
          if (args.update.chips?.increment != null) {
            existing.chips += BigInt(args.update.chips.increment);
          } else if (args.update.chips != null) {
            existing.chips = BigInt(args.update.chips);
          }
          return existing;
        }
        const row: ChipBalanceRow = {
          userId: args.create.userId,
          chips: BigInt(args.create.chips ?? 0n),
        };
        state.balances.push(row);
        return row;
      },
      update: async (args: any) => {
        const existing = state.balances.find((r) => matchWhere(r, args.where));
        if (!existing) throw new Error('chipBalance not found');
        const d = args.data;
        if (d.chips?.increment != null) {
          existing.chips += BigInt(d.chips.increment);
        } else if (d.chips?.decrement != null) {
          existing.chips -= BigInt(d.chips.decrement);
        } else if (d.chips != null) {
          existing.chips = BigInt(d.chips);
        }
        return existing;
      },
    },
    chipAudit: {
      create: async (args: any) => {
        const row: ChipAuditRow = {
          id: id('au'),
          userId: args.data.userId,
          operation: args.data.operation,
          amountDelta: BigInt(args.data.amountDelta),
          balanceBefore: BigInt(args.data.balanceBefore),
          balanceAfter: BigInt(args.data.balanceAfter),
          reference: args.data.reference ?? null,
          notes: args.data.notes ?? null,
          createdAt: new Date(),
        };
        state.chipAudits.push(row);
        return row;
      },
    },
    game: {
      findUnique: async (args: any) => {
        const game = state.games.find((r) => matchWhere(r, args.where));
        if (!game) return null;
        const out: any = { ...game };
        if (args.include?.players) {
          out.players = state.gamePlayers
            .filter((p) => p.gameId === game.id)
            .sort((a, b) => a.seatIndex - b.seatIndex)
            .map((p) => {
              const u = state.users.find((u) => u.id === p.userId);
              return {
                ...p,
                user: u
                  ? { id: u.id, username: u.username }
                  : { id: p.userId, username: p.userId },
              };
            });
        }
        if (args.include?.hands) {
          let hands = state.hands.filter((h) => h.gameId === game.id);
          if (args.include.hands?.where) {
            hands = hands.filter((h) => matchWhere(h, args.include.hands.where));
          }
          if (args.include.hands?.orderBy?.createdAt === 'desc') {
            hands.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          if (args.include.hands?.take) {
            hands = hands.slice(0, args.include.hands.take);
          }
          out.hands = hands;
        }
        if (args.select) {
          // Minimal select support used by listener / sockets.
          const picked: any = {};
          for (const k of Object.keys(args.select)) {
            if (k === 'players' && args.select.players?.select) {
              picked.players = state.gamePlayers
                .filter((p) => p.gameId === game.id)
                .map((p) => ({ userId: p.userId }));
            } else {
              picked[k] = (game as any)[k];
            }
          }
          return picked;
        }
        return out;
      },
      create: async (args: any) => {
        const row: GameRow = {
          id: args.data.id ?? id('g'),
          name: args.data.name,
          createdBy: args.data.createdBy,
          maxPlayers: args.data.maxPlayers ?? 8,
          autoStart: args.data.autoStart ?? false,
          minBuyIn: BigInt(args.data.minBuyIn),
          maxBuyIn: BigInt(args.data.maxBuyIn),
          smallBlind: BigInt(args.data.smallBlind ?? 500_000n),
          bigBlind: BigInt(args.data.bigBlind ?? 1_000_000n),
          status: args.data.status ?? 'waiting',
          currentHandId: null,
          dealerIndex: 0,
          blindLevel: 0,
          handsAtLevel: 0,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
        };
        state.games.push(row);
        return row;
      },
      update: async (args: any) => {
        const existing = state.games.find((r) => matchWhere(r, args.where));
        if (!existing) throw new Error('game not found');
        Object.assign(existing, args.data);
        return existing;
      },
      updateMany: async (args: any) => {
        let count = 0;
        for (const r of state.games) {
          if (!matchWhere(r, args.where)) continue;
          Object.assign(r, args.data);
          count++;
        }
        return { count };
      },
      findMany: async (args: any) => {
        let rows = state.games.filter((r) => matchWhere(r, args?.where ?? {}));
        if (args?.include?.players) {
          rows = rows.map((g) => ({
            ...g,
            players: state.gamePlayers.filter((p) => p.gameId === g.id),
          })) as any;
        }
        return rows;
      },
    },
    gamePlayer: {
      findFirst: async (args: any) =>
        state.gamePlayers.find((r) => matchWhere(r, args.where)) ?? null,
      findMany: async (args: any) => {
        let rows = state.gamePlayers.filter((r) =>
          matchWhere(r, args?.where ?? {})
        );
        if (args?.orderBy?.seatIndex === 'asc') {
          rows = rows.slice().sort((a, b) => a.seatIndex - b.seatIndex);
        }
        if (args?.include?.user) {
          rows = rows.map((p) => {
            const u = state.users.find((u) => u.id === p.userId);
            return {
              ...p,
              user: u
                ? { id: u.id, username: u.username }
                : { id: p.userId, username: p.userId },
            };
          }) as any;
        }
        return rows;
      },
      create: async (args: any) => {
        const row: GamePlayerRow = {
          id: args.data.id ?? id('gp'),
          gameId: args.data.gameId,
          userId: args.data.userId,
          seatIndex: args.data.seatIndex,
          chipStack: BigInt(args.data.chipStack ?? 0n),
          holeCards: args.data.holeCards ?? '[]',
          position: args.data.position ?? 'waiting',
          joinedAt: new Date(),
          leftAt: null,
        };
        state.gamePlayers.push(row);
        return row;
      },
      update: async (args: any) => {
        const existing = state.gamePlayers.find((r) => matchWhere(r, args.where));
        if (!existing) throw new Error('gamePlayer not found');
        const d = args.data;
        if (d.chipStack != null) {
          if (typeof d.chipStack === 'object') {
            if (d.chipStack.increment != null) existing.chipStack += BigInt(d.chipStack.increment);
            else if (d.chipStack.decrement != null) existing.chipStack -= BigInt(d.chipStack.decrement);
          } else {
            existing.chipStack = BigInt(d.chipStack);
          }
        }
        if (typeof d.position === 'string') existing.position = d.position;
        if (typeof d.holeCards === 'string') existing.holeCards = d.holeCards;
        if (d.leftAt != null) existing.leftAt = d.leftAt;
        return existing;
      },
    },
    hand: {
      findUnique: async (args: any) =>
        state.hands.find((r) => matchWhere(r, args.where)) ?? null,
      findFirst: async (args: any) => {
        let rows = state.hands.filter((r) => matchWhere(r, args.where));
        if (args.orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return rows[0] ?? null;
      },
      create: async (args: any) => {
        const row: HandRow = {
          id: id('h'),
          gameId: args.data.gameId,
          handNumber: args.data.handNumber,
          deck: args.data.deck ?? '[]',
          board: args.data.board ?? '[]',
          pot: BigInt(args.data.pot ?? 0n),
          currentBet: BigInt(args.data.currentBet ?? 0n),
          activePlayerIndex: args.data.activePlayerIndex ?? 0,
          turnStartedAt: args.data.turnStartedAt ?? null,
          version: args.data.version ?? 0,
          winnerIds: args.data.winnerIds ?? '[]',
          stage: args.data.stage ?? 'preflop',
          createdAt: new Date(),
          completedAt: null,
        };
        state.hands.push(row);
        return row;
      },
      update: async (args: any) => {
        const existing = state.hands.find((r) => matchWhere(r, args.where));
        if (!existing) throw new Error('hand not found');
        Object.assign(existing, args.data);
        return existing;
      },
      updateMany: async (args: any) => {
        let count = 0;
        for (const r of state.hands) {
          if (!matchWhere(r, args.where)) continue;
          if (args.data?.version?.increment != null) {
            r.version += args.data.version.increment;
          } else {
            Object.assign(r, args.data);
          }
          count++;
        }
        return { count };
      },
      count: async (args: any) =>
        state.hands.filter((r) => matchWhere(r, args?.where ?? {})).length,
    },
    handAction: {
      findMany: async (args: any) => {
        let rows = state.handActions.filter((r) =>
          matchWhere(r, args.where ?? {})
        );
        if (args.orderBy?.timestamp === 'asc') {
          rows = rows.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        }
        return rows;
      },
      aggregate: async (args: any) => {
        const rows = state.handActions.filter((r) => matchWhere(r, args.where));
        const total = rows.reduce((s, r) => s + (r.amount ?? 0n), 0n);
        return { _sum: { amount: total } };
      },
      count: async (args: any) =>
        state.handActions.filter((r) => matchWhere(r, args?.where ?? {})).length,
      create: async (args: any) => {
        const row: HandActionRow = {
          id: id('ha'),
          handId: args.data.handId,
          userId: args.data.userId,
          action: args.data.action,
          amount: args.data.amount != null ? BigInt(args.data.amount) : null,
          stage: args.data.stage,
          timestamp: new Date(),
        };
        state.handActions.push(row);
        return row;
      },
    },
    handEvent: {
      findFirst: async (args: any) => {
        let rows = state.handEvents.filter((r) => matchWhere(r, args.where));
        if (args.orderBy?.sequenceNumber === 'desc') {
          rows = rows.slice().sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        }
        return rows[0] ?? null;
      },
      create: async (args: any) => {
        // Phase 9 follow-up [item 4]: enforce the (scopeId, sequenceNumber)
        // unique index. The retry loop in recordHandEvent handles P2002.
        const dup = state.handEvents.find(
          (e) =>
            e.scopeId === args.data.scopeId &&
            e.sequenceNumber === args.data.sequenceNumber
        );
        if (dup) {
          const err: any = new Error(
            'Unique constraint failed on (scopeId, sequenceNumber)'
          );
          err.code = 'P2002';
          throw err;
        }
        const row: HandEventRow = {
          id: id('he'),
          gameId: args.data.gameId,
          handId: args.data.handId ?? null,
          userId: args.data.userId ?? null,
          scopeId: args.data.scopeId,
          sequenceNumber: args.data.sequenceNumber,
          eventType: args.data.eventType,
          payload: args.data.payload ?? '{}',
          correlationId: args.data.correlationId ?? null,
          serverTime: new Date(),
        };
        state.handEvents.push(row);
        return row;
      },
    },
    moneyEvent: {
      create: async (args: any) => {
        const row: MoneyEventRow = {
          id: id('me'),
          userId: args.data.userId,
          eventType: args.data.eventType,
          amount: BigInt(args.data.amount),
          balanceBefore: args.data.balanceBefore == null ? null : BigInt(args.data.balanceBefore),
          balanceAfter: args.data.balanceAfter == null ? null : BigInt(args.data.balanceAfter),
          gameId: args.data.gameId ?? null,
          handId: args.data.handId ?? null,
          txHash: args.data.txHash ?? null,
          withdrawalId: args.data.withdrawalId ?? null,
          depositId: args.data.depositId ?? null,
          authorizationId: args.data.authorizationId ?? null,
          payload: args.data.payload ?? '{}',
          correlationId: args.data.correlationId ?? null,
          serverTime: new Date(),
        };
        state.moneyEvents.push(row);
        return row;
      },
      findMany: async (args: any) =>
        state.moneyEvents.filter((r) => matchWhere(r, args?.where ?? {})),
    },
    pendingDepositChallenge: {
      create: async (args: any) => {
        if (state.pendingChallenges.some((p) => p.nonce === args.data.nonce)) {
          const err: any = new Error('Unique constraint failed on nonce');
          err.code = 'P2002';
          throw err;
        }
        const row: PendingDepositChallengeRow = {
          id: id('pdc'),
          userId: args.data.userId,
          walletAddress: args.data.walletAddress,
          nonce: args.data.nonce,
          chainId: args.data.chainId,
          contractAddress: args.data.contractAddress,
          amount: args.data.amount == null ? null : BigInt(args.data.amount),
          issuedAt: args.data.issuedAt ?? new Date(),
          expiresAt: args.data.expiresAt,
          used: false,
          usedAt: null,
          createdAt: new Date(),
        };
        state.pendingChallenges.push(row);
        return row;
      },
      findUnique: async (args: any) =>
        state.pendingChallenges.find((r) => matchWhere(r, args.where)) ?? null,
      updateMany: async (args: any) => {
        let count = 0;
        for (const r of state.pendingChallenges) {
          if (!matchWhere(r, args.where)) continue;
          if (args.data.used != null) r.used = args.data.used;
          if (args.data.usedAt != null) r.usedAt = args.data.usedAt;
          count++;
        }
        return { count };
      },
    },
    sidePot: {
      create: async (args: any) => {
        const row: SidePotRow = {
          id: id('sp'),
          handId: args.data.handId,
          potNumber: args.data.potNumber,
          amount: BigInt(args.data.amount),
          cappedAt: BigInt(args.data.cappedAt ?? args.data.amount),
          eligiblePlayerIds: args.data.eligiblePlayerIds,
          winnerId: null,
          createdAt: new Date(),
        };
        state.sidePots.push(row);
        return row;
      },
      update: async (args: any) => {
        const where = args.where.handId_potNumber ?? args.where;
        const existing = state.sidePots.find(
          (r) => r.handId === where.handId && r.potNumber === where.potNumber
        );
        if (!existing) throw new Error('sidePot not found');
        Object.assign(existing, args.data);
        return existing;
      },
      deleteMany: async (args: any) => {
        const before = state.sidePots.length;
        state.sidePots = state.sidePots.filter((r) => !matchWhere(r, args.where));
        return { count: before - state.sidePots.length };
      },
      findMany: async (args: any) =>
        state.sidePots.filter((r) => matchWhere(r, args?.where ?? {})),
    },
  });

  // The top-level client + transaction wrapper.
  const client: any = {
    ...buildClient(),
    $transaction: async (fn: any) => {
      const snap = snapshotState(state);
      try {
        // The inner tx shares state with the top-level client.
        return await fn(buildClient());
      } catch (err) {
        // Rollback.
        state = snap;
        throw err;
      }
    },
  };

  return {
    client,
    state: () => state,
    install() {
      (globalThis as any).__t3PokerSimWorld = client;
    },
    uninstall() {
      delete (globalThis as any).__t3PokerSimWorld;
    },
  };
}
