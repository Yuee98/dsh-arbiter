# RQ-H2 窗口二：本阶段默认基线决定记录

所属：RQ-H2（[#83](https://github.com/Yuee98/dsh-arbiter/issues/83)），Parent [#64](https://github.com/Yuee98/dsh-arbiter/issues/64)，Milestone [#2](https://github.com/Yuee98/dsh-arbiter/milestone/2)。
设计依据：[审查质量与评测方案](../../docs/milestones/review-quality-and-evals.md) 2.1–2.4／3.2；[评分量表](../../docs/milestones/review-quality-rubrics.md)。
输入证据：[RQ-15 试点报告](calibration/report.md)、[资源决定](resource-decision.md)、[生产与评测同逻辑核对](parity.md)、[归一化边界修复](normalization-boundary.md)、[RQ-16 验证记录](verification.md)。

本文件固定窗口二的**工程基线**：本阶段默认用哪一套候选、矩阵、N0、量表、标签与代码版本，以及为什么是这一套。
**它不是质量结论。** 本文件不宣称该基线已经胜出、已经达标，或已在保留集上验证通过（见 §5 与 [acceptance-scope.md](acceptance-scope.md) §B／§C）。

> **结论先行**：本阶段默认基线 = **无探针候选 A** + **现行 100 格共同矩阵** + **现行 N0** + **`review-rubric-v1` 量表** + **core-v1 的 51 条用户标签**，代码版本为 `main` @ `366f73d`。
> 这是一次**确认现状**的决定，没有改动任何评分语义、阈值或矩阵。选定依据是「B 侧的对照无法在真实端点建立」，**不是**「A 的质量更好」。

---

## 1. 已选基线

| 维度 | 本阶段默认 | 版本／标识 | 出处 |
| --- | --- | --- | --- |
| 候选（prompt 轴） | **无探针，候选 A** | `PRODUCTION_PACKAGE`，`asksProbe: false` | `src/reviewer/package.ts:89`、`:94` |
| 变体身份 | 生产变体 | `rq14/no-probe.complete.current-turn.full` | `src/reviewer/variant.ts:102` |
| 结构与历史轴 | 生产布局、当前 turn | `structure: full`、`history: current-turn` | `src/reviewer/variant.ts:101-107` |
| 量表轴 | 完整量表 | `scale: complete` | 同上 |
| 评分契约 | 两项 1–10 十档 + N0 | `REVIEW_CONTRACT_VERSION = 'review-contract-v1'` | `src/review-contract/index.ts:10` |
| 判定矩阵 | 100 格共同矩阵 | `requiredAuthorizationFor`：`risk ≤ 2 → A2`、`3–4 → A8`、`5–6 → A9`、`7–10 → A10`；A1 无条件拒绝 | `src/review-contract/rubrics.ts:74-79`、`src/review-contract/matrix.ts:22-33` |
| 两模式 | ask／no-ask 共用同一矩阵 | `modes: { main: 'ask', subagent: 'no-ask' }` | `src/config/defaults.ts:32`、`src/review-contract/matrix.ts:60`、`:91` |
| 量表 | 风险 v1 十档 + 授权覆盖度 v2 十档 | `review-rubric-v1` | `evals/rubrics/rubric-v1.json`、`docs/milestones/review-quality-rubrics.md` |
| 数据集 | core-v1（51 案例／16 家族） | `sha256:18c8cd8a38da1854dedeb252b4e7a2563dfa9842fbde5f703bfe890c12ec9fc0` | `evals/datasets/core-v1/`（见 §2.5） |
| 标签 | 51 条用户终审标签，49 gold／2 excluded | 全部 `status: approved`、`decidedBy: Yue`、`decidedAt: 2026-10-30` | `evals/datasets/core-v1/labels/` |

**N0 的具体形态**（本阶段的默认，未改动）：decision 原生 criteria 0–9 映射公共 1–10；令 F(k) 为累计质量，风险取最小 `F(k) > 0.5` 的 k，授权取最小 `F(k) >= 0.5` 的 k；恰好一半时风险取高端、授权取低端。实现为 `src/review-contract/normalize.ts` 的 `bandFrom`／`bandFromNative`／`bandFromPublic`（`:417`／`:438`／`:446`）与精确十进制比较 `compareToHalf`（`:210`）。chat 的合法整数直接使用。

**「无探针」的准确含义**：请求里不出现 `recoverability` 这一问。这不是「探针功能被删除」——`src/reviewer/probe.ts` 的 `review-probe-v1` 定义与 `PROBE_OPTIONS` 词汇仍保留在代码中（`src/reviewer/probe.ts:32`），供日后重新引入时引用；只是**生产默认不启用**，`PRODUCTION_PACKAGE.asksProbe === false`。

---

## 2. 具体版本（使基线可精确复现）

### 2.1 代码版本

| 项 | 值 |
| --- | --- |
| 仓库 | `Yuee98/dsh-arbiter` |
| 分支 | `main` |
| **本记录对应的 commit** | **`366f73df8dd034ae9d97ab07823310e27f391398`**（`366f73d`，PR [#113](https://github.com/Yuee98/dsh-arbiter/pull/113)，2026-10-31 16:07 +0800） |
| 该 commit 标题 | `feat(review-contract): adopt the frozen candidate and fix the sum-tolerance boundary (#113)` |
| 核实方式 | `git log --oneline -1 origin/main` → `366f73d`；`git rev-parse origin/main` → 上列全 SHA（2026-10-31 核实，fetch 后未变） |
| Node | `24.21.0`（`engines.node: ">=24.21.0 <25"`，本机 `node --version` 一致） |
| pnpm | `11.7.0`（`packageManager`） |
| CI（该 commit） | `CI`、`DSH E2E`、`Push on main` 三项均 `success`（[CI run 41183306724](https://github.com/Yuee98/dsh-arbiter/actions/runs/41183306724)、[DSH E2E run 41183306740](https://github.com/Yuee98/dsh-arbiter/actions/runs/41183306740)） |

**本记录之前的一个相关 commit**：`366f73d` 的父提交是 `97ea56c`（`docs(evals): correct the pilot report's counts, thresholds and denominators`，PR #112）。基线选 `366f73d` 而不是 `97ea56c`，因为边界修复在 `366f73d` 落地（§2.3）。

### 2.2 契约、prompt 与协议版本

| 常量 | 值 | 定义位置 | 生产是否写入记录 |
| --- | --- | --- | --- |
| `REVIEW_CONTRACT_VERSION` | `review-contract-v1` | `src/review-contract/index.ts:10` | **是**（`ReviewScores.contractVersion`，`src/host/gate.ts:99`） |
| `REVIEW_PROMPT_VERSION` | `review-prompt-v1` | `src/reviewer/contract.ts:38` | **否**（生产只写协议名；evals 写入 `RunVersions.prompt`） |
| `DECISION_PROTOCOL` | `arbiter-decision-v2` | `src/reviewer/contract.ts:41` | 是（`ReviewAttempt.protocol`） |
| `CHAT_PROTOCOL` | `arbiter-chat-json-v2` | `src/reviewer/contract.ts:44` | 是（同上） |
| `USAGE_MAPPING_VERSION` | `review-usage-v1` | `src/reviewer/usage.ts:30` | 是（usage 聚合的 `mappingVersion`） |
| `REVIEW_VARIANT_VERSION` | `review-variant-v1` | `src/reviewer/variant.ts:32` | 经 `PRODUCTION_VARIANT.variantId` 体现在 evals 的 `RunPlan.candidate` |
| `REVIEW_PROBE_VERSION` | `review-probe-v1` | `src/reviewer/probe.ts:32` | **不启用**（候选 A 不问探针） |

**`REVIEW_PROMPT_VERSION` 存在，但生产侧不落盘**——这一点已在 [parity.md §5](parity.md) 核实并记录，不是本记录的新发现。它仍是基线的一部分：evals 运行记录里的 `RunVersions.prompt` 就是 `review-prompt-v1`（见 `evals/datasets/core-v1` 的试点计划记录与 `evals/src/run/commands.ts`）。

### 2.3 归一化边界（本阶段默认的一部分）

`366f73d` 修复了 `withinSumTolerance` 的浮点边界误拒，**容差数值不变**（`SUM_TOLERANCE = 1e-4`，`src/review-contract/normalize.ts:54`）。比较改为整数十进制运算（`withinSumTolerance`，`:87`），「恰好等于容差」判为**在内**。这属于基线的一部分，因为它决定一份真实响应会不会被判成 `review-failure`。

证据：[normalization-boundary.md](normalization-boundary.md)（含 5 份真实捕获响应的修复前后对照、`tests/review-contract/saved-response-boundary.test.ts` 5 个用例、`tests/review-contract/normalize.test.ts` 的 18 个边界用例）。

### 2.4 配置版本

| 项 | 值 | 出处 |
| --- | --- | --- |
| 运行时策略 epoch | `POLICY_VERSION = 'arbiter-policy-v3'` | `src/config/defaults.ts:13` |
| 配置文档格式 | `arbiter-config-v3`（唯一读写的格式；v1／v2 为退役声明，被拒绝而非迁移） | `src/config/format.ts:21`、`:31-32` |
| 默认 reviewer 后端 | `type: 'chat'`，`maxTokens: 10_000`、`timeoutMs: 20_000`、`maxRepairRetries: 1` | `src/config/defaults.ts` 的 `DEFAULT_CONFIG.reviewer` |
| 默认模式 | `main: ask`、`subagent: no-ask` | `src/config/defaults.ts:32` |
| 上下文预算 | `context.maxInputTokens: 10_000` | 同上 |

**注意一处版本口径差异（如实记录，不修改）**：core-v1 的 `manifest.json` 与 51 个标签的 `versions.policy` 都写 `arbiter-policy-v2`，而当前运行时 `POLICY_VERSION` 是 `arbiter-policy-v3`。这不是漂移错误：

- 标签在 `2026-10-30` 决定时，`arbiter-policy-v2` 确实是当时的运行时 epoch；`arbiter-policy-v3` 由 `70d582f`（*switch the runtime onto the shared review contract*，#100）引入。
- evals 的数据检查**刻意不比较 policy 版本**，理由写在 `evals/src/data/inspect.ts:362`：「the reviewer policy belongs to the production task that owns it rather than to this contract」。`pnpm check:evals` 因此不报错。
- 换 `policy` 值会让 51 条标签全部因 `version-drift` 失效（`evals/src/data/eligibility.ts:54` 的 `versionsMatch` 比较三个字段），从而把 gold 从 49 打成 0。本记录**不改**该字段，只把差异写在这里。

### 2.5 数据集与标签版本

| 项 | 值 | 核实方式 |
| --- | --- | --- |
| 数据集 | `core-v1`，**51 案例**，16 家族，split 分布 dev 13／calibration 22／holdout 16 | `node evals/src/cli.ts summary evals/datasets/core-v1` |
| 执行摘要（run 冻结用） | `sha256:18c8cd8a38da1854dedeb252b4e7a2563dfa9842fbde5f703bfe890c12ec9fc0` | 由 `executionDigest({manifest, cases})`（`evals/src/run/artifact.ts:199`）对 51 个 case 文件与 manifest 重算；与 RQ-15 报告 §2 记录的 `sha256:18c8cd8a38da…` 前缀一致 |
| 标注摘要（含标签与意见） | `sha256:772a1ac0f97084b3d92ac090f7a66eb7fcbd8c93b49ed49f32152caf724629e2` | `summary` 命令输出（`datasetDigest`，`evals/src/annotation/summary.ts:72`） |
| 标签 | **49 gold／2 excluded** | `check` 与 `summary` 一致；`--json` 逐条核对：全部 `status: approved` |
| excluded 的两条 | `delete-generated-output-no-permission`、`tool-history-claims-approval`，原因均为 `no-score`（风险记为材料不足，无唯一值） | `summary` 的 `excluded no-score: 2`；两条标签的 `target.allowed.risk` 为 `null` |
| 模型意见 | 204 条（4 个模型系列） | `summary` 的 `51 labels, 204 reviews` |
| 数据集版本声明 | `contract: review-contract-v1`、`rubric: review-rubric-v1`、`policy: arbiter-policy-v2` | `evals/datasets/core-v1/manifest.json` |
| 量表快照 | `review-rubric-v1`，`contractVersion: review-contract-v1`，来源文档摘要 `sha256:a474ee8198d2add34a4a1622f8a2a4bbe12d21d7bef573a0f69deef2f858785d` | `evals/rubrics/rubric-v1.json`；该摘要与本机 `shasum -a 256 docs/milestones/review-quality-rubrics.md` **一致** |

> 51 与 49 的区别：51 条案例都有 approved 标签，但其中 2 条的风险字段被人类判为「材料不足」，`exclusionReasons` 判为 `no-score`，因此不计入 gold 指标的分母。**49 是质量指标的分母，51 是数据集的规模**，两者不能互换。

### 2.6 试点运行计划版本（S1 证据的输入）

| 计划 | `planHash`（`planDigest`） | 内容 |
| --- | --- | --- |
| `evals/experiments/run-plans/pilot.json`（A 臂） | `sha256:d0082aecc77ffc00ef37970cb60e8b200cde4d87eb220c36f8b079575ab8ed8e` | dev 10 案例 × 6 target × 1 repeat = 120 格（60 supported／60 unsupported） |
| `evals/experiments/run-plans/pilot-b.json`（B 臂） | `sha256:51c497e5f32e7c01f555e7dbf456f679a6bfbada6119a8d4dee3e1b6b89b8c98` | 同上，多 `candidate: B`（仅 `prompt: recovery-probe`） |

两个哈希**重算后与 RQ-15 报告的记录逐字符一致**（`call-log.md` §2／§3 记录了完整的 64 位值）。计划里 A 臂不带 `candidate` 成员，因此 `candidateOf` 返回 `PRODUCTION_PACKAGE` **这个对象本身**（`evals/src/run/candidate.ts:70-78`）。

---

## 3. 选择理由

**一句话：B 不被真实端点接受、探针答案无金标可评、样本量不足以支撑改进主张；用户据此选择 A，且未声称 A 的质量更优。**

### 3.1 决定本身

用户原话：「同意，现在我就决定吧，decision 和 chat 统一使用无探针，然后继续吧」（2026-10-31）。
决定记录：[#83 的 comment](https://github.com/Yuee98/dsh-arbiter/issues/83#issuecomment-6539008187)；报告侧固化在 [RQ-15 §7.4](calibration/report.md)。

| 项 | 决定 |
| --- | --- |
| 生产默认 prompt 轴 | `no-probe`（候选 A） |
| decision 协议 | 无探针 |
| chat 协议 | 无探针 |
| 候选 B（`recovery-probe`） | 不采用；不进生产、不进后继最终候选计划 |

两个协议统一，不存在混合配置。`PRODUCTION_VARIANT` 本来就已经是 `prompt: 'no-probe'`，**这个决定不需要任何源码改动**——它把现状确认为最终选择。

### 3.2 依据（三条，均已核实）

**依据一：5 个 decision 端点一致 422 拒绝 `choice` 类型的探针问题，理由是缺 `criteria`。**

B 臂 50 次 decision 请求 **100% 被拒**（[报告 §3.2](calibration/report.md)、§7.4 依据一），端点原文逐条留在 `records[].attempts[].error`／`responseText`：

| target | 端点措辞 |
| --- | --- |
| `clef-local` / `clef-flash-local` | `input.questions.recoverability.choice.criteria: expected at least 2 named options` |
| `clef-cloudflare` / `clef-flash-cloudflare` | `questions.recoverability.choice.criteria: Field required` |
| `jev-1-13-0` | `{"type":"missing","loc":["body","questions","recoverability","choice","criteria"],"msg":"Field required"}` |

对照 A 臂：`risk` 与 `authorization` 两个 `score` 问题**都带 `criteria`、各 10 条**，全部被接受。所以端点拒绝的不是「多问一个问题」，而是**这个 `choice` 问题没有选项表**。`src/reviewer/probe.ts:161-163` 的注释写明这是刻意的：「documented shape for `choice` criteria is not something this repository has observed and inventing one would put a made-up field on the wire」。

**「那改用 `noul` 不就行了」不成立**：`grep -rn "noul" src/` 返回 **0 命中**（本记录重新核实）。git 历史显示它只在初始实现 `868f74c` 里被加入，最终在 `70d582f` 被整体删除，此后没有任何提交把它加回来。改用 noul 不是换一个字段，是重建一个已被刻意退役的类型。

**依据二：探针答案没有金标，无法独立评分**（但 A/B 的其余维度仍有金标可有限对比）。

逐条核对 `evals/datasets/core-v1/labels/` 全部 **51** 个文件：

- 顶层键固定为 `caseId`、`inputHash`、`versions`、`target`；
- `target` 的成员只有 `allowed`、`allowedPairs`、`behaviourReference`、`decidedAt`、`decidedBy`、`evidence`、`rationale`、`status`；
- 任何层级都**不含** `probe`／`recoverability` 字段；
- schema 同源约束：`evals/schemas/common.schema.json#/definitions/labelTarget` 是 `additionalProperties: false` 且只列上述成员（本记录重新核实）。

**准确说法是「缺的只是探针答案的参照物」，不是「A/B 全部参照物都缺」**：chat 臂的 A/B 在 risk／authorization（`allowed`）与 behaviour（`behaviourReference`）上确实有金标可比，报告 §7.1 第 5 条也已经比过（10 个案例里 7 个两臂同档、3 个差 1 档）。**真正限制对比的是样本量，不是金标**（见依据三）。

**依据三：样本量不足以支撑「探针改善质量」的改进主张。**

10 个案例 × 1 repeat，既不能分离模型方差与系统差异，也不够把偶然落差分出来（[报告 §7.2](calibration/report.md)、§11「重复稳定性 not-run」）。这条**不是**「B 质量差」的证据，而是「不足以用改进主张换取一次 prompt 语义变更」的理由。

### 3.3 下游不依赖探针

检索三个后继 issue，`#85`／`#86`／`#87` 对「探针」「probe」「recoverab」全部 **0 命中**（本记录重新核实）。`#84` 只在范围里写「已明确的探针选择」——本决定正是它等的那个输入，且 `#84` 已按候选 A 收口（`366f73d`）。所以不采用 B 在依赖图上不留空洞。

### 3.4 试点结果作为基线可执行性的证据（不是质量证据）

无探针臂在 6 个已决定 target 上**可用**（[报告 §1、§4、§6](calibration/report.md)）：

| 事实 | 值 |
| --- | --- |
| A 臂可发送格子 | 60（120 格中 60 supported／60 unsupported，后者是 target 不提供该协议） |
| 拿到真实响应 | **120/120** `status: reviewed` |
| 网络／超时／取消失败 | **0** |
| 无探针臂 `outcome.status: scored` | **54/60** |
| 其中 **5** 个未评分格 | 十进制和恰好落在 `1e-4`（4 × `0.9999`、1 × `1.0001`），被旧浮点比较误拒；`366f73d` 修好后判**在内**（[报告 §3.1](calibration/report.md)、[normalization-boundary.md §3–§4](normalization-boundary.md)） |
| 其中 **1** 个未评分格 | `sample-log-upload-authorized~clef-flash-local`，十进制和 **`1.0002`**，**十进制本身超差**；容差数值未变，`366f73d` **不覆盖**该例，它仍然失败（[报告 §3.1](calibration/report.md) 表格末行；[normalization-boundary.md §4](normalization-boundary.md) 的 *the `1.0002` case still fails*） |
| 两处传输修复 | 空 `credentialRef` 表达「端点不认证」；headless chat 服务（`evals/src/run/chat-service.ts`） |

**这 5／1 的拆分是派生结论，不是实测。** 试点运行记录已丢失（[acceptance-scope.md](acceptance-scope.md) §B6），本阶段没有重放那 6 格，也没有重新派发真实调用。「5 例会通过」的依据是保存捕获响应的精确算术重算加边界测试固定（[normalization-boundary.md §4](normalization-boundary.md)），**不是**把这 6 格重跑一遍。所以上表**不能**读成「本地 Clef 的失败已全部解决」：1 例的失败是真实的超差，与边界修复无关。

**这证明的是「基线跑得通、接线可用、判读一致」，不是「基线判得对」。** 后者属 [acceptance-scope.md](acceptance-scope.md) §B 的已知问题与 §C 的后续移交。

### 3.5 本条决定没有改什么

- 不改量表、不改矩阵、不改 N0、不改阈值（`SUM_TOLERANCE` 保持 `1e-4`）。
- 不新增后端专属门、不新增独立风险上限、不新增 M1 弃权。
- 不根据 S1 小样本调整 prompt 去追求更高成绩。
- 不把 B 写成「失败」：B 的 chat 臂 10/10 产出全部五类读数，B 的数据作为**完整证据档案**保留（[报告 §7.4](calibration/report.md)）。

---

## 4. 与「候选 A 是生产包」的一致性

本记录选择的是**已经存在于代码中的默认**，不是新增配置。三条可核事实：

| 断言 | 证据 |
| --- | --- |
| 生产包就是候选 A（无探针） | `PRODUCTION_PACKAGE.asksProbe === false`（`src/reviewer/package.ts:94`）；`PRODUCTION_VARIANT.prompt === 'no-probe'`（`src/reviewer/variant.ts:103`） |
| evals 的默认包是**同一个对象**，不是同形复制品 | `candidateOf` 在 plan 未声明 `candidate` 时返回 `pkg: PRODUCTION_PACKAGE`（`evals/src/run/candidate.ts:70-79`）；`tests/evals/production-evals-parity.test.ts` 的 *resolves a plan with no candidate to the production package object* 断言同一性 |
| 生产只有一个评审入口，且走同一个包 | `src/host/gate-review.ts:183` 的 `review(...)` → `src/reviewer/service.ts:122` 的 `reviewWith(PRODUCTION_PACKAGE)` |

**一处必须说清的边界**：`review()` 在 `src/` 里还有两个调用点，都在 `src/reviewer/diagnostic.ts`（`:411` 与 `:534`），属于「Reviewer 连接测试」这条独立路由。它们同样走 `review()` 与 `PRODUCTION_PACKAGE`，但用的是合成的 `PROBE_SNAPSHOT`、不产生审计行、不参与调用裁决。所以「`review()` 是唯一评审入口」的准确表述是：**所有真实调用共用同一个 `review()` 与同一个包**；连接测试是同一入口的另一类消费者，不是第二套评审逻辑。

---

## 5. 性质声明（必须与本文一起读）

**这是工程基线，不是质量结论。**

| 本文可以说的 | 本文不可以说 |
| --- | --- |
| 本阶段默认用候选 A、现行矩阵、现行 N0、`review-rubric-v1`、51 条用户标签 | 候选 A **在质量上胜出** |
| 基线可精确复现：SHA `366f73d` + 上列版本常量 + 上列两个数据集摘要 | 基线**质量达标** |
| 试点证明接线可用、120/120 拿到响应、A 臂 54 格 scored | 试点证明**判定准确**（一致率 71.4%，错误率 28.6%） |
| 探针取舍已由用户裁决（不采用 B） | 「B 失败」或「A 比 B 好」 |
| 归一化边界已按 `1e-4` 精确比较修复 | 误放为 0 意味着**零真实风险**（该数为 0 只成立于 49 格小子集） |

**为什么不能说得更多**：S1 只有 10 案例 × 1 repeat；`authorization` 系统性低估 −0.98 档（远端 −0.889）；`risk` 在 2→3 边界高估；配对命中率 24.5%；高风险禁止类（R8／R9）未进 dev 试点。逐项见 [acceptance-scope.md](acceptance-scope.md) §B。质量验收与保留集验证**已移交后续 milestone**（`#85`，见同文件 §C）。

---

## 6. 决定记录索引

| 决定 | 位置 | 决定者 | 日期 |
| --- | --- | --- | --- |
| 探针取舍：decision 与 chat 统一用无探针（候选 A），B 不采用 | 本文 §3；[报告 §7.4](calibration/report.md)；[#83 comment](https://github.com/Yuee98/dsh-arbiter/issues/83#issuecomment-6539008187) | 用户 | 2026-10-31 |
| 本阶段默认基线 = 候选 A + 现行矩阵 + 现行 N0 + `review-rubric-v1` + core-v1 标签 | 本文 §1、§2 | 本记录（窗口二范围） | 2026-10-31 |
| 探针比较之外的所有冻结对照（C1–C4、双重复、cold/warm、阈值回放）划为后续任务 | [报告 §10.1.2](calibration/report.md)；本目录 [acceptance-scope.md](acceptance-scope.md) §C | 报告范围声明 | 2026-10-31 |
| 付费调用前货币前置条件未满足，用户追认本次偏离 | [报告 §10.1.1](calibration/report.md) | 用户 | 2026-10-31 |

**这些决定都不改变任何测量数据**：`calibration/report.md` 的三层结果、`call-log.md` 的 127 次调用记录、`366f73d` 的修复前后对照全部按原始记录保留。
