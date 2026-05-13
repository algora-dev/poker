import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

let socket: Socket | null = null;
// Track which game rooms to rejoin on reconnect
const activeGameRooms = new Set<string>();

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
        // Rejoin ALL active game rooms on reconnect
        activeGameRooms.forEach(gameId => {
          socket?.emit('join:game', gameId);
          console.log('Rejoined game room:', gameId);
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
    socket?.emit('join:game', gameId);
  };

  const leaveGame = (gameId: string) => {
    activeGameRooms.delete(gameId);
    socket?.emit('leave:game', gameId);
  };

  return { socket, isConnected, joinGame, leaveGame };
}
