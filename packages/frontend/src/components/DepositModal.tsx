import { useState } from 'react';
import { useWallet } from '../hooks/useWallet';
import { api } from '../services/api';
import { Contract, BrowserProvider, parseUnits } from 'ethers';

const LINEA_CHAIN_ID = 59144;
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS;
const MUSD_ADDRESS = import.meta.env.VITE_MUSD_TOKEN_ADDRESS;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const VAULT_ABI = [
  'function deposit(uint256 amount)',
];

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DepositModal({ isOpen, onClose }: DepositModalProps) {
  const wallet = useWallet();
  const [step, setStep] = useState<'connect' | 'authorize' | 'approve' | 'deposit' | 'waiting'>('connect');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState('');

  if (!isOpen) return null;

  const handleConnectWallet = async () => {
    setError('');
    setLoading(true);

    try {
      const address = await wallet.connect();
      if (!address) {
        setError('Failed to connect wallet');
        return;
      }

      if (wallet.chainId !== LINEA_CHAIN_ID) {
        await wallet.switchToLinea();
      }

      setStep('authorize');
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorize = async () => {
    setError('');
    setLoading(true);

    try {
      const response = await api.post('/api/wallet/generate-message', {
        walletAddress: wallet.account,
      });

      const signature = await wallet.signMessage(response.data.message);

      await api.post('/api/wallet/authorize-deposit', {
        walletAddress: wallet.account,
        signature,
        message: response.data.message,
      });

      setStep('approve');
    } catch (err: any) {
      setError(err.message || 'Authorization failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    setError('');
    setLoading(true);

    try {
      const provider = new BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const musd = new Contract(MUSD_ADDRESS, ERC20_ABI, signer);

      const currentAllowance = await musd.allowance(wallet.account, CONTRACT_ADDRESS);
      const amountWei = parseUnits(amount, 6);

      if (currentAllowance < amountWei) {
        const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const tx = await musd.approve(CONTRACT_ADDRESS, MAX_UINT256);
        await tx.wait();
      }

      setStep('deposit');
    } catch (err: any) {
      setError(err.message || 'Approval failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDeposit = async () => {
    setError('');
    setLoading(true);

    try {
      const provider = new BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const vault = new Contract(CONTRACT_ADDRESS, VAULT_ABI, signer);

      const amountWei = parseUnits(amount, 6);

      const tx = await vault.deposit(amountWei);
      setTxHash(tx.hash);
      setStep('waiting');

      await tx.wait();

      setTimeout(() => {
        onClose();
        window.location.href = window.location.href.split('?')[0] + '?refresh=' + Date.now();
      }, 30000);
    } catch (err: any) {
      setError(err.message || 'Deposit failed');
    } finally {
      setLoading(false);
    }
  };

  // Step indicator
  const steps = ['Connect', 'Authorize', 'Approve', 'Deposit'];
  const stepIndex = { connect: 0, authorize: 1, approve: 2, deposit: 3, waiting: 4 }[step];

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="rounded-2xl p-6 max-w-md w-full border border-white/10 shadow-2xl" style={{background:'#262626'}}>
        {/* Header */}
        <div className="flex justify-between items-center mb-5">
          <div className="flex items-center gap-3">
            <img src="/assets/musd-logo.png" alt="mUSD" className="w-7 h-7" />
            <h2 className="text-xl font-bold text-white">Deposit Chips</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition text-xl">×</button>
        </div>

        {/* Step Progress */}
        {step !== 'waiting' && (
          <div className="flex gap-1 mb-6">
            {steps.map((label, i) => (
              <div key={label} className="flex-1">
                <div
                  className="h-1 rounded-full transition-all"
                  style={{
                    background: i <= stepIndex
                      ? 'linear-gradient(135deg, #12ceec, #9c51ff)'
                      : 'rgba(255,255,255,0.05)',
                  }}
                />
                <p className={`text-[10px] mt-1 text-center ${i <= stepIndex ? 'text-gray-300' : 'text-gray-600'}`}>
                  {label}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg p-3 mb-4 border text-sm" style={{background:'rgba(239,68,68,0.08)', borderColor:'rgba(239,68,68,0.2)', color:'#f87171'}}>
            {error}
          </div>
        )}

        {/* Connect Step */}
        {step === 'connect' && (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">Connect your MetaMask wallet to deposit mUSD on Linea.</p>
            <button
              onClick={handleConnectWallet}
              disabled={loading || !wallet.isMetaMaskInstalled}
              className="w-full text-white font-semibold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-50 active:scale-[0.98]"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              {loading ? 'Connecting...' : wallet.isMetaMaskInstalled ? 'Connect MetaMask' : 'Install MetaMask'}
            </button>
          </div>
        )}

        {/* Authorize Step */}
        {step === 'authorize' && (
          <div className="space-y-4">
            <div className="rounded-lg p-3 border border-white/5" style={{background:'rgba(255,255,255,0.03)'}}>
              <p className="text-gray-500 text-xs">Connected Wallet</p>
              <p className="text-white font-mono text-sm">
                {wallet.account?.slice(0, 6)}...{wallet.account?.slice(-4)}
              </p>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Amount (mUSD)</label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min="1"
                step="0.01"
                placeholder="0.00"
                className="w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:outline-none focus:ring-1"
                style={{background:'rgba(255,255,255,0.05)', focusRingColor:'#12ceec'} as any}
              />
            </div>
            <p className="text-xs text-gray-500">
              You'll sign a message to authorize this deposit (no gas fee)
            </p>
            <button
              onClick={handleAuthorize}
              disabled={loading || !amount || parseFloat(amount) <= 0}
              className="w-full text-white font-semibold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-50 active:scale-[0.98]"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              {loading ? 'Signing...' : 'Authorize Deposit'}
            </button>
          </div>
        )}

        {/* Approve Step */}
        {step === 'approve' && (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">Approve mUSD spending (one-time unlimited approval)</p>
            <button
              onClick={handleApprove}
              disabled={loading}
              className="w-full text-white font-semibold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-50 active:scale-[0.98]"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              {loading ? 'Approving...' : 'Approve mUSD'}
            </button>
          </div>
        )}

        {/* Deposit Step */}
        {step === 'deposit' && (
          <div className="space-y-4">
            <div className="rounded-lg p-4 border border-white/5 text-center" style={{background:'rgba(255,255,255,0.03)'}}>
              <p className="text-gray-400 text-sm">Depositing</p>
              <div className="flex items-center justify-center gap-2 mt-1">
                <img src="/assets/musd-logo.png" alt="mUSD" className="w-5 h-5" />
                <p className="text-2xl font-bold text-white">{amount} mUSD</p>
              </div>
            </div>
            <button
              onClick={handleDeposit}
              disabled={loading}
              className="w-full text-white font-semibold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-50 active:scale-[0.98]"
              style={{background:'linear-gradient(135deg, #12ceec, #9c51ff)'}}
            >
              {loading ? 'Depositing...' : `Deposit ${amount} mUSD`}
            </button>
          </div>
        )}

        {/* Waiting Step */}
        {step === 'waiting' && (
          <div className="text-center space-y-4 py-4">
            <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center" style={{background:'rgba(18,206,236,0.1)'}}>
              <svg className="w-6 h-6" style={{color:'#12ceec'}} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-bold text-white">Deposit Submitted</p>
              <p className="text-gray-400 text-sm mt-1">
                Chips will be credited after 6 confirmations (~30 seconds)
              </p>
            </div>
            <p className="text-xs" style={{color:'#12ceec'}}>
              Page will refresh automatically...
            </p>
            {txHash && (
              <a
                href={`https://lineascan.build/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm hover:underline block" style={{color:'#9c51ff'}}
              >
                View on LineaScan →
              </a>
            )}

            {/* Mobile: hint about switching browsers */}
            <p className="text-gray-500 text-xs sm:hidden mt-3 px-4">
              You can now switch to Safari or Chrome to play — just log in with your account.
            </p>
            {/* Desktop: hint about mobile */}
            <p className="text-gray-500 text-xs hidden sm:block mt-3">
              You can also play on mobile — just log in from your phone's browser.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
