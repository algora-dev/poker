# Responsive Layout Plan — Audit 15

**Date:** 2026-05-13
**Owner:** Dave
**Status:** Planned (deferred from playtest-round-3 push)
**Trigger:** Shaun playtest 2026-05-13 — "my screen and other humans' screens differ slightly in resolution but the layout difference changes too much. Need dynamic solution for all screen types, including mobile."

---

## Why a full session

The current PokerTable uses an absolute-positioned oval table with seat slots at hard-coded percentage coordinates (`SEAT_POSITIONS` in `packages/frontend/src/components/PokerTable.tsx`). This works for a narrow band of viewport widths (roughly 1280-1920px landscape on desktop). Outside that band:

- Below ~1100px landscape: opponent seat cards clip into the community-card area; chip badges overlap player avatars.
- 4:3 monitors: the oval gets squished, top-row seats render too close to the dealer button.
- Mobile portrait (≤768px): the table is unusable — seats overlap, card sizes don't shrink, action buttons spill off-screen.
- Mobile landscape: somewhat acceptable but still cramped.

A proper fix touches almost every visual element on the table page. Bundling that with bug fixes risks merge conflicts and is harder to QA in isolation. Hence a dedicated session.

---

## Goals

1. **Single PokerTable component renders cleanly at any viewport ≥320px wide.**
2. **No clipping, no overlap, no scrollbars on the table view.**
3. **Mobile portrait gets a custom vertical layout** (table stacks; you at the bottom, opponents stacked at the top with chip badges and folded state).
4. **Mobile landscape works with the existing oval but with scaled spacing.**
5. **Action buttons always reachable** (sticky-bottom on mobile, no horizontal scroll).
6. **Touch-friendly hit targets** (≥44×44 px) — action buttons, fold confirm, raise slider.
7. **Modals scale to viewport** (showdown, fold-win, raise modal already mostly fine; double-check on small screens).
8. **No regression on desktop** at 1280-2560px wide.

---

## Out of scope for this session

- Animations beyond what's already shipped.
- Real-card-deal visual redesign (`DealAnimation` is good).
- Settings page redesign.
- Any backend changes.

---

## Task list

### Phase 1 — Audit + breakpoint contract (45 min)

1. Test current PokerTable at 6 representative viewports:
   - 1920×1080 (desktop FHD) — baseline OK
   - 1440×900 (laptop) — baseline OK
   - 1280×720 (small laptop)
   - 1024×768 (4:3 / iPad landscape)
   - 768×1024 (iPad portrait)
   - 414×896 (iPhone Pro)
   - 360×640 (small Android)
2. Document the exact failure mode at each viewport (screenshot + notes in `audits/t3-poker/15-responsive-layout-findings.md`).
3. Define the breakpoint contract:
   - `≥1280px`: desktop oval (current layout, possibly tuned).
   - `768-1279px`: tablet oval (scaled spacing, smaller cards, repositioned dealer button).
   - `<768px portrait`: mobile stacked layout (new component).
   - `<768px landscape`: mobile mini-oval (fall back to tablet oval scaled tighter).

### Phase 2 — Extract seat-position math (1 hr)

4. Replace hard-coded `SEAT_POSITIONS` percentages with a function that derives positions from `(seatCount, viewportWidth, viewportHeight)`. Function signature: `computeSeatPositions(seatCount: number, dims: { w: number; h: number }) => Array<{ top: string; left: string }>`.
5. Add `useViewportSize()` hook (returns `{ w, h, breakpoint }`).
6. Unit-test `computeSeatPositions` for 2-9 player tables at 6 viewports. Assert: no two seats within `min(cardWidth * 1.2, 80px)` of each other, no seat outside `[5%, 95%]` for either axis.
7. Migrate PokerTable to use `computeSeatPositions(occupiedSeats.length, viewportSize)` instead of the static array.

### Phase 3 — Card and chip-badge scaling (1 hr)

8. Replace card-size Tailwind classes (`w-10 sm:w-12 ...`) with size derived from viewport breakpoint. Use CSS custom properties for card width/height so a single `:root` block scales the whole table.
9. Chip-badge sizing: same approach. Stack-and-current-bet badges shrink to fit on tablets/mobile.
10. Dealer/SB/BB tokens scale; ensure visible at 320px width.

### Phase 4 — Mobile stacked layout (2 hrs)

11. New component `PokerTableMobile` (file: `components/PokerTableMobile.tsx`). Renders:
    - Opponents in a horizontal scroll-snap row at top (avatar + name + stack + folded state + last action).
    - Community cards horizontal centre.
    - Pot label below community cards.
    - Your hole cards + chip stack mid-bottom.
    - Action buttons sticky-bottom (full-width row, large hit targets).
12. Render `PokerTableMobile` when `breakpoint === 'mobile-portrait'`, else `PokerTable`.
13. Smoke-test on iPhone Safari (real device or Chrome devtools mobile emulation) for: tap targets, scrolling, modal stacking, raise slider usability.

### Phase 5 — Modal + chrome responsiveness (45 min)

14. Showdown modal: cap width to `min(420px, 92vw)`. Verify card grid wraps at narrow widths.
15. Fold-win modal: same constraints.
16. Raise modal: slider usable on touch; quick-button grid wraps to 2x2 at narrow widths.
17. GameRoom header (Cancel / Leave / AudioToggle): collapse to a kebab menu on mobile portrait.
18. Lobby cards: already responsive (Tailwind grid); double-check at 360px.

### Phase 6 — QA + regression (1 hr)

19. Manual sweep of all 6 viewports.
20. Re-run all gameplay tests: `npx vitest run` (138 tests should still pass — frontend changes only, backend untouched).
21. Live deploy to Vercel preview; verify on Shaun's screen + at least one different-resolution screen.
22. Update MEMORY.md with the responsive contract.

### Phase 7 — Stretch (skip if running long)

23. PWA install banner on mobile (manifest already exists?). Cache static assets.
24. Landscape-lock prompt on mobile portrait when the user joins a table? Optional, may annoy.
25. Reduce JS bundle: `index-DoP3o3aV.js` is 622KB / 207KB gzip. Code-split routes (`Lobby`, `GameRoom`, `Dashboard`, `WithdrawModal/DepositModal`).

---

## Estimated effort

- Phases 1-6: ~6-7 hours focused.
- Phase 7 (stretch): +1.5 hours.

One full session should land Phases 1-6. Phase 7 can roll to a follow-up.

---

## Acceptance criteria

- Shaun and the other human in the playtest see materially the same layout despite slightly different resolutions.
- Mobile portrait is *usable* (not pretty, but usable) — Shaun can pull up the table on his phone and act on his turn.
- No regression at desktop 1440×900 (Shaun's primary screen).
- `npx vitest run` still 138/138 PASS.

---

## Pre-work / dependencies

- None. This is pure frontend.
- Doesn't block the next playtest if we deploy the current Phase 1 P0/P1 push first.
