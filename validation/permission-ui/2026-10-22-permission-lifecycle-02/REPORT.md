# 生命周期时序修正与真实并发补测 · 报告

运行 id `2026-10-22-permission-lifecycle-02`。上一轮 `2026-10-22-permission-recovery-01` 的报告与产物**保留不动**；
本报告只更正其测试时序问题，并补充真实并发与人工审批切换。

宿主 DSH **0.2.1-rc.2**（macOS 27.0.1 / arm64）。指纹见 [ENVIRONMENT.md](ENVIRONMENT.md) 与 `raw/fingerprint.txt`。

## 0. 先更正上一轮的三个测试错误

| # | 上一轮的错 | 后果 | 本轮改法 |
|---|---|---|---|
| E1 | 夹具在 `reviewerDelayMs` **等待结束后**才写 `reviewer-requests.jsonl`，驱动拿它当"审查已开始"的信号 | F3/F4 的停用操作实际发生在原审查**结算之后**，没有覆盖真实收尾窗口 | 夹具在**等待之前**写 `<callId>-started.json`，并按 `<callId>-release` 文件**可控释放**；`callId` 从生产代码的 `review/start` trace 领取 |
| E2 | F4 的新调用依赖会话串行队列，被排在旧轮之后 | 不是并发覆盖 | 新调用在**独立会话**中发出，且该会话**事先已被 arbiter 接管**（用 trace 断言 `gate/entered` 出现过） |
| E3 | F5 的"切出"点击的是**当前已选中的** workspace-write；原生控件 `id === currentValue` 时直接 return | 没有发出任何命令，却被解读成"宿主封锁" | 改为**不同预设**（workspace-write → read-only），并走真实公开通道 `sessions.binding(id).session.command(...)`，记录返回与事件 |

E3 的更正推翻了上一轮的一个结论：**审批挂起时是可以切出的**。见第 3 节。

## 1. 复现出的实现问题（先说结论）

**问题**：上一轮的卸载顺序是 `stop-admission → 等待 active 归零 → 回退权限`。
在 drain 期间，插件已经不再接管新调用，但会话仍是旧的 `danger-full-access`。
于是一个在 drain 窗口内到达的调用会被**免审放行**，并按旧权限执行。

**真实复现**（`raw/t2-failure/`，trusted 部署，停用前会话已是受管）：

| 时刻 | 事件 |
|---|---|
| t | `unload/stop-admission`，`active=1`（旧审查仍held） |
| t+798ms | 另一受管会话提交新调用 |
| t+3.2s | 新调用 `tool/call` seq 35 → `tool/result` seq 38，**写出 workspace 外 `t2-new.txt`** |
| t+30s | `unload/drained` 超时（`active` 仍为 1） |
| — | `unload/rollback` **晚于**上面那次执行（会话日志 seq 45/46） |

**修复**：把权限回退移到 drain **之前**，在 `accepting = false` 之后同步执行。

```ts
runtime.accepting = false;
lifecycle('unload/stop-admission', …);
for (const [sessionId, session] of managed) rollbackSession(session, 'plugin-unload');
// …then wait for the drain, then release
```

理由：停止接管之后到达的调用已经不受 gate 保护，此时唯一能约束它的是**宿主自己的权限**。
回退必须先落地，否则"不等 gate 的调用"就会继承旧的高权限。

**修复后同一场景**（`raw/t2/`）：

| 检查 | 结果 |
|---|---|
| 回退时机 | `stop-admission` 后 **1ms** 即写入 `sandbox/mode: workspace-write`，`rolledBeforeDrainMs: 0` |
| 新调用 | 在 stop 后 3251ms 提交，落在回退之后 |
| 文件效果 | `t2-new.txt` **不存在**，工具返回 `Operation not permitted [sandbox: file access denied under workspace-write mode]` |
| 旧的在途调用 | 审查仍 `review-allow`；其执行被收窄后的沙箱取消（`tool/call` 无对应 `tool/result`），未产生部分效果 |
| 隔离对照 | 未受管会话不受影响 |

**回归测试**：`tests/unload.test.ts` 新增 `permission is rolled back before the drain wait, not after`，
用生产代码自己的 `ARBITER_TRACE_PATH` 轨迹断言 `rollback` 出现在 `stop-admission` 之后、`drained` 之前。
已验证该测试在**旧顺序下失败**、新顺序下通过（这是本轮唯一因此新增的测试）。

