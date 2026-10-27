# dsh-loop-recover 插件开发文档

> 目标：为 DeepSeek Harness (dsh) 开发循环救援插件——检测到模型死循环后
> **中断 → 净化/压缩上下文 → 自动续跑任务**。
> 基线方案：fork `dsh-loop-rescue` 的续跑骨架 + 移植 `dsh-loop-detector` 的检测器。

## 1. 背景与动机

### 1.1 问题

本地部署的 qwen3.5 家族模型（Sage-A1.5、Ornith-1.5、Flint 等 35B MoE）在长上下文
agentic 任务中存在两类死循环：

1. **坍缩复读（字面循环）**：注意力退化后 logits 坍缩，单 token/短片段无限刷屏，
   形如 `next move is ssssssssssssssssssss`。M4 Pro 实测在 >~100K 上下文进入退化区。
2. **反思循环（语义循环）**：`Wait, 不对…… Actually, 让我重想……` 措辞不同但语义
   原地打转，Qwen 官方 issue 统计 thinking 失控率 ~17.4%。

现有手段及缺口：

- 模型侧参数（`repetition_penalty`、`presence_penalty`、`thinking_budget`）只能
  降低发生率，发生后无法救回任务。
- `dsh-agent-loop-guard`（已安装）能硬中断工具调用循环和输出复读，但**中断后任务
  直接停止**，长任务进度丢失。
- 需要"救回"能力：中断后清理中毒上下文，自动续跑。

### 1.2 需求

```
检测到死循环 → 立即截断流 → 确保写入 session log 的内容不含循环段
           → （可选）压缩历史为干净摘要 → 自动续跑任务 → 连续救援达上限则停止并提示
```

## 2. 参考实现调研结论

三个开源实现已 clone 至 `docs/code/` 供参考：

| 仓库 | 规模 | 可取资产 | 缺陷 |
|---|---|---|---|
| `dsh-loop-detector` (viego-qiin, v2.0.0, TS, ~830行) | 3 文件 | **检测器最优**：周期扫描(8-256)/n-gram(64×3)/锚段(512) 三层 + 实义字符过滤防误伤，纯函数可离线单测；另有 web_search 意图级检测 | 只会 steer/cancel，无续跑 |
| `dsh-loop-rescue` (citydirector, v0.1.0, JS, ~580行) | 2 文件 + tools | **续跑机制最轻**：拦截 `llm/stream` 瀑布，用"剪过的 block-end"落盘——session log 天然不含循环段，无需事后改写；`whenIdle()` + `followup()` 自动续跑 | 检测器较粗（短句池+逐字周期），0 star 未验证 |
| `rice-patrol` (leelizuoliu, v0.2.11, JS, ~2800行) | 16 文件 | **真·压缩接力**：调官方 `@deepseek-ai/dsh-compaction` API（`compactCheckpointSource`、`toolPairingBalanced*`、`tokenMeter`），验证过的 checkpoint + 新 agent 接力 | 检测器仅 59 行最弱；16 文件状态机复杂度高；0 star 未验证 |

### 关键 API 事实（已从源码确认）

- `llm/stream` 瀑布可包装每次模型调用；`block-end` 载荷决定落盘内容，可替换为剪过的内容
- `inject = ['agents']`，`ctx.agents.get(sessionId)` 取会话 Agent
- `whenIdle()` 回合结束后 `followup()` 发续跑消息（运行中发出的唤醒会被宿主丢弃）
- 打开的 block 含工具调用时不可截断（半截参数会被执行）
- 官方 compaction：`@deepseek-ai/dsh-compaction` 的 `compactCheckpointSource`、`toolPairingBalancedBefore/After`、`tokenMeter`

<!-- === SECTION 1 END === -->

## 3. 架构设计

### 3.1 总体方案（方案 A）

以 `dsh-loop-rescue` 的 stream 拦截 + followup 续跑为骨架，替换其检测器为
`dsh-loop-detector` 的三层检测器。预留 handoff 升级路径（rice-patrol 模式）。

**语言选择：全 TypeScript。** `dsh-loop-detector` 的 `main` 直接指向 `src/index.ts`
并经 npm 发布可装——证明 dsh 原生加载 TS 插件，检测器可整体 vendor 不改写。

```
src/
├── index.ts          # 插件入口：schema、apply()、inject、生命周期
├── detector.ts       # 三层文本检测器（vendor 自 dsh-loop-detector，保留原版权头）
├── stream-wrap.ts    # llm/stream 瀑布包装：逐 block 检测、剪枝、闭合
├── rescue.ts         # 救援流程：whenIdle → followup → 重试参数 → 上限保护
├── handoff.ts        # 【可选/二期】压缩接力：compactCheckpoint + 新 agent
└── i18n.ts           # zh/en 提示文案
```

