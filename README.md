# dsh-loop-recover

DeepSeek Harness 插件：检测模型死循环 → **流内剪枝**（落盘消息不含循环段）→ **自动续跑任务**。

区别于普通"打断"：命中后在 `llm/stream` 瀑布中给出剪过的 `block-end`，写入 session log 的
上下文里根本没有循环内容，模型不会复读自己的输出；随后 `followup()` 自动续跑。

工作流程：检测循环 → 流内剪枝（落盘消息无循环段）→ **上下文压缩**（旧事件整体 shadow，只留检查点摘要）→ `whenIdle` 后 `followup()` 续跑。

## 检测能力

- **叙事型打转**：同一短句散布重复（`pool` 层，真实长任务验证）
- **单字符刷屏**：`sssssss` 类坍缩（`charrun` 层，实义字符 ≥128）

- **周期复读**：`abc123`×N 类字面循环
- **n-gram 复读**：64 字符块多次复现（措辞不同的语义循环）
- **锚段复读**：大段内容整体重写一遍
- **意图级循环**：web_search 换措辞搜同一主题 → steer 纠正

## 压缩（compactOnRescue）

续跑前调用 `session.append('compaction/*')` 把全部非 system 事件 shadow 成一条
检查点摘要（原任务 + 循环提示）——下一轮模型物理上看不到中毒上下文。
session API 不可用时自动降级为纯 followup。

## 模式

| mode | 行为 |
|---|---|
| `rescue`（默认） | 切断 + 剪除 + 自动续跑 |
| `cut` | 切断 + 剪除，不续跑 |
| `observe` | 只记日志不干预（建议先跑几天观察误伤率） |

连续救援上限 `maxConsecutiveRescues`（默认 3），一次正常输出即重置。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-loop-recover
# 或在 profile 的 cordis.patch.yml 里加本地 bundle
```

**与 `dsh-agent-loop-guard` / `@mrweicodes/dsh-loop-guard` / `dsh-client-auto-continue` 二选一**：
都包装 llm/stream 或做自动续跑，同时开启会重复切断/重复唤醒。

注意：桌面 app 跑 `desktop` profile（不是 `web`）：`dsh plugin --profile desktop add <path>`

## 配置（profile cordis.patch.yml）

```yaml
- id: loop-recover
  config:
    mode: rescue            # rescue | cut | observe
    watch: both             # both | reasoning | text
    maxConsecutiveRescues: 3
    retryTemperature: 1.0   # 续跑请求换温度，打破确定性复读
    retryReasoningEffort: low
    retryRequests: 1
    compactOnRescue: true   # 续跑前压缩上下文
    detector:
      runMinChars: 128      # 单字符刷屏阈值
      ngramSize: 64
      anchorSize: 512
    intentEnabled: true
```

## License

MIT。检测器/意图检测 vendor 自 `dsh-loop-detector` (viego-qiin)，
剪枝/续跑机制移植自 `dsh-loop-rescue` (citydirector)，压缩接力设计参考 `rice-patrol` (LeeLizuoLiu)。