## 2. 测试观测点（不改变执行语义）

为让并发窗口**可证**而非靠 sleep 猜，正式代码增加了只在 `ARBITER_TRACE_PATH` 设置时写入的轨迹：

| 事件 | 含义 |
|---|---|
| `gate/entered` | 调用进入 arbiter 门禁（含 callId、sessionId、`active`） |
| `gate/skipped` | 调用到达门禁但被 `accepting=false` 放行 |
| `review/start` · `review/settled` | 审查开始/结算，带真实 callId |
| `unload/stop-admission` · `drained` · `rollback` · `release` | 生命周期四个节点 |

这些都是**纯观测**：默认关闭，不参与任何判定。夹具据此领取 `callId`，从而能"只释放我正在测的那一次审查"。

## 3. 真实停用与卸载期间的新调用

两种操作都通过**真实插件页**执行（`setPluginEnabled` / `removeBundle`），没有使用探针路由或直接 dispose。

| 场景 | 结论 | 级别 |
|---|---|---|
| trusted 下旧审查在途，正常返回 allow | 审查 `review-allow`，回退后其执行被沙箱取消 | 正式插件运行确认 |
| 停止接管后、回退前到达的新调用 | 见第 1 节：修复前可越界写盘，修复后被挡 | 正式插件运行确认 |
| 另一已启用且受管的会话 | 用 trace 断言其 `gate/entered` 早于停用；其新调用同样受新权限约束 | 正式插件运行确认 |
| 未受管会话对照 | 不受影响 | 正式插件运行确认 |
| 真实卸载（`removeBundle`）期间 | 依赖删除、bundle 取消选择、路由 404；重启不复活；关闭会话可重开 | 正式插件运行确认 |
| 卸载期间的在途审查 | 12s 审查仍 `review-allow` 并写出文件，随后插件被移除 | 正式插件运行确认 |

### 3.1 同一会话内的并行工具入口（已实测，不是"遇不到"）

原先记为"未覆盖"的理由是会话串行队列——这个理由**不成立**。宿主在同一步骤内通过调度池并发派发工具调用：

- `dsh-agent-loop` 的 `fillPool` / `maxParallelToolCalls`（默认 **10**）会同时启动多个调用；
- 是否并行由工具自己的 `isConcurrencySafe(args)` 决定（`dsh-tools` 的 `executionMode`，仅精确 `true` 才并行）；
- `read` 与 `web_search` 都声明了 `isConcurrencySafe: () => true`，`bash` 则没有。

因此**同一步骤里的两个 `read` 会真正并发进入 `tools/pre-execute`**。实测（`raw/t7/`）：

| 观察 | 值 |
|---|---|
| 同一步骤的调用 | seq 27 与 29，均为 `read`，`step: 1` |
| gate 进入时刻 | `0-0` 在 +0ms、`0-1` 在 +6ms，两次 `gate/entered` 都在第二次审查挂起期间 |
| 审查 | 两个独立 `review/start`，第二条被夹具挂住 650ms |
| 裁决 | 两条 `review-allow`，各自独立 |
| 结果 | 两个 `tool/result`，都成功 |

所以这项不是"显示中不会遇到"，而是真实存在、且已经验证过。上一轮的"串行队列"判断只对**同一条消息被排队**成立，
不适用于同一步骤内的多个工具调用。

## 4. 人工审批挂起时的切换

审批已产生（`approval/asked`）且未答复时，分别执行：

| 入口 | 实际参数 | 返回 | 命令事件 | 权限 | 审批 |
|---|---|---|---|---|---|
| 原生通道，不同预设 | `/permission read-only` | `{ok:true,value:{matched:true}}` | `command/run` seq 29 `" read-only"` → `command/done` success | `workspace-write` → **`read-only`** | **仍挂起** |
| 显式同值命令 | `/permission workspace-write` | `{ok:true,value:{matched:true}}` | seq 33 → 36 success | `read-only` → `workspace-write` | **仍挂起** |

所以上一轮"宿主封锁、无法切出"的结论是**测试错误**，不是宿主边界。真实行为是：**切换成功，审批保持挂起**。

