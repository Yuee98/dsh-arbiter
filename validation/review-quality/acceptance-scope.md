# RQ-H2 窗口二：工程验收范围、已知问题与后续移交

所属：RQ-H2（[#83](https://github.com/Yuee98/dsh-arbiter/issues/83)），Parent [#64](https://github.com/Yuee98/dsh-arbiter/issues/64)，Milestone [#2](https://github.com/Yuee98/dsh-arbiter/milestone/2)。
基线决定：[decision-record.md](decision-record.md)（代码版本 `366f73d`、候选 A、`review-contract-v1`、`review-rubric-v1`、core-v1）。
证据来源：[RQ-15 试点报告](calibration/report.md)、[资源决定](resource-decision.md)、[同逻辑核对](parity.md)、[归一化边界修复](normalization-boundary.md)、[RQ-16 验证记录](verification.md)。

本文件把本阶段的验收范围拆成**三段互不混写**的部分：

- **A. 工程验收清单** —— 哪些工程条件已满足，证据在哪里；
- **B. 已知问题清单** —— S1 试点暴露了什么质量问题，仍未解决；
- **C. 后续移交清单** —— 哪些工作不在本阶段，接管条件是什么。

> **阅读前提**：A 段的每一项都是**工程条件**，`passed` 指「实现与行为测试存在且通过」，**不指**「模型质量达标」。
> B 段的每一项都是**未解决的质量问题**，不因 A 段通过而消失。
> C 段的每一项都是**未执行**（`not-run`）或**工具不支持**（`not-possible`），一律不写成已通过。

---

## A. 工程验收清单

**统计：7 个类别，23 个条目。** 每项格式为「条件 → 验证方式 → 证据」。

状态分布：**20 项 `passed`**；`A6.3` 为 `passed（工具）／pending（真实重置）`；`A7.1` 为 `pending（#87）`；`A7.2` 为 `passed（CI）／blocked（本机 E2E）`。**没有任何一项把 pending 或 blocked 写成 passed。**

状态口径：`passed` = 有实现 + 有行为测试 + 本记录实际执行过；`pending` = 依赖未完成的任务；`not-run` = 未执行；`blocked` = 环境阻塞。

### A1 统一评分契约（4 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A1.1 | 两项十档（risk 1–10、authorization 1–10）为单一语义来源，两个协议共用，不按 backend 分叉 | 单元测试 + 性质测试 | `src/review-contract/rubrics.ts:37`（`RISK_BANDS`）、`:57`（`AUTHORIZATION_BANDS`）；`tests/review-contract/rubric.test.ts`（24 tests）、`prohibition.test.ts`（13）、`evaluate.test.ts` 的 *no backend branch*（`:242`）、`properties.test.ts` 的 *protocol parity*（`:221`）。实测 185 个 review-contract 用例全过 | passed |
| A1.2 | N0 归一化：风险取最小 `F(k) > 0.5`、授权取最小 `F(k) >= 0.5`，恰好一半分别取高／低端；精确十进制比较，无浮点台阶 | 单元测试（含精确一半与指数形式） | `src/review-contract/normalize.ts:210`（`compareToHalf`）、`:417`／`:438`／`:446`（`bandFrom` 三形）；`tests/review-contract/normalize.test.ts` 的 *N0 medians*（`:51`）与 *exact-half arithmetic*（`:140`），共 86 tests | passed |
| A1.3 | 100 格共同矩阵：A1 无条件拒绝、`risk ≤ 2 → A2`、`3–4 → A8`、`5–6 → A9`、`7–10 → A10`，无第二风险上限、无后端专属门 | 100 格逐格断言 + 单调性 + 计数 | `src/review-contract/matrix.ts:22`（`verdictFor`）、`src/review-contract/rubrics.ts:74`（`requiredAuthorizationFor`）；`tests/review-contract/matrix.test.ts` 的 *the grid itself is the documented shape*（断言 `[denies, escalates, allows] = [10, 58, 32]` 且合计 100）、*column 1 denies at every risk*、*there is no second risk ceiling*（32 tests）；`properties.test.ts` 的矩阵单调性；`tests/review-contract/rubric.test.ts` 的 `test.each` 逐档门槛表 | passed |
| A1.4 | 双协议 + ask／no-ask：同一矩阵在两个模式与两个协议下判定一致；无通道或 no-ask 的升级结算为 `fallback-deny`，不静默放行 | 12 种 stage × ask × channel 组合逐项断言 + 真实 gate 集成测试 | `src/review-contract/matrix.ts:60`（`AskPolicy`）、`:91`（`settle`）；`tests/review-contract/matrix.test.ts` 的 `test.each` 12 例（含 `review-escalate`/`error-escalate` × `no-ask` → `fallback-deny`）；`tests/integration/decision-chain.test.ts` 的 *mode equivalence on the real gate*（`:376`）与 *missing approval channel*（`:793`）。实测两文件 34 tests 全过 | passed |

### A2 生产接线（3 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A2.1 | `review()` 是唯一评审入口；生产与 evals 走同一条 `reviewWith(pkg)` 管线，默认包是 `PRODUCTION_PACKAGE` **这个对象本身** | 同一性断言 + 两侧入口对照 | `src/reviewer/service.ts:121-122`；`src/host/gate-review.ts:183`（生产唯一调用点）；`evals/src/run/execute.ts:349` → `evals/src/run/candidate.ts:70-78`；`tests/evals/production-evals-parity.test.ts` 的 *resolves a plan with no candidate to the production package object*（同一性非相等）。见 [parity.md](parity.md) §2–§4 | passed |
| A2.2 | 模式切换（ask／no-ask）由会话类别决定，两个模式共用同一矩阵；`no-ask` 不是更严的策略 | 单元测试 + 真实 gate 集成测试 | `src/config/defaults.ts:32`（`main: 'ask'`、`subagent: 'no-ask'`）、`src/config.ts:121`（`askPolicyForSession`）、`src/host/gate.ts:319`；`tests/config.test.ts`（39 tests，含模式默认值与未知模式拒绝）；`tests/integration/decision-chain.test.ts` 的 *mode equivalence on the real gate* | passed |
| A2.3 | 生产记录写入契约版本；评审前的材料可用性、预算与熔断各有独立失败类别，不折叠成「评审失败」 | 集成测试 | `src/host/gate.ts:99`（`contractVersion: REVIEW_CONTRACT_VERSION`）；`src/host/gate-review.ts` 的 `preRequestExit`（`:73`）分四条早退路径并各带 stage code——熔断 `circuit_open`、快照不可组装 `snapshot_error:*`、超出输入预算、材料不足；`tests/review-contract/evaluate.test.ts` 的 *insufficient material*（`:82`）与 *review failure*（`:139`）；`tests/integration/reviewer-service.test.ts`（4 tests） | passed |

> **A2.1 的准确边界**：`src/reviewer/diagnostic.ts:411` 与 `:534` 也调用 `review()`，那是「Reviewer 连接测试」路线的两个分支（chat／decision）。它同样走 `PRODUCTION_PACKAGE`，但用合成 `PROBE_SNAPSHOT`、不写审计、不参与裁决。所有**真实调用**共用同一入口与同一包。

### A3 evals 接线（5 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A3.1 | 有界运行器：并发、超时、attempts 上限、token 上限、取消与续跑 | 单元测试 | `evals/src/run/`（`scheduler.ts`、`execute.ts`、`lifecycle.ts`）；`tests/evals/run-bounded.test.ts`（59）、`run-cli.test.ts`（55）、`run-artifact.test.ts`（34）、`run-interrupt.test.ts`（1）、`run-wiring.test.ts`（18）。实测 run-* 共 167 tests 全过 | passed |
| A3.2 | 三层报告（自动行为／R-A 诊断／模式与宿主结算）可从保存的运行记录离线重建，每个比率公开分母 | 单元测试 + 真实报告 | `evals/src/report/`（`sections-behaviour.ts`、`sections-diagnostics.ts`、`sections-settlement.ts`）；`tests/evals/report-*.test.ts` 8 个文件共 131 tests 全过；真实产物 [calibration/report.md](calibration/report.md) §6 | passed |
| A3.3 | 离线回放：保存的响应可重读、可换阈值（N0 `strict`／`at-least`）、可换模式与通道，全程零模型调用；回放不得自带第二套矩阵 | 单元测试 + 边界测试 | `evals/src/replay/`（`variants.ts`、`derive.ts`、`source.ts`）；`tests/evals/replay-boundary.test.ts`（断言 `derive.ts` 内不得本地定义 `requiredAuthorizationFor`）、`replay-variants.test.ts`（39）、`replay-thresholds.test.ts`、`replay-offline.test.ts`、`replay-lineage.test.ts`、`replay-failures.test.ts`；实测 replay-* 共 84 tests 全过。`evals/README.md:162` 记录「共同矩阵不是轴」的理由 | passed |
| A3.4 | 候选轴可表达且只在实验侧；生产永不选择变体 | 单元测试 + parity | `evals/experiments/run-plans/pilot.json`（无 `candidate`）与 `pilot-b.json`（`candidate: { prompt: 'recovery-probe' }`）；`src/reviewer/variant.ts:101-107`、`:122`（`variantIdFor`）；`tests/reviewer-variant.test.ts`（40 tests）、`tests/evals/run-wiring.test.ts`（18）。实测 `pnpm evals:plan pilot.json` 输出 `package rq14/no-probe.complete.current-turn.full (production)`、120 格（60／60） | passed |
| A3.5 | 数据集与标签离线校验：gold／excluded 判定、失效标签不可计入金标 | CLI 校验 | `node evals/src/cli.ts check evals/datasets/core-v1` → 退出码 0、`51 cases, 49 gold labels, 2 excluded`；`pnpm run check:evals` → 退出码 0（`evals/datasets/core-v1`、`format-example`、`rq14-matrix` 全部通过）；`tests/evals/eligibility.test.ts`（15）、`core-v1.test.ts`（59）、`data-contract.test.ts`（33）。**注：issue 写的 `pnpm evals:validate` 不存在**，等价入口是 `check` 与 `check:evals` | passed |

### A4 边界修复（2 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A4.1 | `withinSumTolerance` 用精确十进制整数比较，不再有浮点台阶；「恰好等于容差」判为在内，真正超差仍失败；容差数值不变（`1e-4`） | 18 个边界单元测试 + 5 个真实保存响应回放 | `src/review-contract/normalize.ts:54`（`SUM_TOLERANCE = 1e-4`）、`:87`（`withinSumTolerance`）；`tests/review-contract/normalize.test.ts` 的 *the sum tolerance boundary is decimal, not float*（`:419`）；`tests/review-contract/saved-response-boundary.test.ts`（5 tests，用 `tests/fixtures/saved-clef-distributions.json` 的 5 份真实捕获重算新旧两种规则）。commit **`366f73d`**（PR [#113](https://github.com/Yuee98/dsh-arbiter/pull/113)）。详见 [normalization-boundary.md](normalization-boundary.md) | passed |
| A4.2 | 修复只放宽「恰好等于容差」这一侧；没有任何原本通过的回答被判失败 | 逐份捕获对照 | [normalization-boundary.md](normalization-boundary.md) §3 的 5 行表：只有 `clef-flash-4bit`（十进制和 `0.9999`）改变判定，方向是「拒绝 → 接受」；其余 4 份两规则都接受。`saved-response-boundary.test.ts` 断言「若有第二份捕获开始改变判定就失败」 | passed |

> **A4 的 `passed` 不等于「试点那 6 个未评分格全清了」。** 试点 6 例中只有 **5** 例属这一修复（十进制和恰好 `1e-4`：4 × `0.9999`、1 × `1.0001`）；第 6 例 `sample-log-upload-authorized~clef-flash-local` 的十进制和是 **`1.0002`**，十进制本身超差，容差未变所以**仍然失败**（[normalization-boundary.md §4](normalization-boundary.md) 的 *the `1.0002` case still fails*）。且这 5／1 拆分是**派生**结论，试点运行记录已丢失（§B6），本阶段没有重放那 6 格。

### A5 规则体验（4 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A5.1 | 普通规则编辑简化：exact 默认、字段选择、多条件 `all`、未限定范围显式显示 | UI 测试 + 单元测试 | commit `a405265`（PR [#92](https://github.com/Yuee98/dsh-arbiter/pull/92)）的 `src/client/components/rules/rule-condition.tsx`、`rule-editor.tsx`；`tests/client/rules-editor.test.tsx`（51 tests）、`tests/rules-draft.test.ts`（28 tests）。实测两者全过 | passed |
| A5.2 | 显示匹配范围与最终命中路径：优先级、`shadowed`、复合命令覆盖 | UI 测试 + 单元测试 | `src/client/components/rules/rule-test-priority.tsx` 的 `PriorityBlock`（`:21`）与 `CoverageBlock`（`:115`）；`tests/client/rule-test-model.test.ts`（39 tests）、`tests/client/rule-test.test.tsx`（26 tests）、`tests/rules-draft.test.ts` 的 *scope and condition reach*（`:514`）。实测全过 | passed |
| A5.3 | 从真实调用创建可测试规则草稿（选择可固定的值 → 生成草稿 → 用同一求值器验证） | UI 测试 + 单元测试 | commit `3bf9176`（PR [#94](https://github.com/Yuee98/dsh-arbiter/pull/94)）的 `src/client/components/rules/rule-from-call.tsx`（`RuleFromCallDialog`）、`rule-from-call-model.ts`、`rule-from-call-state.ts`；`tests/rules-from-call.test.ts`（34 tests，含 *a draft built from a call decides that call* 与 *every offered field matches through the evaluator*）、`tests/client/rule-from-call.test.tsx`（14 tests）。实测全过 | passed |
| A5.4 | 不为保存增加强制测试；一次人工批准不变成永久规则 | 设计边界 + E2E 观察 | `docs/milestones/review-quality-and-evals.md:89` 写明「不新增保存前强制测试，也不把一次人工批准变永久规则」；`tests/e2e/rules-editor.spec.ts:246` 的 *a draft without conditions is editable but cannot be applied* 显示应用门的判据是**条件是否齐备**，不是是否跑过测试；`src/client/components/rules/draft.ts` 的写路径（`:463`／`:476`）只追加与格式化，不触发测试运行 | passed |

> **A5 的 E2E 状态**：`tests/e2e/rules-editor.spec.ts` 与 `tests/e2e/rule-from-call.spec.ts` 存在，但**本机 E2E 为 blocked（环境）**，见 A7.2。上表 `passed` 仅覆盖单元／UI 层。

### A6 数据清理（3 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A6.1 | 旧配置格式（`arbiter-config-v1`／`v2`）与模式转换退出，只读 `arbiter-config-v3`；退役声明被拒绝而非迁移 | 单元测试 + 集成测试 | commit `5afb6e9`（PR [#103](https://github.com/Yuee98/dsh-arbiter/pull/103)），删除 `src/config/legacy.ts`（433 行）与 `src/config/v1.ts`；`src/config/format.ts:21`、`:31-32`；`tests/config-format.test.ts`（16 tests）、`tests/config.test.ts`（39 tests，含未知模式拒绝）、`tests/integration/config-recovery.test.ts` 的 *a copy left by a build with the retired formats*（`:204`）。实测 55 + 9 tests 全过 | passed |
| A6.2 | 旧审计迁移、兼容读取与日志修复工具退出；旧结构库被拒绝打开而不是迁移 | 集成测试 | commit `644e4d0`（PR [#104](https://github.com/Yuee98/dsh-arbiter/pull/104)），删除 `scripts/repair-session.ts`；`tests/integration/audit-isolation.test.ts` 的 *an unmigratable audit database*（`:191`，7 tests）、`tests/audit.test.ts`（111 tests，integration 项目）。实测均全过 | passed |
| A6.3 | 限定范围的旧测试数据重置工具：默认 dry-run、显式 `--apply` + plan id、按文件头与结构版本判定身份、`REFUSE` 阻止整次运行 | 集成测试 + 文档 | commit `4b54f0c`（PR [#106](https://github.com/Yuee98/dsh-arbiter/pull/106)）的 `scripts/arbiter-reset/`、`scripts/arbiter-reset-test-data.ts`；`package.json:57`（`reset:test-data`）；`tests/integration/reset-test-data.test.ts`（35 tests，实测全过）；`docs/test-data-reset.md`。**真实删除未执行**，属 #86 | passed（工具）／pending（真实重置） |

### A7 宿主验收（2 项）

| # | 条件 | 验证方式 | 证据 | 状态 |
| --- | --- | --- | --- | --- |
| A7.1 | 隔离 DSH 的主子会话、ask/no-ask、规则优先级、有效授权／policy、缺失与故障、冷恢复、配置流程验收 | `pnpm test:e2e:dsh`（隔离 profile） | 归属 **#87（RQ-19）**，`tests/e2e/` 下 **23** 个 spec 文件已存在（`gate-real`、`config-lifecycle`、`context-sources`、`history-recovery`、`rule-from-call`、`rules-editor` 等）。**本阶段未验收** | **pending（#87）** |
| A7.2 | `pnpm verify` 与完整隔离 E2E 通过 | 本地执行 + CI | 本 checkout 实测：`typecheck` 0、`lint` 0、`format:check` 0、`check:evals` 0、`pnpm test` 0（unit 71 files／**1739** tests、integration 25 files／**467** tests、UI 21 files／**353** tests）；`366f73d` 的 CI 与 DSH E2E 均 `success`。**`test:e2e:dsh` 本机为 blocked（环境）**——失败集与未修改的 `main` 逐条相同（[verification.md](verification.md) §2） | passed（CI）／**blocked（本机 E2E）** |

---

## B. 已知问题清单

**8 项，全部来自 S1 试点的实测结果，全部仍未解决。** 引用章节号以 [calibration/report.md](calibration/report.md) 为准。

| # | 问题 | 证据（报告章节） | 影响与边界 |
| --- | --- | --- | --- |
| B1 | **authorization 系统性低估 −0.98 档**（平均绝对偏差 1.469，19/49 格相差两档以上） | [§6 第二层](calibration/report.md)（评分误差与相邻档表）；排除本地两 target 后 36 格仍为 **−0.889**，方向与量级保留 | 这是本轮最稳定的质量信号：六个 target 上都出现、方向一致。**因果链未经证明**——它解释了 10 次「不必要人工」里的 3 次、参与解释另外 3 次（§6.4），不是全部原因。**本阶段不据此调整 prompt 或矩阵** |
| B2 | **risk 在 2→3 边界高估**（`unrequested-config-reformat` 稳定多给一档，4/4 次） | [§6.4](calibration/report.md) 的逐格归因表（4 次「纯 risk 高估」）；[§8 争议 2](calibration/report.md) | 这 4 次是 10 次不必要人工里唯一完全由 risk 造成的部分。**「是模型高估还是 A8 门槛偏严」未分离**——分离需要矩阵门槛实验，而现有回放工具**刻意不支持**该轴（§10.1.2.1）。本阶段不动矩阵 |
| B3 | **配对命中率 24.5%（12/49）**：落进人类允许配对的格子只有 12 个，其余 23 格「行为对但配对错」 | [§6 第一层与第二层](calibration/report.md)（*合法配对命中*表）；具名例证已在同节勘误中**撤回** | 12 格是行为一致 35 格的子集。早期版本曾用具名反例支持该结论，已撤回并改为纯聚合口径；具名清单只能从已丢失的运行产物导出，**本报告给不出** |
| B4 | **样本量不足：10 案例 × 1 repeat** | [§7.2](calibration/report.md)（不能下的结论）；[§11](calibration/report.md)（重复稳定性 `not-run`） | 1 repeat 无法分离模型方差与系统差异；`repeats: 2` 的全量计划 `full.json` 尚未对齐六 target 范围（§10.1.3），**不是可直接运行的后继计划** |
| B5 | **误放 0 不覆盖高风险禁止类**：`误放 = 0/49` 仅成立于小子集，R8／R9 禁止场景未进 dev 试点 | [§6 第一层](calibration/report.md)（混淆表后的加粗说明）；[§11](calibration/report.md)（「高风险误放场景 未覆盖」） | dev 10 案例里只有 2 条参考为 `deny`（`private-key-upload` R7／A1、`prohibited-config-reformat` R2／A1），都是低到中风险禁止类。真正的高风险误放场景（`prohibited-billing-wipe` R9／A1、`injection-in-project-rules` R8／A2）在 calibration／holdout。**零误放是「这个小子集上没观察到」，不是能力证明** |
| B6 | **试点原始运行记录已丢失**，仅存 `call-log.md` 的摘要 | [normalization-boundary.md §4](normalization-boundary.md)；[报告 §0](calibration/report.md)（原始调用记录不覆写、不重跑） | 运行产物原在 `rq-15` worktree 的 ignored `.local/evals/runs/core-v1/pilot-a`，该 worktree 已被移除。本记录核实：本机主 checkout 与 `rq-h2` worktree 的 `.local/evals/runs/` **均不存在**，全盘搜索 `pilot-a` 目录 **0 命中**。后果：**报告里的逐格 R/A、B3 的具名清单、B 臂矛盾（§6.3 第三层）都无法复核**；重建需要重新派发真实调用（未授权，且是新的付费调用），因此记为 `not-run` 而非估算 |
| B7 | **`promptFingerprint` 无法从 masked attempt 重算**（实测 `sha256:070eee…` vs `sha256:8218e2…`） | [parity.md §5 记录层限制](parity.md)；[verification.md §3](verification.md) 的 parity 用例 | `CellMaterial.promptFingerprint` 是**渲染后请求**的摘要；attempt 里的 `request` 已过 `maskAttempt`，chat 提示的 `<integer 1-10>` 占位符被当成 auth header 值遮蔽。**不影响分数、判定或 provider 侧行为**（`stream` 收到的字节完好），且已被 `tests/evals/production-evals-parity.test.ts` 的 *the masked attempt is not a fingerprint source, by design* 断言固定。可追溯性另由「从 `snapshots.content` 重算」补足（parity §5.1），但**生产不持久化 `promptFingerprint` 也不记录 `REVIEW_PROMPT_VERSION`** |
| B8 | **本地 Clef 的 1 个格子在容差修复后仍失败**：`sample-log-upload-authorized~clef-flash-local` 的风险十进制和为 **`1.0002`**，十进制本身超差 | [报告 §3.1](calibration/report.md) 表格末行与紧随其后的说明；[normalization-boundary.md §4](normalization-boundary.md) 的 *the `1.0002` case still fails* | **这一例与 `366f73d` 的边界修复无关**：修复只把「恰好等于 `1e-4`」判为在内，容差数值仍是 `1e-4`，`1.0002` 是真实超差。它与另外 5 例（4 × `0.9999`、1 × `1.0001`）**不是同一类**，不能合并成「本地 Clef 的 6 例已修复」。原运行记录已丢失（B6），本阶段未重放该格 |

**B 段的共同结论**：S1 试点**没有让任何候选获胜**，也没有让 RQ-15 整体通过。报告 §7.2 明确拒绝五项结论（不宣称获胜、不宣称零风险、不宣称 B 更贵、不宣称零错误、不宣称 B 失败）。本阶段基线（[decision-record.md](decision-record.md)）**不因 B 段的存在而改变**，B 段也**不因基线被确认而消失**。

### B.x 附：S1 中已修复的工程问题（不属于本清单）

以下三项是**接线**问题，已在 RQ-16 修复并验证，不构成质量债务：

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 空 `credentialRef` 被拒，本地无认证端点不可达 | 空字符串表示「端点不认证」，不发送 `Authorization`、不伪造占位名 | [报告 §4](calibration/report.md)；`tests/evals/run-wiring.test.ts` |
| headless CLI 无宿主 LLM 服务 | 新增 `evals/src/run/chat-service.ts` | 同上 |
| plan 无法表达候选 | 可选 `candidate`（四轴）+ `reviewWith(pkg)` | 同上 |

---

## C. 后续移交清单

**6 项。** 每项写明移交项、理由、接管条件与对应 issue／状态。**没有一项在本阶段执行。**

| # | 移交项 | 理由 | 接管条件 | 对应 issue／状态 |
| --- | --- | --- | --- | --- |
| C1 | **保留集验证**（在未参与逐例调参的家族上给出通过／未通过结论，含真实 SHA／数据／prompt hash 与成本证据） | 需要事前冻结的验收数值线，而本阶段按 2026-10-31 范围调整**不冻结质量数值线** | ① dev 全 13 条跑完（S1 只用了 10 条）；② 高风险禁止类（`prohibited-billing-wipe` R9、`injection-in-project-rules` R8）进运行范围；③ **至少 2 repeats**；④ `full.json` 对齐六 target（移除 `workbuddy-glm-5-3-flash`、两个本地 target 的 `credentialRef` 改为空字符串）；⑤ 派发前按 [resource-decision.md §3.3.4](resource-decision.md) 记录「硬上限 + 自动关闭充值」或「逐次余额核对授权」 | [#85](https://github.com/Yuee98/dsh-arbiter/issues/85)（RQ-17）— **已移出 Milestone #2，保持 OPEN** |
| C2 | **C1–C4 消融对照**（prompt／结构／历史／量表四轴各自单独移动） | 每轴需要新的 run plan 与新一轮真实调用；S1 只覆盖 A/B 一轴（prompt） | 先有独立预算与冻结计划；其余三轴已在 `src/reviewer/variant.ts` 有取值——结构 `full`／`compact`／`compact-no-audit`、历史 `current-turn`／`none`、量表 `complete`／`labels`——但**从未派发** | **未开**（无 issue）；三轴的取值与身份已由 `tests/reviewer-variant.test.ts`（40 tests）固定 |
| C3 | **S2 全量**（更大数据集、多 repeat） | S1 的 10 案例 × 1 repeat 不足以分离模型方差与系统差异（B4） | ① 冻结 S2 计划并重算 `planHash`；② dev 13 条 + 至少 2 repeats；③ 预算与货币前置（同上 C1 ⑤）；④ B3 的具名配对清单若要复核，需先决定是否重建已丢失的运行记录（B6） | **未开**；输入文件 `evals/experiments/run-plans/full.json` 存在但**不一致**（[报告 §10.1.3](calibration/report.md)），当前**不可直接运行** |
| C4 | **cold／warm 缓存对照** | S1 没有该工作负载；属 RQ-14 的 cache 序列 | 需要能表达缓存工作负载的计划与一次真实对照；`review-usage-v1` 需先覆盖全部缓存字段（当前 `cacheWriteTokens` 未报，[报告 §5.4](calibration/report.md)） | **未开**；`evals/experiments/rq14-matrix.json` 已含 6 candidates／312 cells／5 cache requests，但**未派发** |
| C5 | **阈值回放实验**（N0 边界：同一份保存响应换 `strict`／`at-least` 重算） | 工具**支持**该轴，但 S1 只跑过生产默认值（risk `strict`／auth `at-least`），对照变体 `not-run` | ① 需要可读的保存运行目录——**当前本机不存在**（B6），因此该实验必须先重建或重新生成运行产物；② 输出是阈值建议，属产品语义变更，需新窗口裁决 | **未开**（[报告 §10.1.2.1](calibration/report.md)）；矩阵门槛实验则**现有工具刻意不支持**（`evals/README.md:162`） |
| C6 | **费用证据**（provider 账单） | 运行器不代币定价，S1 的 120/120 格 `cost.status` 全为 `not-computed`，货币金额 `unknown`（[报告 §5.3](calibration/report.md)） | 需 provider 账户账单或可信 rate card；接管方读完账单后按实测 token 计价，**不得用估算替代**（§5.3 已明确拒绝该做法） | **未开**（B02）；该项是 RQ-15 报告 AC1 **唯一剩余未满足项** |

### C.x 依赖关系与顺序

```
本阶段基线（已确认，本文 §A）
   └─ C1（#85 保留集验证）  ← 接管条件 ①–⑤ 全部满足才能开
         ├─ C3（S2 全量）     ← 与 C1 共享「dev 13 条 + 2 repeats + 预算前置」
         ├─ C4（cold/warm）   ← 依赖 C3 的运行产物
         └─ C5（阈值回放）    ← 依赖可读的保存运行目录（B6）
   └─ C2（C1–C4 消融）      ← 独立预算，可与 C1 并行但不得用保留集调参
   └─ C6（费用证据）        ← 独立于运行；任何时候都可补，且补完才能说 AC1 完整
```

**#86 与 #87 不属移交**：两者仍在 Milestone #2 内（#86 是真实数据重置的操作任务，#87 是宿主集成验收与 milestone 交付报告）。A6.3 的重置工具已就绪，真实删除待 #86；A7.1 的宿主验收待 #87。**本条不表示 #86／#87 已完成。**

### C.y 移交不改变的事项

- 移交**不**把未执行项改写成已通过。C1–C6 的状态一律是 `not-run` 或 `未开`。
- 移交**不**解除本阶段基线：候选 A、现行矩阵、现行 N0、`review-rubric-v1` 仍是默认，直到有新的窗口决定。
- 移交**不**授权新的付费调用；任何真实运行仍需按 C1 ⑤ 的货币前置单独授权。
- 移交**不**改变父任务与 milestone 的关闭状态。

---

## D. 范围边界

本阶段**不做**（与 issue 非目标一致）：

- 不冻结模型质量数值线（移交 C1）
- 不生成最终保留集运行计划（移交 C1／C3）
- 不根据 S1 小样本调整评分提示、量表或矩阵去追求更高成绩
- 不新增旧兼容、后端专属门、M1 或风险上限（A1.3 与 `tests/reviewer-protocol.test.ts` 的 *no configuration can move the matrix*（`:642`）共同保证：`Object.keys(DEFAULT_CONFIG.policy)` 恒为 `['version']`）
- 不以未知／未执行证据声明通过

**本阶段的完成标志是「记录与任务图同步」，不是「质量达标」。** 记录完成后 [#83](https://github.com/Yuee98/dsh-arbiter/issues/83) 即可收口，不等 S2 与 #85。
