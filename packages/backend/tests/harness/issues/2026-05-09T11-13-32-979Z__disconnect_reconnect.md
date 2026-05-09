# Harness failure: disconnect_reconnect

- **runId:** `2026-05-09T11-13-32-979Z`
- **invariantId:** `INV-BOTS-HEALTHY`
- **error:** [INV-BOTS-HEALTHY] Bot bot2.persist1@harness.test accumulated 6 errors (allowed 3). First few: action all-in@x22mas -> 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"} | action all-in@x22mas -> 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"} | action all-in@x22mas -> 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"} | action all-in@x22mas -> 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"} | action all-in@x22mas -> 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}
- **JSONL:** ..\runs\2026-05-09T11-13-32-979Z\disconnect_reconnect.jsonl
- **snapshot:** ..\runs\2026-05-09T11-13-32-979Z\disconnect_reconnect.snapshot.json

## Reproduce

```bash
HARNESS_BASE_URL=http://localhost:3000 \
HARNESS_ADMIN_SECRET=*** \
HARNESS_SCENARIO=disconnect_reconnect \
npm run --workspace=packages/backend harness
```

## Triage checklist

- [ ] Compared snapshot to last green run
- [ ] Checked server log slice around failure ts
- [ ] Identified suspected commit / change
- [ ] Wrote failing unit test if reproducible in isolation
- [ ] Patched + re-ran scenario in loop mode
