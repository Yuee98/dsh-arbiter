# RQ-19 Milestone 交付报告

所属：[RQ-19](https://github.com/Yuee98/dsh-arbiter/issues/87)（#87），Parent [#64](https://github.com/Yuee98/dsh-arbiter/issues/64)，Milestone [#2](https://github.com/Yuee98/dsh-arbiter/milestone/2)。
代码基线：`569f1ee`（`main`，PR [#114](https://github.com/Yuee98/dsh-arbiter/pull/114)）。本报告在 `feat/review-quality-rq19-acceptance` 上记录。
前序输入：[基线决定](../decision-record.md)、[工程验收范围](../acceptance-scope.md)、[RQ-15 试点报告](../calibration/report.md)、[归一化边界](../normalization-boundary.md)、[RQ-16 验证记录](../verification.md)。

**本报告是 Milestone #2 的收口记录，不是公开发布说明，也不是质量达标声明。**

---

## 四类分列（先读这一节）

Issue #87 的验收条件是「四类不得混写」。本报告因此拆成四个文件，每一类只回答自己的问题：

| 类别 | 文件 | 回答的问题 | 状态口径 |
| --- | --- | --- | --- |
| **A. 工程结果** | [engineering.md](engineering.md) | 六项宿主流程是否在隔离 profile 中真实跑通，证据在哪 | `passed`／`blocked（环境）`／`not-run`，逐项附命令与日志 |
| **B. 核心试点结果** | [pilot.md](pilot.md) | S1 试点让本阶段知道了什么，结论是什么 | 只引用 [calibration/report.md](../calibration/report.md)，不重复其数字 |
| **C. 已知限制** | [limitations.md](limitations.md) | 哪些质量问题仍未解决，边界在哪 | 引用 [acceptance-scope.md §B](../acceptance-scope.md) 的 8 项，逐项给现状 |
| **D. 后续移交项** | [handover.md](handover.md) | 哪些工作不在本阶段，接管条件是什么 | 引用 [acceptance-scope.md §C](../acceptance-scope.md) 的 6 项，含 #85 |

**四类之间的关系，一句话**：A 通过不使 B 变成质量达标；B 的试点结论不消除 C；C 的存在不阻塞 D 的移交；D 的移交不把任何未执行项改写成已通过。

> **工程条件满足 ≠ 质量达标。** 本报告的 `passed` 一律指「实现与行为测试存在、且本机实际执行过」，不指「模型判定准确」「矩阵阈值已冻结」或「保留集已验证」。后三者在 C、D 两类里，状态是 `not-run`。

---

## 一句话结论

**工程条件已满足：`pnpm verify` 通过，完整隔离 DSH E2E 为 59 passed / 1 failed，唯一的失败是既有 UI 缺陷且不属本 PR 范围。质量达标不属本阶段条件，也未被本阶段证明。**

**证据来自两个会话，必须分开记账**：

| 项 | 本 worker 会话（`workspace-write`） | coordinator 完整权限会话 |
| --- | --- | --- |
| `pnpm verify` | 12 步 passed；`check:build` 环境阻塞（pnpm store 不可写） | — |
| `check:build` | `blocked（环境）` | **通过** |
| 完整 E2E | 60 用例 55 passed / 5 failed（均含 `sandbox-exec` 原因） | **59 passed / 1 failed** |

同一条命令在两处结果不同，原因是**会话权限差异**（`workspace-write` 不能写工作区外的 pnpm store，也不能嵌套 `sandbox-exec`；`danger-full-access` 两者都可用），**不是代码差异**——本 PR 对 `src/` 与 `evals/` 的改动为 **0 字节**。

| 陈述 | 是否成立 |
| --- | --- |
| 六项宿主流程的实现存在、有行为测试、且真实跑通 | **成立** |
| 本 PR 未引入 E2E 回归 | **成立**（余 1 失败在未修改的 `main` 上同样失败） |
| `pnpm verify` 通过 | **成立**（`check:build` 由 coordinator 在完整权限会话执行通过） |
| 适用完整隔离 DSH E2E 通过 | **成立（1 项既有缺陷除外）** |
| 工程条件已满足 | **成立** |
| 质量达标 | **不成立**（属 [D 类移交](handover.md) 与 [C 类已知限制](limitations.md)） |

**唯一未通过项**：`tests/e2e/locale-surfaces.spec.ts:361` —— 规则测试对话框遮挡 `Test rule:` 按钮。这是**既有 UI 缺陷**，在未修改的 `main` 上同样失败，本 PR 未修复也未被要求修复（见 [engineering.md §3.5](engineering.md)）。

**证据归属**：`check:build` 通过与本 E2E 结果由 **coordinator 在完整权限会话中验证**，不是本 worker 会话跑出来的。本 worker 会话自己的记录（12/14 步、55/5）原样保留在 [engineering.md §3.6](engineering.md)，两者并存、互不替代。

---

## 本阶段新增的工程发现（收口过程中产生，非试点结论）

这三条不属于 A/B/C/D 任何一类的「已通过」证据，但影响后续判断，单列于此：

| # | 发现 | 影响 |
| --- | --- | --- |
| F1 | **E2E 的 12 个失败里有 7 个不是「本机环境不可修」，而是没按 `docs/development-baseline.md:106` 跑固定 DSH 运行时** | 按基线执行 `npm ci --prefix tests/e2e/runtime` 后，`gate-real`、`history-recovery`、`context-sources`、`agent-guidance` 的 7 个用例立即转为通过（54 passed / 5 failed）。**「失败集与 main 逐条相同」的结论成立，但当时把可修的配置缺失算进了「环境阻塞」**。历史记录（如 `verification.md`）保持原样未改写；纠正记录于 [limitations.md §2.1](limitations.md) 与 [engineering.md §3.2](engineering.md) |
| F2 | `check:build` 的 `ERR_SQLITE_ERROR` 已定位到具体条件：**`CI=true` 时 pnpm 需要写共享 store 的 SQLite 索引，而 store 位于 checkout 之外、本 checkout 不可写** | 不是随机故障，也不是本次改动引起。在空目录里只切换 `CI` 即可复现与不复现（`scripts/check-build.ts:34`／`:50` 硬编码 `CI: 'true'`，因此该脚本本机必然触发）。CI 上通过是因为 runner 的 store 可写。详见 [engineering.md §2.2](engineering.md) |
| F3 | 本 worker 会话剩余的 5 个 E2E 失败中，4 个由 `sandbox-exec` 不可用或由此派生的写入缺失引起，在 coordinator 的完整权限会话中转为通过；**第 5 个 `locale-surfaces` 是既有 UI 缺陷，在未修改的 `main` 上同样失败** | 4 个环境项已由 coordinator 实测解决；`locale-surfaces` 单列为既有缺陷，不记成通过、也不算本 PR 回归。详见 [engineering.md §3.4](engineering.md)／[§3.5](engineering.md) |

---

## Issue 附加验收条件的逐条对照

| 条件（issue #87 原文要点） | 状态 | 证据 |
| --- | --- | --- |
| `pnpm verify` 与适用完整隔离 DSH E2E 通过 | **通过** —— `pnpm verify` 12 步由本 worker 执行，`check:build` 由 coordinator 在完整权限会话执行通过；E2E **59 passed / 1 failed**，唯一失败为既有缺陷 | [engineering.md §3.4](engineering.md) 的双会话记账表与 [§3.5](engineering.md) 的既有缺陷说明 |
| 每项范围可链接到实现和证据；**工程条件**满足才建议整体完成 | **是** | [engineering.md](engineering.md) 六项逐项给实现文件与用例；[pilot.md](pilot.md)／[limitations.md](limitations.md)／[handover.md](handover.md) 各自给引用 |
| 新日志正常保留、无旧迁移入口、evals 未入发布包 | **passed** | 见下方 §「日志、迁移与发布包」 |
| 沿用 #88 的 `startNewSession` 或等价宿主可观察同步 | **passed** | 见下方 §「会话切换同步」 |
| 报告链接新版 decision 的完整十档真实验证（RQ-15 S1），**并明确声明工程通过不代替质量证据** | **是** | [pilot.md §2.2](pilot.md) 指向 [decision-record.md](../decision-record.md)；[pilot.md §4](pilot.md) 与本节末的声明 |
| 链接 #91 的故障／usage／凭据回显回归 | **passed** | 见下方 §「#91 回归」 |
| 四类分列不混写 | **是** | 本文件是索引，四类各自独立文件 |

### 日志、迁移与发布包

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 新日志正常保留 | **passed** | `tests/e2e/history-recovery.spec.ts:928`／`:1064`／`:1115`（补齐固定运行时后三条全过）；`tests/audit.test.ts` 111 tests |
| 无旧配置迁移入口 | **passed** | `src/config/format.ts:21`（`CONFIG_FORMAT_V3`）／`:31-34`（`RETIRED_CONFIG_FORMATS`）只接受 `arbiter-config-v3`；`src/config/policy.ts:14-23` 的 `RETIRED_THRESHOLDS` 把旧阈值字段报为 `policy.retired`；`tests/config-format.test.ts`（14 tests）、`tests/config.test.ts`（39 tests）全过 |
| 无旧审计迁移／修复工具 | **passed** | RQ-06（PR [#104](https://github.com/Yuee98/dsh-arbiter/pull/104)）删除 `scripts/repair-session.ts`；`tests/integration/audit-isolation.test.ts:191` 的 `describe('an unmigratable audit database')` 断言旧结构库被拒绝打开而不是迁移 |
| evals 未入发布包 | **passed** | `scripts/build/package-boundary.ts` 的判定由 `scripts/check-build.ts` 的 tarball 清单与导入扫描执行；本 worker 会话在消费者安装失败前已打印 `Published package: no evals source, schema, data or import.`（`.local/logs/verify.log:664`），coordinator 的完整权限会话则让整步通过 |

> 上面的说明保留了两层证据：本 worker 会话里该断言在消费者安装失败前就已通过；coordinator 的完整权限会话则让 `check:build` 整步通过（`Packed consumer: runtime, types, client factory, patch and locales passed.`）。两者不互相替代，结论以后者为准。

### 会话切换同步

issue 要求「发送前确认会话创建响应对应的 conversation 已显示，并断言最终日志／turn 的 sessionId 与之相同；编辑器可见、固定等待或标记文本本身不能证明切换完成」。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 共享 helper 存在且等两个宿主信号 | **passed** | `tests/e2e/dsh/ui.ts:60` 的 `startNewSession`：先等 `POST /api/session/create` 的 `result.value.sessionId`，再等 `[data-conversation-session="<id>"]` 可见（宿主自己用该属性定位会话归属），无固定 `waitForTimeout` |
| 用例断言 turn 落在该 id 上 | **passed** | `tests/e2e/agent-guidance.spec.ts:635-636`（`other.sessionId === otherSessionId` 且 `!== plainSession.sessionId`）；`tests/e2e/session-admission.spec.ts:745-746`（`expect(plain.sessionId).toBe(plainSessionId)`）；`tests/e2e/session-denial.spec.ts:327`／`:438`／`:580`（`toBe(createdId)`） |
| 这三处用例在本次执行中通过 | **passed** | `agent-guidance`（§3.2 转为通过的 7 条之一）、`session-admission`（本机直接通过）、`session-denial` 的前两条本机通过；**`session-denial` 的第 3 条 `the refusal reason reaches the agent, and parallel calls keep running` 本机 timedOut**，但它的断言对象是并行调用，不是会话切换 |

### #91 回归（故障／usage／凭据回显）

[#91](https://github.com/Yuee98/dsh-arbiter/pull/91)（`fd96646`）修复 decision 传输层，作为本任务的回归基线。三项：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| **故障**（`success:false` 优先于结构完整的答案） | **passed** | `tests/reviewer-protocol.test.ts:1021` *HTTP 200 with success:false classifies as a provider failure*、`:1174` *a provider failure with no code is not reported as a network fault* |
| **usage**（从响应读取并写入 attempt） | **passed** | `tests/reviewer-usage.test.ts`（全文件，含 `:442` *a stream that fails after reporting usage keeps it*）；`tests/reviewer-protocol.test.ts:815` *both attempts contribute their own reported usage* |
| **凭据回显**（三条路径都遮蔽） | **passed** | `tests/reviewer-protocol.test.ts:851` *a credential echoed in a successful answer never leaves review()*、`:894` *a credential resolved by the transport itself is masked too*、`:516` *the credential never reaches a stored field* |

以上用例均在本机 `test:unit`（71 files / 1739 tests）中实际执行并通过（`.local/logs/verify.log:195-196`）。

> **一个诚实的限定**：#91 的真实端点验证（Cloudflare／TypeSafe 三个入口的真实响应）是 **PR #91 当时的记录**，本阶段**没有重跑真实端点**。本报告引用的是**回归测试**层面，不是新的真实端点证据。

### 声明

**工程通过不代替真实模型质量证据。** 本报告的 A 类（工程结果）与上述附加条件全部是工程层面的判据；模型准确率、矩阵阈值合理性、保留集表现属于 [B 类](pilot.md) 的限定结论与 [D 类](handover.md) 的移交项，本阶段**没有**、也**不声称**已达标。

---

## 范围与边界（与 issue 非目标一致）

- 不冻结模型质量数值线（属移交 D1）。
- 不根据 S1 小样本调整评分提示、量表或矩阵（属 C1、C2）。
- 不新增旧兼容、后端专属门、风险上限或模式转换。
- 不以未知／未执行证据声明通过；本 worker 会话未执行的项目写 `blocked（环境）` 或 `not-run`，并在 coordinator 另行提供实测结果时**注明证据来源**，不合并成同一份记录。
- 不执行真实付费模型调用；本报告的 E2E 全部使用确定性 reviewer 桩，不发送模型请求。
- 不关闭 #64 与 Milestone #2 —— 由用户确认。
- **工程条件已满足**，本报告据此建议 Milestone #2 按工程条件收口；**质量达标不属本阶段条件**。milestone 与 #64 的关闭仍由用户确认。
