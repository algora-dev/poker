/**
 * PlayingCard — single source of truth for card rendering across the
 * entire game (felt board, hole cards, mobile table, showdown modal,
 * deal animation). One component, four explicit size variants, ZERO
 * regex-based heuristics. Add a new size here, never inline.
 *
 * Shaun playtest 2026-05-14: cards were rendering with 3 different
 * layouts (J of clubs vs 3 of clubs vs hole cards) because the previous
 * implementation guessed size from tailwind class strings. This
 * component is the fix. Don't add fork copies — extend this file.
 *
 * Design spec (locked in):
 * - White card face, rounded corners, subtle gray border, soft shadow
 * - Top-left corner: rank stacked above suit symbol, hearts/diamonds red
 * - Centre: large suit symbol (visual anchor)
 * - Card BACK: deep-blue→purple→deep-blue diagonal gradient with T3
 *   logo at 90% of inner area (was 60% — bumped 50% per Shaun's request)
 */

import type { CSSProperties } from 'react';

export interface Card {
  rank: string;
  suit: string;
}

export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

interface CardSpec {
  /** Card width in px */
  w: number;
  /** Card height in px (~1.45 × width for standard poker proportions) */
  h: number;
  /** Top-left rank font (Tailwind class) */
  rankClass: string;
  /** Top-left small suit font (Tailwind class) */
  cornerSuitClass: string;
  /** Centre large suit font (Tailwind class) */
  centreSuitClass: string;
  /** Corner padding (Tailwind class) */
  cornerPad: string;
}

const SIZE_SPEC: Record<CardSize, CardSpec> = {
  // xs: deal-animation in-flight cards, mobile face-down opponents
  xs: { w: 28, h: 40, rankClass: 'text-[8px] font-bold', cornerSuitClass: 'text-[8px]', centreSuitClass: 'text-sm', cornerPad: 'top-0 left-0.5' },
  // sm: showdown modal mini cards, mobile opponent cards
  sm: { w: 32, h: 46, rankClass: 'text-[10px] font-bold', cornerSuitClass: 'text-[10px]', centreSuitClass: 'text-base', cornerPad: 'top-0.5 left-0.5' },
  // md: standard felt board cards + opponent hole cards
  md: { w: 48, h: 68, rankClass: 'text-sm font-bold', cornerSuitClass: 'text-sm', centreSuitClass: 'text-2xl', cornerPad: 'top-0.5 left-1' },
  // lg: hero hole cards + featured cards in modals
  lg: { w: 64, h: 92, rankClass: 'text-lg font-bold', cornerSuitClass: 'text-base', centreSuitClass: 'text-4xl', cornerPad: 'top-1 left-1.5' },
};

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: '\u2665',   // ♥
  diamonds: '\u2666', // ♦
  clubs: '\u2663',    // ♣
  spades: '\u2660',   // ♠
};

const SUIT_COLORS: Record<string, string> = {
  hearts: 'text-red-500',
  diamonds: 'text-red-500',
  clubs: 'text-gray-900',
  spades: 'text-gray-900',
};

interface PlayingCardProps {
  card: Card;
  size?: CardSize;
  /** Add a yellow ring to mark this card as part of the winning 5-card hand */
  highlight?: boolean;
}

/**
 * Face-up card. Single design, four sizes. Use this everywhere a card
 * value is shown.
 */
export function PlayingCard({ card, size = 'md', highlight = false }: PlayingCardProps) {
  const spec = SIZE_SPEC[size];
  const symbol = SUIT_SYMBOLS[card.suit] || '?';
  const color = SUIT_COLORS[card.suit] || 'text-gray-900';
  const style: CSSProperties = { width: `${spec.w}px`, height: `${spec.h}px` };
  return (
    <div
      className={`relative bg-white rounded-md shadow-md select-none border border-gray-200 overflow-hidden ${
        highlight ? 'ring-2 ring-yellow-400' : ''
      }`}
      style={style}
    >
      <div className={`absolute leading-tight ${color} ${spec.cornerPad}`}>
        <div className={spec.rankClass}>{card.rank}</div>
        <div className={`${spec.cornerSuitClass} -mt-0.5`}>{symbol}</div>
      </div>
      <div className={`absolute inset-0 flex items-center justify-center ${spec.centreSuitClass} ${color}`}>
        {symbol}
      </div>
    </div>
  );
}

interface CardBackProps {
  size?: CardSize;
}

/**
 * Face-down card. Deep-blue→purple→deep-blue diagonal gradient with the
 * T3 logo at 90% of inner area. Single design, four sizes.
 */
export function CardBack({ size = 'md' }: CardBackProps) {
  const spec = SIZE_SPEC[size];
  const style: CSSProperties = { width: `${spec.w}px`, height: `${spec.h}px` };
  return (
    <div
      className="relative rounded-md shadow-md overflow-hidden"
      style={{
        ...style,
        background: 'linear-gradient(135deg, #1e3a8a 0%, #7c3aed 50%, #1e3a8a 100%)',
        border: '1.5px solid rgba(255,255,255,0.25)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
      }}
    >
      <div className="absolute inset-0.5 rounded border border-white/15 flex items-center justify-center p-0.5">
        <img
          src="/assets/t3-logo-white.png"
          alt=""
          className="object-contain opacity-90"
          style={{ width: '90%', height: '90%' }}
          draggable={false}
        />
      </div>
    </div>
  );
}

/**
 * Compute the destination card width/height in px for a given size.
 * Used by DealAnimation to size the in-flight card identically to the
 * landed card. Single source of size truth.
 */
export function getCardPixelSize(size: CardSize): { w: number; h: number } {
  const spec = SIZE_SPEC[size];
  return { w: spec.w, h: spec.h };
}
