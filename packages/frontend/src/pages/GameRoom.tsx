import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api } from '../services/api';
import { useSocket } from '../hooks/useSocket';
import { playTurnNotification, showTurnNotification, requestNotificationPermission, initAudioContext } from '../utils/sounds';
import { ShowdownModal } from '../components/ShowdownModal';
import { PokerTable } from '../components/PokerTable';
import { DealAnimation } from '../components/DealAnimation';
import { useViewport } from '../hooks/useViewport';
import { computeSeatPositionsForViewport } from '../utils/seatLayout';
import { PokerTableMobile } from '../components/PokerTableMobile';
import { TurnTimer } from '../components/TurnTimer';
import { AudioToggle } from '../components/AudioToggle';
import { playCheckSound, playFoldSound, playBetSound, playCallSound, playWinSound, playLoseSound, playNextHandChime } from '../utils/gameAudio';
import { getAudioPrefs, subscribeAudioPrefs } from '../utils/audioPreferences';

interface PlayerInfo {
  userId: string;
  username: string;
  seatIndex: number;
  chipStack: string;
  holeCards: any[];
  position: string;
}

interface GameState {
  gameId: string;
  gameName: string;
  status: string;
  creatorId: string;
  smallBlind: string;
  bigBlind: string;
  pot: string;
  currentBet: string;
  amountToCall: string;
  stage: string;
  board: any[];
  playerCount: number;
  myPlayer: PlayerInfo;
  opponents: PlayerInfo[];
  opponent: PlayerInfo | null; // backward compat
  isMyTurn: boolean;
  activePlayerUserId?: string;
  turnStartedAt?: string;
  dealerSeatIndex?: number;
  sbSeatIndex?: number;
  bbSeatIndex?: number;
}