### 3.2 核心机制

**机制一：流内剪枝（loop-rescue 方案，一期）**

`agent-loop` 组装 `assistant/message` 时取 `block-end` 载荷而非累计 delta。
在 `llm/stream` 瀑布中拦截每个 reasoning/text block：

1. 逐 block 增量喂检测器（只看尾部窗口，O(1) 摊销）
2. 命中：闭合所有打开的 block（循环所在 block 换成剪过的 `block-end`），以 `stop` 结束流
3. 落盘消息天然不含循环段 → 下一轮上下文干净，模型不会复读自己的输出
4. 原始流仍完整保存在事件 `stream` 记录中，轨迹可追溯

约束：**打开的 block 含工具调用时不切**（半截参数会被宿主执行），退化为 observe。

**机制二：自动续跑**

- `whenIdle()` 等回合真正结束 → `followup()` 发带纠正语的续跑消息
- 续跑的前 N 次请求可换采样参数（`retryTemperature`、`retryReasoningEffort`）
- `maxConsecutiveRescues`（默认 3）防无限救援；一次正常调用即重置计数

**机制三：压缩接力（rice-patrol 方案，二期可选）**

若一期验证"同 agent 续跑仍会再陷"（深层上下文退化）：

1. 提取干净 checkpoint（剔除退化尾巴，校验工具配对完整性）
2. `compactCheckpointSource` 压缩为摘要 message
3. shadow 旧历史、注入 checkpoint、新 agent 接力
4. 接力次数上限 1 次，防套娃

### 3.3 检测器设计（移植自 dsh-loop-detector）

三层检测，全部只看文本尾部窗口，避免长输出 O(n²)：

| 层 | 判定 | 默认参数 |
|---|---|---|
| 周期扫描 | 尾部 N 个周期逐字符一致 | period 8-256，重复 ≥4 次 |
| n-gram | 64 字符块在窗口内出现 ≥3 次（步长抽样允许不对齐） | window 2048，step 16 |
| 锚段 | 512 字符尾块在更早文本复现并向前扩展 | window 8192 |

误伤过滤：重复块需满足 `minDistinctChars≥2`（拦 `-----` 涂抹）且
`minSubstantiveRatio≥0.3`（拦 markdown 分隔线等纯符号重复）。

工具意图层（web_search 打转）：topic-set 检测，新查询相对最近 3 次查询并集
新词占比 <25% 连续 2 次 → 判意图级循环。

<!-- === SECTION 2 END === -->

## 4. 配置规格

写入 profile 的 `cordis.patch.yml`（schemastery 校验，非法值 load 即抛错）：

```yaml
- id: loop-recover
  config:
    mode: rescue           # rescue: 剪+续 | cut: 只剪不续 | observe: 只记录
    watch: both            # both | reasoning | text
    marker: true           # 剪枝处留"〔N chars repeated removed〕"标记
    maxConsecutiveRescues: 3   # 连续救援上限，一次正常调用重置
    # 检测器阈值（移植 detector 默认）
    minPeriod: 8
    maxPeriod: 256
    periodRepeats: 4
    ngramSize: 64
    ngramRepeats: 3
    anchorSize: 512
    minDistinctChars: 2
    minSubstantiveRatio: 0.3
    # 续跑参数
    retryTemperature: 1.0      # resume 请求的采样温度，未设=不变
    retryReasoningEffort: low
    retryRequests: 1           # resume 后几次请求应用上述参数
    # 二期 handoff
    handoffEnabled: false      # 启用压缩接力替代同agent续跑
    handoffMaxCount: 1
    language: auto
```

## 5. 功能点拆分（按 AGENTS.md 逐个推进）

