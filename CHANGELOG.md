# Changelog

## 0.3.7

Detector fixes and hardening from audit.

### Detector

- `detectPoolRepeat` now splits on ASCII `.` — English repetition was invisible because sentences were never segmented.
- `detectNgram` samples every position by default (`ngramStep` 16 → 1) — the old alignment sampling missed most mid-size verbatim repeats at non-16-aligned distances.
- Reasoning blocks use relaxed thresholds (`poolMinRepeats ≥ 8`, `ngramRepeats ≥ 4`) via `resolveDetectorOptions` — methodical enumeration with a repeated verdict sentence no longer triggers false positives; text blocks keep defaults.
- `detectCharRun` scans the whole tail window instead of only the very end — a spam run followed by normal tail text now hits.
- `detectRepetition` minimum-scan floor decoupled from `minPeriod × periodRepeats` (constant 32) — raising `minPeriod` no longer silently disables the pool/charrun layers on short text.
- `StreamLoopDetector` keeps only a bounded tail internally; `cutStart` is translated back to full-text coordinates.

### Rescue / stream

- Unsafe open blocks (e.g. tool calls) now defer pruning instead of permanently disabling the block's detector; the cut lands once they close.
- New `maxTotalRescues` option (default 24) caps cumulative rescues — alternating "loop → output → loop" no longer rescues forever.
- Host callbacks (`whenIdle`/`inject`/`steer`) are guarded so synchronous host exceptions cannot abort the stream before the pruned block-end + finish are emitted.
- `agent/request` and intent tracking resolve agent state via session-id registry fallback when the payload's `agent` object identity differs — `retryTemperature` override and stall tracking no longer silently miss.

### Compaction / intent

- Task-anchor extraction skips plugin-generated notices and compact checkpoints.
- Open-turn lookup probes `session.openTurn`/`currentTurn` before falling back to event scan; `shadowedTokenCount` estimates tokens from event payloads (~4 chars/token).
- Intent history entries expire after `maxAgeMs` (default 30 min) — stale topics from a previous task no longer cause false intent-loop verdicts.

### Tooling / docs

- `scripts/install-to-profile.mjs` for local dev installs (`node scripts/install-to-profile.mjs desktop`).
- Debug logging uses `os.homedir()` with `HOME` fallback and never throws.
- 84 unit + integration tests.
