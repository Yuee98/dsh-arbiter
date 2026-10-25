# 首版范围回归 · 2026-10-25

本目录是 issue #20 的当前契约回归，与 `validation/codex-review/2026-10-21/` 的历史复现分开保存：

- `reproduce.mjs`：在临时 home 中预置一条审计调用和一个 pending 候选，再启动当前构建的插件，验证 S1–S3。
- `results.json`：最近一次运行结果。

覆盖内容：

- **S1** 四个离线建议端点（`/api/arbiter/suggestions`、`/analyze`、`/replay`、`/suggestions/act`）均未注册。
- **S2** 即使存在合法 pending 候选，尝试接纳也无法触达配置编辑器，候选仍为 pending，生效规则不变。
- **S3** 规则测试与日志仍可用，且预置的审计调用未被清除。

## 与历史 R1–R9 的关系

`validation/codex-review/2026-10-21/reproduce.mjs` 及其 `results.json` 保持逐字节原样，作为原型行为的原始证据。其 R8 覆盖的候选接纳流程已从首版移除，因此该用例在当前构建上不再通过。`scripts/check-regressions.ts` 不按用例名放行它，而是断言其 `actual` 观测值符合当前契约：候选仍为 `pending`、未新增规则、且接纳尝试确实因路由不存在而失败。若接纳路由被恢复并生效，R8 会通过或记录 `accepted`，该断言随之失败。R1–R7、R9 仍要求原样通过。

## 运行

```sh
pnpm build
pnpm check:regressions
```

`pnpm verify` 会在构建后串联运行两组脚本；任何未通过其观测值断言的用例都会使检查退出非零，判定规则见 `scripts/regression-verdict.ts`。
