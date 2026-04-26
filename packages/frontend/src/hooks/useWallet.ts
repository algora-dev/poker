import { useState, useEffect } from 'react';
import { BrowserProvider, Eip1193Provider } from 'ethers';

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      isMetaMask?: boolean;
      request: (args: { method: string; params?: any[] }) => Promise<any>;
    };
  }
}

export function useWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isMetaMaskInstalled, setIsMetaMaskInstalled] = useState(false);
  const [chainId, setChainId] = useState<number | null>(null);

  useEffect(() => {
    // Check if MetaMask is installed
    if (typeof window.ethereum !== 'undefined') {
      setIsMetaMaskInstalled(true);
      
      // Check if already connected
      window.ethereum
        .request({ method: 'eth_accounts' })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            setAccount(accounts[0]);
            setIsConnected(true);
          }
        });

      // Get chain ID
      window.ethereum
        .request({ method: 'eth_chainId' })
        .then((chainId: string) => {
          setChainId(parseInt(chainId, 16));
        });

      // Listen for account changes
      window.ethereum.on?.('accountsChanged', (accounts: string[]) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          setIsConnected(true);
        } else {
          setAccount(null);
          setIsConnected(false);
        }
      });

      // Listen for chain changes
      window.ethereum.on?.('chainChanged', (chainId: string) => {
        setChainId(parseInt(chainId, 16));
        window.location.reload();
      });
    }
  }, []);

  const connect = async () => {
    if (!window.ethereum) {
      alert('MetaMask is not installed!');
      return null;
    }

    try {
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      });

      if (accounts.length > 0) {
        setAccount(accounts[0]);
        setIsConnected(true);
        return accounts[0];
      }
      return null;
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      return null;
    }
  };

  const disconnect = () => {
    setAccount(null);
    setIsConnected(false);
  };

  const signMessage = async (message: string): Promise<string | null> => {
    if (!window.ethereum || !account) {
      throw new Error('Wallet not connected');
    }

    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(message);
      return signature;
    } catch (error) {
      console.error('Failed to sign message:', error);
      throw error;
    }
  };

  const switchToLinea = async () => {
    if (!window.ethereum) return;

    const LINEA_CHAIN_ID = '0xe708'; // 59144 in hex

    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: LINEA_CHAIN_ID }],
      });
    } catch (error: any) {
      // Chain not added, add it
      if (error.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: LINEA_CHAIN_ID,
                chainName: 'Linea Mainnet',
                nativeCurrency: {
                  name: 'ETH',
                  symbol: 'ETH',
                  decimals: 18,
                },
                rpcUrls: ['https://rpc.linea.build'],
                blockExplorerUrls: ['https://lineascan.build'],
              },
            ],
          });
        } catch (addError) {
          console.error('Failed to add Linea network:', addError);
          throw addError;
        }
      } else {
        throw error;
      }
    }
  };

  return {
    account,
    isConnected,
    isMetaMaskInstalled,
    chainId,
    connect,
    disconnect,
    signMessage,
    switchToLinea,
  };
}
