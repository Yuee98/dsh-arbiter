# 生产与评测同逻辑核对（RQ-16, #84）

范围：issue 验收条件之一——「验证当前默认配置在生产和 evals 中使用同一套渲染、解析、N0 与判定逻辑」。
本文件是**源码与测试的核对记录**，不含新调用。真实运行证据见
[RQ-15 报告](../review-quality/calibration/report.md)。

## 1. 结论

默认配置下两者**是同一份实现**，不是两份互相模拟的代码。生产入口和 evals 运行器在同一条
`reviewWith(pkg)` 管线上汇合，`pkg` 的默认值就是 `PRODUCTION_PACKAGE` 这个对象本身。

## 2. 各自的入口

| 路径 | 调用点 | 用的包 |
| --- | --- | --- |
| 生产 | `src/host/gate-review.ts` → `review(request)` | `review()` 内部固定 `reviewWith(PRODUCTION_PACKAGE)`（`src/reviewer/service.ts:121`） |
| evals | `evals/src/run/execute.ts:349` → `reviewWith(deps.pkg)(…)` | `deps.pkg` 来自 `candidateOf(plan)` |

`candidateOf`（`evals/src/run/candidate.ts:70`）在 plan 未声明 `candidate` 时返回
`pkg: PRODUCTION_PACKAGE`——**同一个对象**，不是按四条轴重新拼出来的同形包。这是关键差异：
一个「同形基线」会让每次 A/B 比较都变成「处理组对比另一份处理组」。

## 3. 共享的四个环节

| 环节 | 实现 | 生产 | evals |
| --- | --- | --- | --- |
| 渲染 | `src/reviewer/prompt.ts` 的 `renderChatRequest` / `renderDecisionRequest` | ✔ 直接调用 | ✔ 经 `PRODUCTION_PACKAGE.renderChat`（同一个函数） |
| 解析 | `src/reviewer/signals.ts` 的 `readChatAnswer` / `readDecisionAnswer` | ✔ | ✔ 经 `PRODUCTION_PACKAGE.readChat/readDecision`（同一个函数） |
| N0 | `src/review-contract/normalize.ts` 的 `readProtocolScores` | ✔ | ✔ 同一函数（`service.ts` 内的 `outcomeOf` → `evaluateReview`） |
| 判定 | `src/review-contract/evaluate.ts` 的 `evaluateReview` + `matrix.ts` | ✔ | ✔ 同一函数 |

读之后的一切——遮蔽边界 `maskAttempt`、用量汇总 `aggregateUsage`、outcome 映射——都是
`service.ts` 自己的代码，与包无关。所以一个候选只能改变「问了什么」和「怎么读」，不能改变
「一个分数意味着什么」。

## 4. 可检验的证据（测试，不是声明）

`tests/evals/production-evals-parity.test.ts`（13 个测试）：

| 断言 | 防的是什么 |
| --- | --- |
| `candidateOf(planOf()).pkg === PRODUCTION_PACKAGE`（同一性，非相等） | 有人把默认包换成同形变体 |
| `PRODUCTION_VARIANT.prompt === 'no-probe'` 且 `PRODUCTION_PACKAGE.asksProbe === false` | 默认候选被改成 B |
| `PRODUCTION_PACKAGE.renderChat === renderChatRequest` | 生产函数被复制一份 |
| `caseMaterial(case,'chat').request` 等于 `renderChatRequest(snapshot)` | evals 绕过生产渲染器 |
| `caseMaterial(case,'decision').request` 等于 `PRODUCTION_PACKAGE.renderDecision(snapshot)` | 同上，decision 侧 |
| 同一答案经 `review()` 与 `reviewWith(candidateOf(plan).pkg)` 得到相同 outcome | 两条入口在下游分叉 |
| **decision 侧**：同一 10 档分布经两条入口得到相同的 `risk`/`authorization`/`requiredAuthorization`/`verdict`，且两侧 `audit` 相同 | 只比了 chat，而 N0 修复主要作用于 decision |
| **decision 侧**：恰好落在容差的分布两侧都判 `scored`；`1.0002` 两侧都判 `review-failure` 且 reason 相同 | 修好一处却放宽了另一处，或两侧失败分类不同 |
| 两条入口发出的 decision 请求体 `toEqual` | 两侧各自渲染，字节其实不同 |
| 该 outcome 的 `requiredAuthorization` / `verdict` 也相同 | 只比了两档分、没比矩阵 |
| 不可读答案在两条入口同样失败 | 候选把失败归因成质量差 |
| `REVIEW_PROMPT_VERSION = 'review-prompt-v1'`、`REVIEW_CONTRACT_VERSION = 'review-contract-v1'` | 版本无法追溯 |

**证伪**：把 `candidateOf` 的默认包改成 `variantPackage(PRODUCTION_VARIANT)`，"same object" 断言变红；
把 `caseMaterial` 的渲染结果加一个空格，两条渲染断言变红；把默认 prompt 轴改成
`recovery-probe`，"candidate A" 断言变红。三条都已实测。

## 5. 版本与指纹的可关联性

一次生产审查与一次评测格可被追到同一组标识：

