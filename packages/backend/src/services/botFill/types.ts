/**
 * Bot-fill shared types.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the GameState / Decision
 * shapes consumed by both:
 *   - the bot-fill admin feature (live, runtime headless bots)
 *   - the test harness bot client (tests/harness/botClient.ts)
 *
 * Keep this dependency-free so it can be imported from anywhere.
 */

export type BotAction = 'fold' | 'check' | 'call' | 'raise' | 'all-in';

export interface Decision {
  action: BotAction;
  /** Chips (user-facing unit), only meaningful for `raise`. */
  raiseAmount?: number;
}

/**
 * The shape served by GET /api/games/:id/state. All chip fields are
 * stringified micro-units (BigInt-as-string).
 */
export interface BotGameState {
  gameId: string;
  status: string;
  pot: string;
  currentBet: string;
  amountToCall: string;
  stage: string;
  board: string[];
  isMyTurn: boolean;
  myPlayer: {
    userId: string;
    chipStack: string;
    holeCards: string[];
    position: string;
    currentStageBet: string;
  };
  opponents: Array<{
    userId: string;
    chipStack: string;
    position: string;
    currentStageBet: string;
  }>;
  smallBlind: string;
  bigBlind: string;
  activePlayerUserId: string | null;
  /** Some servers include `lastRaiseIncrement` for tighter min-raise calcs. */
  lastRaiseIncrement?: string;
}

export interface BotStrategy {
  name: string;
  decide(state: BotGameState, rng?: () => number): Decision;
}
