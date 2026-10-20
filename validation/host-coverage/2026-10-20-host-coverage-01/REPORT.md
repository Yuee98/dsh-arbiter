# 七组宿主覆盖验证 · 结果报告

运行 id：`2026-10-20-host-coverage-01`　·　DSH **0.2.1-rc.2**（macOS 27.0.1 / arm64）　·　执行状态：**7 组全部执行**（第 6 组仅基本路径，第 7 组真实人工审批未运行）　·　**1 项运行反证**（监听顺序）

本报告只记录本轮实测。逐条源码依据仍见 [evidence.md §22](../../../evidence.md#evidence-22)，
产品能力矩阵见 [architecture.md 覆盖矩阵](../../../docs/architecture.md#execution-coverage)。

---

## 0. 方法与环境

完整环境与安装指纹（含关键文件 SHA-256）见 [ENVIRONMENT.md](ENVIRONMENT.md)。

**验证对象是宿主，不是 dsh-arbiter。** 本轮没有实现规则引擎、reviewer 或配置页。
探针是 `fixtures/probe.mjs`：一个只处理显式规则的 `tools/pre-execute` 监听器，
其余调用一律 `next()` 交还原链路；它同时记录 `tools/execute`、`tools/result` 与
`tools.guard()` 的位置，用于区分探针、其他监听器、原生 guard 与沙箱各自的作用。

**模型不参与判定。** `fixtures/llm-fixture.mjs` 是与 `ctx.llm.registerAdapter()` 对接的固定回放适配器：
它按 session 内 assistant 步数回放脚本化的 `tool-call`，不联网、不产生判断。
因此本轮结论与 reviewer 质量、阈值无关。

**隔离。** 每个用例一个 `DSH_HOME`（`cases/<id>/home`），一个自建 profile
（`dsh-base` + `dsh-headless` + 用例补丁），工作区 `cases/<id>/ws`，
"根外"是同一用例下的受控同级目录 `cases/<id>/outside`——不是 `/tmp`。
所有用例跑完后都用 `node scripts/summarize.mjs` 汇入 `raw/case-index.json`。

### 挂载位置与监听顺序（实测）

探针挂在 profile 用户层（`cordis.patch.yml` 的 `insert`），fiber id `hostcov-probe`。
在 `native` 模式下，`tools/pre-execute` 的实际监听数组为：

| 用例 | 监听数组（按 dispatch 顺序） |
|---|---|
| `g1-a`（默认挂载） | ① `prepend:true`（非探针）② 探针 decide ③ 探针 sentinel |
| `g1-g`（`prepend: true`） | ① `prepend:true`（非探针）② 探针 decide ③ 探针 sentinel |
| `g1-h`（并存官方 auto-review bundle） | ① ② 两个 `prepend:true`（非探针）③ 探针 decide ④ 探针 sentinel |

headless 组合下非探针的 prepend 监听只有一个；加入官方 auto-review bundle 后变为两个，
与源码中 `dsh-tool-jobs` 和 `dsh-experimental-auto-review` 均以 `{prepend:true}` 注册一致。

> 关键观察：探针用 `prepend: true` 也**不能**排到宿主的 `prepend` 监听之前——
> `waterfall` 的 `unshift` 让后注册者排更前，而宿主插件先于 profile 层注册。
> 若要保证本插件永远第一个看到调用，仅靠 `prepend` 不够，需要显式排序策略
> （见第 8 节"影响设计的发现"）。

---

## 1. 普通工具与探针加载 —— 运行确认

**用例**：`g1-a`（allow 对照）、`g1-b`（deny）、`g1-c`（pass-through）、
`g1-e`/`g1-f`（原生 guard 对照）、`g1-g`（prepend）、`g1-h`（并存 auto-review）。

**同一动作的 allow/deny 对照**（命令都是写 `ws/marker.txt`）：

| 用例 | 探针判定 | 结果 | `marker.txt` | 证据 |
|---|---|---|---|---|
| `g1-a-bash-allow` | allow | success | **存在**（`G1A-OK`） | `cases/g1-a-bash-allow/probe.jsonl` |
| `g1-b-bash-deny` | deny | isError，模型可见 `hostcov fixture: G1-B denied` | **不存在** | `cases/g1-b-bash-deny/probe.jsonl` |
| `g1-c-bash-pass` | 不处理 → `next()` | success | 存在 | `cases/g1-c-bash-pass/probe.jsonl` |

**deny 时 hook 已触发、body 未执行**，由同一次运行的三条独立记录确认：

1. `probe/pre-execute` 与 `probe/decision` 都记到了该 `callId`；
2. **没有** `probe/execute` 记录（`tools/execute` 是 body 派发前的 waterfall）；
3. 无 `marker.txt`，且 `probe/result` 为 `isError: true`。

allow 对照有 `probe/execute` 且标记文件存在，排除了"探针根本没生效"的解释。
`g1-e` 进一步把**探针 allow 与原生 guard** 分开：探针返回 `{kind:"allow"}` 后，
仍被 `ctx.tools.guard()` 拒绝，`probe/guard` 记录 `deny`，`marker.txt` 不存在；
从不匹配的 `g1-f` 则正常执行。**插件的 allow 不能绕过 monotonic guard**，
这条与源码一致，并且本轮有运行证据。

**状态**：全部运行确认。`g1-d`（纯快照用例）用于记录监听顺序，不产生工具调用。

---

## 2. `run_code` 外层与内层工具 —— 运行确认

**用例**：`g2-a`（外层 allow）、`g2-b`（外层 deny）、
`g2-c`（内层 deny + 程序 catch 后继续）、`g2-d`（两个并发内层调用，一放一拒）。

| 用例 | 外层 | 内层 | 程序启动标记 | 内层效果 | 证据 |
|---|---|---|---|---|---|
| `g2-a` | allow | `bash` pass → 执行 | 存在 | `inner.txt` 存在 | 同左 `probe.jsonl` |
| `g2-b` | **deny** | 无 | **不存在** | `inner.txt` 不存在 | 同左 |
| `g2-c` | pass → 执行 | `ptc:1` deny、`ptc:2` pass | 存在 | `inner-denied.txt` **不存在**、`inner-allowed.txt` 存在 | 同左 |
| `g2-d` | pass → 执行 | `ptc:1` pass、`ptc:2` deny | 存在 | `parallel-allow.txt` 读到；deny 返回 `ToolCallError` | 同左 |

**外层拒绝时程序没有启动**：`g2-b` 的程序第一行就是 `writeFileSync("program-started.txt")`，
该文件不存在，且探针只看到一次 `run_code` 的 `pre-execute`，没有任何内层 `ptc` 记录。

**内层拒绝只阻止该内层 body**：`g2-c` 中程序捕获 `ToolCallError`（`toolName: "bash"`），
随后第二个 `tools.bash` 正常执行，外层 `run_code` 最终 `isError: false`。
被拒绝的内层调用**没有** `probe/execute`，允许的那次有。

**调用关联**（`g2-c` 实测值）：

| 层 | callId | rootCallId | parent |
|---|---|---|---|
| 外层 | `fixture-session-c4ed…-0-0` | 同左 | 无 |
| 内层 `ptc:1` | `fixture-session-c4ed…-0-0:ptc:1` | 同外层 | `Symbol(dsh.tool.execution)` |
| 内层 `ptc:2` | `fixture-session-c4ed…-0-0:ptc:2` | 同外层 | `Symbol(dsh.tool.execution)` |

会话日志（`scripts/inspect-session.mjs` 解码）交叉验证了同一组值：
`tool/ptc-dispatch` 记录 `parentCallId` = 外层 callId、`subCallId` = 内层 callId、
`rootCallId` 三者一致。**`parent` 是内层调用令牌，不是父 agent 标识**——本轮用
`exec.agent.session.id` 与 `session.header.parentSession` 另外记录会话身份。

`g2-d` 的并发为两次独立派发（`ptc:1`/`ptc:2`），各自进入 pre-execute，
互不取消；一个 deny 不阻止另一个完成，符合"拒绝不取消其他独立调用"。

**状态**：运行确认。

---

## 3. 直接 Node 效果与文件沙箱 —— 运行确认

程序内直接使用 `node:fs/promises`、`fetch`、`node:child_process`，不经 `tools.*`。
探针在同一环境同时记录工具调用，用于证明"门禁确实在工作"而不是"探针失效"。

| 用例 | 沙箱 | 写 `ws/` | 写 `outside/` | `fetch` 本地接收端 | 子进程 | 探针工具记录 |
|---|---|---|---|---|---|---|
| `g3-a-full-access` | danger-full-access | **成功** | **成功** | 200 `HOSTCOV-ACK` | `G3-CHILD-OK` | 仅 1 条 `run_code` |
| `g3-b-workspace-write` | workspace-write | 成功 | **EPERM** | 200 `HOSTCOV-ACK` | `G3-CHILD-OK` | 仅 1 条 `run_code` |

**直接 Node 效果没有独立工具门禁**：两次运行探针都只看到外层 `run_code`，
而 fs 写入、本地 HTTP 请求、子进程都在同一次程序执行中实际发生（文件、接收端收件
`network-receipt.jsonl`、子进程 stdout 三重证据）。沙箱只改变**文件写入**的允许根，
不改变网络与子进程。

**允许根内／外的对照**（同为 workspace-write）：

| 用例 | 工具 | 目标 | 结果 |
|---|---|---|---|
| `g3-f` | `write` | `ws/inside-tool.txt` | 成功 |
| `g3-d` | `write` | `outside/outside-tool.txt` | 原生 `[sandbox: file access denied under workspace-write mode]`，非探针 |
| `g3-e` | `write` | 同一 outside 路径，full-access | 成功 |
| `g3-c` | `bash` | `outside/` | `Operation not permitted`，探针未拦截 |
| `g3-g` | `bash` | `/tmp/hostcov-g3g-probe.txt` | **成功**——证明 `/tmp` 在实际允许根内 |
| `g3-h` | `read` | `outside/outside-readable.txt` | 成功——沙箱不限制读取 |

**/tmp 不能当作根外**：`g3-g` 在 workspace-write 下写 `/tmp` 成功。
"根外"必须用受控同级目录，本轮使用 `cases/<id>/outside`，且已确认它不在
workspaceRoot 下、也不在 `/tmp` 或 `tmpdir()` 下。

**状态**：运行确认。网络只发向 `127.0.0.1` 随机端口，载荷是固定字符串
`HOSTCOV-G3-FIXED-PAYLOAD` 与 `GET /fixed`。

---

## 4. MCP 工具与资源 —— 运行确认

本地 stdio MCP 服务器（`fixtures/mcp-test-server.mjs`）在**回答任何请求前**先把
每一帧 JSON-RPC 写入收件文件，因此"服务器没有收到 `tools/call`"是可靠证据。

| 用例 | 调用 | 探针判定 | 服务端收件 | 备注 |
|---|---|---|---|---|
| `g4-a` | 直接 `mcp__hostcov__echo_marker` | allow | `tools/call echo_marker {"marker":"G4A"}` | 有 `tools/list` 与 `initialize` |
| `g4-b` | 同一工具 | **deny** | **无 `tools/call`**；只有 `initialize`/`tools/list` | 拒绝发生在 RPC 之前 |
| `g4-c` | `run_code` 内允许一个、拒绝一个 | allow / deny | 只收到 `echo_marker`（G4C-ALLOW） | `write_receipt` 的 deny 未发出 RPC |
| `g4-d` | `list_mcp_resources` + `read_mcp_resource` | allow | `resources/list` + `resources/read hostcov://fixture/alpha` | 返回 `body:alpha` |
| `g4-e` | `read_mcp_resource` | **deny** | **无 `resources/read`** | 服务器仍完成握手 |

**拒绝发生在 RPC 发出前**：`g4-b`/`g4-c`/`g4-e` 的服务端收件里完全没有对应方法；
同一用例中服务器**确实启动并完成了 `initialize` 与 `tools/list`**，
排除了"服务器没起来所以没收到"的替代解释。

**只形成一次工具入口**：`g4-c` 的 MCP 调用在 `run_code` 内仍各自产生一条
`tools/pre-execute`（内层 `ptc` 派发），服务器内部的执行不再有第二次工具门禁。
本轮**不**声称能逐项审查服务器内部效果。

**状态**：运行确认。动态工具列表变化与断连重连为**未运行**（超出本轮范围）。

---

## 5. 进程内 subagent：spawn / fork —— 运行确认

| 用例 | 委派 | 子会话内判定 | 子标记文件 | 子会话身份 |
|---|---|---|---|---|
| `g5-a` | `subagent`（spawn） | allow | 存在 | `origin: subagent`, `depth 1` |
| `g5-b` | `subagent`（spawn） | **deny** | **不存在** | 同上 |
| `g5-c` | `subagent_fork` | **deny** | **不存在** | fork 子会话 |
| `g5-e` | `subagent_fork` | allow | 存在 | fork 子会话 |

**子会话身份与父会话关联**（`g5-b` 实测）：

- 子会话 header：`id: 4d674416-…`、`parentSession: session-a8ee249c-…`、`origin: "subagent"`、`delegationDepth: 1`；
- 探针在子调用上记录到同一组值（`agentSessionId` 与 `sessionParent`）；
- 父会话可见 `subagent/catalog` 事件，子会话有自己的 `subagent/descriptor`。

**创建时的 `never` 不阻止插件先行判定**：子会话自己的日志里有
`approval/policy {policy:"never", source:"delegation"}`，而 `g5-a`/`g5-e` 的插件 allow
仍然让子任务内的 `bash` 执行成功。说明"子任务审批固定 never"影响的是**原生审批 seam**，
不影响更前面的 `tools/pre-execute`。

**原生人工审批被拒的路径**：`g5-d` 让探针返回 `{kind:"ask"}`，子会话中随即出现
`approval/asked` → `approval/decided {outcome:"rejected"}`，工具结果为
`Error: the user rejected tool "bash"`，标记文件不存在。
注意这条消息在 **never 策略下由原生 seam 直接拒绝**产生，
**没有真实的 UI 或人类参与**；它不能记作一次人工拒绝。

**`exec.parent` 不是父 agent**：本轮所有子任务内的调用 `parent` 均为空
（子会话中的工具调用不是 PTC 内层派发），父会话关联只能从
`session.header.parentSession` 或 `agentSessionId` 读取。

**状态**：运行确认。不同 preset、冷恢复、后代与并发会话为**未运行**。

---

## 6. workflow 服务直调 —— 运行确认（基本路径）

| 用例 | workflow 工具入口 | 子任务创建 | 子任务自己的工具调用 | 子标记 |
|---|---|---|---|---|
| `g6-a` | **deny** | 未发生 | 无 | 不存在 |
| `g6-b` | allow | 发生（`subagent/descriptor`） | `bash` **deny** | 不存在 |
| `g6-c` | allow | 发生 | `bash` allow | 存在 |
| `g6-d` | allow | 发生 | `bash` allow（另有直调 `subagent` 对照） | 两个都生成 |

**哪些步骤经过工具门禁**：

- workflow **工具入口**经过 `tools/pre-execute`（`g6-a` 拒绝后没有任何子任务创建，
  连 `subagent/descriptor` 都没有）；
- **编排创建子任务**本身不产生独立的 `subagent` 工具调用：`g6-b`/`g6-c` 的探针只看到
  `workflow` 与之后子会话里的 `bash`，**没有** `subagent` 入口记录。
  `g6-d` 在同一会话里先直调 `subagent`、再用 workflow，对比更明确：
  直调那次有 `subagent` 的 pre-execute，workflow 那次没有，但两者的子任务
  都真实产生了 `bash` 调用与文件效果。
- **本地子任务自己的工具调用**仍走各自的 `tools/pre-execute`（`g6-b` deny 生效，
  标记文件不存在；`g6-c` allow 生效，文件存在）。

因此：**workflow 的内部编排没有独立的逐步骤工具门禁**，能控制的是 workflow 入口
和子 agent 自己的工具调用；本轮不声称覆盖后台运行、取消或生命周期组合。

**状态**：基本路径运行确认；后台/生命周期组合**未运行**。

---

## 7. 原生沙箱升权 —— 运行确认 + 模拟测试（分开记录）

**工具准入与 body 内升权是两道独立的判定**。

| 用例 | 工具入口 | 升权请求 | 原生审批结果 | outside 写入 | 性质 |
|---|---|---|---|---|---|
| `g7-a` | allow | bash body 内请求 `danger-full-access` | `approval/decided: rejected`（never 策略） | **不存在** | 真实宿主，无人类 |
| `g7-b` | allow | run_code body 内请求 | `rejected`（never） | 不存在 | 真实宿主，无人类 |
| `g7-c` | pass（无规则） | bash body 内请求 | `unavailable`（无应答者） | 不存在 | 真实宿主 |
| `g7-d` | allow | bash body 内请求 | `allowed-once` | **存在** | **模拟** |
| `g7-e` | allow | run_code body 内请求 | `allowed-once` | **存在** | **模拟** |
| `g7-f` | allow | bash body 内请求 | `rejected` | 不存在 | **模拟** |

**关键结论**：工具 allow 之后**仍会进入原生审批**。
`g7-a`/`g7-b` 的工具入口是插件 allow，但 body 内的 `sandbox_permissions` 触发了
`approval/asked`，在 `never` 下被原生 seam 直接判为 `rejected`，命令/程序没有产生效果。
`g7-c` 说明即使没有插件规则，`ask` 策略下没有可用应答者时也是 `unavailable`。

**真实人工审批**：本轮**未运行**。没有任何真实用户点击批准或拒绝；
`g7-d/e/f` 的 `allowed-once` 来自 `fixtures/approval-sim.mjs`，
每条记录都标注 `simulated: true`，只能证明"seam 可分离、结果会被采纳"，
**不能**记成 UI 或人工审批已验证。

**状态**：never/ask 下的原生结果运行确认；真实人工路径未运行；模拟路径单独标注。

---

## 8. 运行反证与影响设计的发现

### 8.1 运行反证：`prepend` 不能保证插件排在最前

`g1-a`（默认）与 `g1-g`（`prepend: true`）的监听数组都显示宿主的 `prepend` 监听排在探针之前：

```
g1-a: [ {prepend:true, label:null}, {prepend:false, label:"decide"}, {prepend:false, label:"sentinel"} ]
g1-g: [ {prepend:true, label:null}, {prepend:true,  label:"decide"}, {prepend:false, label:"sentinel"} ]
```

探针用 `prepend` 只是把自已插到**同一 prepend 组里的最前**，但宿主 bundle 的监听
注册得更早，`unshift` 之后仍在更前。这条与"用 prepend 抢队首"的直觉相反。

**影响**：插件若要保证"规则短路先于其他审查"，不能只依赖 `prepend`；
需要显式确认执行顺序（例如让其他审查者也用 `prepend` 并约定注册顺序，
或在产品层明确"本插件不保证优先于 X"）。这与 architecture.md 中
"消除监听器顺序依赖"的设计前提有关，建议在实现前定案。

### 8.2 `tools/pre-execute` 的 allow 不能绕过 `tools.guard()`

`g1-e` 实测：探针返回 allow 后，`ctx.tools.guard()` 仍然拒绝，body 未执行。
这与源码一致（guard 在 waterfall 之后运行），并把"插件 allow = 放行"的说法
限定为"不再经过后续 waterfall/审批"，但**仍受 monotonic guard 约束**。

### 8.3 子任务 `never` 的可见后果

`g5-d` 中，插件把调用交给原生 `ask` 后，子会话的原生 seam 直接返回 `rejected`，
模型看到的是 `the user rejected tool "bash"`。这是**产品文案与实际原因的偏差**：
并没有人类拒绝。architecture.md 已提到旧文案可能误称"用户拒绝"；
本轮在子任务路径上实测到了它。建议 dsh-arbiter 不要依赖原生结果文案，
而是自己记录 `human-abort / fallback-deny / native-never` 的区别。

### 8.4 网络与子进程不受文件沙箱约束

`g3-b` 在 workspace-write 下：文件根外写入 `EPERM`，但 `fetch` 到本地接收端成功，
子进程正常运行。这与源码"Seatbelt 只 deny file-write"一致，
意味着**文件沙箱不能当作网络或子进程的边界**。

### 8.5 MCP 与 workflow 的入口/内部边界

`g4-b`/`g4-e` 证明 MCP 的 deny 发生在 RPC 前（服务端收件为空但握手完成）；
`g6-b`/`g6-d` 证明 workflow 内部创建子任务**不产生** `subagent` 工具入口。
两者都是"能拦截入口，不等于能观察内部每一步"的实例。

---

## 9. 覆盖状态汇总

| 组 | 状态 | 未运行 / 说明 |
|---|---|---|
| 1 普通工具与探针加载 | **运行确认** | — |
| 2 run_code 外层与内层 | **运行确认** | — |
| 3 直接 Node 效果与文件沙箱 | **运行确认** | 网络仅本地接收端 |
| 4 MCP 工具与资源 | **运行确认** | 动态列表变化、断连重连未运行 |
| 5 进程内 spawn/fork | **运行确认** | 不同 preset、冷恢复、后代、并发未运行 |
| 6 workflow 服务直调 | **运行确认（基本路径）** | 后台、取消、生命周期未运行 |
| 7 原生沙箱升权 | **运行确认 + 模拟标注** | 真实人工审批**未运行** |

**未运行的外部条件**：无可用外部后端 subagent；无真实人工审批；未在 Web/headless
以外的 surface 验证；未测不同 profile 的插件安装。

---

## 10. 证据索引

| 内容 | 路径 |
|---|---|
| 用例事实总表 | `raw/case-index.json` |
| 精简事实表 | `raw/case-facts.json` |
| 每组执行日志 | `raw/g1..g7-summary.json`、`raw/g1..g7-stderr.txt` |
| 单用例原始记录 | `cases/<id>/probe.jsonl`、`stdout.txt`、`stderr.txt`、`sessions/`、`result.json` |
| 探针 | `fixtures/probe.mjs` |
| 确定性模型适配器 | `fixtures/llm-fixture.mjs` |
| MCP 测试服务器 | `fixtures/mcp-test-server.mjs` |
| 模拟审批 | `fixtures/approval-sim.mjs` |
| TCP 接收端 | `fixtures/tcp-receiver.mjs` |
| 执行器 | `scripts/run-case.mjs` |
| 会话日志解码 | `scripts/inspect-session.mjs` |
| 固定期望断言 | `scripts/check.mjs`（74 passed, 0 failed） |
