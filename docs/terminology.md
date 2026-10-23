# 产品术语与判定阶段

本文件是产品术语的统一定义入口。专题文档引用这里的定义；术语调整先更新本文件，再同步相关正文和示例。历史记录与原稿快照保留旧名称。

状态：已确认“审查策略 = 审查判定规则 + 判定阈值”的概念划分，以及审查、故障、人工、兜底处理的阶段区分。总称沿用当前讨论中的“审批模式”，替代 DND；具体判定条件与阈值见[策略整理稿](approval-modes.md)，未确认项明确标注。本文件不规定最终 API 字段。

入口：[README](../README.md) · [设计导航](../design.md) · [决策记录](decisions-and-questions.md)

<a id="core-terms"></a>

## 核心术语

| 术语 | 定义与边界 | 相关正文 |
|---|---|---|
| 命令规则 | 根据工具名、选定参数或解析出的命令等匹配对象，选择禁止、人工审批、强制审查或免审放行路径；与审查判定规则分开 | [规则引擎](rules.md#design-4) |
| 规则显示名称 | 默认使用根据实际条件生成的摘要，可由用户自定义覆盖；清空或恢复自动名称后继续随规则更新，允许重名，不参与匹配 | [规则名称、摘要与标识](configuration-and-audit.md#rule-naming) |
| 规则 ID | 新建／复制时自动生成并持久化的稳定标识，编辑或改名不变；与当时配置版本共同用于历史追溯 | [规则名称、摘要与标识](configuration-and-audit.md#rule-naming) |
| 匹配对象 | 规则实际检查的命令、工具名或选定参数值；路径字段按普通参数处理，不附加自动路径识别或文件访问范围保证 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 命令规范文本 | 对 AST 拆出的独立命令统一静态字面量的书写及词间空格，保留参数边界；动态或无法可靠转换的词保留原文，用于匹配而不改写执行请求 | [命令匹配文本与规范化](rules.md#command-matching) |
| 匹配条件 | 对指定对象应用精确匹配、RE2 或 glob 表达式；同一规则的多个条件使用“或”，具体仍受适用范围及调用整体覆盖要求约束 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 规则适用范围 | 工具、agent 身份等范围限制；先满足适用范围，再判断是否有匹配条件命中 | [规则管理](configuration-and-audit.md#rule-management) |
| 参数选择器 | 使用 JSONPath（RFC 9535）从本次工具调用的参数对象 `$` 取得零个或多个待匹配值，例如 `$.target.path`；不解析字符串中的 CLI 参数或推断业务含义 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 多值匹配 | 单个参数条件对选中值使用“任一／全部”，默认任一；两者均要求非空结果，“全部”要求每个选中值匹配；与多个条件之间的“或”分开 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 完整值匹配 | 精确匹配、RE2、glob 都检查整个选中值；RE2 不强制填写 `^`，三种方式默认大小写敏感，可逐条件显式忽略 | [匹配方式与大小写](rules.md#matcher-semantics) |
| 匹配求值状态 | 条件及规则使用匹配／不匹配／无法判断；结构缺失不能当作不匹配，同一规则按“或”传播，不新增权限裁决名称 | [解析状态与无法判断](rules.md#matching-uncertainty) |
| 解析与分析状态 | 结构解析、每个词的静态取值、效果事实提取分别记录，可以同时存在不同程度的缺口；事实 partial 不全局取消文本规则 allow 资格 | [解析状态与无法判断](rules.md#matching-uncertainty) |
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
| 会话启用状态 | 后端记录当前会话是否由 arbiter 接管新调用；权限选择器负责用户切入／切出，不能仅根据原生 auto 或 workspace-write 推断，不依赖审计 SQLite | [权限选择器](architecture.md#permission-selector-contract) |
| 执行边界 | 插件配置页选择的 trusted / guarded；决定 arbiter 放行后是否保留工作区文件沙箱，与会话启用状态、审批模式分开 | [双模式](rules.md#design-4-5) |
| Arbiter 自动审查入口 | 自有权限菜单中的单一入口，通过后端会话状态启用配置中的 trusted／guarded；不同于宿主原生 auto 预设 | [权限选择器](architecture.md#permission-selector-contract) |
| 原生 auto 入口 | DSH 固定捆绑 full-access 的原生命令／预设；用户已确认在 arbiter 提供审批能力的配置作用域内拒绝 `/permission auto`，失败保持原有状态，不新增审批链阶段 | [原生入口拒绝](architecture.md#native-auto-rejection) |
| ask 工具 | 宿主向用户提问的工具，可用于补充授权或澄清需求；其答复作为审查证据，不等于 force-ask 所要求的实际人工审批 | [ask 独立性](approval-modes.md#ask-independence) |
| 审查指引 | 供模型理解风险与授权的自然语言文本；CUSTOM_RULES／启用的 PROJECT_RULES 可以表达事实、限制、偏好和持续授权，用户负责内容。规则 hint 仍是审查关注点。指引通过模型信号影响判定，不直接改写命令规则优先级、代码判定规则或阈值 | [审查输入](review-context.md#design-5-2-3-1) |
| 授权来源优先级 | 适用内容冲突时，本会话人类原话 > 直接父会话人类原话 > PROJECT_RULES > CUSTOM_RULES > agent 转述；同层相关冲突以较新适用指令为准。优先级不删除其他上下文，也不等于来源所能支持的授权强度 | [来源契约](review-context.md#authorization-source-priority) |
| 执行 agent 行为指引 | 告诉执行任务的模型如何理解拒绝、寻找可行方案、报告受阻与补充授权；不是发给 reviewer 的审查指引，也不直接改变权限结果 | [子任务恢复流程](architecture.md#subagent-recovery) |
| 审查快照（ReviewSnapshot） | 经选择和预算裁剪后、用于构造一次模型审查请求的不可变结构化输入；保留来源与缺失信息，供 prompt 渲染、审计和详情展示复用 | [结构化记录与快照](configuration-and-audit.md#audit-record-model) |
| 模型调用记录 | 一次实际 reviewer 请求的输入引用、返回或错误及运行元数据；同次审查的修复重试产生独立记录，不只保留最后一次返回 | [结构化记录与快照](configuration-and-audit.md#audit-record-model) |
| 配置／模板快照 | 不可变的历史内容，通过内容标识去重，供调用与判定事件引用；不能只存版本名称而不保留对应内容 | [结构化记录与快照](configuration-and-audit.md#audit-record-model) |
| 配置生效记录 | 记录某份配置何时、通过哪个入口在什么范围成功生效；同一内容快照可以对应多次生效，包括恢复旧配置 | [配置保存与版本历史](configuration-and-audit.md#config-history) |
| 文件修订 | 用于发现外部修改、拒绝过期保存的并发保护标识；与配置内容身份、实际生效次数分开 | [配置保存与版本历史](configuration-and-audit.md#config-history) |
| 运行状态 | 支撑当前和后续判定的配置、在途请求、人工审批状态及先前裁决等；正常运行在内存维护，裁决历史可分层尽力恢复，不能据此承诺恢复所有在途执行状态 | [运行状态与审计解耦](configuration-and-audit.md#runtime-audit-separation) |
| 会话裁决记录 | 本插件用 `plugin:arbiter/decision` 类型写入 DSH 会话的自足裁决摘要；用于会话内展示和优先冷恢复，写入失败不改变当前权限结果，宿主持久化保证待验证 | [分层恢复](configuration-and-audit.md#decision-history-recovery) |
| 审计记录 | 用于插件内事后解释、SQL 查询、统计与离线分析的历史记录；写入成功不是执行前置条件，可同时为先前裁决提供兜底恢复材料；首版不要求专门导出功能 | [运行状态与审计解耦](configuration-and-audit.md#runtime-audit-separation) |

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
| trusted 模式 | 插件配置的执行边界：`danger-full-access + ask`，准入放行后无工作区文件沙箱约束；不代表跳过 arbiter 规则与审查 |
| guarded 模式 | 插件配置的执行边界：`workspace-write + ask`，arbiter 仍启用，准入放行后仍受文件沙箱约束；不同于未启用 arbiter 的普通工作区权限模式 |
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
