# dsh-loop-recover

> [English README](README.md)

DeepSeek Harness 插件：检测模型死循环 → 流内剪枝 → **压缩上下文** → 自动续跑任务。

与只会"打断"的插件不同：**循环内容不进会话日志**，中毒上下文被检查点摘要
物理替换，模型在干净上下文上继续跑同一个任务——不用开新会话。

真机已验证完整链路：`检测 → 剪枝 → 压缩（97 条 shadow）→ 续跑 → 任务 completed`。

## 工作流

```
模型进入死循环 → 流内检测命中 → 剪枝：循环尾巴不写入 session log
            → 压缩：旧上下文被 surfaceOp replace 整体 shadow，只留检查点摘要
            → whenIdle → followup() 注入续跑消息 → 任务继续
```

## 检测能力

| 层 | 抓什么 |
|---|---|
| `periodic` | `abc123`×N 字面复读 |
| `ngram` | 64 字符块复现 3+ 次（措辞不同的语义打转） |
| `anchor` | 大段内容整体重写 |
| `charrun` | `sssssss` 单字符坍缩（实义字符 ≥128，`----` 等符号不误伤） |
| `pool` | 短句散布重复（叙事型打转，真实长任务验证） |
| `intent` | web_search 换措辞搜同一主题 → steer 纠正 |

## 三种模式

| mode | 行为 |
|---|---|
| `rescue`（默认） | 中断 + 剪枝 + 压缩 + 自动续跑 |
| `cut` | 中断 + 剪枝，不续跑 |
| `observe` | 只记日志不干预（建议先跑观察误伤率） |

`maxConsecutiveRescues`（默认 3）防止无限套娃；正常输出自动重置计数。

## 安装（桌面版）

```bash
dsh plugin --profile desktop add github.com/terry2010/dsh-loop-recover
# 注意：桌面 app 跑的是 desktop profile，不是 web
```

重启 app 后，插件列表里出现 `loop-recover` 即生效。

## ⚠️ 冲突说明（必须二选一，否则会互相干扰）

| 插件 | 冲突原因 |
|---|---|
| `dsh-agent-loop-guard` / `@mrweicodes/dsh-loop-guard` | **同时包装 `llm/stream`**：循环触发时两个插件各自截断输出、各发各的 block-end——流被双重切断，session 记录错乱，任务直接失败 |
| `dsh-client-auto-continue` | **重复唤醒**：任务暂停时它和本插件的 `followup` 各自发续跑消息，模型收到两条冲突指令，行为不可预期 |
| `dsh-session-shift` | **职责重叠**：它的上下文压力接续（≥60% 自动开新会话）和本插件的压缩续跑会叠加触发——一边压缩一边开新会话 |

**建议**：想试本插件，先把上面三个都禁用；确认稳定后再决定保留哪个组合。

## 配置（`cordis.patch.yml`）

```yaml
- id: loop-recover
  config:
    mode: rescue              # rescue | cut | observe
    watch: both               # both | reasoning | text
    maxConsecutiveRescues: 3
    retryTemperature: 1.0     # 续跑请求换采样参数，打破确定性复读
    retryReasoningEffort: low
    retryRequests: 1
    compactOnRescue: true     # 续跑前压缩上下文
    detector:
      runMinChars: 128        # 单字符刷屏阈值
      ngramSize: 64
      anchorSize: 512
      poolMinRepeats: 4       # 散布短句重复阈值
    intentEnabled: true
```

## 开发

```bash
npm install
npm test        # 46 个单测+集成测
npm run check   # 插件加载冒烟
```

真实死循环样本回归：`test/fixtures-real-loop.txt`（Ornith 长上下文实采）。

## License

MIT。检测器/意图检测 vendor 自 `dsh-loop-detector`（viego-qiin），
剪枝/续跑机制移植自 `dsh-loop-rescue`（citydirector），压缩接力参考 `rice-patrol`（LeeLizuoLiu）。
