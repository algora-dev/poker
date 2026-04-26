import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

let socket: Socket | null = null;

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const user = useAuthStore((state) => state.user);
  const setAuth = useAuthStore((state) => state.setAuth);
  const accessToken = useAuthStore((state) => state.accessToken);
  const refreshToken = useAuthStore((state) => state.refreshToken);

  useEffect(() => {
    if (!user) return;

    // Initialize socket if not already connected
    if (!socket) {
      socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => {
        console.log('Socket connected:', socket?.id);
        setIsConnected(true);

        // Join user room for balance updates
        if (user?.id) {
          socket?.emit('join:user', user.id);
        }
      });

      socket.on('disconnect', () => {
        console.log('Socket disconnected');
        setIsConnected(false);
      });

      // Listen for balance updates
      socket.on('balance:updated', (data: { chips: string }) => {
        console.log('Balance updated:', data.chips);
        
        // Update auth store with new balance
        if (user && accessToken && refreshToken) {
          const updatedUser = { ...user, chips: data.chips };
          setAuth(updatedUser, accessToken, refreshToken);
        }
      });
    }

    // Join user room when user changes
    if (socket && user?.id) {
      socket.emit('join:user', user.id);
    }

    return () => {
      // Don't disconnect on unmount, keep socket alive for whole session
    };
  }, [user?.id]);

  const joinGame = (gameId: string) => {
    socket?.emit('join:game', gameId);
  };

  const leaveGame = (gameId: string) => {
    socket?.emit('leave:game', gameId);
  };

  return {
    socket,
    isConnected,
    joinGame,
    leaveGame,
  };
}
