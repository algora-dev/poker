import { useEffect } from 'react';
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

export function ShowdownModal({
  isOpen,
  pot,
  sidePots = [],
  communityCards,
  players,
  winnerIds,
  currentUserId,
  onClose,
}: ShowdownModalProps) {
  const navigate = useNavigate();

  const formatChips = (chips: string) => {
    return (parseInt(chips) / 1_000_000).toFixed(2);
  };

  const getSuitSymbol = (suit: string) => {
    const symbols: Record<string, string> = {
      hearts: '♥',
      diamonds: '♦',
      clubs: '♣',
      spades: '♠',
    };
    return symbols[suit] || suit;
  };

  const getSuitColor = (suit: string) => {
    return suit === 'hearts' || suit === 'diamonds' ? 'text-red-500' : 'text-gray-900';
  };

  const renderCard = (card: Card, isHighlighted: boolean = false) => {
    return (
      <div
        className={`
          relative inline-block w-16 h-24 bg-white rounded-lg shadow-lg border-2 mx-1
          ${isHighlighted ? 'border-yellow-400 ring-4 ring-yellow-300' : 'border-gray-300'}
        `}
      >
        <div className="absolute top-1 left-2 text-lg font-bold">
          <div className={getSuitColor(card.suit)}>{card.rank}</div>
        </div>
        <div className="absolute top-7 left-1/2 transform -translate-x-1/2 text-3xl">
          <span className={getSuitColor(card.suit)}>{getSuitSymbol(card.suit)}</span>
        </div>
        <div className="absolute bottom-1 right-2 text-lg font-bold rotate-180">
          <div className={getSuitColor(card.suit)}>{card.rank}</div>
        </div>
      </div>
    );
  };

  const currentPlayer = players.find(p => p.userId === currentUserId);
  const opponent = players.find(p => p.userId !== currentUserId);
  const winner = players.find(p => p.isWinner);
  const isCurrentPlayerWinner = currentPlayer?.isWinner || false;
  const isTie = winnerIds.length > 1;

  // Check if a card is in the best 5
  const isCardInBest5 = (card: Card, bestCards: Card[]) => {
    return bestCards.some(bc => bc.rank === card.rank && bc.suit === card.suit);
  };

  if (!isOpen || !currentPlayer || !opponent) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto border border-white/10" style={{background:'#262626'}}>
        {/* Header */}
        <div className="p-6 rounded-t-xl" style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}>
          <h2 className="text-3xl font-bold text-center text-white">
            {isTie ? 'TIE' : 'HAND COMPLETE'}
          </h2>
        </div>

        <div className="p-8 space-y-6">
          {/* Pot Display - Side Pots or Single Pot */}
          {sidePots && sidePots.length > 1 ? (
            <div className="rounded-xl border border-white/5 p-5 space-y-3" style={{background:'rgba(255,255,255,0.02)'}}>
              <h3 className="text-base font-bold text-white text-center">Multiple Pots Awarded</h3>
              {sidePots.map((sp, idx) => (
                <div key={idx} className="rounded-lg p-3 border border-white/5 flex justify-between items-center" style={{background:'rgba(255,255,255,0.03)'}}>
                  <div className="flex items-center gap-2">
                    <img src="/assets/musd-chip.png" alt="" className="w-5 h-5" />
                    <div>
                      <span className="text-white font-semibold text-sm">
                        {sp.potNumber === 0 ? 'Main Pot' : `Side Pot ${sp.potNumber}`}
                      </span>
                      <p className="text-[10px] text-gray-500">
                        Won by: {sp.winnerNames.join(', ')}
                      </p>
                    </div>
                  </div>
                  <span className="text-white font-bold" style={{color:'#12ceec'}}>
                    {formatChips(sp.amount)}
                  </span>
                </div>
              ))}
              <div className="text-center text-gray-400 text-xs pt-2 border-t border-white/5">
                Total: {formatChips(pot)}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-white/5 p-5 text-center" style={{background:'rgba(255,255,255,0.02)'}}>
              <p className="text-gray-500 text-sm mb-1">Total Pot</p>
              <div className="flex items-center justify-center gap-2">
                <img src="/assets/musd-chip.png" alt="" className="w-7 h-7" />
                <p className="text-3xl font-bold text-white">{formatChips(pot)}</p>
              </div>
            </div>
          )}

          {/* Winner Announcement */}
          <div className="text-center space-y-2">
            {isTie ? (
              <>
                <p className="text-2xl font-bold text-cyan-400">TIE! POT SPLIT</p>
                <p className="text-xl text-white">Split among {winnerIds.length} winners</p>
              </>
            ) : (
              <>
                <p className="text-3xl font-bold text-cyan-400">
                  {isCurrentPlayerWinner ? 'YOU WIN!' : `${winner?.username} WINS!`}
                </p>
                <p className="text-2xl text-white">
                  Won {formatChips(pot)} chips
                </p>
              </>
            )}
            <p className="text-xl text-yellow-300 font-semibold mt-4">
              ✨ {winner?.handName.toUpperCase()} ✨
            </p>
          </div>

          {/* Community Cards */}
          <div className="bg-green-950 bg-opacity-50 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-cyan-400 mb-3 text-center">Community Cards</h3>
            <div className="flex justify-center flex-wrap gap-2">
              {communityCards.map((card, idx) => (
                <div key={idx}>
                  {renderCard(card, isCardInBest5(card, winner?.bestCards || []))}
                </div>
              ))}
            </div>
          </div>

          {/* Winner's Hand */}
          <div className="bg-yellow-900 bg-opacity-30 rounded-xl p-6 border border-white/10">
            <h3 className="text-lg font-semibold text-cyan-400 mb-3 text-center">
              {winner?.username}'s Hand {winner?.isWinner && '👑'}
            </h3>
            <div className="flex justify-center flex-wrap gap-2 mb-4">
              {winner?.holeCards.map((card, idx) => (
                <div key={idx}>
                  {renderCard(card, isCardInBest5(card, winner.bestCards))}
                </div>
              ))}
            </div>
            <div className="text-center">
              <p className="text-white font-semibold">Best 5 Cards:</p>
              <div className="flex justify-center flex-wrap gap-1 mt-2">
                {winner?.bestCards.map((card, idx) => (
                  <span key={idx} className="text-yellow-300 font-mono">
                    {card.rank}{getSuitSymbol(card.suit)}
                    {idx < (winner.bestCards.length - 1) && ', '}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Loser's Hand (if not tie) */}
          {!isTie && (
            <div className="bg-gray-800 bg-opacity-30 rounded-xl p-6 border-2 border-gray-600">
              <h3 className="text-lg font-semibold text-gray-400 mb-3 text-center">
                {players.find(p => !p.isWinner)?.username}'s Hand
              </h3>
              <div className="flex justify-center flex-wrap gap-2 mb-4">
                {players.find(p => !p.isWinner)?.holeCards.map((card, idx) => (
                  <div key={idx}>
                    {renderCard(card, false)}
                  </div>
                ))}
              </div>
              <div className="text-center">
                <p className="text-gray-400 text-sm">
                  {players.find(p => !p.isWinner)?.handName}
                </p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-4 justify-center pt-4">
            <button
              onClick={() => navigate('/lobby')}
              className="px-8 py-4 bg-blue-600 text-white text-lg font-bold rounded-lg hover:bg-blue-700 transition shadow-lg"
            >
              Return to Lobby
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
