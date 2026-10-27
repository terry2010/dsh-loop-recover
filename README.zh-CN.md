# dsh-loop-recover

DeepSeek Harness 插件：检测模型死循环 → 流内剪枝 → **压缩上下文** → 自动续跑。

与只"打断"的插件不同：循环内容不进入会话日志，旧上下文被检查点摘要 shadow，
模型在干净上下文上继续任务——而非带着中毒上下文重试。

## 功能

- 五层循环检测：周期复读 / n-gram / 锚段 / 单字符刷屏（ssss）/ 散布型短句复读（pool）
- 意图级检测：web_search 换措辞重复搜索 → steer 纠正
- 三种模式：`rescue`（断+剪+压+续，默认）/ `cut`（只断不续）/ `observe`（只记录）
- 连续救援上限 `maxConsecutiveRescues`，正常输出自动重置
- `compactOnRescue` 续跑前压缩会话（默认开）

## 安装（桌面版）

```bash
dsh plugin --profile desktop add /path/to/dsh-loop-recover
```

与 `dsh-agent-loop-guard`、`dsh-client-auto-continue` **二选一**（功能重叠会互相干扰）。

## License

MIT。检测器 vendor 自 dsh-loop-detector（viego-qiin），
剪枝/续跑机制参考 dsh-loop-rescue（citydirector），压缩接力移植自 rice-patrol（LeeLizuoLiu）。
