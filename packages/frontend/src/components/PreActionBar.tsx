/**
 * PreActionBar — pre-action queue bar shown when it is NOT the local
 * player's turn (Shaun 2026-05-15).
 *
 * Replaces the v1 single Check/Fold button under the hero's cards. Sits
 * in the SAME physical location as the live action bar (Fold / Check /
 * Call / Bet|Raise / All-In) so the player always looks at one spot.
 * When `isMyTurn` flips true, GameRoom hides this bar and shows the
 * live bar; when it flips false, the swap reverses.
 *
 * Three mutually-exclusive options:
 *   - Check       : auto-check if amountToCall === 0. Auto-deselects
 *                   when anyone raises (handled by GameRoom effect).
 *   - Fold        : auto-fold regardless of board state.
 *   - Check / Fold: check if free, fold if anyone bets. (v1 behaviour.)
 *
 * Clicking the same selected button again deselects it (no pre-action
 * queued). Clicking a different button switches selection.
 *
 * Mobile vs desktop: same wrapper styling as the live action bar so the
 * two bars are visually indistinguishable position/size-wise.
 */

import type { CSSProperties } from 'react';

export type PreActionOption = 'check' | 'fold' | 'check_fold';

interface PreActionBarProps {
  selected: PreActionOption | null;
  onSelect: (opt: PreActionOption) => void;
  isMobile: boolean;
  isTablet: boolean;
}

export function PreActionBar({ selected, onSelect, isMobile, isTablet }: PreActionBarProps) {
  const wrapperClass = isMobile
    ? 'fixed bottom-0 inset-x-0 z-20 px-2 pt-2'
    : 'z-20 mt-3';
  const wrapperStyle: CSSProperties = isMobile
    ? { paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }
    : {
        // Match the live action bar's spacing so the swap doesn't jump.
        // Match the live action bar's spacing so the swap doesn't jump.
        // Shaun playtest 2026-05-15: bumped from 90/110 to 125/145 so
        // the hero's chip plate is no longer obscured by either bar.
        marginTop: isTablet ? '125px' : '145px',
      };

  const innerClass = isMobile
    ? 'flex flex-col gap-1 rounded-2xl p-2 border border-white/10 shadow-2xl'
    : 'flex flex-col gap-1 rounded-2xl p-3 border border-white/10 shadow-2xl';
  const buttonRowClass = isMobile
    ? 'flex gap-1.5 justify-center'
    : 'flex gap-2 justify-center';

  // Compact status line beneath the buttons — keeps everything in the
  // fixed-position bar slot so the table layout above never reflows when
  // a pre-action is queued. Previous version put this text in the page
  // header under "Blinds: x/y" and the wrap pushed the table down by
  // ~1 line. (Shaun playtest 2026-05-15.)
  const statusText =
    selected === 'check_fold'
      ? 'Check/Fold queued — click again to undo.'
      : selected === 'check'
        ? 'Check queued — auto-cancels if anyone raises.'
        : selected === 'fold'
          ? 'Fold queued — auto-folds on your turn.'
          : null;

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      <div className={innerClass} style={{ background: 'rgba(38,38,38,0.95)', backdropFilter: 'blur(8px)' }}>
        <div className={buttonRowClass}>
        <PreActionButton
          label="Check"
          option="check"
          tooltip="Auto-check if no one raises before your turn. Auto-cancels if anyone raises."
          selected={selected === 'check'}
          activeColor="bg-yellow-500 text-black ring-2 ring-yellow-300"
          dimColor="bg-white/10 text-gray-300 hover:bg-white/15 border border-white/10"
          onClick={() => onSelect('check')}
          isMobile={isMobile}
          symbol={'\u2713'}
        />
        <PreActionButton
          label="Fold"
          option="fold"
          tooltip="Auto-fold when your turn arrives, regardless of action."
          selected={selected === 'fold'}
          activeColor="bg-red-500 text-white ring-2 ring-red-300"
          dimColor="bg-white/10 text-gray-300 hover:bg-white/15 border border-white/10"
          onClick={() => onSelect('fold')}
          isMobile={isMobile}
          symbol={'\u2715'}
        />
        <PreActionButton
          label="Check/Fold"
          option="check_fold"
          tooltip="Check if free, fold if anyone raises before your turn."
          selected={selected === 'check_fold'}
          activeColor="bg-yellow-500 text-black ring-2 ring-yellow-300"
          dimColor="bg-white/10 text-gray-300 hover:bg-white/15 border border-white/10"
          onClick={() => onSelect('check_fold')}
          isMobile={isMobile}
          symbol={'\u21AA'}
        />
        </div>
        {statusText && (
          <div
            className="text-[10px] sm:text-xs text-center font-medium"
            style={{ color: '#facc15' }}
          >
            {statusText}
          </div>
        )}
      </div>
    </div>
  );
}

interface PreActionButtonProps {
  label: string;
  option: PreActionOption;
  tooltip: string;
  selected: boolean;
  activeColor: string;
  dimColor: string;
  onClick: () => void;
  isMobile: boolean;
  symbol: string;
}

function PreActionButton({
  label,
  tooltip,
  selected,
  activeColor,
  dimColor,
  onClick,
  isMobile,
  symbol,
}: PreActionButtonProps) {
  const sizing = isMobile ? 'flex-1 px-2 py-3 min-h-[44px]' : 'px-5 py-2.5';
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className={`${sizing} rounded-xl transition font-semibold text-sm flex items-center justify-center gap-1.5 shadow-lg ${
        selected ? activeColor : dimColor
      }`}
    >
      <span>{symbol}</span> {label}
    </button>
  );
}