| 标识 | 值 | 生产落点 | evals 落点 |
| --- | --- | --- | --- |
| `REVIEW_CONTRACT_VERSION` | `review-contract-v1` | `ReviewScores.contractVersion`（`src/host/gate.ts:99`） | `RunVersions.contract`（`evals/src/run/commands.ts:83`） |
| `REVIEW_PROMPT_VERSION` | `review-prompt-v1` | **未写入记录**（生产只把 `CHAT_PROTOCOL` / `DECISION_PROTOCOL` 写进 attempt 的 `protocol`） | `RunVersions.prompt` |
| 请求指纹（可复现） | `digestOf({protocol, request})` | **可从 `snapshots.content` 重算**（见 §5.1） | `CellMaterial.promptFingerprint` |
| `POLICY_VERSION` | `arbiter-policy-v3` | `DEFAULT_CONFIG.policy.version` | 计划与运行目录的 config revision |
| 线协议 | `arbiter-chat-json-v2` / `arbiter-decision-v2` | `ReviewAttempt.protocol` | `CellTargetRecord.protocolName` |
| 请求指纹 | `digestOf({protocol, request})` | —（生产按 callId 记录 attempt） | `CellMaterial.promptFingerprint` |
| 变体身份 | `rq14/no-probe.complete.current-turn.full` | `PRODUCTION_VARIANT.variantId` | `RunPlan.candidate` / `candidateSummary` |

### 已核实的一个记录层限制

`CellMaterial.promptFingerprint` 是**渲染后请求**的摘要（`evals/src/run/material.ts:373`），不是
attempt 里那份 `request` 的摘要。两者不同：

```
渲染并发送的 system：  {"risk":<integer 1-10>,"authorization":<integer 1-10>}
attempt.request.system：{"risk":<integer 1-10>,"authorization":[redacted]}
```

原因是 `maskAttempt` 的凭据遮蔽规则（`src/reviewer/redact.ts:518`）只豁免「精确键
`"authorization"` + 未加引号的数」。chat 提示里的 `<integer 1-10>` 是一个占位符，不是数字，
于是被当成 auth header 的值遮蔽掉。

**实测影响面**（不是推定）：

| 事实 | 结果 |
| --- | --- |
| 发给 provider 的字节是否被破坏 | **否**。`stream` 收到的 `system` 仍含 `<integer 1-10>`，不含 `[redacted]` |
| 判定是否受影响 | **否**。同一格 `outcome.status === 'scored'` |
| 能否从 attempt 重算 `promptFingerprint` | **否**。重算值与记录值不同（实测 `sha256:070eee…` vs `sha256:8218e2…`） |
| `evals/src/run/types.ts:240` 是否已声明这一点 | **是**。该字段注释明确写「取自渲染后的请求，不是 attempt 的 `request`——那份已过遮蔽」 |

所以这不是本分支引入的缺陷，也不影响分数、判定或 provider 侧行为；它是既有设计对「记录字节」
与「提交字节」的区分，且已被文档化。**本任务不改它**：修正的话要放宽遮蔽规则或改写 chat
提示的占位符，两者都会动到本任务范围之外的安全边界或 prompt 语义。记录在此，供后续任务决定。

### 5.1 请求指纹可以在两侧相关（RQ16-B01 的收口）

前置事实：生产**不**持久化 `promptFingerprint`，但**持久化了完整 `ReviewSnapshot`**
（`src/audit/writer.ts:89` 把 `record.snapshot` 写进 `snapshots.content`，`hash(content)` 存在
`content_hash`）。渲染器是纯函数，所以同一 build 上可以由该快照重算出同一个规范摘要：

```
evals 记录：   CellMaterial.promptFingerprint = digestOf({ protocol, request })
生产重算：     digestOf({ protocol, PRODUCTION_PACKAGE.render<Protocol>(snapshots.content) })
               → 与上面相等
```

这条已由 `tests/evals/production-evals-parity.test.ts` 的 *the production request fingerprint is
reproducible from the stored snapshot* 断言，chat 与 decision 各一次；**用的是记录里真实的
`material.material.promptFingerprint`，不是测试自己重算的值**（自己重算会让断言变成恒真）。

因此「候选参数与生产请求指纹可关联」的成立方式是：

| 环节 | 是否有同一摘要 | 依据 |
| --- | --- | --- |
| evals 记录 | 有 | `CellMaterial.promptFingerprint` |
| 生产审计快照 | 可重算得到 | `snapshots.content` + 生产渲染器（同一 build） |
| 生产 attempt 的 `request` | **不能**（设计如此） | 已过 `maskAttempt`；实测重算值不同，见下 |

**代价与边界**：这不是新增列或迁移，也不改 schema；它依赖「同一 build 重放」。跨 build 重放需要
渲染语义变了就换 `REVIEW_PROMPT_VERSION` —— 该约定已在 `src/reviewer/contract.ts:34` 写明。生产侧
若要直接读出摘要，需要新增一个持久化字段；本任务**不**做（issue 不要求新增开关／字段，且快照路径
已足够证明可关联）。

**边界（必须如实说明）**：

- 生产**不记录** `promptFingerprint`（它没有「同一格的多次运行」要比较），也不记录
  `REVIEW_PROMPT_VERSION`；`REVIEW_PROMPT_VERSION` 目前只有 evals 的 `RunVersions` 在用。
- evals **不记录**宿主 config revision。
- 两侧真正共有的可追溯标识是 `REVIEW_CONTRACT_VERSION`（契约语义）与 attempt / record 上的
  **线协议名**。这足以说明「两侧用同一套语义、同一套代码」，但**不足以**从一个生产 callId
  反查某个具体评测格——那需要两边都记同一个键，本任务不引入新键（issue 明确不新增未选择的开关）。

## 6. 未做

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 生产链路的真实宿主抓包核对 | not-run | 属 RQ-19（#87）宿主集成验收；本任务不发起真实审查 |
| 用 evals 重跑生产材料做逐字节比对 | not-run | 生产材料来自宿主会话日志，evals 材料来自 case 文件；两者输入本就不同，比对会得到一个不存在的结论 |
| 候选 B 的默认化 | 已否决 | #83 已决定不采用 B；本任务只接入 A |