| # | 功能点 | 独立验收标准 | 协作 gate |
|---|---|---|---|
| FP0 | **环境预检**：确认用户 dsh 版本/profile 结构/`inject` 可用性 | `dsh --version` ≥0.1.7、profile 目录可读、官方插件 API 对得上 | 无（自助） |
| FP1 | **项目骨架**：package.json、cordis.patch.yml、index.ts apply/inject 声明 | `dsh plugin add` 安装成功、profile 启动不报错、config schema 校验生效 | 🔴 **GATE-1 冒烟安装**（用户装一次验证兼容，~10min） |
| FP2 | **检测器**：vendor 三层检测 + 实义字符过滤 | 单测：合成循环文本命中、误伤样本零误报、O(1) 摊销（1M 字符流压测） | 🟡 **GATE-2 真实样本**（用户触发一次死循环发 session id → 离线灌检测器调阈值） |
| FP3 | **流内剪枝**：llm/stream 拦截、剪过的 block-end 落盘 | 集成测：注入模拟循环流 → session log 中 assistant/message 不含循环段、原始 stream 记录完整 | 🟡 **GATE-3 observe 实测**（装 observe 模式跑一次真实任务验证误伤，~10min） |
| FP4 | **自动续跑**：whenIdle + followup + 重试参数 + 上限保护 | 集成测：rescue 后任务自动继续、maxConsecutiveRescues 达上限停止、正常调用重置计数 | 无 |
| FP5 | **意图级检测**：web_search topic-set 重复判定 | 单测：同义改写查询序列命中、正常多主题搜索不误伤 | 无 |
| FP6 | **真实场景验证**：本地 oMLX + Ornith/BigBang 长任务实测 | 长上下文任务触发循环 → 插件救回 → 任务完成（验收靠实测日志） | 🔴 **GATE-4 rescue 验收**（用户跑一个会长任务抽查续跑质量） |

**二期（视 FP6 结果决定是否启动）**：

| # | 功能点 | 说明 |
|---|---|---|
| FP7 | 压缩接力 handoff | 仅当"同 agent 续跑再陷率 >30%"时启动，否则一期已够用 |

## 6. 开发计划

| 阶段 | 内容 | 预估 |
|---|---|---|
| D0 | FP0 环境预检（dsh 版本 + API 对齐） | 0.5 小时 |
| D1 | FP1 骨架 → **GATE-1** + FP2 检测器 vendor + 单测 → **GATE-2** | 0.5 天 |
| D2 | FP3 流内剪枝 + 集成测试 → **GATE-3** | 0.5 天 |
| D3 | FP4 续跑 + FP5 意图检测 | 0.5 天 |
| D4 | FP6 真机验证（oMLX + Ornith 长任务）+ 阈值调优 → **GATE-4** | 0.5-1 天 |
| — | **一期合计** | **~2-2.5 天（含 4 个 gate 各 ~10-30min）** |
| D5+ | （可选）FP7 handoff | +1 天 |

## 7. 测试计划

- **单测**：`detector.ts` 为纯函数离线可测——构造 8 类循环样本（单字符、短周期、
  段落复读、`ssss` 坍缩、反思循环模拟、web_search 同义打转）+ 6 类误伤样本
  （代码重复块、markdown 表格、合法长文、工具调用嵌套、中英混排、JSON 输出）
- **真实样本回归（GATE-2）**：用户触发一次死循环后发 session id → 从 profile
  session 事件里提取真实退化文本灌进检测器，校准周期/ngram 阈值并加入固定回归集
- **集成测**：mock `llm/stream` 事件序列验证剪枝正确性；mock agent session
  验证 followup 时序
- **E2E**：本地 oMLX 起 Ornith-BigBang-MTP（已确认长上下文退化），发长任务实测
  触发 → 观察插件日志 + session log 落盘内容 + 任务是否继续
- **回归**：每次阈值调整后重跑全部误伤样本 + 真实样本集

## 8. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| dsh dev-preview API 变动 | 高 | 锁版本 `requires: dsh>=0.1.7`，API 变更时降级为 observe-only 不 crash |
| block-end 剪枝对含工具调用的 block 无效 | 中 | 检测 block 类型，含 tool_call 时跳过剪枝改 observe+steer |
| 同 agent 续跑再陷循环 | 中 | maxConsecutiveRescues 上限 + 二期 handoff 备选 |
| 阈值误伤正常输出 | 中 | observe 模式先跑一周收集数据再开 rescue |
| 与已装 loop-guard 双重截断 | 低 | 文档注明二者取一；本插件 mode=cut 时可与 loop-guard 互补 |
| MIT 版权归属 | 低 | LICENSE 文件并列三个上游 copyright 行；README 注明 vendor 来源 |

## 9. 发布检查清单

- [ ] `dsh plugin --profile test add` 干净安装/卸载
- [ ] observe 模式 3 天零误伤
- [ ] rescue 模式 E2E 通过（Ornith 长任务救回）
- [ ] README.en/zh + 配置说明 + 与 loop-guard 的互斥说明
- [ ] LICENSE 含上游三方 copyright（viego-qiin / citydirector / LeeLizuoLiu）
- [ ] npm 发布（名字：`dsh-loop-recover`，已确认无冲突）


