import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

let socket: Socket | null = null;
// Track which game rooms to rejoin on reconnect
const activeGameRooms = new Set<string>();

/**
 * Ack-confirmed join:game with retries.
 *
 * Why this exists:
 *   The server gates the game room (it only accepts our join if a
 *   GamePlayer row exists). Plain socket.emit() is fire-and-forget, so if
 *   we emit BEFORE the socket is connected, or BEFORE the createGame
 *   transaction has fully committed, the server rejects/drops the join
 *   and we silently miss future player:joined / broadcastGameState pushes.
 *
 *   Shaun playtest 2026-05-13 14:51: "every match I create, I need to
 *   refresh to see bots show up". Root cause = silent join:game failure.
 *
 * Strategy:
 *   Emit with ack callback. On ack.ok=false (e.g. not_seated because of
 *   replication lag), back off and retry up to 6 times over ~3.5 seconds.
 *   On ack.ok=true we trigger a state refresh so the UI catches any
 *   pushes that were missed during the join window.
 */
let joinAcksHandler: ((gameId: string, ok: boolean) => void) | null = null;
function tryJoinGameRoom(gameId: string, attempt = 0) {
  if (!socket) return;
  const delays = [0, 200, 400, 700, 1100, 1700, 2500];
  const delay = delays[Math.min(attempt, delays.length - 1)];
  setTimeout(() => {
    if (!socket || !activeGameRooms.has(gameId)) return;
    socket.emit('join:game', gameId, (ack: any) => {
      const ok = ack && ack.ok === true;
      if (ok) {
        joinAcksHandler?.(gameId, true);
      } else if (attempt < delays.length - 1) {
        // Likely not_seated yet - retry shortly.
        tryJoinGameRoom(gameId, attempt + 1);
      } else {
        console.warn('join:game gave up after retries', { gameId, ack });
        joinAcksHandler?.(gameId, false);
      }
    });
  }, delay);
}

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const user = useAuthStore((state) => state.user);
  const setAuth = useAuthStore((state) => state.setAuth);
  const accessToken = useAuthStore((state) => state.accessToken);
  const refreshToken = useAuthStore((state) => state.refreshToken);

  useEffect(() => {
    if (!user || !accessToken) return;

    if (!socket) {
      socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        // Backend requires JWT in handshake; userId is derived from the token.
        auth: { token: accessToken },
      });

      socket.on('connect', () => {
        console.log('Socket connected:', socket?.id);
        setIsConnected(true);

        // Server auto-joins user room on auth; emit kept as a no-op for back-compat.
        // Rejoin ALL active game rooms on reconnect, ack-confirmed.
        // Without the ack, we don't know if the server accepted us into
        // the game room before subsequent events fire — which causes
        // player:joined / broadcastGameState pushes to be missed and the
        // table to look empty until the user refreshes (Shaun playtest
        // 2026-05-13 14:51).
        activeGameRooms.forEach(gameId => {
          tryJoinGameRoom(gameId);
        });
      });

      socket.on('connect_error', (err) => {
        console.warn('Socket connect_error:', err?.message || err);
        setIsConnected(false);
      });

      socket.on('disconnect', () => {
        console.log('Socket disconnected');
        setIsConnected(false);
      });

      socket.on('balance:updated', (data: { chips: string }) => {
        if (user && accessToken && refreshToken) {
          setAuth({ ...user, chips: data.chips }, accessToken, refreshToken);
        }
      });
    }

    // If the access token rotated (e.g. after refresh), tear the socket down
    // so it reconnects with the new token in the auth handshake.
    return () => {
      // no-op on unmount; socket is intentionally a module singleton
    };
  }, [user?.id, accessToken]);

  const joinGame = (gameId: string) => {
    activeGameRooms.add(gameId);
    tryJoinGameRoom(gameId);
  };

  const leaveGame = (gameId: string) => {
    activeGameRooms.delete(gameId);
    socket?.emit('leave:game', gameId);
  };

  /**
   * Register a callback fired on each join:game ack outcome.
   * Only one handler is supported (latest replaces previous). Used by
   * GameRoom to trigger a state refresh once the socket is confirmed to
   * be in the room — catching pushes that may have happened while we
   * were still racing to join.
   */
  const setJoinAckHandler = (fn: ((gameId: string, ok: boolean) => void) | null) => {
    joinAcksHandler = fn;
  };

  return { socket, isConnected, joinGame, leaveGame, setJoinAckHandler };
}