驱动接入方式与原生控件一致：`sessions.binding(sessionId).session.command('/permission <preset>')`
（对应 `dsh-client-ui-permission-presets/lib/client.js` 的 `submit`）。桥是测试用客户端插件
（`probes/command-bridge/`），只转发字符串并原样返回结果，不做任何判断。

### 真实停用／卸载期间的审批保留

| 操作 | 审批状态 | 工具 |
|---|---|---|
| 真实停用（`setPluginEnabled`） | 仍为 `approval/asked`，未结算 | 未执行 |
| 真实卸载（`removeBundle`） | 仍为 `approval/asked`，未结算 | 未执行 |

即：**移除 arbiter 不会丢弃已经弹出的审批**，它仍由宿主持有并可继续答复。

## 5. 切换之后的真人结算（已取得）

操作者在**切到 read-only 之后**点了「允许一次」。完整序列：

| seq | 事件 | 关键值 |
|---|---|---|
| 27 | `tool/call` | bash 写 `ws/t5-ask.txt` |
| 28 | `approval/asked` | 请求人工决定 |
| 29–32 | `/permission read-only` | `command/done success`，`sandbox/mode: read-only` |
| 33 | `approval/decided` | **`allowed-once`**（真人点击） |
| 34 | `plugin:arbiter/decision` | **`human-allow`**，trace `review(default) → review-escalate → human-allow` |
| 37 | `tool/result` | **`Operation not permitted [sandbox: file access denied under read-only mode]`** |

**结论**：真人批准决定的是**裁决**（`human-allow`），**不会**把权限重新放宽。
该调用被批准，但执行时仍被收紧后的 read-only 沙箱挡住，文件未生成。

这符合契约"实际执行仍尊重宿主沙箱"：审批是授权判断，不是权限升级。
同时保留了应有的区分——这条记为 `human-allow`（不是 `human-deny`），"批准但被沙箱挡住"与"被人拒绝"是两件事。

证据：`raw/t5h/`（`t5h-01-switched.json` 记录切换前的挂起状态，`t5h-02-result.json` 记录结算全序列）。

## 5.1 对照：取消 ≠ 人工拒绝

`raw/t5h-cancel/` 记录了一次**宿主在审批挂起时被终止**（驱动的收尾清理，不是真人点击）：

| 事件 | 值 |
|---|---|
| `approval/decided` | `cancelled` |
| 裁决 | `human-abort`（trace `review(default) → review-escalate → human-abort`） |
| 工具 | 未执行，`Not executed [human-abort]` |
| 文件 | 未生成 |

这正好验证契约要求的区分：**等待与宿主取消不能被记成人工拒绝**——`cancelled` 映射到 `human-abort`，而不是 `human-deny`。

这条只作为**取消语义**的对照，不计入人工审批证据——它由驱动收尾时终止宿主产生，不是真人操作。
切换之后由真人答复的结算见**第 5 节**（已取得）。

## 6. 仍未验证

并发项已无遗留：同会话并行由 `raw/t7/` 覆盖。剩余都是范围或环境限制，不是并发窗口：

| # | 项 | 原因 |
|---|---|---|
| L1 | 冷恢复覆盖全部历史会话 | 只覆盖被打开的那一个 |
| L2 | 正式客户端选择器接入会话启停 | 属实施，不在验证范围 |
| L3 | 日常 profile 历史日志迁移 | 交接明确排除 |

## 7. 证据索引

| 组 | 产物 |
|---|---|
| T2 修复前（失败） | `raw/t2-failure/t2-01-window.json`、`arbiter-trace.jsonl`、`decisions.jsonl` |
| T2 修复后 | `raw/t2/t2-01-window.json`、`arbiter-trace.jsonl`、`t2-01-window.png` |
| T5 挂起时切换 | `raw/t5/t5-01-pending.json` … `t5-05-still-pending.json` |
| T5 生命周期期间审批 | `raw/t5l/t5l-01-disable.json`、`t5l-01-uninstall.json` |
| 切换后真人结算 | `raw/t5h/`（切到 read-only → 真人允许 → `human-allow` → 执行被沙箱挡住） |
| 切换后宿主取消（非真人对照） | `raw/t5h-cancel/` |
| 同会话并行工具入口 | `raw/t7/t7-01-parallel.json`、`t7-01-parallel.png` |

`cases/` 保留隔离 `DSH_HOME`、profile、会话日志、夹具 `barrier/` 轨迹与截图。不含 token 或 Cookie。
