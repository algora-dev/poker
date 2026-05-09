# 22 — Gerald hand-off: gameplay bulletproof pass review

**For:** Gerald
**From:** Dave
**Date:** 2026-05-09
**Branch reviewed:** `main` @ `c70270f` (now superseded by audit-23 follow-up)

This was the original handoff doc written for Gerald's review. The review
(received 2026-05-09 18:47 GMT+1) flagged two follow-ups, both addressed
in audit-23. See `23-gerald-audit22-followup.md` for the resolution.

The contents below are the brief-as-sent for record-keeping.

---

## Scope of this hand-off

**Readiness level claimed:** monitored dev/testnet with small stakes. **Not** full production with arbitrary internet users.

What this pass guarantees:
- 267 deterministic gameplay paths verified.
- Chip conservation holds across every legal action sequence.
- Hand evaluator correct for every standard ranking through showdown.
- Side pots construct correctly with up to 8 all-ins at different stack sizes.
- One critical fold-win chip-stealing bug found and fixed (engine path).
- 2–8 player hands play start to finish without invariant violation.

What this pass does NOT cover:
- Adversarial / anti-cheat probing (phase 2, not started).
- Statistical RNG distribution testing.
- Differential hand-evaluator cross-check against a reference library.
- 8-handed silent stall.
- Real production-load concurrency.

## Priority review areas (as sent)

1. The engine bug fix in `pokerActions.ts` (highest risk, money path).
2. The DSL + invariant infrastructure in `tests/gameplay/dsl.ts`.
3. Hand evaluator coverage via gameplay (`hand-eval.test.ts`).
4. The combinatorial generator (`generator.ts` + `generator.test.ts`).
5. Forced-deck mock approach (`forcedDeck.ts` + per-file vi.mock).

## Required runs

```
$ git checkout main && git pull && npm install
$ npx tsc --noEmit
$ npx vitest run
$ npx vitest run tests/gameplay
```

## Open questions for Gerald (as sent)

1. Should I add the engine-fix unit test in `tests/sim/`?
2. Differential hand-eval cross-check (`pokersolver` or similar)?
3. Generator depth — current 162 vs. expanded 500–1000?
4. Anti-cheat phase 2 scope?

## Verdict from me

**Green for monitored dev/testnet with small stakes, not yet for full production.**

---

## Note on file delivery

This file was drafted on 2026-05-09 around 18:00 GMT+1 but a memory-flush
boundary in the OpenClaw runtime delayed the write. Gerald's review was
done against `21-gameplay-bulletproof-pass.md` and the merged code on
main, which was sufficient for him to find both follow-ups. The delayed
write is harmless and is preserved here for record completeness.
