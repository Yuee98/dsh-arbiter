# 首轮 dsh-arbiter 集成验证

运行 id：`2026-10-21-arbiter-01`。验证对象是 **dsh-arbiter 插件**，宿主为 DSH 0.2.1-rc.2（macOS / arm64）。

- 结果与逐用例事实：[REPORT.md](REPORT.md)
- 固定断言：`node scripts/check.mjs` → 146 passed, 0 failed
- 原始数据：`raw/results.json`；逐用例 `cases/<id>/`
- 复现：

```sh
node scripts/run-case.mjs
node scripts/check.mjs
```

## 装置

| 文件 | 作用 | 是否真实人类/模型 |
|---|---|---|
| `fixtures/arbiter-llm.mjs` | 回放 agent 工具调用；对 `REVIEW_POLICY` 请求返回固定 reviewer JSON | 否，确定性 fixture |
| `fixtures/approval-sim.mjs` | 自动回答 `approval/request` | **否，模拟**；每条记录 `simulated: true` |
| `scripts/run-case.mjs` | 为每个用例创建隔离 `DSH_HOME`/profile/workspace，运行真实 CLI，收集 SQLite、会话、marker、请求日志 | — |
| `scripts/check.mjs` | 读取 `raw/results.json` 并断言固定期望 | — |

每个用例的 profile 位于 `cases/<id>/home/profiles/arbiter-it/`；插件通过 `node_modules/dsh-arbiter` link 指向仓库。日常 `~/.dsh` 和日常 profile 未被修改。

## 与宿主覆盖证据的分界

七组宿主覆盖验证（`validation/host-coverage/2026-10-20-host-coverage-01/`）验证的是宿主接入机制，不是本插件。本目录验证插件自身的规则、reviewer、审批、审计和配置集成；不重复声明七组中的 MCP、子 agent、workflow 和真实人工路径已覆盖。
