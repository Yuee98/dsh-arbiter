# 评审复现 · 2026-10-21

本目录保留首轮实现评审提供的 9 项补充复现：

- `reproduce.mjs`：调用构建后的真实产品模块，使用显式生命周期夹具；所有写入在临时目录，结束清理。
- `results.json`：最近一次运行结果。返修前为 9/9 FAIL；返修后为 **9/9 PASS**。
- 逐项根因、修复和验证见[返修记录](../../../docs/implementation-review-remediation-2026-10-21.md)。

> **2026-10-25 更新**：首版范围收敛（issue #20）移除了离线建议的公开入口与接纳路由，因此 `reproduce.mjs` 中 R8 的预期改为“接纳端点不存在，候选状态与生效配置均不变”。R1–R7、R9 未改动；上面记录的返修结果与 `results.json` 保持原样，作为历史证据。

## 运行

```sh
mise exec -- pnpm build
mise exec -- pnpm check:regressions
```

`pnpm verify` 已在构建后自动执行该脚本。脚本不启动 DSH、不调用模型、不访问真实人工审批；它证明产品模块在给定夹具下的行为，不等同于真实 Loader 热更新或浏览器流程。
