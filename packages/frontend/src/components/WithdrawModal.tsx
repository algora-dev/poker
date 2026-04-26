import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { styles, cls } from '../styles/theme';

interface Withdrawal {
  id: string;
  amount: string;
  status: string;
  txHash: string | null;
  requestedAt: string;
  completedAt: string | null;
}

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  chipBalance: string;
  walletAddress: string | null;
}

export function WithdrawModal({ isOpen, onClose, chipBalance, walletAddress }: WithdrawModalProps) {
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ txHash?: string; status: string } | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadHistory();
      setError('');
      setSuccess(null);
      setAmount('');
    }
  }, [isOpen]);

  const loadHistory = async () => {
    try {
      const response = await api.get('/api/wallet/withdrawals');
      setWithdrawals(response.data.withdrawals || []);
    } catch (_) {}
  };

  const handleWithdraw = async () => {
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum < 1) {
      setError('Minimum withdrawal is 1.00 mUSD');
      return;
    }

    const balanceNum = parseFloat(chipBalance);
    if (amountNum > balanceNum) {
      setError(`Insufficient balance. Available: ${balanceNum.toFixed(2)}`);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await api.post('/api/wallet/withdraw', {
        amount: amountNum,
      });

      setSuccess({
        txHash: response.data.txHash,
        status: response.data.status,
      });
      loadHistory();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Withdrawal failed');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const statusColors: Record<string, { bg: string; text: string; border: string }> = {
    pending: { bg: 'rgba(245,158,11,0.08)', text: '#f59e0b', border: 'rgba(245,158,11,0.2)' },
    submitted: { bg: 'rgba(18,206,236,0.08)', text: '#12ceec', border: 'rgba(18,206,236,0.2)' },
    completed: { bg: 'rgba(34,197,94,0.08)', text: '#22c55e', border: 'rgba(34,197,94,0.2)' },
    failed: { bg: 'rgba(239,68,68,0.08)', text: '#ef4444', border: 'rgba(239,68,68,0.2)' },
  };

  return (
    <div className={cls.modalOverlay} style={styles.modalOverlay}>
      <div className={cls.modalPanel + ' p-6'} style={styles.modalPanel}>
        {/* Header */}
        <div className="flex justify-between items-center mb-5">
          <div className="flex items-center gap-3">
            <img src="/assets/musd-logo.png" alt="mUSD" className="w-7 h-7" />
            <h2 className="text-xl font-bold text-white">Withdraw</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition text-xl">×</button>
        </div>

        {/* Success State */}
        {success ? (
          <div className="text-center space-y-4 py-4">
            <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center" style={{background:'rgba(34,197,94,0.1)'}}>
              <svg className="w-6 h-6" style={{color:'#22c55e'}} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-bold text-white">Withdrawal {success.status === 'completed' ? 'Complete' : 'Submitted'}</p>
              <p className="text-gray-400 text-sm mt-1">
                {success.status === 'completed'
                  ? 'mUSD has been sent to your wallet.'
                  : 'Your withdrawal is being processed.'}
              </p>
            </div>
            {success.txHash && (
              <a
                href={`https://lineascan.build/tx/${success.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm hover:underline block" style={{color:'#9c51ff'}}
              >
                View on LineaScan →
              </a>
            )}
            <button
              onClick={onClose}
              className={'w-full py-3 mt-4 ' + cls.btnPrimary}
              style={styles.btnPrimary}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Wallet Check */}
            {!walletAddress ? (
              <div className="text-center py-6">
                <p className="text-gray-400 mb-3">You need a connected wallet to withdraw.</p>
                <p className="text-gray-500 text-sm">Connect a wallet via Deposit first.</p>
              </div>
            ) : (
              <>
                {/* Balance Display */}
                <div className="rounded-xl p-4 border mb-4" style={{...styles.card}}>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400 text-sm">Available Balance</span>
                    <div className="flex items-center gap-2">
                      <img src="/assets/musd-logo.png" alt="" className="w-4 h-4" />
                      <span className="text-white font-bold text-lg">{chipBalance}</span>
                    </div>
                  </div>
                  <div className="mt-2">
                    <p className="text-gray-500 text-xs font-mono">
                      To: {walletAddress.slice(0, 10)}...{walletAddress.slice(-8)}
                    </p>
                  </div>
                </div>

                {/* Amount Input */}
                <div className="mb-4">
                  <label className={cls.label + ' block mb-2'}>Amount (mUSD)</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      min="1"
                      step="0.01"
                      placeholder="0.00"
                      className={cls.input}
                      style={styles.input}
                    />
                    <button
                      onClick={() => setAmount(chipBalance)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded hover:bg-white/10 transition"
                      style={{color:'#12ceec'}}
                    >
                      MAX
                    </button>
                  </div>
                  <p className="text-gray-600 text-xs mt-1">Minimum: 1.00 mUSD</p>
                </div>

                {/* Error */}
                {error && (
                  <div className="rounded-lg p-3 mb-4 border text-sm" style={styles.error}>{error}</div>
                )}

                {/* Withdraw Button */}
                <button
                  onClick={handleWithdraw}
                  disabled={loading || !amount || parseFloat(amount) < 1}
                  className={'w-full py-3 ' + cls.btnPrimary}
                  style={styles.btnPrimary}
                >
                  {loading ? 'Processing...' : `Withdraw ${amount || '0.00'} mUSD`}
                </button>
              </>
            )}

            {/* History Toggle */}
            {withdrawals.length > 0 && (
              <div className="mt-5 pt-4 border-t border-white/5">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="text-gray-500 text-xs hover:text-white transition w-full text-left"
                >
                  {showHistory ? 'Hide' : 'Show'} withdrawal history ({withdrawals.length})
                </button>

                {showHistory && (
                  <div className="mt-3 space-y-2">
                    {withdrawals.map((w) => {
                      const colors = statusColors[w.status] || statusColors.pending;
                      return (
                        <div key={w.id} className="rounded-lg p-3 flex justify-between items-center" style={{background:'rgba(255,255,255,0.03)'}}>
                          <div>
                            <div className="flex items-center gap-2">
                              <img src="/assets/musd-logo.png" alt="" className="w-3 h-3" />
                              <span className="text-white text-sm font-medium">{w.amount} mUSD</span>
                            </div>
                            <p className="text-gray-600 text-xs mt-0.5">
                              {new Date(w.requestedAt).toLocaleString()}
                            </p>
                          </div>
                          <div className="text-right">
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full border capitalize"
                              style={{background: colors.bg, color: colors.text, borderColor: colors.border}}
                            >
                              {w.status}
                            </span>
                            {w.txHash && (
                              <a
                                href={`https://lineascan.build/tx/${w.txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-[10px] mt-1 hover:underline"
                                style={{color:'#9c51ff'}}
                              >
                                TX →
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
