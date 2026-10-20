# DSH 宿主覆盖验证 · 2026-10-20-host-coverage-01

本轮只验证 **DSH 宿主接入机制**，没有实现 dsh-arbiter，也没有规则引擎、reviewer 或配置界面。
范围是 [implementation.md 七组第一轮用例](../../../docs/implementation.md#host-coverage-validation)，
不是文末 1–47 总清单。

## 环境

| 项 | 值 |
|---|---|
| DSH 版本 | **0.2.1-rc.2**（与项目源码结论针对的版本相同） |
| 平台 | macOS 27.0.1（Darwin 25），arm64 |
| 宿主 | DeepSeek Harness Desktop，安装包 `app.asar` 内 dsh 运行时 |
| Profile | 隔离的临时 profile `hostcov`，位于本目录 `cases/<case>/home/profiles/hostcov` |
| DSH_HOME | 每用例独立 `cases/<case>/home`，从不指向 `~/.dsh` |
| 模型 | 固定回放的本地 fixture adapter（`hostcov`），不调用任何真实模型 |
| 安装指纹 | 见 [ENVIRONMENT.md](ENVIRONMENT.md)（关键文件 SHA-256 与 evidence.md §22 一致） |
| 审批策略 | 按用例为 `ask` 或 `never`；无真实人工参与 |
| 文件沙箱 | 按用例为 `workspace-write` 或 `danger-full-access` |
| 工具展示 | 按用例为 `native` 或 `ptc` |

日常 profile（`~/.dsh/profiles/desktop`）未被修改：本轮所有 profile 都写在用例目录内。
本轮未安装任何插件到日常 profile，也没有启动替代 Web 服务。

## 目录

```
fixtures/    探针插件、确定性 LLM 适配器、MCP 测试服务器、模拟审批应答器、TCP 接收端
scripts/     run-case.mjs（用例执行器）、summarize.mjs、inspect-session.mjs（会话日志解码）
scenarios/   g1–g7 用例定义（JSON）
ENVIRONMENT.md  平台、版本、安装包 SHA-256
cases/       每个用例的 profile、scenario、probe.jsonl、stdout/stderr、sessions、result.json
raw/         case-index.json（全部用例事实索引）、case-facts.json、各组 summary/stderr
```

## 复现

```bash
cd validation/host-coverage/2026-10-20-host-coverage-01
for g in g1 g2 g3 g4 g5 g6 g7; do
  node scripts/run-case.mjs scenarios/$g.json > raw/$g-summary.json 2> raw/$g-stderr.txt
done
node scripts/summarize.mjs   # 重建 raw/case-index.json
node scripts/check.mjs       # 固定期望断言（不调用模型；当前 74 passed, 0 failed）
```

`scripts/check.mjs` 只读取已记录的产物并断言固定结果，不重跑 DSH、不询问模型。
探针给出的是固定 allow／deny，所以每个用例的期望值是常量。

每个用例都在独立的 `DSH_HOME` 下用真实 `dsh` CLI 以 headless 模式运行，因此可以单独重放。

## 与其他证据的分界

- **运行确认**：本目录 `cases/<id>/` 下有本轮实测记录。
- **模拟测试**：`approvalSim` 参与的 `g7-d/e/f` 使用 `fixtures/approval-sim.mjs` 自动应答。
  这只是证明审批 seam 可分离，**不是人类批准**，日志里每条都带 `simulated: true`。
- **仅源码支持** / **未运行**：见 [evidence.md §22](../../../evidence.md#evidence-22) 与本轮报告
  [REPORT.md](REPORT.md)。

## 收尾

临时插件、profile、会话和进程都在用例目录内；本轮结束后没有后台进程残留，
`~/.dsh` 下的日常配置与 profile 未被写入。
