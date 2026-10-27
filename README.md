# dsh-loop-recover

> [中文文档](README.zh-CN.md)

A [DeepSeek Harness](https://deepseek.com) plugin that rescues agents stuck in repetition loops:

**detect → prune → compact → resume** — in-place, no session forking.

## Why

Long-running local models (Ornith, Qwen, Sage…) on long contexts degrade into repetition:
`sssssss` char spam, `abc`×N literal loops, or *semantic* spins where reasoning repeats the
same sentences in different words. Most loop plugins only **interrupt** — the task dies.

`dsh-loop-recover` goes further:

- the loop tail **never lands in the session log** (the `block-end` payload is rewritten mid-stream)
- the poisoned context is **physically compacted** — a checkpoint summary replaces all earlier turns via `surfaceOp: replace`
- the agent gets a corrective **follow-up** and continues the same task — verified end-to-end on real sessions (`turn/end → completed`)

## Detection layers

| Layer | Catches |
|---|---|
| `periodic` | literal `abc123`×N loops |
| `ngram` | 64-char blocks recurring 3+× (reworded spins) |
| `anchor` | large paragraph rewrite |
| `charrun` | `sssssss` collapse — substantive char run ≥128 (`----` won't trigger) |
| `pool` | short sentence repeated across the stream (real-session verified) |
| `intent` | reworded same-topic `web_search` queries → `steer` correction |

## Modes

| `mode` | Behavior |
|---|---|
| `rescue` (default) | cut + prune + compact + auto-resume |
| `cut` | cut + prune, task stops |
| `observe` | log detections only — run first to check false positives |

`maxConsecutiveRescues` (default 3) bounds auto-rescue; normal output resets the counter.
Optional `retryTemperature`/`retryReasoningEffort` overrides apply to resumed requests.

## Install

```bash
# desktop app runs the `desktop` profile (NOT `web`)
dsh plugin --profile desktop add github.com/terry2010/dsh-loop-recover
```

Then restart the app. The plugin appears in the installed list as `loop-recover`.

**Mutually exclusive** with `dsh-agent-loop-guard` / `@mrweicodes/dsh-loop-guard` /
`dsh-client-auto-continue` — they wrap `llm/stream` or auto-resume and would double-intervene.

## Config (`cordis.patch.yml`)

```yaml
- id: loop-recover
  config:
    mode: rescue              # rescue | cut | observe
    watch: both               # both | reasoning | text
    maxConsecutiveRescues: 3
    retryTemperature: 1.0     # sampling override on resumed requests
    retryReasoningEffort: low
    retryRequests: 1
    compactOnRescue: true     # shadow old context before resuming
    detector:
      runMinChars: 128        # single-char spam threshold
      ngramSize: 64
      anchorSize: 512
      poolMinRepeats: 4       # scattered-sentence repeat threshold
    intentEnabled: true
```

## Development

```bash
npm install          # deps: @deepseek-ai/schemastery, dsh-llm, dsh-compaction
npm test             # 46 node:test unit + integration tests
npm run check        # plugin load smoke test
```

Real-session regression fixtures live in `test/fixtures-real-loop.txt`
(an actual reasoning-loop capture from an Ornith long-context run).

## License

MIT. Vendored/adapted from:
`dsh-loop-detector` (viego-qiin) · `dsh-loop-rescue` (citydirector) · `rice-patrol` (LeeLizuoLiu)
