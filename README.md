# dsh-loop-recover

DeepSeek Harness plugin: detects model dead loops → prunes mid-stream → **compacts context** → auto-resumes the task.

Unlike plugins that only interrupt: the loop text never lands in the session log, old context is shadowed by a checkpoint summary, and the model resumes on a clean surface.

## Pipeline

```
detect loop → prune stream (block-end payload never contains the loop)
            → compact (surfaceOp replace shadows poisoned context)
            → whenIdle → followup() resume
```

## Detection layers

- **periodic** — literal `abc`×N repeats
- **ngram** — 64-char blocks recurring 3+× (semantic spin)
- **anchor** — large paragraph rewrite
- **charrun** — `sssssss` collapse (substantive char ≥128)
- **pool** — short sentence scattered repeats (verified on real long-task sessions)
- **intent** — reworded same-topic web_search → steer correction

## Modes

| mode | behavior |
|---|---|
| `rescue` (default) | cut + prune + compact + auto-resume |
| `cut` | cut + prune, no resume |
| `observe` | log only, no interference |

`maxConsecutiveRescues` (default 3) bounds rescues; normal output resets the counter.

## Install (desktop app)

```bash
dsh plugin --profile desktop add /path/to/dsh-loop-recover
# NOTE: desktop app runs the `desktop` profile, not `web`
```

**Mutually exclusive** with `dsh-agent-loop-guard` / `@mrweicodes/dsh-loop-guard` / `dsh-client-auto-continue` — they wrap llm/stream or auto-resume too and would double-intervene.

## Config (profile cordis.patch.yml)

```yaml
- id: loop-recover
  config:
    mode: rescue            # rescue | cut | observe
    watch: both             # both | reasoning | text
    maxConsecutiveRescues: 3
    retryTemperature: 1.0   # sampling override for resumed requests
    retryReasoningEffort: low
    retryRequests: 1
    compactOnRescue: true   # compact context before resume
    detector:
      runMinChars: 128      # single-char spam threshold
      ngramSize: 64
      anchorSize: 512
      poolMinRepeats: 4     # scattered-sentence repeat threshold
    intentEnabled: true
```

## License

MIT. Detector/intent vendored from `dsh-loop-detector` (viego-qiin),
stream prune/resume mechanics adapted from `dsh-loop-rescue` (citydirector),
compaction handoff ported from `rice-patrol` (LeeLizuoLiu).

中文文档见 [README.zh-CN.md](README.zh-CN.md)。
