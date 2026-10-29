<p align="center">
  <!-- IMAGE: banner/logo —「检测→剪枝→压缩→续跑」循环救援概念图 -->
  <img src="docs/assets/banner.png" alt="dsh-loop-recover" width="720">
</p>

<h1 align="center">dsh-loop-recover</h1>

<p align="center">
  <em>Detects model dead loops and auto-rescues — the task resumes in place.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-loop-recover"><img src="https://img.shields.io/npm/v/dsh-loop-recover?logo=npm&label=npm" alt="npm version"></a>
  <a href="https://github.com/terry2010/dsh-loop-recover/stargazers"><img src="https://img.shields.io/github/stars/terry2010/dsh-loop-recover?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/GUI--configurable-0ea5e9?style=flat" alt="GUI configurable">
  <br>
  <b>English</b> · <a href="README.zh-CN.md">中文</a>
</p>

---

## What It Does

Small local models (Ornith, some Qwen variants, etc.) can collapse into literal token loops (`ssssss...`) or semantic analysis loops — re-reasoning the same paragraphs forever. Plain loop guards just cut and stop; the task dies.

`dsh-loop-recover` breaks the full rescue chain:

- **Detect** — 5-layer detector: periodic, n-gram, anchor, char-run, sentence-pool + intent-level tool-query tracking
- **Prune** — cuts the repeated suffix mid-stream, leaves a one-line marker so the model knows something was removed
- **Compact** — replaces the poisoned context with a checkpoint summary (v4 `compaction/*` transaction) so the model can't replay the same reasoning
- **Resume** — auto-followups the same task with fresh sampling params — **no new session, no restart**

All inside one agent loop — the model keeps working after rescue.

<!-- IMAGE: 真实会话截图——循环被剪除+压缩标记+续跑恢复 -->
![Rescue in action](docs/assets/rescue-demo.png)

## Install

### GUI (recommended)

Open **Plugins → Add plugin**, search `dsh-loop-recover`, click **Install**.

### CLI

```sh
dsh plugin --profile desktop add dsh-loop-recover
# then restart the app
```

## Configuration

Everything is editable on the plugin page — no YAML needed. 32 fields grouped: Basics / Rescue / Resume / Intent / Detection / Detector (Advanced).

| Group | Key fields |
|---|---|
| Basics | `mode` (rescue/cut/observe), `watch`, `language`, `keepLanguage`, `marker`, `debugLog` |
| Rescue | `maxConsecutiveRescues`, `compactOnRescue`, `stallCalls` |
| Resume | `retryTemperature`, `retryReasoningEffort`, `retryRequests` |
| Intent | `intentEnabled`, `intentNoveltyThreshold`, `intentConfirmCount` |

**Modes** — `rescue` (cut+prune+compact+resume, default), `cut` (prune only, no resume), `observe` (log only, zero intervention — use this to evaluate thresholds on your workload first).

## Why not other loop plugins

Different tools solve different problems — **don't stack them**:

| Plugin | What it does | Conflict |
|---|---|---|
| `dsh-agent-loop-guard` | Cuts at loop detection, stops turn | Both wrap `llm/stream` → double-cut, confused state |
| `dsh-client-auto-continue` | Resumes after interruption | Triggers extra resume → two conflicting continuation commands |
| `dsh-session-shift` | Context-pressure compaction → new session | Overlapping rescue → one compacts while the other shifts |

Disable them when using this plugin.

## How it works

```
llm/stream (agent calls only)
  ↓ StreamLoopDetector — watches reasoning & text blocks
loop hit → cut repeated suffix → rewrite block-end → finish: stop
  ↓ commitLoopCompaction — v4 transaction, old context → checkpoint
  ↓ followup() — resume same task, fresh sampling params
```

Non-agent requests (title/summary generation) pass through untouched.

## Development

```sh
npm test        # 66 unit + integration tests
npm run check   # plugin load smoke
```

## License

MIT · [NOTICE](NOTICE) for upstream attributions (dsh-compaction helpers adapted).
