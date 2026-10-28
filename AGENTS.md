# dsh-loop-recover 开发规范

## 推送/发布规则（用户明确要求）

- **git push 和 npm publish 只在用户明确说"推"时才执行**
- 平时所有改动只做本地 commit（不 push）
- 版本号 bump 也只在发布前做

## 开发流程

- `npm test` 全绿才能提交；`npm run check` 验证插件加载
- 检测器改动必须过真实样本回归（test/fixtures-real-loop.txt）
- 与 loop-guard / auto-continue / session-shift 互斥，文档必须同步更新冲突表

## 市场投稿（待用户确认后执行）

- awesome-dsh-plugin 市场投稿文件草稿在 `docs/market-submission.yml`
- 仓库需满 1 天才能提交（创建于 2026-10-27）
- 提交流程：fork awesome-dsh-plugin → 加 data/plugins/terry2010__dsh-loop-recover.yml → PR
