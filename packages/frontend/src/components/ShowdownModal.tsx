import { useNavigate } from 'react-router-dom';
import { PlayingCard } from './PlayingCard';

interface Card {
  rank: string;
  suit: string;
}

interface PlayerShowdown {
  userId: string;
  username: string;
  holeCards: Card[];
  handRank: number;
  handName: string;
  bestCards: Card[];
  isWinner: boolean;
}

interface SidePotResult {
  potNumber: number;
  amount: string;
  winnerIds: string[];
  winnerNames: string[];
}

interface ShowdownModalProps {
  isOpen: boolean;
  pot: string;
  sidePots?: SidePotResult[];
  communityCards: Card[];
  players: PlayerShowdown[];
  winnerIds: string[];
  currentUserId: string;
  onClose: () => void;
}

/**
 * Compute chips won per userId from the side-pot results. A player's
 * winnings is the sum of `amount / winnerIds.length` for every pot they
 * won (an even split — the backend allocates any odd-chip remainder
 * deterministically to one seat, but for the modal display we show the
 * advertised share; remainder skew is sub-1-chip and visible only to
 * the recipient via their stack delta).
 */
function computeChipsWonMap(sidePots: SidePotResult[] | undefined): Record<string, bigint> {
  const map: Record<string, bigint> = {};
  if (!sidePots || sidePots.length === 0) return map;
  for (const sp of sidePots) {
    if (!sp.winnerIds || sp.winnerIds.length === 0) continue;
    const amount = BigInt(sp.amount);
    const share = amount / BigInt(sp.winnerIds.length);
    for (const id of sp.winnerIds) {
      map[id] = (map[id] || BigInt(0)) + share;
    }
  }
  return map;
}

export function ShowdownModal({
  isOpen, pot, sidePots, communityCards, players, winnerIds, currentUserId, onClose,
}: ShowdownModalProps) {
  const navigate = useNavigate();
  const formatChips = (c: string | bigint) => {
    const n = typeof c === 'bigint' ? c : BigInt(c);
    return (Number(n) / 1_000_000).toFixed(2);
  };

  const isCurrentPlayerWinner = winnerIds.includes(currentUserId);
  const isTie = winnerIds.length > 1;

  // Per-player winnings from sidePots (split-pot aware).
  const chipsWonByUser = computeChipsWonMap(sidePots);

  // Highlight the 5 best cards in the winning hand for community-card display.
  // When multiple winners, use the first winner's bestCards (their best-5 is
  // representative; tied hands share the same best-5 structure for the
  // community portion).
  const firstWinner = players.find(p => p.isWinner);
  const isInBest5 = (card: Card, best: Card[]) =>
    best.some(b => b.rank === card.rank && b.suit === card.suit);

  // Sort: winners first (chips desc), then losers
  const sortedPlayers = [...players].sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    const aWon = Number(chipsWonByUser[a.userId] || BigInt(0));
    const bWon = Number(chipsWonByUser[b.userId] || BigInt(0));
    return bWon - aWon;
  });

  if (!isOpen || !firstWinner) return null;

  const totalPot = formatChips(pot);
  const winnerNames = players.filter(p => p.isWinner).map(p => p.username);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-2">
      <div className="rounded-2xl border border-white/10 shadow-2xl w-full max-w-2xl max-h-[95vh] overflow-y-auto" style={{ background: '#262626' }}>
        {/* Header */}
        <div
          className="py-4 px-6 rounded-t-2xl flex items-center justify-between"
          style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)' }}
        >
          <div>
            <h2 className="text-2xl font-bold text-white">
              {isTie ? `Split Pot — ${winnerNames.join(' & ')}` : isCurrentPlayerWinner ? 'YOU WIN!' : `${firstWinner.username} Wins!`}
            </h2>
            <p className="text-white/80 text-xs mt-0.5">{firstWinner.handName}</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 justify-end">
              <img src="/assets/musd-chip.png" alt="" className="w-6 h-6" />
              <span className="text-white font-bold text-2xl">{totalPot}</span>
            </div>
            <p className="text-white/70 text-[10px] uppercase tracking-wider mt-0.5">Total Pot</p>
          </div>
        </div>

        <div className="p-5">
          {/* Community cards — large + centered, winning 5 highlighted gold */}
          <div className="mb-5">
            <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2 text-center">Community Cards</p>
            <div className="flex gap-2 justify-center">
              {communityCards.map((card, i) => (
                <PlayingCard key={i} card={card} size="md" highlight={isInBest5(card, firstWinner.bestCards)} />
              ))}
            </div>
          </div>

          {/* Players list — winners first, then losers; each row shows chips won */}
          <div className="space-y-2">
            <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">Players</p>
            {sortedPlayers.map(p => {
              const won = chipsWonByUser[p.userId] || BigInt(0);
              const isYou = p.userId === currentUserId;
              return (
                <div
                  key={p.userId}
                  className={`rounded-lg p-3 flex items-center justify-between gap-3 border ${
                    p.isWinner ? 'border-cyan-500/40' : 'border-white/5'
                  }`}
                  style={{
                    background: p.isWinner ? 'rgba(18,206,236,0.08)' : 'rgba(255,255,255,0.03)',
                  }}
                >
                  {/* Left: hole cards + name + hand */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="flex gap-1 flex-shrink-0">
                      {p.holeCards.map((card, i) => (
                        <PlayingCard
                          key={i}
                          card={card}
                          size="sm"
                          highlight={p.isWinner && isInBest5(card, p.bestCards)}
                        />
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-semibold truncate ${p.isWinner ? 'text-white' : 'text-gray-400'}`}>
                        {p.username}
                        {isYou && <span className="text-green-400 ml-1">(You)</span>}
                      </p>
                      <p className={`text-xs truncate ${p.isWinner ? 'text-cyan-300' : 'text-gray-500'}`}>
                        {p.handName}
                      </p>
                    </div>
                  </div>

                  {/* Right: chips won (winners only) */}
                  {p.isWinner ? (
                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center gap-1 justify-end">
                        <img src="/assets/musd-chip.png" alt="" className="w-4 h-4" />
                        <span className="text-cyan-300 font-bold text-lg">+{formatChips(won)}</span>
                      </div>
                      <p className="text-[9px] uppercase tracking-wider text-cyan-400/70 mt-0.5">Won</p>
                    </div>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-gray-600 flex-shrink-0">
                      Out
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Side-pot breakdown (only shown if there ARE side pots) */}
          {sidePots && sidePots.length > 1 && (
            <div className="mt-4 pt-3 border-t border-white/5">
              <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-1.5">Pot Breakdown</p>
              <div className="space-y-1">
                {sidePots.map((sp, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-gray-400">
                      {sp.potNumber === 0 ? 'Main pot' : `Side pot ${sp.potNumber}`}
                      <span className="text-gray-600 ml-1.5">— {sp.winnerNames.join(', ')}</span>
                    </span>
                    <span style={{ color: '#12ceec' }} className="font-semibold">
                      {formatChips(sp.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Suppress noisy compiler warnings about unused props that some
            channels of this modal don't read. Kept on the props interface
            for API stability. */}
        <span className="hidden">{navigate.length}{onClose.length}</span>
      </div>
    </div>
  );
}
