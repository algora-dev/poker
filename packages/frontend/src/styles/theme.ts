/**
 * T3 Poker Brand Theme
 * Single source of truth for all colors and styles.
 * Import and use these constants everywhere instead of hardcoding.
 */

export const theme = {
  // Core colors
  bg: '#262626',
  bgCard: 'rgba(255,255,255,0.03)',
  bgCardHover: 'rgba(255,255,255,0.06)',
  bgInput: 'rgba(255,255,255,0.05)',
  
  cyan: '#12ceec',
  purple: '#9c51ff',
  
  // Borders
  border: 'rgba(255,255,255,0.06)',
  borderLight: 'rgba(255,255,255,0.10)',
  borderHover: 'rgba(255,255,255,0.20)',
  
  // Gradients
  gradient: 'linear-gradient(135deg, #12ceec, #9c51ff)',
  gradientCyan: 'linear-gradient(135deg, rgba(18,206,236,0.08), transparent)',
  gradientPurple: 'linear-gradient(135deg, rgba(156,81,255,0.08), transparent)',
  
  // Status
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  
  // Accent backgrounds
  cyanBg: 'rgba(18,206,236,0.08)',
  cyanBorder: 'rgba(18,206,236,0.20)',
  purpleBg: 'rgba(156,81,255,0.08)',
  purpleBorder: 'rgba(156,81,255,0.20)',
  successBg: 'rgba(34,197,94,0.08)',
  successBorder: 'rgba(34,197,94,0.20)',
  errorBg: 'rgba(239,68,68,0.08)',
  errorBorder: 'rgba(239,68,68,0.20)',
} as const;

/**
 * Reusable style objects for common patterns.
 * Use with style={{...styles.card}} on elements.
 */
export const styles = {
  // Page background
  page: { background: theme.bg } as React.CSSProperties,
  
  // Card surfaces
  card: {
    background: theme.bgCard,
    borderColor: theme.border,
  } as React.CSSProperties,
  
  // Input fields
  input: {
    background: theme.bgInput,
    borderColor: theme.borderLight,
  } as React.CSSProperties,
  
  // Primary gradient button
  btnPrimary: {
    background: theme.gradient,
  } as React.CSSProperties,
  
  // Modal overlay
  modalOverlay: {
    background: 'rgba(0,0,0,0.80)',
    backdropFilter: 'blur(8px)',
  } as React.CSSProperties,
  
  // Modal panel
  modalPanel: {
    background: theme.bg,
    borderColor: theme.borderLight,
  } as React.CSSProperties,
  
  // Error message
  error: {
    background: theme.errorBg,
    borderColor: theme.errorBorder,
    color: '#f87171',
  } as React.CSSProperties,
  
  // Success
  success: {
    background: theme.successBg,
    borderColor: theme.successBorder,
    color: '#4ade80',
  } as React.CSSProperties,

  // Cyan accent card
  cyanCard: {
    background: theme.gradientCyan,
    borderColor: theme.cyanBorder,
  } as React.CSSProperties,

  // Purple accent card
  purpleCard: {
    background: theme.gradientPurple,
    borderColor: theme.purpleBorder,
  } as React.CSSProperties,
} as const;

/**
 * Common className strings for Tailwind utility combinations.
 */
export const cls = {
  // Base page
  page: 'min-h-screen',
  
  // Cards
  card: 'rounded-2xl border p-6',
  cardSm: 'rounded-xl border p-4',
  
  // Buttons
  btnPrimary: 'text-white font-semibold rounded-xl hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50',
  btnGhost: 'text-white rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition',
  btnDanger: 'text-white rounded-xl bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition',
  
  // Inputs
  input: 'w-full px-4 py-3 text-white rounded-lg border border-white/10 focus:outline-none focus:ring-1 focus:ring-cyan-400',
  
  // Modal
  modalOverlay: 'fixed inset-0 flex items-center justify-center z-50 p-4',
  modalPanel: 'rounded-2xl border border-white/10 shadow-2xl max-w-md w-full mx-2 sm:mx-4',
  
  // Text
  heading: 'text-xl font-bold text-white',
  label: 'text-sm text-gray-400',
  muted: 'text-gray-500 text-sm',
  
  // Tags/badges
  badge: 'text-xs px-2 py-0.5 rounded-full border',
} as const;