export default function GameRoom() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { socket, isConnected, joinGame: joinGameRoom, leaveGame: leaveGameRoom } = useSocket();
  const viewport = useViewport();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showRaiseModal, setShowRaiseModal] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState('');
  const [gameCompleted, setGameCompleted] = useState(false);
  const [showdownData, setShowdownData] = useState<any>(null);
  const [foldWinData, setFoldWinData] = useState<any>(null);
  const [nextHandCountdown, setNextHandCountdown] = useState<number | null>(null);
  // Between-hands flag (Shaun 2026-05-14). True from the moment a hand
  // ends (game:showdown / game:fold-win) until the next hand actually
  // starts (game:new-hand). While true, the felt is rendered with no
  // community cards and no hole cards so closing the result modal early
  // doesn't leave the previous hand's cards lingering, and the deal
  // animation feels like a single clean event rather than "twice".
  const [betweenHands, setBetweenHands] = useState<boolean>(false);
  // Pre-action queue (Shaun 2026-05-14 v1, expanded to 3 options 2026-05-15).
  // When set while it is NOT the player's turn, the moment turn arrives
  // the client auto-issues the queued action:
  //   'check'      — auto-check ONLY if amountToCall === 0. If anyone
  //                  raises before our turn, this auto-deselects (you
  //                  wouldn't want to surprise-call).
  //   'fold'       — auto-fold whatever the situation. Useful if you
  //                  know you're out regardless.
  //   'check_fold' — check if free, fold if anyone bets. The classic
  //                  pre-action button.
  // Mutually exclusive. Player can cancel by clicking the same button
  // again, or by switching to a different option. Cleared automatically
  // on hand end / stage change / leave / not-active-in-hand. (Shaun
  // 2026-05-15.)
  type PreAction = 'check' | 'fold' | 'check_fold' | null;
  const [preAction, setPreAction] = useState<PreAction>(null);
  // Track the stage we last saw so we can auto-clear pre-actions when
  // the betting round changes (preflop → flop, etc). Re-deciding on
  // each street is safer than carrying intent across rounds.
  const lastSeenStageRef = useRef<string | null>(null);
  const previousTurn = useRef<boolean>(false);
  // Track previous "eliminated" state for the local user so we play the
  // lose chime exactly once when they bust. Initialised null so the
  // initial state-load isn't treated as a transition.
  const wasEliminatedRef = useRef<boolean | null>(null);
  // betweenHands watchdog (Shaun 2026-05-15, Gerald audit-28).
  // When game:new-hand arrives we set a single one-shot timer; if
  // betweenHands is still true after 4s (deal animation worst-case
  // is ~3s for 8 seats), we force-flip it false so the UI never
  // gets stuck with hidden cards. Mobile portrait has NO
  // DealAnimation mounted, so this watchdog is the ONLY thing that
  // clears betweenHands on mobile new-hand. Cleared on every successful
  // animation onComplete + on unmount.
  const betweenHandsWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counter incremented on every game:new-hand. DealAnimation watches this
  // to (re)trigger the card-flick animation + per-card sound.
  // Deal-animation trigger key. NULL initial so the animation does NOT
  // fire on mount/remount (Gerald audit-26 [M-02]). It fires only when
  // we explicitly increment in response to game:started or game:new-hand.
  // DealAnimation's effect guards `if (triggerKey == null) return` so
  // null means "do nothing".
  const [dealTrigger, setDealTrigger] = useState<number | null>(null);

  // All-in fast-forward animated board reveal (Issue B, Shaun 2026-05-14).
  // When the server returns a showdown with fastForwardFromStage set,
  // we slice the final board down to the pre-fast-forward state and
  // reveal each remaining community card 1 second apart before showing
  // the showdown modal. Override stays null for natural showdowns.
  const [revealBoardOverride, setRevealBoardOverride] = useState<Array<{ rank: string; suit: string }> | null>(null);

  // Table zoom (Shaun 2026-05-14). Five preset levels at
  // 80 / 90 / 100 (default) / 110 / 120 percent. Persisted to
  // localStorage so a player's preferred zoom survives reloads.
  const ZOOM_LEVELS = [80, 90, 100, 110, 120] as const;
  const [tableZoom, setTableZoom] = useState<number>(() => {
    try {
      const stored = parseInt(localStorage.getItem('t3-table-zoom') || '100', 10);
      return ZOOM_LEVELS.includes(stored as any) ? stored : 100;
    } catch {
      return 100;
    }
  });
  const adjustZoom = (delta: 1 | -1) => {
    const idx = ZOOM_LEVELS.indexOf(tableZoom as any);
    const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + delta));
    const next = ZOOM_LEVELS[nextIdx];
    setTableZoom(next);
    try { localStorage.setItem('t3-table-zoom', String(next)); } catch { /* ignore */ }
  };
  // Subscribe to audio/UI preferences so toggling "Hand-result popups"
  // off immediately hides the modals (also stops them appearing for
  // future hands until re-enabled).
  const [audioPrefs, setAudioPrefs] = useState(() => getAudioPrefs());
  useEffect(() => subscribeAudioPrefs(setAudioPrefs), []);

  // Play the lose chime when the local user becomes eliminated
  // (chip stack hits 0, can no longer play). Fires once per elimination.
  useEffect(() => {
    const isEliminated = gameState?.myPlayer?.position === 'eliminated';
    if (wasEliminatedRef.current === false && isEliminated) {
      try { playLoseSound(); } catch { /* ignore */ }
    }
    if (isEliminated !== undefined) {
      wasEliminatedRef.current = isEliminated;
    }
  }, [gameState?.myPlayer?.position]);
  // When the user disables popups mid-hand, clear any currently-open
  // hand-result modals so the table is immediately usable.
  useEffect(() => {
    if (!audioPrefs.popups) {
      setFoldWinData(null);
      setShowdownData(null);
    }
  }, [audioPrefs.popups]);
  // Pre-action auto-fire + auto-clear logic (Shaun 2026-05-14 v1,
  // expanded to 3 options 2026-05-15).
  //   1. If player is no longer active in the hand → clear.
  //   2. If queued 'check' and anyone has raised (currentBet > 0 and we
  //      owe to call) → auto-deselect. You queued a check; we won't
  //      surprise-call you.
  //   3. If stage changed (preflop → flop, etc) → clear all pre-actions.
  //      Each street is a fresh decision.
  //   4. If between hands → clear (already-completed hand context).
  //   5. If it's now my turn AND a pre-action is queued → fire the
  //      mapped live action and clear.
  useEffect(() => {
    if (!gameState) return;
    const pos = gameState.myPlayer?.position;
    if (pos === 'folded' || pos === 'eliminated' || pos === 'all_in') {
      if (preAction !== null) setPreAction(null);
      return;
    }

    // (2) Auto-deselect 'check' when anyone has raised the action.
    const owesAny = parseInt(gameState.amountToCall || '0') > 0;
    if (preAction === 'check' && owesAny) {
      setPreAction(null);
      return;
    }

    // (3) Stage change → clear all pre-actions.
    const stageNow = gameState.stage ?? null;
    if (
      lastSeenStageRef.current !== null &&
      stageNow !== null &&
      lastSeenStageRef.current !== stageNow &&
      preAction !== null
    ) {
      setPreAction(null);
      lastSeenStageRef.current = stageNow;
      return;
    }
    if (stageNow !== null) lastSeenStageRef.current = stageNow;

    // (4) Between hands → clear.
    if (betweenHands && preAction !== null) {
      setPreAction(null);
      return;
    }

    // (5) Fire queued action on turn arrival.
    if (gameState.isMyTurn && preAction !== null) {
      let next: 'check' | 'fold' | null = null;
      if (preAction === 'check_fold') {
        next = owesAny ? 'fold' : 'check';
      } else if (preAction === 'check') {
        // Should already be cleared if owesAny became true (see (2)),
        // but defensive: only fire check if it's actually legal.
        next = owesAny ? null : 'check';
      } else if (preAction === 'fold') {
        next = 'fold';
      }
      setPreAction(null);
      if (next) handleAction(next);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gameState?.isMyTurn,
    gameState?.myPlayer?.position,
    gameState?.amountToCall,
    gameState?.stage,
    betweenHands,
  ]);
  // Final standings snapshot captured BEFORE closeGame zeroes every chipStack.
  // closeGame refunds in-table chipStack back to off-table ChipBalance and
  // writes 0 to every GamePlayer.chipStack ÔÇö so the post-close gameState
  // legitimately shows everyone at 0. We keep the last in-progress stacks
  // here so the Game Over modal can show meaningful final standings.
  const finalStandingsRef = useRef<Array<{ userId: string; username: string; chipStack: string }> | null>(null);
  const [finalStandings, setFinalStandings] = useState<Array<{ userId: string; username: string; chipStack: string }> | null>(null);

  // Snapshot the last meaningful (non-zero) stacks so the Game Over modal
  // can render real final standings even after closeGame zeroes chipStack.
  // Fires on EVERY state push while game is still in_progress; the last
  // one before status flips to 'completed' wins.
  const captureFinalStandingsIfNeeded = (state: any) => {
    if (!state) return;
    if (state.status !== 'in_progress') return;
    const allPlayers = [state.myPlayer, ...(state.opponents || [])].filter(Boolean);
    if (allPlayers.length === 0) return;
    const totalChips = allPlayers.reduce(
      (sum: number, p: any) => sum + parseFloat(p.chipStack || '0'),
      0
    );
    if (totalChips <= 0) return;
    const snap = allPlayers.map((p: any) => ({
      userId: p.userId,
      username: p.username,
      chipStack: p.chipStack,
    }));
    finalStandingsRef.current = snap;
    setFinalStandings(snap);
  };

  // Load game state
  const loadGameState = async (showLoader = false) => {
    if (!gameId) return;

    try {
      if (showLoader) setLoading(true);
      const response = await api.get(`/api/games/${gameId}/state`);
      captureFinalStandingsIfNeeded(response.data);
      setGameState(response.data);
      setError('');
      
      // Don't auto-set gameCompleted - only showdown event should do that
      // (Otherwise old modal shows instead of showdown modal)
      
      // Detect turn change - play notification if it just became your turn
      const isNowMyTurn = response.data.isMyTurn;
      const wasMyTurn = previousTurn.current;
      
      if (isNowMyTurn && !wasMyTurn && !loading) {
        // Turn just switched to you!
        playTurnNotification();
        showTurnNotification();
      }
      
      previousTurn.current = isNowMyTurn;
    } catch (err: any) {
      console.error('Load game state error:', err);
      const status = err.response?.status;
      const msg = err.response?.data?.message || '';

      // Server says we're not in this game (404, or explicit 'You are not
      // in this game'). This used to fall through silently, leaving the
      // UI rendering stale gameState.myPlayer at the bottom of the table
      // forever (the 'phantom seat' bug Shaun hit 2026-05-11 ÔÇö he saw
      // himself + no bots even though server-side only the bots were
      // seated). Bounce to lobby instead.
      const notInGame =
        status === 404 ||
        /not in this game/i.test(msg) ||
        /game not found/i.test(msg);
      if (notInGame) {
        setGameState(null);
        navigate('/lobby');
        return;
      }

      // Only show error if we don't have any game state yet (initial load).
      // Don't kick player out for transient refresh errors.
      if (!gameState) {
        setError(msg || 'Failed to load game');
      }
    } finally {
      setLoading(false);
    }
  };

  // FALLBACK POLLING: if socket fails, poll every 15 seconds as safety net
  useEffect(() => {
    if (!gameId || !gameState || gameState.status !== 'in_progress') return;
    const interval = setInterval(() => {
      loadGameState();
    }, 15000);
    return () => clearInterval(interval);
  }, [gameId, gameState?.status]);

  useEffect(() => {
    loadGameState(true); // Show loader on initial load only
    
    // Request notification permission
    requestNotificationPermission();
  }, [gameId]);

  // Real-time updates
  useEffect(() => {
    if (!socket || !gameId) return;

    // Join game room. Use the hook helper (not raw emit) so the room
    // is tracked in activeGameRooms and auto-rejoined on reconnect.
    joinGameRoom(gameId);

    // On reconnect, rejoin room and reload state. The hook already
    // re-emits join:game on its own connect handler, but we add this
    // belt-and-braces refetch so stale UI snaps back into sync.
    const onReconnect = () => {
      joinGameRoom(gameId);
      loadGameState();
    };
    socket.on('connect', onReconnect);

    // Instant action event ÔÇö update everything from socket data directly.
    //
    // Playtest 2026-05-11 surfaced two UX bugs in this merge path:
    //   (a) "Your turn" alert fired up to 5s late because it was only
    //       wired into the polling loadGameState(), not the socket push.
    //   (b) Check->Call flicker on the action buttons: when a peer raised
    //       just before our turn, the UI briefly showed Check (because
    //       amountToCall was still 0 from before the merge applied) and
    //       then snapped to Call. Cause was that React batched setState
    //       didn't apply atomically with the alert-firing block; we now
    //       compute the new my-state in one place and use it for both.
    socket.on('game:action', (data: any) => {
      // Per-action sound for all players in the room.
      // - check     ÔåÆ knock-knock
      // - fold      ÔåÆ soft thud + paper slide
      // - bet/raise ÔåÆ chip cascade
      // - call      ÔåÆ two chip clicks
      // - all-in    ÔåÆ bigger chip cascade (re-use bet sound)
      switch (data?.action) {
        case 'check': playCheckSound(); break;
        case 'fold':  playFoldSound();  break;
        case 'bet':
        case 'raise':
        case 'all-in': playBetSound(); break;
        case 'call':  playCallSound();  break;
      }

      let firedTurnAlert = false;
      setGameState(prev => {
        if (!prev) return prev;

        const newCurrentBet = data.currentBet || prev.currentBet;
        const isNowMyTurn = data.nextPlayer === user?.id;
        const wasMyTurn = prev.isMyTurn;

        // Update opponents' last action + chip-on-felt amount.
        const updatedOpponents = prev.opponents?.map((o: any) => ({
          ...o,
          lastAction: o.userId === data.userId ? data.action : o.lastAction,
          currentStageBet: o.userId === data.userId && data.actionAmount
            ? String(parseInt(o.currentStageBet || '0') + parseInt(data.actionAmount || '0'))
            : o.currentStageBet,
        })) || [];

        // Update my player. If I'm the one who acted, record my lastAction
        // + grow my own stage bet by data.actionAmount. If a NEW turn just
        // landed on me (peer's action made me active), clear any stale
        // lastAction from this hand so the action label doesn't briefly
        // misrepresent the current button state.
        let updatedMyPlayer = prev.myPlayer;
        if (data.userId === prev.myPlayer.userId) {
          updatedMyPlayer = {
            ...prev.myPlayer,
            lastAction: data.action,
            currentStageBet: data.actionAmount
              ? String(parseInt(prev.myPlayer.currentStageBet || '0') + parseInt(data.actionAmount || '0'))
              : prev.myPlayer.currentStageBet,
          };
        } else if (isNowMyTurn && !wasMyTurn) {
          // New turn landed on us. Clear stale lastAction so we don't show
          // "Check" on our seat while the Call button is mid-flicker.
          updatedMyPlayer = { ...prev.myPlayer, lastAction: null };
        }

        // Always recompute amountToCall when it's our turn, from the
        // authoritative new currentBet + our latest stage contribution.
        // This is what closes the check->call flicker for good.
        const myStageBet = parseInt(updatedMyPlayer.currentStageBet || '0');
        const newCurrentBetN = parseInt(newCurrentBet || '0');
        const amountToCall = isNowMyTurn
          ? String(Math.max(0, newCurrentBetN - myStageBet))
          : prev.amountToCall;

        // Instant turn-alert: socket-driven, no 0-5s polling delay.
        if (isNowMyTurn && !wasMyTurn) {
          firedTurnAlert = true;
        }

        return {
          ...prev,
          isMyTurn: isNowMyTurn,
          activePlayerUserId: data.nextPlayer || prev.activePlayerUserId,
          pot: data.pot || prev.pot,
          currentBet: newCurrentBet,
          amountToCall,
          stage: data.stage || prev.stage,
          myPlayer: updatedMyPlayer,
          opponents: updatedOpponents,
        };
      });

      // Side-effect after the state commit, NOT inside the reducer (no
      // double-fires under StrictMode).
      if (firedTurnAlert) {
        previousTurn.current = true;
        try { playTurnNotification(); } catch { /* audio context not ready */ }
        try { showTurnNotification(); } catch { /* notifications denied */ }
      }

      // Full state refresh handled by game:state broadcast from server
    });

    // Full game state from server. Fire the turn alert here too ÔÇö
    // game:state pushes can arrive before/instead of game:action when the
    // server broadcasts a fresh personalized state, so without this the
    // alert can still feel laggy. previousTurn.current acts as a 1-trip
    // dedupe key, matching the game:action path.
    socket.on('game:state', (state: any) => {
      if (!state) return;
      const wasMyTurn = previousTurn.current;
      const isNowMyTurn = !!state.isMyTurn;
      captureFinalStandingsIfNeeded(state);
      setGameState(state);
      setLoading(false);
      if (isNowMyTurn && !wasMyTurn) {
        previousTurn.current = true;
        try { playTurnNotification(); } catch { /* audio context not ready */ }
        try { showTurnNotification(); } catch { /* notifications denied */ }
      } else if (!isNowMyTurn && wasMyTurn) {
        previousTurn.current = false;
      }
    });

    socket.on('game:started', () => {
      // First hand of a freshly-started match. Chime + deal animation
      // fire AT THE SAME INSTANT (Shaun 2026-05-14 update: previous
      // 2s gap felt too long). Cards stay hidden via betweenHands
      // until the animation's onComplete flips it false.
      //
      // Flip betweenHands BEFORE the state load completes so there's
      // no flash of cards-already-on-felt during the chime.
      setBetweenHands(true);
      loadGameState();
      try { playNextHandChime(); } catch { /* audio not ready */ }
      setDealTrigger(t => (t ?? 0) + 1);
    });

    socket.on('player:joined', (data: any) => {
      // Playtest 2026-05-13: creator could not see joiners until manual
      // refresh. Belt-and-braces: server now also pushes a full game:state
      // on join (see api/games/index.ts).
      //
      // PLAYTEST 2026-05-15 follow-up (Shaun, CeceVsShaunV4): bug
      // RE-APPEARED. Root cause this time: the two HTTP loadGameState()
      // calls (immediately + at 500ms) were racing the socket-pushed
      // game:state. HTTP reads can hit the read-replica and return
      // STALE playerCount=1 just after the join transaction committed
      // (replication lag), then setGameState() with the stale payload
      // OVERWROTE the fresh socket-pushed state. The creator's UI then
      // showed playerCount=1 until manual refresh.
      //
      // FIX: trust the socket-pushed game:state push. Only HTTP-refetch
      // as a last-resort fallback at 1.2s, and ONLY if our local
      // playerCount is still below what the player:joined event told
      // us. If the broadcastGameState push has already updated us,
      // we'll see the new playerCount and skip the HTTP call entirely
      // — no clobbering.
      const expectedCount = typeof data?.playerCount === 'number' ? data.playerCount : null;
      setTimeout(() => {
        setGameState(curr => {
          const have = curr?.playerCount ?? 0;
          if (expectedCount !== null && have >= expectedCount) {
            // Socket push beat us — already up to date. Leave it alone.
            return curr;
          }
          // Fallback: socket push didn't arrive or carried a stale
          // count. Trigger an HTTP refetch (outside this updater).
          // Use Promise.resolve so we don't run an effect inside the
          // setState callback.
          Promise.resolve().then(() => loadGameState());
          return curr;
        });
      }, 1_200);
    });

    socket.on('game:showdown', (data: any) => {
      // Win/lose sound (fires immediately regardless of fast-forward).
      try {
        const winnerIds: string[] = Array.isArray(data?.winnerIds) ? data.winnerIds : [];
        const myId = user?.id;
        if (myId && winnerIds.includes(myId)) {
          playWinSound();
        } else if (myId && Array.isArray(data?.players)) {
          const meAtShowdown = data.players.some((p: any) => p.userId === myId);
          if (meAtShowdown) playLoseSound();
        }
      } catch { /* ignore */ }

      // FAST-FORWARD ANIMATED STREET REVEAL (Issue B, Shaun 2026-05-14).
      // If the server fast-forwarded through one or more streets (all-in
      // scenario), reveal each remaining community card 1s apart, with
      // a chime per card, BEFORE showing the showdown modal. The player
      // sees the streets play out as if the hand ran normally.
      const ff: 'preflop' | 'flop' | 'turn' | undefined = data?.fastForwardFromStage;
      const allCommunity: Array<{ rank: string; suit: string }> = Array.isArray(data?.communityCards) ? data.communityCards : [];
      const REVEAL_STEP_MS = 1000;
      if ((ff === 'preflop' || ff === 'flop' || ff === 'turn') && allCommunity.length === 5) {
        // Compute the pre-FF board (cards already on felt when FF started).
        // preflop → 0 cards; flop → 3 cards; turn → 4 cards.
        const preFfCount = ff === 'preflop' ? 0 : ff === 'flop' ? 3 : 4;
        const preFf = allCommunity.slice(0, preFfCount);
        setBetweenHands(false); // make the felt visible so we can paint board
        setRevealBoardOverride(preFf);

        // Schedule each reveal step. Flop reveals 3 cards together (1
        // step); turn and river each 1 card.
        const steps: Array<Array<{ rank: string; suit: string }>> = [];
        if (ff === 'preflop') {
          steps.push(allCommunity.slice(0, 3)); // flop
          steps.push(allCommunity.slice(0, 4)); // turn
          steps.push(allCommunity.slice(0, 5)); // river
        } else if (ff === 'flop') {
          steps.push(allCommunity.slice(0, 4)); // turn
          steps.push(allCommunity.slice(0, 5)); // river
        } else {
          steps.push(allCommunity.slice(0, 5)); // river
        }
        const totalDuration = steps.length * REVEAL_STEP_MS + REVEAL_STEP_MS; // +1s pause before modal
        steps.forEach((boardAtStep, i) => {
          setTimeout(() => {
            setRevealBoardOverride(boardAtStep);
            try { playNextHandChime(); } catch { /* ignore */ }
          }, (i + 1) * REVEAL_STEP_MS);
        });
        // After all cards revealed + 1s pause: show the modal and
        // restore the normal board source (gameState.board).
        setTimeout(() => {
          setShowdownData(data);
          setBetweenHands(true);
          setRevealBoardOverride(null);
        }, totalDuration);
      } else {
        // No fast-forward (natural river→showdown) OR malformed data:
        // show the modal immediately, same as before.
        setShowdownData(data);
        setBetweenHands(true);
      }
    });

    socket.on('game:completed', (data: any) => {
      // Backend authoritative final standings (winner + cashout amounts).
      // Replaces the mid-hand chipStack snapshot we'd otherwise display
      // on the Game Over screen, which could be wrong on all-in fast-
      // forward (Shaun 2026-05-13: "bot won 5 chips" while Shaun actually
      // won the whole 20-chip pot with pocket jacks).
      if (Array.isArray(data?.standings) && data.standings.length > 0) {
        finalStandingsRef.current = data.standings;
        setFinalStandings(data.standings);
      }
    });

    socket.on('game:fold-win', (data: any) => {
      setFoldWinData(data);
      setBetweenHands(true);
      // Only the winner hears the win chime on fold-win. Folders are
      // not considered "losers" ÔÇö they chose to fold.
      try {
        if (data?.winnerId && user?.id && data.winnerId === user.id) {
          playWinSound();
        }
      } catch { /* ignore */ }
    });

    socket.on('game:next-hand-countdown', (data: any) => {
      // Start countdown timer. Backend currently emits seconds=10
      // (Shaun playtest 2026-05-14). The fallback default is kept high
      // so a misconfigured event doesn't show a 0-second flash.
      let remaining = data.seconds || 10;
      setNextHandCountdown(remaining);
      const interval = setInterval(() => {
        remaining--;
        setNextHandCountdown(remaining);
        if (remaining <= 0) clearInterval(interval);
      }, 1000);
    });

    socket.on('game:next-hand-chime', () => {
      // Three-tone airport-style chime fired when the inter-hand
      // countdown reaches zero. ~2s before the deal animation begins.
      try { playNextHandChime(); } catch { /* audio not ready */ }
    });

    socket.on('game:new-hand', (_payload?: { handId?: string | null }) => {
      // New hand actually starting. The 10s countdown and chime have
      // already fired (game:next-hand-chime arrived ~2s ago). Now we
      // trigger the deal animation. betweenHands STAYS true here so
      // the felt remains clean while the animation plays; we only flip
      // it false on the animation's onComplete callback so cards appear
      // exactly when the last animated card lands.
      // 2026-05-13 (Shaun): showdown / fold-win modals must NOT auto-close
      // when the next hand starts — players need time to read the winning
      // hand. Only the modal's own "Play Next Hand" / "Leave" buttons,
      // and the audioPrefs.popups toggle, may close it.
      setGameCompleted(false);
      setNextHandCountdown(null);
      setDealTrigger(t => (t ?? 0) + 1); // trigger deal animation
      // State arrives via broadcastGameState which the server now sends
      // BEFORE this event (Gerald audit-28). Even so, install a 4s
      // watchdog so the UI never gets stuck on betweenHands=true if the
      // animation aborts or (on mobile portrait) is never mounted.
      if (betweenHandsWatchdogRef.current) {
        clearTimeout(betweenHandsWatchdogRef.current);
      }
      betweenHandsWatchdogRef.current = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.warn('[betweenHands watchdog] forcing false 4s after game:new-hand');
        setBetweenHands(false);
        betweenHandsWatchdogRef.current = null;
      }, 4_000);
    });

    socket.on('game:turn-warning', () => {
      // Timer warning ÔÇö no reload needed, frontend timer handles display
    });

    return () => {
      // IMPORTANT: do NOT call bare `socket.off('connect')` here.
      // The socket is a module-level singleton in useSocket.ts and
      // `off('connect')` with no handler strips ALL connect listeners,
      // including the hook's own reconnect/rejoin logic. Always pass
      // the specific handler reference so we only remove ours.
      // (Gerald audit-25, 2026-05-14.)
      socket.off('connect', onReconnect);
      socket.off('game:action');
      socket.off('game:updated');
      socket.off('game:state');
      socket.off('game:started');
      socket.off('player:joined');
      socket.off('game:fold-win');
      socket.off('game:showdown');
      socket.off('game:completed');
      socket.off('game:new-hand');
      socket.off('game:next-hand-countdown');
      socket.off('game:next-hand-chime');
      socket.off('game:turn-warning');
      if (betweenHandsWatchdogRef.current) {
        clearTimeout(betweenHandsWatchdogRef.current);
        betweenHandsWatchdogRef.current = null;
      }
      leaveGameRoom(gameId);
    };
  }, [socket, gameId]);

  const formatChips = (chips: string) => {
    return (parseInt(chips) / 1_000_000).toFixed(2);
  };

  const handleAction = async (action: string, raiseAmt?: number) => {
    if (!gameId) return;

    // Initialize audio on first click
    initAudioContext();

    setActionLoading(true);
    setError('');

    // Immediately mark as not-my-turn so buttons hide instantly
    setGameState(prev => prev ? ({ ...prev, isMyTurn: false }) : prev);

    try {
      await api.post(`/api/games/${gameId}/action`, {
        action,
        raiseAmount: raiseAmt,
      });
      // Socket.io will handle state updates
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${action}`);
      console.error('Action error:', err);
      // Restore turn if action failed
      loadGameState();
    } finally {
      setActionLoading(false);
    }
  };

  const handleFold = () => handleAction('fold');
  const handleCheck = () => handleAction('check');
  const handleCall = () => handleAction('call');
  
  const handleRaiseClick = () => {
    setShowRaiseModal(true);
    setRaiseAmount((parseFloat(gameState?.currentBet || '0') / 1_000_000 * 2).toFixed(2));
  };

  const handleRaiseConfirm = () => {
    setShowRaiseModal(false);
    handleAction('raise', parseFloat(raiseAmount));
  };

  const handleCancelGame = async () => {
    if (!gameId) return;
    
    if (!confirm('Are you sure you want to cancel this game? Your buy-in will be refunded.')) {
      return;
    }

    try {
      await api.post(`/api/games/${gameId}/cancel`);
      navigate('/lobby');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to cancel game');
    }
  };

  /**
   * Leave the table.
   *
   *  - waiting status: chips are refunded immediately to off-table balance.
   *    If you're the last player, the game is cancelled.
   *  - in_progress status: you forfeit any open-hand commitments, but your
   *    remaining chip stack is paid out when the game ends. This unblocks
   *    your account so you can join other games / withdraw, once the
   *    server-side active-game lock releases (i.e. once the table
   *    eventually closes via natural completion or admin cancel).
   *
   * The leave button used to just `navigate('/lobby')` which left the
   * GamePlayer row intact server-side, locking the user out of new games
   * with the very confusing error "You are already in this game". Reported
   * by Shaun 2026-05-11.
   */
  const handleLeaveGame = async () => {
    if (!gameId) return;

    const status = gameState?.status;
    const message = status === 'in_progress'
      ? 'Leave the table?\n\nYou will forfeit the current hand. Your remaining chips will be paid out when the game ends (you stay seated until then).'
      : 'Leave the table? Your buy-in will be refunded.';

    if (!confirm(message)) return;

    try {
      await api.post(`/api/games/${gameId}/leave`);
      // Disconnect from the socket room politely on the way out so peers
      // get an updated player list without waiting for socket timeout.
      try { socket?.emit('leave:game', gameId); } catch { /* socket may be down */ }
      navigate('/lobby');
    } catch (err: any) {
      // 400 with a message means the server rejected a leave (e.g.
      // mid-stuck state); fall back to navigating anyway so the user
      // isn't trapped in the room. The lobby's 'You are already in this
      // game' guard will surface the truth.
      const msg = err.response?.data?.message || 'Failed to leave table';
      setError(msg);
      // Still navigate — better UX than trapping the user.
      navigate('/lobby');
    }
  };

  // formatCard helper removed 2026-05-14: was unused and contained
  // mojibaked suit symbols. All card rendering goes through
  // <PlayingCard/> now (see components/PlayingCard.tsx).

  if (!user) {
    navigate('/login');
    return null;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading game...</div>
      </div>
    );
  }

  if (error || !gameState) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex items-center justify-center">
        <div className="rounded-2xl p-8 max-w-md border border-white/10 shadow-2xl" style={{background:'#262626'}}>
          <h2 className="text-2xl font-bold text-white mb-4">Error</h2>
          <p className="text-gray-300 mb-6">{error || 'Game not found'}</p>
          <button
            onClick={() => navigate('/lobby')}
            className="w-full px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  // Eliminated player → spectator mode (Shaun 2026-05-15, Gerald audit-28).
  //
  // PREVIOUSLY: when the local player was marked eliminated, this branch
  // returned a full-screen "You've Been Eliminated" card that REPLACED
  // the table. That unmounted the showdown modal, the fast-forward
  // street reveal, the fold-win modal — anything in flight. Cece's
  // playtest report: she went all-in, busted, and immediately got the
  // eliminated screen WITHOUT ever seeing who won or what happened.
  //
  // NEW BEHAVIOUR: keep the table mounted. The per-seat plate already
  // renders "ELIMINATED" status (PokerTable + PokerTableMobile both
  // know how to suppress action/pre-action buttons for eliminated
  // players). A small dismissible banner is rendered below the header
  // so eliminated players are reminded they're out, and they get a
  // single-click Leave button right where the live Leave button used
  // to be. Auto-leave on elimination is deliberately NOT wired:
  // leaveGame has accounting implications and must stay user-triggered.
  // (Gerald audit-28 sign-off.)

  // Show game completed screen.
  // Playtest 2026-05-13 fix: in a heads-up game, when opponent folds the
  // game.status flips to 'completed' AND a fold-win event fires. Previously
  // this branch ran first and replaced the table with the Game Over screen,
  // so the fold-win modal never rendered. We now defer Game Over while a
  // fold-win or showdown modal is on screen so the player sees the hand
  // result first, dismisses it, then sees Game Over.
  if (gameState?.status === 'completed' && !foldWinData && !showdownData) {
    // Prefer the pre-close snapshot (real stacks). Fall back to current
    // gameState only if no snapshot was captured (shouldn't happen in
    // normal play but keeps the modal renderable).
    const allPlayers =
      finalStandings ?? finalStandingsRef.current
        ? (finalStandings ?? finalStandingsRef.current)!
        : ([gameState.myPlayer, ...(gameState.opponents || [])] as any);
    return (
      <div className="min-h-screen flex items-center justify-center" style={{background:'#262626'}}>
        <div className="rounded-2xl p-8 max-w-md w-full mx-4 border border-white/10 shadow-2xl" style={{background:'rgba(255,255,255,0.03)'}}>
          <div className="text-center mb-6">
            <div className="w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-3" style={{background:'linear-gradient(135deg, rgba(18,206,236,0.15), rgba(156,81,255,0.15))'}}>
              <img src="/assets/musd-chip.png" alt="" className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-bold text-white">Game Over</h2>
            <p className="text-gray-500 text-sm mt-1">Final standings</p>
          </div>
          
          <div className="space-y-2 mb-6">
            {allPlayers
              .sort((a, b) => parseFloat(b.chipStack) - parseFloat(a.chipStack))
              .map((p, i) => (
                <div key={p.userId} className="flex justify-between items-center rounded-lg p-3 border" style={{background:'rgba(255,255,255,0.03)', borderColor: i === 0 ? 'rgba(18,206,236,0.3)' : 'rgba(255,255,255,0.05)'}}>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs w-4">{i + 1}.</span>
                    <span className={`text-sm font-medium ${i === 0 ? 'text-white' : 'text-gray-400'}`}>
                      {p.username}{p.userId === user?.id ? ' (You)' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <img src="/assets/musd-logo.png" alt="" className="w-3.5 h-3.5" />
                    <span className={`text-sm font-bold ${i === 0 ? 'text-white' : 'text-gray-400'}`} style={i === 0 ? {color:'#12ceec'} : {}}>
                      {formatChips(p.chipStack)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
          
          <button
            onClick={() => navigate('/lobby')}
            className="w-full py-3 text-white font-semibold rounded-xl hover:opacity-90 transition active:scale-[0.98]"
            style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{background:'#262626'}}>
      {/* Top padding 2026-05-13: top-centre seats anchored at felt rail
          y=8% render their meta column ABOVE that line; at 8-handed the
          top row was getting cut off by the page header.
          2026-05-15 Shaun playtest: previous pt-24/28 forced the table
          so far down the page that even at min zoom the action bar
          went off-screen and required scrolling every turn. Cut to
          ~50%; the deal animation + top-row seats still clear the
          header cleanly because the avatar+plate sit BELOW the felt
          rail at top seats since the 2026-05-14 horizontal layout. */}
      <div className="max-w-6xl mx-auto px-2 sm:px-4 pt-12 sm:pt-14 pb-2 sm:pb-4">
        {/* Eliminated banner (Shaun 2026-05-15). Sits at the very top
            of the in-game view so the player can keep watching the
            action play out below. Dismissible — only re-appears on
            page reload. Leave button takes them back to the lobby. */}
        {gameState?.myPlayer.position === 'eliminated' && gameState?.status === 'in_progress' && (
          <EliminatedBanner onLeave={handleLeaveGame} />
        )}

        {/* Header */}
        <div className="flex justify-between items-center mb-3 sm:mb-4">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold text-white">{gameState.gameName}</h1>
            <p className="text-gray-500 text-xs sm:text-sm">
              Blinds: {formatChips(gameState.smallBlind)} / {formatChips(gameState.bigBlind)}
            </p>
            {/* Pre-action status text was previously rendered HERE, under
                the blinds line. It caused the table to shift down by a
                line whenever a player queued a pre-action because the
                text claimed extra header height (Shaun playtest
                2026-05-15). The status info is now rendered INSIDE the
                PreActionBar itself (which lives in the fixed-position
                action-bar slot), so the table layout no longer reflows. */}
          </div>
          <div className="flex gap-2 items-center">
            <AudioToggle variant="compact" />
            {/* Table size +/- (Shaun 2026-05-14). Adjusts CSS transform
                on the table wrapper. Persisted per-browser via
                localStorage. 80 / 90 / 100 (default) / 110 / 120. */}
            <div className="flex items-center gap-0.5 rounded-lg border border-white/10 px-1" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <button
                onClick={() => adjustZoom(-1)}
                disabled={tableZoom === ZOOM_LEVELS[0]}
                title="Decrease table size to suit your screen"
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition w-6 h-7 flex items-center justify-center text-base font-semibold leading-none"
              >
                {'\u2212' /* MINUS SIGN */}
              </button>
              <span className="text-[10px] text-gray-500 tabular-nums px-1 min-w-[2.25rem] text-center">{tableZoom}%</span>
              <button
                onClick={() => adjustZoom(1)}
                disabled={tableZoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
                title="Increase table size to suit your screen"
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition w-6 h-7 flex items-center justify-center text-base font-semibold leading-none"
              >
                +
              </button>
            </div>
            {gameState.status === 'waiting' && (gameState.playerCount || 1) <= 1 && (
              <button
                onClick={handleCancelGame}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition text-sm"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleLeaveGame}
              className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition text-sm"
            >
              Leave
            </button>
          </div>
        </div>

        {/* Waiting for Players */}
        {gameState.status === 'waiting' && (
          <div className="mb-6 rounded-xl p-6 border" style={{background:'rgba(18,206,236,0.06)', borderColor:'rgba(18,206,236,0.2)'}}>
            <h2 className="text-2xl font-bold text-white text-center mb-4">
              {'\u23F3'} Waiting for Players... ({gameState.playerCount || 1}/9)
            </h2>
            
            {/* Show different UI for creator vs other players */}
            {gameState.myPlayer.userId === gameState.creatorId ? (
              // Creator view
              <>
                <p className="text-gray-300 text-center mb-4">
                  Share this game with friends, or click Start Game when ready (minimum 2 players)
                </p>
                <div className="flex justify-center">
                  <button
                    onClick={async () => {
                      try {
                        await api.post(`/api/games/${gameId}/start`);
                        await loadGameState();
                      } catch (err: any) {
                        setError(err.response?.data?.message || 'Failed to start game');
                      }
                    }}
                    disabled={(gameState.playerCount || 1) < 2}
                    className="px-8 py-4 text-white text-lg font-bold rounded-xl hover:opacity-90 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
                    style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                  >
                    Start Game Now
                  </button>
                </div>
                {(gameState.playerCount || 1) < 2 ? (
                  <p className="text-yellow-400 text-center mt-2 text-sm">
                    Need at least 2 players to start
                  </p>
                ) : (
                  <p className="text-gray-500 text-center mt-2 text-xs">
                    Game will auto-start in 2 minutes if not started manually
                  </p>
                )}
              </>
            ) : (
              // Other players view
              <>
                <p className="text-gray-300 text-center mb-4 text-lg">
                  {'\u23F3'} Waiting for host to start the game...
                </p>
                <p className="text-yellow-400 text-center text-sm">
                  Game will auto-start in 2 minutes
                </p>
              </>
            )}
          </div>
        )}



        {/* Global turn-timer overlay (renders nothing when not
            in-progress / no turnStartedAt). Glow + big countdown only
            when it's the local user's turn AND <=10s remain. */}
        {gameState.status === 'in_progress' && (
          <TurnTimer
            turnStartedAt={gameState.turnStartedAt || null}
            isMyTurn={gameState.isMyTurn}
          />
        )}

        {/* Poker Table — mobile portrait gets a custom stacked layout
            (PokerTableMobile); everything else gets the oval (PokerTable).
            DealAnimation overlay only mounts for the oval since the mobile
            stacked layout has its own dealing presentation.

            Wrapped in a transform: scale(tableZoom/100) container so the
            user-adjustable zoom buttons in the header (80/90/100/110/120)
            resize the entire table proportionally.

            ZOOM-CENTERING FIX 2026-05-15: previous version used
            `width: ${100*100/tableZoom}%` to inverse-scale the natural
            width so the table filled the same horizontal space at every
            zoom. But `transform: scale()` does NOT affect layout — the
            inverse-width box still took its natural (overscaled) space
            in the parent, and `margin: 0 auto` centred the
            PRE-SCALE box. With clipping parents upstream (mx-auto +
            max-w + overflow constraints), zoom < 100 drifted right
            because the inverse-width overflowed asymmetrically.

            New approach: `transform-origin: 50% 0` (top-centre), full
            natural width, scale shrinks the visual size symmetrically
            around the horizontal centre. At zoom < 100 there is extra
            blank space below the table (acceptable; the layout below
            is already separately positioned). Table stays centred at
            every zoom level. */}
        <div
          style={{
            transform: `scale(${tableZoom / 100})`,
            transformOrigin: '50% 0',
            width: '100%',
          }}
        >
        {viewport.isMobilePortrait ? (
          <PokerTableMobile
            myPlayer={gameState.myPlayer}
            opponents={gameState.opponents || (gameState.opponent ? [gameState.opponent] : [])}
            board={revealBoardOverride ?? gameState.board}
            pot={gameState.pot}
            currentBet={gameState.currentBet}
            stage={gameState.stage}
            isMyTurn={gameState.isMyTurn}
            activePlayerUserId={gameState.activePlayerUserId || null}
            turnStartedAt={gameState.turnStartedAt || null}
            dealerSeatIndex={gameState.dealerSeatIndex}
            sbSeatIndex={gameState.sbSeatIndex}
            bbSeatIndex={gameState.bbSeatIndex}
            status={gameState.status}
            amountToCall={gameState.amountToCall || '0'}
            formatChips={formatChips}
            onFold={handleFold}
            onCheck={handleCheck}
            onCall={handleCall}
            onRaise={handleRaiseClick}
            // All In goes through the shared handleAction path so the
            // local isMyTurn flag clears IMMEDIATELY on click (same as
            // fold/check/call/raise). The old inline POST + loadGameState
            // path made the UI feel stuck for the full backend latency
            // and then snap forward when state arrived. (Gerald audit-25.)
            onAllIn={() => handleAction('all-in')}
            actionLoading={actionLoading}
            betweenHands={betweenHands}
            preAction={preAction}
            onSelectPreAction={(opt) => setPreAction(p => p === opt ? null : opt)}
          />
        ) : (
        <div className="relative">
        {/* DealAnimation: card-flick animation + sound on each new hand. */}
        {(() => {
          const allPlayers = [gameState.myPlayer, ...(gameState.opponents || [])].filter(Boolean);
          const occupiedSeats = allPlayers.map((p: any) => p.seatIndex);
          const layout = computeSeatPositionsForViewport(
            occupiedSeats,
            gameState.myPlayer.seatIndex,
            viewport.breakpoint,
          );
          const seatPositionByIndex: Record<number, { top: string; left: string }> = {};
          for (const sp of layout) {
            seatPositionByIndex[sp.seatIndex] = { top: sp.top, left: sp.left };
          }
          return (
            <DealAnimation
              triggerKey={dealTrigger}
              players={allPlayers.map((p: any) => ({
                seatIndex: p.seatIndex,
                position: p.position,
              }))}
              seatPositionByIndex={seatPositionByIndex}
              sbSeatIndex={gameState.sbSeatIndex ?? -1}
              dealerSeatIndex={gameState.dealerSeatIndex ?? -1}
              onComplete={() => {
                setBetweenHands(false);
                // Successful animation clear — cancel the safety watchdog
                // installed by game:new-hand. (Gerald audit-28.)
                if (betweenHandsWatchdogRef.current) {
                  clearTimeout(betweenHandsWatchdogRef.current);
                  betweenHandsWatchdogRef.current = null;
                }
              }}
            />
          );
        })()}
        <PokerTable
          myPlayer={gameState.myPlayer}
          opponents={gameState.opponents || (gameState.opponent ? [gameState.opponent] : [])}
          board={revealBoardOverride ?? gameState.board}
          pot={gameState.pot}
          currentBet={gameState.currentBet}
          stage={gameState.stage}
          isMyTurn={gameState.isMyTurn}
          activePlayerUserId={gameState.activePlayerUserId || null}
          turnStartedAt={gameState.turnStartedAt || null}
          dealerSeatIndex={gameState.dealerSeatIndex}
          sbSeatIndex={gameState.sbSeatIndex}
          bbSeatIndex={gameState.bbSeatIndex}
          status={gameState.status}
          amountToCall={gameState.amountToCall || '0'}
          formatChips={formatChips}
          onFold={handleFold}
          onCheck={handleCheck}
          onCall={handleCall}
          onRaise={handleRaiseClick}
          // All In goes through the shared handleAction path so the
          // local isMyTurn flag clears IMMEDIATELY on click (same as
          // fold/check/call/raise). The old inline POST + loadGameState
          // path made the UI feel stuck for the full backend latency
          // and then snap forward when state arrived. (Gerald audit-25.)
          onAllIn={() => handleAction('all-in')}
          actionLoading={actionLoading}
          betweenHands={betweenHands}
          preAction={preAction}
          onSelectPreAction={(opt) => setPreAction(p => p === opt ? null : opt)}
        />
        </div>
        )}
        </div>{/* close table-zoom transform wrapper */}

        {/* Error Display */}
        {error && (
          <div className="mt-3 p-3 bg-red-500 bg-opacity-20 border border-red-500 rounded-lg text-red-200 text-sm text-center">
            {error}
          </div>
        )}


        {/* Raise Modal */}
        {showRaiseModal && (() => {
          const stack = parseFloat(formatChips(gameState?.myPlayer.chipStack || '0'));
          const pot = parseFloat(formatChips(gameState?.pot || '0'));
          const currentBetNum = parseFloat(formatChips(gameState?.currentBet || '0'));
          const bbNum = parseFloat(formatChips(gameState?.bigBlind || '200000'));
          const minRaise = Math.max(currentBetNum + bbNum, bbNum * 2); // At least current bet + BB
          const currentAmount = parseFloat(raiseAmount) || minRaise;
          // Bet vs Raise label, matches PokerTable button: postflop with no
          // current bet = 'Bet'; everything else = 'Raise'.
          const isBetNotRaise = gameState?.stage !== 'preflop' && currentBetNum === 0;
          const verb = isBetNotRaise ? 'Bet' : 'Raise';

          /**
           * Playtest 2026-05-11 feedback (Shaun): quick buttons should
           * size the raise as a fraction of the POT (the conventional
           * poker shorthand), NOT a fraction of remaining stack.
           *   25% = quarter pot, 50% = half pot, 100% = full pot.
           * All-In stays stack-based (no pot reference).
           * All values are clamped to [minRaise, stack] so the slider
           * stays in legal-action territory.
           */
          const setQuickPotPct = (pct: number) => {
            const val = Math.round(pot * pct * 100) / 100;
            setRaiseAmount(Math.min(stack, Math.max(minRaise, val)).toFixed(2));
          };
          const setAllIn = () => {
            setRaiseAmount(stack.toFixed(2));
          };

          return (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="rounded-2xl p-6 max-w-sm w-full border border-white/10 shadow-2xl" style={{background:'#262626'}}>
                {/* Header */}
                <div className="flex justify-between items-center mb-5">
                  <h2 className="text-lg font-bold text-white">{verb}</h2>
                  <button onClick={() => setShowRaiseModal(false)} className="text-gray-500 hover:text-white transition text-xl">×</button>
                </div>

                {/* Amount display */}
                <div className="text-center mb-5">
                  <div className="flex items-center justify-center gap-2">
                    <img src="/assets/musd-logo.png" alt="" className="w-5 h-5" />
                    <span className="text-3xl font-bold text-white">{raiseAmount || minRaise.toFixed(2)}</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Stack: {stack.toFixed(2)}</p>
                </div>

                {/* Slider */}
                <div className="mb-4 px-1">
                  <input
                    type="range"
                    min={minRaise}
                    max={stack}
                    step={0.1}
                    value={currentAmount}
                    onChange={(e) => setRaiseAmount(parseFloat(e.target.value).toFixed(2))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                    <span>{minRaise.toFixed(2)}</span>
                    <span>{stack.toFixed(2)}</span>
                  </div>
                </div>

                {/* Quick buttons ÔÇö sized off the POT, not the stack.
                    'All In' is the exception and snaps to remaining stack. */}
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {[
                    { label: '½ pot', pct: 0.5 },
                    { label: '¾ pot', pct: 0.75 },
                    { label: 'Pot',  pct: 1.0 },
                  ].map(({ label, pct }) => (
                    <button
                      key={label}
                      onClick={() => setQuickPotPct(pct)}
                      className="py-2 rounded-lg text-xs font-semibold text-white border border-white/10 hover:bg-white/10 transition active:scale-95"
                      style={{background:'rgba(255,255,255,0.03)'}}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    onClick={setAllIn}
                    className="py-2 rounded-lg text-xs font-semibold text-white border border-purple-500/30 hover:bg-purple-500/20 transition active:scale-95"
                    style={{background:'rgba(156,81,255,0.1)'}}
                  >
                    All In
                  </button>
                </div>
                <p className="text-[10px] text-gray-600 mb-5 text-center">Pot: {pot.toFixed(2)} · Stack: {stack.toFixed(2)}</p>

                {/* Manual input */}
                <div className="mb-5">
                  <input
                    type="number"
                    value={raiseAmount}
                    onChange={(e) => setRaiseAmount(e.target.value)}
                    min={minRaise}
                    max={stack}
                    step="0.1"
                    className="w-full px-4 py-2.5 text-white text-center rounded-lg border border-white/10 focus:outline-none focus:ring-1 focus:ring-cyan-400 text-sm"
                    style={{background:'rgba(255,255,255,0.05)'}}
                    placeholder="Enter amount"
                  />
                </div>

                {/* Action buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowRaiseModal(false)}
                    className="flex-1 py-3 text-white rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRaiseConfirm}
                    disabled={!raiseAmount || parseFloat(raiseAmount) <= 0}
                    className="flex-1 py-3 text-white rounded-xl hover:opacity-90 transition disabled:opacity-50 font-semibold text-sm active:scale-[0.98]"
                    style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                  >
                    {verb} {isBetNotRaise ? '' : 'to '}{raiseAmount || minRaise.toFixed(2)}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {/* Fold Win Display ÔÇö same style as showdown modal */}
      {foldWinData && !showdownData && audioPrefs.popups && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-white/10" style={{background:'#262626'}}>
            {/* Header ÔÇö matches showdown modal */}
            <div className="p-5" style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}>
              <h2 className="text-2xl font-bold text-center text-white">HAND COMPLETE</h2>
            </div>

            <div className="p-6 space-y-5">
              {/* Winner announcement */}
              <div className="text-center">
                <p className="text-2xl font-bold text-white mb-1">
                  {foldWinData.winnerId === user?.id ? 'You Win!' : `${foldWinData.winnerName} Wins!`}
                </p>
                <p className="text-gray-400 text-sm">Everyone else folded</p>
              </div>

              {/* Pot awarded */}
              <div className="rounded-xl border border-white/5 p-5 text-center" style={{background:'rgba(255,255,255,0.02)'}}>
                <p className="text-gray-500 text-sm mb-1">Pot Awarded</p>
                <div className="flex items-center justify-center gap-2">
                  <img src="/assets/musd-chip.png" alt="" className="w-7 h-7" />
                  <p className="text-3xl font-bold text-white">{formatChips(foldWinData.pot)}</p>
                </div>
              </div>

              {/* Countdown */}
              {nextHandCountdown !== null && nextHandCountdown > 0 && (
                <div className="text-center">
                  <p className="text-sm" style={{color:'#12ceec'}}>
                    Next hand in {nextHandCountdown}s
                  </p>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => { setFoldWinData(null); loadGameState(); }}
                  className="flex-1 py-2.5 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition"
                  style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
                >
                  {gameState?.status === 'completed'
                    ? 'Continue'
                    : gameState?.myPlayer?.position === 'eliminated'
                      ? 'Watch Next Hand'
                      : 'Play Next Hand'}
                </button>
                <button
                  onClick={handleLeaveGame}
                  className="flex-1 py-2.5 text-gray-400 text-sm rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Showdown Modal */}
      {showdownData && audioPrefs.popups && (
        <>
          <ShowdownModal
            isOpen={!!showdownData}
            pot={showdownData.pot}
            sidePots={showdownData.sidePots}
            communityCards={showdownData.communityCards}
            players={showdownData.players}
            winnerIds={showdownData.winnerIds}
            currentUserId={user?.id || ''}
            onClose={() => {
              setShowdownData(null);
              setGameCompleted(false);
              loadGameState();
            }}
          />
          {/* Buttons overlay */}
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[60] flex gap-3">
            <button
              onClick={() => { setShowdownData(null); setGameCompleted(false); loadGameState(); }}
              className="px-5 py-2.5 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              {gameState?.myPlayer?.position === 'eliminated' ? 'Watch Next Hand' : 'Play Next Hand'}
            </button>
            <button
              onClick={handleLeaveGame}
              className="px-5 py-2.5 text-gray-400 text-sm rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition"
            >
              Leave Table
            </button>
          </div>
          {/* Next hand countdown overlay */}
          {nextHandCountdown !== null && nextHandCountdown > 0 && (
            <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[60] backdrop-blur-sm rounded-full px-6 py-2 border" style={{background:'rgba(0,0,0,0.8)', borderColor:'rgba(18,206,236,0.3)'}}>
              <p className="text-white text-center text-sm">
                Next hand in <span className="font-bold text-lg" style={{color:'#12ceec'}}>{nextHandCountdown}s</span>
              </p>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
}

/**
 * EliminatedBanner — small dismissible toast shown at the top of the
 * in-game view when the local player has been knocked out but the game
 * is still in progress. Replaces the full-screen "You've Been
 * Eliminated" card that previously REPLACED the table and killed
 * in-flight showdown/fold-win modals. (Shaun 2026-05-15, Gerald
 * audit-28.)
 *
 * The eliminated player stays at the table as a spectator. Real poker
 * sites do this — players want to see who beat them, who's running
 * the table now, and decide when to leave on their own terms.
 */
function EliminatedBanner({ onLeave }: { onLeave: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      className="mb-3 rounded-xl px-4 py-3 border flex items-center justify-between gap-3"
      style={{ background: 'rgba(239,68,68,0.10)', borderColor: 'rgba(239,68,68,0.35)' }}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.18)' }}>
          <svg className="w-4 h-4 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-white leading-tight">You’ve been eliminated</p>
          <p className="text-xs text-gray-400 leading-tight">You can stay and watch, or leave the table when you’re ready.</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onLeave}
          className="px-3 py-1.5 text-xs text-white font-semibold rounded-lg hover:opacity-90 transition"
          style={{ background: 'linear-gradient(135deg, #12ceec, #9c51ff)' }}
        >
          Leave
        </button>
        <button
          onClick={() => setDismissed(true)}
          title="Dismiss banner"
          className="px-2 py-1.5 text-xs text-gray-300 rounded-lg hover:bg-white/5 transition"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
