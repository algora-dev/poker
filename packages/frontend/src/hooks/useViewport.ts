/**
 * useViewport — reports current viewport size + breakpoint bucket.
 *
 * Buckets (used across the table, modals, and chrome):
 *   - 'mobile-portrait' : width < 768 AND height >= width
 *   - 'mobile-landscape': width < 768 AND height < width
 *   - 'tablet'          : 768 <= width < 1280
 *   - 'desktop'         : width >= 1280
 *
 * The hook re-renders on viewport resize and on orientationchange. It
 * is debounced via rAF so a drag-resize doesn't thrash setState.
 *
 * No SSR concerns — this app is client-side only (Vite SPA).
 */

import { useEffect, useState } from 'react';

export type Breakpoint =
  | 'mobile-portrait'
  | 'mobile-landscape'
  | 'tablet'
  | 'desktop';

export interface ViewportSize {
  w: number;
  h: number;
  breakpoint: Breakpoint;
  isMobile: boolean;
  isMobilePortrait: boolean;
  isMobileLandscape: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

function computeBreakpoint(w: number, h: number): Breakpoint {
  if (w < 768) {
    return h >= w ? 'mobile-portrait' : 'mobile-landscape';
  }
  if (w < 1280) return 'tablet';
  return 'desktop';
}

function read(): ViewportSize {
  const w = typeof window === 'undefined' ? 1920 : window.innerWidth;
  const h = typeof window === 'undefined' ? 1080 : window.innerHeight;
  const breakpoint = computeBreakpoint(w, h);
  return {
    w,
    h,
    breakpoint,
    isMobile: breakpoint === 'mobile-portrait' || breakpoint === 'mobile-landscape',
    isMobilePortrait: breakpoint === 'mobile-portrait',
    isMobileLandscape: breakpoint === 'mobile-landscape',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
  };
}

export function useViewport(): ViewportSize {
  const [vp, setVp] = useState<ViewportSize>(() => read());

  useEffect(() => {
    let rafId = 0;
    const onResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setVp(read()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return vp;
}
