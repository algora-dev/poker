import { useNavigate } from 'react-router-dom';

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

const SUIT_SYM: Record<string, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_CLR: Record<string, string> = { hearts: 'text-red-500', diamonds: 'text-red-500', clubs: 'text-gray-900', spades: 'text-gray-900' };

function MiniCard({ card, highlight }: { card: Card; highlight?: boolean }) {
  const color = SUIT_CLR[card.suit] || 'text-gray-900';
  return (
    <div className={`bg-white rounded w-8 h-11 flex flex-col items-center justify-center text-xs font-bold shadow ${highlight ? 'ring-2 ring-yellow-400' : ''}`}>
      <span className={color}>{card.rank}</span>
      <span className={`${color} text-[10px] -mt-0.5`}>{SUIT_SYM[card.suit]}</span>
    </div>
  );
}

export function ShowdownModal({
  isOpen, pot, sidePots, communityCards, players, winnerIds, currentUserId, onClose,
}: ShowdownModalProps) {
  const navigate = useNavigate();
  const formatChips = (c: string) => (parseInt(c) / 1_000_000).toFixed(2);

  const winner = players.find(p => p.isWinner);
  const losers = players.filter(p => !p.isWinner);
  const isCurrentPlayerWinner = winnerIds.includes(currentUserId);
  const isTie = winnerIds.length > 1;

  const isInBest5 = (card: Card, best: Card[]) => best.some(b => b.rank === card.rank && b.suit === card.suit);

  if (!isOpen || !winner) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-2">
      <div className="rounded-2xl border border-white/10 shadow-2xl w-full max-w-3xl" style={{background:'#262626'}}>
        {/* Header */}
        <div className="py-3 px-6 rounded-t-2xl flex items-center justify-between" style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}>
          <h2 className="text-xl font-bold text-white">
            {isTie ? 'TIE' : isCurrentPlayerWinner ? 'YOU WIN!' : `${winner.username} Wins!`}
          </h2>
          <div className="flex items-center gap-2">
            <img src="/assets/musd-chip.png" alt="" className="w-5 h-5" />
            <span className="text-white font-bold text-lg">{formatChips(pot)}</span>
          </div>
        </div>

        <div className="p-5">
          {/* Main layout: community cards + players side by side */}
          <div className="flex gap-5">
            {/* Left: Community cards + winning hand */}
            <div className="flex-1">
              {/* Community Cards */}
              <div className="mb-3">
                <p className="text-gray-500 text-xs mb-1.5">Community Cards</p>
                <div className="flex gap-1.5">
                  {communityCards.map((card, i) => (
                    <MiniCard key={i} card={card} highlight={isInBest5(card, winner.bestCards)} />
                  ))}
                </div>
              </div>

              {/* Winning hand info */}
              <div className="rounded-lg p-3 border" style={{background:'rgba(18,206,236,0.06)', borderColor:'rgba(18,206,236,0.2)'}}>
                <p className="text-xs font-bold mb-1.5" style={{color:'#12ceec'}}>{winner.handName}</p>
                <div className="flex gap-1.5">
                  {winner.holeCards.map((card, i) => (
                    <MiniCard key={i} card={card} highlight={isInBest5(card, winner.bestCards)} />
                  ))}
                </div>
                <p className="text-gray-500 text-[10px] mt-1">{winner.username}'s cards</p>
              </div>
            </div>

            {/* Right: All players' hands */}
            <div className="flex-1 space-y-2">
              <p className="text-gray-500 text-xs mb-1">All Hands</p>
              {players.map(p => (
                <div key={p.userId} className={`rounded-lg p-2.5 flex items-center justify-between border ${
                  p.isWinner ? 'border-cyan-500/30' : 'border-white/5'
                }`} style={{background:'rgba(255,255,255,0.03)'}}>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      {p.holeCards.map((card, i) => (
                        <MiniCard key={i} card={card} />
                      ))}
                    </div>
                    <div>
                      <p className={`text-sm font-medium ${p.isWinner ? 'text-white' : 'text-gray-400'}`}>
                        {p.username}{p.userId === currentUserId ? ' (You)' : ''}
                      </p>
                      <p className={`text-[10px] ${p.isWinner ? 'text-cyan-400' : 'text-gray-600'}`}>
                        {p.handName}
                      </p>
                    </div>
                  </div>
                  {p.isWinner && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{background:'rgba(18,206,236,0.15)', color:'#12ceec'}}>
                      Winner
                    </span>
                  )}
                </div>
              ))}

              {/* Side pots */}
              {sidePots && sidePots.length > 1 && (
                <div className="pt-2 border-t border-white/5 space-y-1">
                  {sidePots.map((sp, i) => (
                    <div key={i} className="flex justify-between text-xs text-gray-400">
                      <span>{sp.potNumber === 0 ? 'Main' : `Side ${sp.potNumber}`}: {sp.winnerNames.join(', ')}</span>
                      <span style={{color:'#12ceec'}}>{formatChips(sp.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
