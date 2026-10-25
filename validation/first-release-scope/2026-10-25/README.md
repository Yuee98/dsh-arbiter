# 首版范围回归 · 2026-10-25

本目录是 issue #20 的当前契约回归，与 `validation/codex-review/2026-10-21/` 的历史复现分开保存：

- `reproduce.mjs`：在临时 home 中预置一条审计调用和一个 pending 候选，再启动当前构建的插件，验证 S1–S3。
- `results.json`：最近一次运行结果。

覆盖内容：

- **S1** 四个离线建议端点（`/api/arbiter/suggestions`、`/analyze`、`/replay`、`/suggestions/act`）均未注册。
- **S2** 即使存在合法 pending 候选，尝试接纳也无法触达配置编辑器，候选仍为 pending，生效规则不变。
- **S3** 规则测试与日志仍可用，且预置的审计调用未被清除。

## 与历史 R1–R9 的关系

`validation/codex-review/2026-10-21/reproduce.mjs` 及其 `results.json` 保持逐字节原样，作为原型行为的原始证据。其 R8 覆盖的候选接纳流程已从首版移除，因此该用例在当前构建上按预期失败，并由 `scripts/check-regressions.ts` 显式列为已知例外，不改写脚本、不删除用例。R1–R7、R9 仍在当前构建上通过。

## 运行

```sh
pnpm build
pnpm check:regressions
```

`pnpm verify` 会在构建后串联运行两组脚本；任何未列入已知例外的失败都会使检查退出非零。
