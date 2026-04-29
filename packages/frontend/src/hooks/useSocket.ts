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
    if (!user) return;

    if (!socket) {
      socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      socket.on('connect', () => {
        console.log('Socket connected:', socket?.id);
        setIsConnected(true);

        // Rejoin user room
        if (user?.id) {
          socket?.emit('join:user', user.id);
        }

        // Rejoin ALL active game rooms on reconnect
        activeGameRooms.forEach(gameId => {
          socket?.emit('join:game', gameId);
          console.log('Rejoined game room:', gameId);
        });
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

    if (socket && user?.id) {
      socket.emit('join:user', user.id);
    }

    return () => {};
  }, [user?.id]);

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
