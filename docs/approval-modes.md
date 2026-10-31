# 审批模式与审查策略

本页集中维护审批模式（`ask`／`no-ask`）、共用判定矩阵、配置生效与判定链。沿用“审批模式”总称，替代 DND。

入口：[产品术语](terminology.md) · [总体架构](architecture.md) · [审查后端与引擎](reviewer.md) · [统一评分契约](reviewer.md#design-5-5) · [决策与待定项](decisions-and-questions.md#dnd-refinements)

实现状态（2026-10-29，#68；本页 2026-10-31 按新版契约修订，RQ-19）：**审批模式只有两档 `ask`／`no-ask`**，两者共用同一份 `review-contract` 矩阵，模式只决定升级时能否开启真人审批。人工允许／拒绝／未决结束、`fallback-deny` 与 `error-escalate` 接入宿主审批 seam；插件直接调用 `approval.request` 以取得完整结果。

<a id="mode-selection"></a>

## 模式与设置入口

**审批模式 = 插件人工审批方式。** 模式不选择审查策略：判定规则与档位是共用的 `review-contract` 矩阵，两种模式逐字相同。这里的人工审批不包括 agent 自行调用 ask 工具或在聊天中提问。

| 显示名称 | 标识 | 审查策略 | 需要人工时 |
|---|---|---|---|
| 交互审批 | `ask` | 共用矩阵 | 审批通道可用且为真实通道时发起人工审批 |
| 自动审批 | `no-ask` | 同一份共用矩阵 | `fallback-deny`（不提问、不执行） |

`no-ask` 不是更严格的策略，只是移除了问题：同一分数在两种模式下得到同一 `review-allow`／`review-deny`；只有「升级」的去向不同。矩阵本身见[统一评分契约](reviewer.md#design-5-5)：A1 无条件拒绝，`risk ≤ 2 → A2`、`3–4 → A8`、`5–6 → A9`、`7–10 → A10`，没有第二个风险上限，也不按后端分叉。

每档提供 tooltip：

| 名称 | Tooltip |
|---|---|
| 交互审批 | 按命令规则处理，对需要审查的调用进行自动审查（Auto Review），并按共用矩阵自动批准或拒绝；需要人工决定时发起审批。 |
| 自动审批 | 使用与交互审批完全相同的审查标准；需要人工审批的调用不执行，不新发起审批。Agent 仍可通过 ask 或聊天提问。 |

名称描述插件的权限审批，不承诺所有操作自动完成、不被问题阻塞或全程无人值守。

插件设置页提供两项设置，其中只有一项是真正的选择：

| 设置 | 可选值 | 作用范围 |
|---|---|---|
| 主会话审批模式 | `ask` / `no-ask` | 当前插件配置作用域内的主会话 |
| 子任务审批模式 | 固定 `no-ask`（不可选） | 当前插件配置作用域内的所有 subagent |

由用户控制主会话的选择，不提供单个 subagent 的覆盖开关。**子任务不继承父会话的审批模式**，统一读取子任务设置；“继承授权证据”是另一件事。默认值为主会话 `ask`、子任务 `no-ask`（`src/config/defaults.ts:32`），完整默认配置见[首版初始默认值](configuration-and-audit.md#initial-defaults)。

**子任务固定 `no-ask` 的理由。** 子会话没有自己的审批通道：宿主在委派时把子会话的审批策略固定为 `never`，插件也不代子任务发起人工审批（`src/host/settlement.ts` 的 `channelOf` 先按会话类型判定，再按模式判定）。因此 `ask` 从未真正打开过一个提问——它只是把同一个 `fallback-deny` 记成另一种原因。既然两个值对结果没有任何差别，该设置不再接受 `ask`：设置页保留同一控件但禁用（灰色、不可聚焦），tooltip 说明原因；文档里存着 `modes.subagent: ask` 会报 `modes.subagent-fixed` 配置错误，**不做静默改写**。子任务的兜底原因码因此是 `subagent_no_human_channel`，而不是 `automatic_mode_no_human`——前者是比任何配置都更长久的事实。

**升级到本版前请先手工改掉 `modes.subagent: ask`。** 无效文档的回退顺序是「内存中已生效的配置 → 本 profile 的 `last-good` 副本 → 内置默认值」（`src/host/runtime.ts` 的 `selectConfig`），其中 `last-good` 副本同样要过当前解析器。热重载时内存里还有上一份有效配置，自定义规则不受影响；但**冷启动**时若文档和 `last-good` 副本都还含 `ask`，两者都无法通过新解析器，最终落到内置默认值——此时自定义规则不生效，原先配置的确定性 deny 也会一并消失。改写这一个字段即可，不需要迁移工具。该行为是既有恢复路径的属性，由 `tests/integration/config-recovery.test.ts` 固定。

**旧值不转换。** `normal`／`strict`／`progress` 与 `probeMode` 一律作为配置错误报出（`src/config/policy.ts:43-57` 的 `policy.retired`），并提示替代：`normal` 与 `strict` 原本就是同一引擎加一个通道开关（即此处的 `ask`／`no-ask`），而 `progress` 会放宽矩阵本身——设计已明确禁止。旧阈值字段（`tauAuth`／`tauRisk`／`tauCritical`／`tauLow`、两个风险上限、`allowBulkEgress`）同样报错并提示「共用矩阵取代了概率阈值」。**不提供迁移、转换或兼容读取。**

<a id="ask-independence"></a>

### ask 工具独立于审批模式

按用户决定，**审批模式不限制 agent 使用 ask 工具或聊天补充授权、澄清需求**。两种模式下 agent 都可提问；不强制 agent 每次拒绝后都询问。

提问及其答复不复活已结束的工具调用。取得补充授权后，由新请求重新审查；答复是授权证据，不自动记为 human-allow，也不替代 force-ask 要求的实际人工审批。用户没有答复不产生授权。

子 agent 仍受宿主通道限制，向父 agent 报告受阻；父 agent 的审批模式不妨碍其调用宿主可用的 ask 工具。插件不替 agent 自动发问，也不把“允许提问”当成调用必定可用。

本机 DSH 0.2.1-rc.2 同时提供 legacy 阻塞式 ask 与可选 timed ask：timed 默认前台等待 120 秒，返回 pending 后问题仍可回答，agent 可继续独立工作；实际等待还受配置、单次 timeout 和界面交互影响。不能假定所有会话都已启用 timed，详见[源码核对](../evidence.md#ask-timing)。该 pending 不属于插件人工审批的 human-abort，插件不接管宿主问答生命周期。

<a id="command-boundary"></a>

## 命令规则与模式的边界

`deny > force-ask > force-review > allow > review(default)` 保持不变。

| 规则路径 | `ask` | `no-ask` |
|---|---|---|
| `deny` | 规则拒绝，不进入审查 | 相同 |
| `force-ask` | 进入人工处理 | `fallback-deny`，不交模型代批 |
| `allow` 完整覆盖 | 免审放行，仍受执行环境约束 | 相同 |
| `force-review / review(default)` | 应用共用矩阵 | 应用同一份共用矩阵 |

**规则裁决与审查裁决是两个阶段。** 前者由 `settleRule()` 按上述优先级映射（`src/policy.ts:120`），后者由 `settle()` 把审查阶段按模式与通道结算（`src/review-contract/matrix.ts:91`）。两者都不扩大对方：规则 `allow` 不因为「矩阵允许」而得到额外放行，审查 `review-allow` 也不能覆盖已命中的规则 `deny`。

**下面的矩阵只适用于已经进入审查的调用。** 不因矩阵中的限制对命令 allow 追加审查，也不把审批批准当成沙箱升权。

<a id="rule-matrix"></a>

## 共用判定矩阵（现行契约）

**这是唯一一份判定表，不由模式、后端或配置选择第二份。** 完整定义见[统一评分契约](reviewer.md#design-5-5)，实现为 `src/review-contract/matrix.ts:22`（`verdictFor`）与 `src/review-contract/rubrics.ts:74`（`requiredAuthorizationFor`）。

| 风险 | 最低授权 | 未达门槛时 |
|---|---|---|
| 任意风险 | **A1**（有效禁止／撤回） | **`review-deny`**，任何模式、任何风险都不例外 |
| `risk ≤ 2` | A2 | `review-escalate` |
| `risk 3–4` | A8 | `review-escalate` |
| `risk 5–6` | A9 | `review-escalate` |
| `risk 7–10` | A10 | `review-escalate` |

100 格逐格断言与计数（`[denies, escalates, allows] = [10, 58, 32]`，合计 100）见 `tests/review-contract/matrix.test.ts:51`。

**已退出的历史设计**：本页此前保留的 R1–R8 评测候选表、`normal`／`strict`／`progress` 三档对照、`τ_auth`／`τ_risk`／`τ_critical`／`τ_low` 概率门、chat 点值上限 6／8，以及「规则组合建议」的四步顺序，都已由上式取代。它们不再作为可选策略、不再可配置、也不再是评测素材——**评测阈值与矩阵门槛属于后续窗口的独立任务**（见[交付报告](../validation/review-quality/delivery/handover.md)）。

<a id="thresholds"></a>

## 统一授权标准

**chat 与 decision 采用统一的授权标准。** 对某类操作需要多少授权，由同一份矩阵规定，不因后端不同而改变。两类后端的信号形式仍不同：chat 给点值，decision 给分布；统一标准不等于数值或实际模型输出必定相同。

| 项目 | 现行契约 |
|---|---|
| 审查判定规则 | 共用矩阵，两个协议、两种模式逐字相同 |
| 风险→最低授权 | `≤2 → A2`、`3–4 → A8`、`5–6 → A9`、`7–10 → A10` |
| A1 | 无条件 `review-deny` |
| decision 的分布处理 | N0：风险取最小 `F(k) > 0.5`、授权取最小 `F(k) >= 0.5`；总和与 1 的偏差 ≤ `1e-4`（精确十进制比较） |
| chat 的点值处理 | 1–10 整数恒等映射 |
| 可调阈值 | **无**。`policy` 配置段只保留 `version`（`arbiter-policy-v3`），档位、N0 与矩阵由 `REVIEW_CONTRACT_VERSION` 命名 |

**为什么没有可调阈值**：第二份数字就是第二个答案。档位含义、N0 规则或矩阵一旦可配置，同一分数在不同配置下含义不同，审计记录与离线回放也就无法复现判定。语义变更走 `REVIEW_CONTRACT_VERSION` 升版，不走进配置项。

**质量现状（不是本页的契约，但必须一起读）**：共用矩阵的**工程条件**已满足（100 格逐格断言、单调性、无第二风险上限、无后端分支）。**模型判定质量未达标也未冻结**——S1 试点暴露的 authorization 系统性低估、risk 在 2→3 边界高估、样本量不足等问题仍未解决，且矩阵门槛实验属**工具刻意不支持**的轴。详见[交付报告的已知限制](../validation/review-quality/delivery/limitations.md)与[移交项](../validation/review-quality/delivery/handover.md)。**不要把「矩阵已固定」读成「矩阵已校准」。**

<a id="configuration-activation"></a>

## 配置生效与在途请求

本节的审批模式及配置生效与会话启用状态分开：用户在权限选择器切入／切出 arbiter，trusted / guarded 在插件配置页选择。切出停止接管新调用，已经接管的请求不因此主动取消；停用／卸载和宿主取消的限制见[生命周期契约](architecture.md#permission-lifecycle)。

采用用户提出的统一边界：**配置校验并成功应用后生效；已有结果继续推进到最终处理，不因后端或输入协议变更而丢弃、重审；已弹出的人工审批继续等待，尚未作出的后续判定使用新配置。** 不增加“每次执行前再检查一次模式”的独立产品流程。

**实现（#12）**：每个阶段的边界各取一次一致的配置快照（`src/host/stage.ts`）——规则求值在 `await` 之后取，快照用该次求值的配置，模型请求发出时冻结后端与协议设置；决策阶段另取一次快照，因此「解释旧响应」与「用新策略判定」分别有各自的版本。审计在快照上记录请求侧版本，阶段 trace 记录各阶段实际版本。人工审批的资格判断移到结算入口：`approvalOpen` 为真表示问题已在屏幕上，此时不再按当前模式撤回，答案仍会结算该调用；尚未发问的决定才读取当前模式。终态由一次认领决定：`CallSettlement` 先认领再写记录，竞争路径拿到已认领结果并直接返回同一 disposition，因此记录、trace 与交给宿主的答案不会互相矛盾。人工答案与取消作为**竞争事件**处理：先被确定观察到的一方获胜——取消先于拒绝到达时为 `human-abort`，答案先到达时不会被随后的取消改写。所有受阻终态（规则拒绝、审查拒绝、`review-escalate`/`error-escalate` 的兜底、人工拒绝与未决结束）都经同一组合反馈，包含规则、审查理由、#11 的截断/缺失与恢复指引；终态阶段记录实际生效的配置版本，等待中的审批保留提问时的版本。

| 请求状态 | 配置生效后的处理 |
|---|---|
| 尚未进入审批处理 | 使用新配置及主会话／子任务对应模式 |
| 模型请求仍在运行 | 不会仅因配置变化而取消或重复发起；按原请求的后端及协议接收、解释结果，再继续后续处理 |
| 审查信号已取得、尚未形成结论 | 保留有效信号，不因切换后端重新调用模型；使用已生效策略中与该信号类型对应的判定规则和阈值 |
| 已形成规则或审查阶段结果 | 保留 allow / deny / escalate 等已有结果，不重算；尚未进入的后续阶段按已生效配置处理 |
| 已弹出并等待人工 | 保留原审批请求及其具体操作，等待 human-allow / human-deny / human-abort；切为 `no-ask` 不撤销它，也不自动代批 |
| 已经形成最终权限结论或已开始执行 | 不追溯、不撤回、不重新判定 |
| 之前已 fallback-deny | 保持该次调用未执行；切回 `ask` 不自动补执行 |

这里区分**结果的解释协议**与**后续阶段使用的策略**：旧响应按原请求的协议解析、校验，不拿新协议重新解释旧字段；后端和输入协议的新选择用于新发起的模型请求。审计保留信号产生时的配置／协议，以及后续判定实际使用的版本，不把整条链改写成一个新版本。正常超时、调用取消或输出非法仍按各自流程处理，配置变化本身不制造故障。

例如，已有 review-escalate、尚未弹出审批时切为 `no-ask`，保留该审查结论，继续得到 fallback-deny；若审批已经弹出，则继续等待人工处理。已有 review-allow / review-deny 不因切换后端被撤回。保留同一请求的已有结果不等于允许新请求跨配置复用旧缓存，见[去重](reviewer.md#design-5-11)。

“已保存”和“已生效”应在设置页有明确反馈；配置校验或应用失败不得显示为已生效。具体设置服务的应用方式需实现验证，当前不承诺已经具备热更新能力。

<a id="escalation"></a>

## 审查、故障与人工处理

采用用户提出的 **`error-escalate`**，与 `review-escalate` 并列进入相同的人工处理流程，但来源含义不同：

- `review-escalate`：已经获得有效审查信号，当前策略要求人工决定。
- `error-escalate`：审查未能正常完成，例如超时、后端不可用、有限修复后输出仍不合法。没有形成有效审查结论。

| 阶段结果 | `ask` 且审批通道可用 | `no-ask`，或审批通道不可用 |
|---|---|---|
| `review-escalate` | 人工审批 → human-allow / human-deny / human-abort | fallback-deny |
| `error-escalate` | 提示审查故障及具体操作 → human-allow / human-deny / human-abort | fallback-deny |
| `force-ask` | 人工审批 → human-allow / human-deny / human-abort | fallback-deny |

人工处理不能覆盖已经命中的命令 deny 或已形成的 review-deny。force-review 要求进入审查；若审查故障，可按上述路径由人决定，不能由故障路径自动放行。该定义明确区分“人工接管”和“审查成功”。

error-escalate 的建议边界限于审查服务及其信号生成失败：配置非法、已命中的禁止规则、用户取消、已获批后的工具执行错误都不应直接归入此类。取消应终止当前请求，不再向人发起审批。

两种 escalate 都不扩大代批范围。既有有限重试和修复策略可在 error-escalate 前执行；完整日志保留每次尝试与原因。因熔断而没有运行审查时的分类与计数口径需明确，不能把 fallback-deny 计成模型认为操作危险。

<a id="human-outcomes"></a>

## 人工处理结果

采用用户提出的 `human-abort`，与 human-allow / human-deny 并列：

| 结果 | 含义 | 当前调用 |
|---|---|---|
| `human-allow` | 人明确批准当前审批请求 | 放行，仍受执行环境约束 |
| `human-deny` | 人明确拒绝当前审批请求 | 不执行 |
| `human-abort` | 已进入人工审批，但流程结束时没有取得批准或拒绝答案 | 不执行；底层可映射为 deny |

**尚未回答、审批仍有效时是 pending，不是 human-abort。** 关闭弹窗、超时、断开连接或取消请求，只有确实终止了这次人工审批才记 human-abort；如果只是隐藏界面或连接可恢复，不能仅凭界面状态提前结算。是否设置审批超时及宿主事件如何映射仍需确定。

human-abort 保留具体结束原因，不表示用户反对，也不是审查认为操作危险。它与 fallback-deny 的区别在于：前者已经进入人工审批但未取得决定，后者无法进行所需人工处理。人工处理开始之前的调用取消不伪装为 human-abort；已经取得人工答案后，后续执行取消也不改写该答案。

<a id="decision-trace"></a>

## 完整判定链与任务继续

链按实际发生的阶段记录；不为未发生的阶段补造结果。示例：

```text
force-review → review-escalate → fallback-deny
review(default) → error-escalate → fallback-deny
force-review → error-escalate → human-allow
force-ask → human-deny
force-review → review-escalate → human-abort
allow → 执行成功
```

至少保存规则入口及命中规则、主／子任务模式、各阶段结果与原因、各阶段实际采用的配置版本、命中的审查判定规则和阈值。配置变化不改写已有阶段；人工等待期间也保留原审批请求的模式与配置。具体日志 Schema 仍在[配置与审计](configuration-and-audit.md#design-9-2)维护。

用户界面可显示“未执行：需要人工审批，当前模式不发起审批”或“未执行：审查服务超时，当前模式不转人工审批”。agent 得到可区分的结果和原因，不能只得到无来源的 deny，也不能把该结果解释为禁止使用 ask 工具。

human-abort 可显示“未执行：审批已结束，未收到批准或拒绝”，并附具体原因；历史与统计不把它计为用户明确拒绝。重新尝试是新的调用，原审批请求不自动恢复执行。

fallback-deny 只结束当前 tool call，其他独立调用照常处理；依赖该调用的部分报告受阻。不会因此取消整个任务、创建拒绝规则或改变审查策略。历史中保留整条链，不能把 fallback-deny 误解为 human-deny 或危险判定，也不能把 error-escalate 当成一次有效风险评估。

上述任务继续原则也适用于其他由 Arbiter 产生的审批拒绝：Arbiter 返回具体结果与原因，不主动中断会话；agent 自行判断能否按允许的方案继续、是否需要补充信息或授权，无法推进时回复用户说明受阻。用户侧复用宿主工具调用界面，以橙色图标和 Arbiter 来源标记提示拒绝；执行失败及沙箱错误仍由宿主展示。完整展示契约见[审批拒绝的展示与会话继续](architecture.md#approval-rejection-feedback)。

**关于「推进」指标**：本页此前定义了 `promoted`（同一信号在 progress 下为 review-allow、在同版本 normal 下为 review-escalate）。两模式取代三档后，这个比较不再有对象——两种模式的 `review-allow`／`review-deny` 完全相同。**该指标随 `progress` 一并退出。** 若后续窗口要比较不同的矩阵门槛，那属于新的契约版本与独立实验，不能借用本条定义。

<a id="open-choices"></a>

## 当前收敛状态与后续工作

**产品框架已收敛**：`ask` / `no-ask` 共用同一份判定矩阵，`no-ask` 把需要人工的升级结算为 `fallback-deny`；两类后端统一授权标准；ask 不受审批模式限制；默认两档（主 `ask`、子 `no-ask`），优先通过命令规则处理特定命令。设置范围、配置生效、各类终态和行为指引沿用已定契约。

| 后续工作 | 状态 |
|---|---|
| 矩阵门槛与阈值校准 | **不在本 milestone**。2026-10-31 范围调整把质量数值线的冻结移出；矩阵门槛实验属现有回放工具**刻意不支持**的轴。见[移交项](../validation/review-quality/delivery/handover.md) |
| 高级设置 | 当前只保留 `policy.version`，没有可调阈值入口。开放字段与编辑形式属新窗口的产品裁决，不承诺任意脚本或完整规则语言 |
| 显示名称与 tooltip、主／子初始值 | 上文已给出名称与 tooltip；主 `ask`／子 `no-ask` 已实现（`src/config/defaults.ts:32`） |
| 等待、重试与恢复参数 | 超时长度、重试次数、熔断阈值、冷却与恢复方式留到运行评测；故障不自动放行、取消终止当前请求、完整记录阶段等既定语义保持不变 |
| 宿主接入验证 | 升权入口、指引注入、父级原话与 ask 答复采集、设置应用、人工审批结束事件映射。**六项宿主流程已在隔离 profile 验收**，见[交付报告的工程结果](../validation/review-quality/delivery/engineering.md) |

“后续精调”表示现在不锁死参数，不表示实现可以长期不定义行为。评测同时观察误放、误拦、受阻后恢复、等待时长与成本；不只优化自动批准比例。

**本页与实现的一致性**：模式取值、共用矩阵、`fallback-deny` 结算、旧值拒绝分别由 `src/config/defaults.ts:32`、`src/review-contract/matrix.ts:22`／`:91`、`src/config/policy.ts:43`、`src/policy.ts:120` 实现；行为测试见 `tests/config.test.ts`、`tests/review-contract/matrix.test.ts`、`tests/integration/decision-chain.test.ts`。
