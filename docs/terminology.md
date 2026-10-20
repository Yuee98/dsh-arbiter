# 产品术语与判定阶段

本文件是产品术语的统一定义入口。专题文档引用这里的定义；术语调整先更新本文件，再同步相关正文和示例。历史记录与原稿快照保留旧名称。

状态：已确认“审查策略 = 审查判定规则 + 判定阈值”的概念划分，以及审查、故障、人工、兜底处理的阶段区分。总称沿用当前讨论中的“审批模式”，替代 DND；具体判定条件与阈值见[策略整理稿](approval-modes.md)，未确认项明确标注。本文件不规定最终 API 字段。

入口：[README](../README.md) · [设计导航](../design.md) · [决策记录](decisions-and-questions.md)

<a id="core-terms"></a>

## 核心术语

| 术语 | 定义与边界 | 相关正文 |
|---|---|---|
| 命令规则 | 根据调用及其 AST 匹配结果，选择禁止、人工审批、强制审查或免审放行路径；与审查判定规则分开 | [规则引擎](rules.md#design-4) |
| 审查信号 | 供判定引擎使用的风险、授权、探针及相应分布或点值；模型输出是信号，不是最终执行指令 | [统一中间表示](reviewer.md#design-5-5) |
| **审查策略** | **审查判定规则 + 判定阈值**的完整组合，规定如何从审查信号得到审查结论 | [判定引擎](reviewer.md#design-5-6) |
| **审查判定规则** | 由代码执行的条件与效果，例如根据风险、授权、`destructive`、`bulk` 的组合决定是否拒绝、要求人工或允许代批。审查上下文中可简称“判定规则” | [判定引擎](reviewer.md#design-5-6) |
| **判定阈值** | 判定规则使用的数值参数，如风险上限、最低授权等级、概率门槛；同时涵盖点值与概率后端 | [判定引擎](reviewer.md#design-5-6) |
| 判定引擎 | 执行当前审查策略的代码，负责综合信号、应用规则与阈值并产生审查结论 | [判定引擎](reviewer.md#design-5-6) |
| 审查结论 | 判定引擎产生的 `review-allow`、`review-deny` 或 `review-escalate`，不是模型直接给出的操作指令 | [判定阶段](#decision-stages) |
| 人工处理结果 | `human-allow / human-deny / human-abort`；前两项是人的明确决定，human-abort 表示人工审批已结束但未取得决定 | [人工处理结果](approval-modes.md#human-outcomes) |
| 故障转人工 | `error-escalate`：审查未能正常完成，与 review-escalate 共用后续人工处理流程，但不伪装成有效审查结论 | [故障与人工处理](approval-modes.md#escalation) |
| 兜底策略 | 需要人工审批但模式不发起审批或审批通道不可用时的处理约定；review-escalate 和 error-escalate 都可转为 fallback-deny，不表示禁止 agent 提问 | [审批模式](approval-modes.md#escalation) |
| 审批模式 | 审查策略选择与插件人工审批方式的组合；normal / strict 共用常规策略，progress 调整部分条件；不限制 agent 的 ask 或聊天提问 | [模式选择](approval-modes.md#mode-selection) |
| ask 工具 | 宿主向用户提问的工具，可用于补充授权或澄清需求；其答复作为审查证据，不等于 force-ask 所要求的实际人工审批 | [ask 独立性](approval-modes.md#ask-independence) |
| 审查指引 | `CUSTOM_RULES`、`PROJECT_RULES`、规则附带 `hint` 等供模型理解的自然语言文本。可以影响模型对信号的判断，不直接改写代码中的判定规则和阈值 | [审查输入](review-context.md#design-5-2-3-1) |
| 执行 agent 行为指引 | 告诉执行任务的模型如何理解拒绝、寻找可行方案、报告受阻与补充授权；不是发给 reviewer 的审查指引，也不直接改变权限结果 | [子任务恢复流程](architecture.md#subagent-recovery) |

`destructive ∧ bulk` 本身只是一个判定条件。要构成完整的判定规则，还需写清效果、适用策略及冲突处理；具体建议见[审查判定规则对照](approval-modes.md#rule-matrix)，本术语表不替代规则的逐项确认。

<a id="decision-stages"></a>

## 判定阶段与结果名称

| 阶段 | 名称 | 含义 |
|---|---|---|
| 命令规则 | `deny / force-ask / force-review / allow` | 四种可配置的规则行为，优先级见[规则正文](rules.md#design-4-4) |
| 规则兜底入口 | `review(default)` | 显式规则未能裁定整个调用时进入审查；不是第五种配置 verdict |
| 审查 | `review-allow` | 当前审查策略允许执行，后续仍受宿主执行边界约束 |
| 审查 | `review-deny` | 当前审查策略拒绝；不能再当作“需要人工”流入兜底代批 |
| 审查 | `review-escalate` | 当前审查策略无法自动批准，需要人工决定 |
| 故障 | `error-escalate` | 审查未能正常完成，转入人工处理；保留具体故障原因 |
| 人工 | `human-allow / human-deny` | 人对当前请求作出的批准或拒绝 |
| 人工 | `human-abort` | 人工审批已结束但未取得批准或拒绝答案；当前调用不执行，不代表用户反对 |
| 兜底 | `fallback-deny` | 因无法进行所需人工处理而不执行；必须保留来源阶段与具体原因 |
| 执行 | 成功、失败、取消等 | 工具实际执行结果，与权限判定分开；获批不保证执行成功 |

典型路径：

```text
force-review 或 review(default)
  → 审查信号
  → 判定引擎应用当前审查策略
  → review-allow / review-deny / review-escalate

review-escalate 或 error-escalate + 插件可发起人工审批 → human-allow / human-deny / human-abort
review-escalate 或 error-escalate + 自动档不发起审批 → fallback-deny
force-ask + 自动档不发起审批 → fallback-deny（未经过审查）
```

normal / strict 对同份信号使用相同判定规则与阈值，区别是是否发起插件人工审批。progress 对判定规则和阈值的影响发生在形成审查结论之前，使部分常规策略下的 review-escalate 成为 review-allow；不是在兜底阶段覆盖已形成的结论。`fallback-deny` 不代表操作被评为危险，也不代表人拒绝；例如可展示“未执行：该操作需要人工审批，当前模式不发起审批”。

审查超时、非法响应等故障走 error-escalate；用户取消和工具执行失败不归入此类。完整路径如 `force-review → error-escalate → fallback-deny`，不能只记最终 deny。具体边界见[故障与人工处理](approval-modes.md#escalation)。

人工审批仍在等待时为 pending，只有未取得决定且审批已结束才是 human-abort。human-abort 在执行上与 deny 一样不放行，审计和后续审查必须保留其含义；不能由此推出 human-deny。授权聊天消息（包括父 agent 转述）属于审查证据，不自动等于实际审批响应 human-allow。

审批模式不禁止 ask。宿主 timed ask 返回 pending 时，问题仍可能被回答，不属于本插件审批的 human-abort，也不产生授权；后续补充授权用于新请求，不能恢复已经结束的调用。

<a id="supporting-terms"></a>

## 模式与相关术语

| 术语 | 含义 |
|---|---|
| 勿扰模式（DND，旧称） | 原稿对 strict / progress 的称呼；当前统一使用“审批模式”，不再暗示控制所有通知或普通需求澄清 |
| 审批通道可用性 | 宿主及当前会话能否实际请求人工审批；与当前审批模式是否允许询问分开。通道不可用本身不授权扩大代批范围 |
| normal / strict / progress | 三档审批模式及其对应审查策略；主会话可选三档，子任务统一只选 strict / progress。具体差异见[策略整理稿](approval-modes.md) |
| trusted 模式 | 原稿的 `danger-full-access` + `ask` 预设，规则 allow 可免审且无沙箱约束 |
| guarded 模式 | 原稿的 `workspace-write` 模式，规则 allow 可免审但仍受沙箱约束 |
| 升权 | DSH 的单次调用沙箱放宽机制，与插件的审查批准分开 |
| 探针（probe） | `secrets`、`destructive`、`egress`、`bulk` 四个信号；信号本身不等于一条权限规则 |
| 推导表 | 审查判定规则的一种表格表达，例如风险与授权类别的组合；不是独立于审查策略的第二套裁决 |
| 概率门 | 判定规则对概率分布施加的条件；概率门槛属于判定阈值。chat 后端没有该分布，使用点值相关条件 |
| 不变式（旧稿用语） | 旧稿曾混指硬拒和必须人工的条件；需逐条确定效果与是否跨策略固定，不能仅凭这个名称推断行为 |
| `promoted` | progress 额外代批的审计标记；建议比较同份信号在同配置版本的 normal / progress 下的审查结论，不表示兜底阶段可覆盖结论 |
| `session` 变体 | `chat.provider: "session"`，复用当前会话的模型配置，使用 chat 类型的信号和判定方式 |
| 五段式快照 | 原稿对官方 reviewer 输入结构的描述：固定策略、cwd 环境、项目约束、带来源历史、待审动作；本产品上下文以[当前专题](review-context.md)为准 |

<a id="usage"></a>

## 写作与维护约定

- 同时讨论两类规则时，完整使用“命令规则”和“审查判定规则”；不笼统写“规则”。
- 不使用“推导概率规则”作为新的分类；推导表属于判定规则，概率门槛属于判定阈值。
- 描述完整审查结论时，不再说“只由阈值映射算出”；应写“由判定引擎应用审查策略得出”。
- 产品流程与审计说明保留审查、人工、兜底阶段；底层适配器即使返回相同的 `deny`，也不抹掉来源。
- 旧稿中的裸 `ask/deny/allow` 需要结合所属阶段迁移；“deny 后再问人”等混合表达不能机械加上 `review-` 前缀。具体条件冲突仍在[问题登记](decisions-and-questions.md#product-discussion)收敛。
- 术语定义不等于开放配置能力；哪些判定规则可编辑、由谁编辑、哪些阈值可调，需要单独确定。
