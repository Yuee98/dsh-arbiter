# dsh-arbiter 首轮集成验证 · 2026-10-21-arbiter-01

本目录记录 **dsh-arbiter 插件本身**在真实 DSH 0.2.1-rc.2 宿主中的首轮集成结果。它不是七组宿主覆盖验证的替代；七组证据仍保留在 `validation/host-coverage/2026-10-20-host-coverage-01/`。

## 方法

- **真实宿主**：DSH desktop 0.2.1-rc.2，`ELECTRON_RUN_AS_NODE=1` 运行 CLI，headless profile。
- **真实接入点**：`tools/pre-execute`、真实工具执行、真实 DSH 会话持久化、真实 `approval/request` seam、真实 SQLite。
- **隔离**：每个用例独立 `DSH_HOME`、自建 profile、workspace；`dsh-arbiter` 以 link 安装到 profile。日常 `~/.dsh` 未被修改。
- **确定性模型**：`fixtures/arbiter-llm.mjs` 回放 agent 工具调用，并按 `REVIEW_POLICY` 系统提示返回固定 reviewer JSON。它不是真实模型；本轮结论与模型质量／阈值无关。
- **模拟人工**：`fixtures/approval-sim.mjs` 自动回答审批请求，每条记录都带 `simulated: true`。这只证明审批 seam 与插件映射，**不是**真实人工审批。
- **证据**：`raw/results.json`、`cases/<id>/result.json`、`cases/<id>/stdout.txt`、`stderr.txt`、`approval-sim.jsonl`、`reviewer-requests.jsonl`、`agent-requests.jsonl`、`sessions/`、SQLite 在 `cases/<id>/home/arbiter/arbiter.db`。
- **断言**：`scripts/check.mjs` 读取已记录产物，固定期望 146 项，不重跑 DSH、不调用模型。

## 用例与结果

| 用例 | 规则／信号 | 权限结果 | 执行 | 模型调用 | 模拟人工 | 判定链 |
|---|---|---|---|---|---|---|
| allow-rule | 完整 allow（命令 + workspace redirect） | allow | success | 0 | — | allow |
| deny-rule | deny `^echo` | deny | not-started | 0 | — | deny |
| review-allow | reviewer risk 1 / auth 8 | review-allow | success | 1 | — | review(default) → review-allow |
| review-deny | reviewer risk 10 / destructive | review-deny | not-started | 1 | — | review(default) → review-deny |
| review-error-fallback | 两次非法 JSON；strict | fallback-deny | not-started | 2 | — | review(default) → error-escalate → fallback-deny |
| force-ask-strict | force-ask；strict | fallback-deny | not-started | 0 | — | force-ask → fallback-deny |
| force-review-shadow | allow + force-review；reviewer risk 2 | review-allow | success | 1 | — | force-review → review-allow |
| audit-unavailable | 完整 allow；SQLite 打开失败 | allow | success | 0 | — | allow（SQLite 缺失，会话记录写入） |
| force-ask-human-allow | force-ask；normal；模拟 allowed-once | human-allow | success | 0 | 1 | force-ask → human-allow |
| force-ask-human-deny | force-ask；normal；模拟 rejected | human-deny | not-started | 0 | 1 | force-ask → human-deny |
| review-escalate-human-allow | reviewer auth 2 → review-escalate；模拟 allowed-once | human-allow | success | 1 | 1 | review(default) → review-escalate → human-allow |
| review-escalate-human-abort | reviewer auth 2；模拟 cancelled | human-abort | not-started | 1 | 1 | review(default) → review-escalate → human-abort |
| subagent-allow | 父 `subagent` 工具 + 子 bash 均由规则 allow | allow / allow | success / success | 0 | — | 两次独立 allow；会话类型 main / subagent |
| probe-override | reviewer 全 false；`.env` + curl 事实 | review-deny | not-started | 1 | — | review(default) → review-deny（R1） |

`scripts/check.mjs`：**146 passed, 0 failed**。

## 关键观察

1. **规则短路确实没有调用 reviewer**：allow-rule 的 `model_calls` 为 0、`reviewer-requests.jsonl` 为空，marker 文件存在且 `tools/result` 成功。
2. **deny 时 body 未执行**：deny-rule 的 marker 不存在，调用执行状态 `not-started`，SQLite 无模型调用。
3. **真实 reviewer 链路可用**：review-allow／review-deny 各产生 1 条模型调用记录、1 条 reviewer 请求；判定链与信号保存到 SQLite。
4. **非法输出不会被当成 allow**：review-error-fallback 记录 2 次尝试（首次 + 1 次修复），最终 `error-escalate`；strict 模式结算为 `fallback-deny`，marker 不存在。
5. **force-ask 不交模型代批**：strict 下没有模型调用，直接 `fallback-deny`。
6. **force-review 遮蔽 allow**：trace 从 `force-review` 开始并调用 reviewer；配置页会提示这类遮蔽。
7. **审计故障不改变权限**：`audit-unavailable` 中 `$DSH_HOME/arbiter` 被一个普通文件占用，SQLite 无法打开；marker 仍被写入，工具成功；会话日志中仍有 `plugin:arbiter/decision`，内容为 allow。
8. **人工结果区分清楚**：模拟 allowed-once → human-allow、rejected → human-deny、cancelled → human-abort；human-abort 不再混作 human-deny。
9. **子任务身份可区分**：subagent-allow 的两条调用分别记录为 `main` 与 `subagent`，父委派与子任务自己的 bash 调用各自经过门禁。
10. **事实只往更危险方向用**：probe-override 中 reviewer 报告 risk 1、全部探针 false；`probeMode: override` 用 `.env` 读取与 curl 网络事实把 secrets／egress 置真，R1 拒绝。
11. **每个结果都有会话记录**：会话日志包含 `plugin:arbiter/decision`；SQLite 详情包含调用、阶段、ReviewSnapshot 和模型调用。

## 未运行

- **真实人工审批**：本轮没有用户点击；模拟应答只证明 seam 可分离。
- **真实模型质量**：集成 reviewer 是固定回放；不能用它评价误放率、阈值或 progress 额外代批质量。
- **真实 decision 后端**：无 endpoint／凭据，仅有协议单元测试。
- **浏览器 UI 点击**：配置页路由与真实数据在隔离 Web profile 中实测，客户端 bundle 由真实模块图加载（200，约 108 KB）；但没有在浏览器中点击表单。
- **子 agent 的其余组合**：本轮只新增了“父委派 + 子任务 allow”的基本路径；子任务 deny、progress、父证据、冷恢复与并发未测。MCP 与 workflow 的插件级组合未新增。
- **无 `exec.agent` 的程序化调用**：当前实现直接 `next()`，属于声明覆盖缺口，未做集成。

## 复现

```sh
cd validation/arbiter-integration/2026-10-21-arbiter-01
node scripts/run-case.mjs      # 真实 DSH，约 1–2 分钟
node scripts/check.mjs         # 读取 raw/results.json，146 项固定期望
```

`run-case.mjs` 会重建 `cases/` 与 `raw/results.json`；每个用例独立 `DSH_HOME`，不会写入日常 profile。Web 复核步骤见[首轮实施报告](../../../docs/implementation-report.md#33-web-配置与查询真实宿主路由无浏览器点击)。

## 收尾

用例的 profile、会话、SQLite 和临时 workspace 都在本目录内；本轮结束后没有后台 DSH 进程残留（隔离 Web 验证使用的后台进程已停止）。日常 `~/.dsh` 未被修改。
