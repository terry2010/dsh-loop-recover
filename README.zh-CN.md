<p align="center">
  <!-- IMAGE: banner/logo —「检测→剪枝→压缩→续跑」循环救援概念图 -->
  <img src="https://raw.githubusercontent.com/terry2010/dsh-loop-recover/master/docs/assets/banner.jpg" alt="dsh-loop-recover" width="720">
</p>

<h1 align="center">dsh-loop-recover</h1>

<p align="center">
  <em>检测模型死循环并自动救回，任务原地续跑。</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-loop-recover"><img src="https://img.shields.io/npm/v/dsh-loop-recover?logo=npm&label=npm" alt="npm 版本"></a>
  <a href="https://github.com/terry2010/dsh-loop-recover/stargazers"><img src="https://img.shields.io/github/stars/terry2010/dsh-loop-recover?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT 协议"></a>
  <img src="https://img.shields.io/badge/GUI--configurable-0ea5e9?style=flat" alt="GUI 可配置">
  <br>
  <a href="https://github.com/terry2010/dsh-loop-recover/blob/master/README.md">English</a> · <b>中文</b>
</p>

---

## 做什么

本地小模型（Ornith，部分版本 qwen 等）容易陷入两类死循环：**字面刷屏**（`ssssss...`）和**语义复读**（反复论证同一段话）。普通循环守卫只会"切断+终止"，任务直接死掉。

`dsh-loop-recover` 是完整的救援链：

- **检测** —— 五层检测器：周期扫描 / n-gram / 锚段 / 单字符刷屏 / 短句池 + 意图级工具查询跟踪
- **剪枝** —— 流内切掉重复后缀，留一行标记让模型知道这里删过东西
- **压缩** —— 被污染的上下文换成检查点摘要（v4 `compaction/*` 事务），模型没法再回放同样的推理
- **续跑** —— 自动 followup 原任务，换采样参数——**不开新会话，不重启**

全在同一个 agent 循环里完成，救援后模型继续干活。


## 安装

### GUI（推荐）

打开 **插件 → 添加插件**，搜 `dsh-loop-recover`，点安装。

### 命令行

```sh
dsh plugin --profile desktop add dsh-loop-recover
# 然后重启 app
```

## 配置

32 个配置项全部在插件页可视化编辑——不用手写 YAML。分组：基本 / 救援 / 续跑参数 / 意图检测 / 检测阈值 / 检测器（高级折叠）。

| 分组 | 关键字段 |
|---|---|
| 基本 | `mode`（rescue/cut/observe）、`watch`、`language`、`keepLanguage`、`marker`、`debugLog` |
| 救援 | `maxConsecutiveRescues`（连续救援上限）、`compactOnRescue`（续跑前压缩）、`stallCalls`（空转提示） |
| 续跑 | `retryTemperature`、`retryReasoningEffort`、`retryRequests` |
| 意图 | `intentEnabled`、`intentNoveltyThreshold`、`intentConfirmCount` |

**模式**：`rescue`（剪+压+续，默认）、`cut`（只剪不续）、`observe`（只记日志零干预——先用它评估阈值再上救援）。

## 冲突说明

不同插件解决不同问题——**不要叠装**：

| 插件 | 做什么 | 冲突原因 |
|---|---|---|
| `dsh-agent-loop-guard` | 检测循环即切断 | 同包装 `llm/stream` → 双重截断、状态错乱 |
| `dsh-client-auto-continue` | 中断后自动续跑 | 重复唤醒 → 两条冲突的续跑指令 |
| `dsh-session-shift` | 上下文压力压缩→新会话 | 职责重叠 → 一边压缩一边开新会话 |

用本插件时请禁用它们。

## 工作原理

```
llm/stream（仅 agent 调用）
  ↓ StreamLoopDetector 监控 reasoning & text 块
命中循环 → 剪除重复后缀 → 重写 block-end → finish: stop
  ↓ commitLoopCompaction——v4 事务，旧上下文换检查点
  ↓ followup()——续跑原任务，换采样参数
```

非 agent 请求（标题/摘要生成）原样透传不干预。

## 开发

```sh
npm test        # 66 个单元+集成测试
npm run check   # 插件加载冒烟
```

## 协议

MIT · [NOTICE](NOTICE) 上游署名（改自 dsh-compaction 辅助代码）。
