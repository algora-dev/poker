# Harness failure: eight_player_full_session

- **runId:** `2026-05-09T11-13-32-979Z`
- **invariantId:** `INV-NO-STALLS`
- **error:** [INV-NO-STALLS] Bot bot4.persist1@harness.test stalled on its turn for 90659ms
- **JSONL:** ..\runs\2026-05-09T11-13-32-979Z\eight_player_full_session.jsonl
- **snapshot:** ..\runs\2026-05-09T11-13-32-979Z\eight_player_full_session.snapshot.json

## Reproduce

```bash
HARNESS_BASE_URL=http://localhost:3000 \
HARNESS_ADMIN_SECRET=*** \
HARNESS_SCENARIO=eight_player_full_session \
npm run --workspace=packages/backend harness
```

## Triage checklist

- [ ] Compared snapshot to last green run
- [ ] Checked server log slice around failure ts
- [ ] Identified suspected commit / change
- [ ] Wrote failing unit test if reproducible in isolation
- [ ] Patched + re-ran scenario in loop mode
