# 设计导航与旧节号索引

原单文件设计已按阅读目的拆分。当前产品入口为 [README](README.md)，需求见[产品需求与边界](docs/requirements.md)。

本文件只维护导航和旧节号映射，不再维护第二份设计正文。旧讨论中的 `design.md §…` 可通过下表找到当前位置；专题标题不再依赖原稿的全局章节顺序。

## 专题文档

| 文档 | 负责的内容 |
|---|---|
| [产品术语](docs/terminology.md) | 命令规则、审查策略、判定规则、判定阈值、审查与兜底阶段的统一定义 |
| [审批模式与审查策略](docs/approval-modes.md) | 三档规则／阈值对照、主／子任务设置、配置生效、故障与完整判定链 |
| [产品需求](docs/requirements.md) | 产品定位、初版目标、非目标与已知边界 |
| [总体架构](docs/architecture.md) | 命名、包结构、执行链、子 agent、审批模式接入、权限预设 |
| [规则引擎](docs/rules.md) | AST、规则匹配、优先级、执行模式、规则沉淀 |
| [审查上下文](docs/review-context.md) | 事实、授权证据、历史、变量展开、token 预算 |
| [审查后端与判定](docs/reviewer.md) | 后端协议、prompt、IR、判定、reason、运行时控制 |
| [配置与审计](docs/configuration-and-audit.md) | 配置 UI、凭据、规则测试、日志、离线调优 |
| [交接与项目索引](docs/handover.md) | 现有实现的代码地图、调用链路、测试分层、常见改动步骤、已知缺口与调试入口 |
| [实施与验证](docs/implementation.md) | 原 P0–P11 路线与待验证项 |
| [旧测试数据重置工具](docs/test-data-reset.md) | 限定范围的旧审计数据重置：默认 dry-run、拒绝条件、报告与执行记录 |
| [权限 UI 验证任务](docs/permission-ui-validation.md) | 同位置控件覆盖、原生命令同步、重连及停用／卸载恢复四组验证与结果回填 |
| [冷恢复修复与生命周期补测](docs/permission-recovery-followup.md) | 已授权的正式写入修复、原生 auto 拒绝、真实管理器、新调用、人工答复与 PTC 取消补测 |
| [决策与问题](docs/decisions-and-questions.md) | 历史取舍、O1–O10 状态、已确认结论与待讨论建议 |
| [调研证据](evidence.md) | 来源清单、个人工作流灵感、生态对比和价格快照 |

## 旧节号映射

保留到所有编号小节的映射；未编号的小标题随其父节移动。正文中的大部分节号引用已转换为跨文件链接，代码示例中的文字引用通过此索引解析。

| 原节号 | 原标题 | 当前正文 |
|---|---|---|
| §1 | 需求 | [产品需求与边界](docs/requirements.md#design-1) |
| §1.1 | 来源：Codex 侧的现有配置 | [调研证据](evidence.md#design-1-1) |
| §1.2 | 迁移目的 | [产品需求与边界](docs/requirements.md#design-1-2) |
| §1.3 | 核心痛点 | [产品需求与边界](docs/requirements.md#design-1-3) |
| §1.4 | 目标 | [产品需求与边界](docs/requirements.md#design-1-4) |
| §1.5 | 非目标 | [产品需求与边界](docs/requirements.md#design-1-5) |
| §2 | 调研结论摘要 | [调研证据](evidence.md#design-2) |
| §2.1 | 与竞品的关系 | [调研证据](evidence.md#design-2-1) |
| §2.2 | 与 `dsh-perm-gate` 的详细对比 | [调研证据](evidence.md#design-2-2) |
| §3 | 总体设计 | [总体架构与运行模式](docs/architecture.md#design-3) |
| §3.1 | 一个插件，两层门禁 | [总体架构与运行模式](docs/architecture.md#design-3-1) |
| §3.2 | 包结构 | [总体架构与运行模式](docs/architecture.md#design-3-2) |
| §3.3 | 数据流（trusted 模式，规则命中） | [总体架构与运行模式](docs/architecture.md#design-3-3) |
| §4 | 规则引擎 | [规则引擎与规则沉淀](docs/rules.md#design-4) |
| §4.1 | 解析 | [规则引擎与规则沉淀](docs/rules.md#design-4-1) |
| §4.2 | 匹配方言 | [规则引擎与规则沉淀](docs/rules.md#design-4-2) |
| §4.2.1 | regex 用 `re2js`，不自建安全子集 | [规则引擎与规则沉淀](docs/rules.md#design-4-2-1) |
| §4.2.2 | 完整匹配、glob 与大小写 | [规则引擎与规则沉淀](docs/rules.md#design-4-2-2) |
| §4.2.3 | 被否决的替代方案 | [规则引擎与规则沉淀](docs/rules.md#design-4-2-3) |
| §4.3 | 规则 Schema | [规则引擎与规则沉淀](docs/rules.md#design-4-3) |
| §4.4 | 五层裁决与优先级 | [规则引擎与规则沉淀](docs/rules.md#design-4-4) |
| §4.5 | 双模式 | [规则引擎与规则沉淀](docs/rules.md#design-4-5) |
| §4.6 | fail-closed 清单 | [规则引擎与规则沉淀](docs/rules.md#design-4-6) |
| §4.7 | PTC（`run_code`）与内层调用 | [规则引擎与规则沉淀](docs/rules.md#design-4-7) |
| §5 | Reviewer | [审查后端与判定引擎](docs/reviewer.md#design-5) |
| §5.1 | 为什么换模型 | [审查后端与判定引擎](docs/reviewer.md#design-5-1) |
| §5.2 | Reviewer 配置：二选一，不做自动回退 | [审查后端与判定引擎](docs/reviewer.md#design-5-2) |
| §5.2.1 | 审查者形态：只做无状态单次调用 | [审查后端与判定引擎](docs/reviewer.md#design-5-2-1) |
| §5.2.2 | 结构化事实的完整性闸门 | [审查上下文与证据](docs/review-context.md#design-5-2-2) |
| §5.2.3 | 审查输入的三段上下文 | [审查上下文与证据](docs/review-context.md#design-5-2-3) |
| §5.2.3.1 | 用户规则的两个来源 | [审查上下文与证据](docs/review-context.md#design-5-2-3-1) |
| §5.2.3.2 | `EVIDENCE` 的结构 | [审查上下文与证据](docs/review-context.md#design-5-2-3-2) |
| §5.2.3.3 | `CONTEXT` 的结构 | [审查上下文与证据](docs/review-context.md#design-5-2-3-3) |
| §5.2.4 | 先前裁决（prior verdicts） | [审查上下文与证据](docs/review-context.md#design-5-2-4) |
| §5.2.5 | 变量展开与 `cd` 追踪 | [审查上下文与证据](docs/review-context.md#design-5-2-5) |
| §5.2.6 | Token 预算与估算 | [审查上下文与证据](docs/review-context.md#design-5-2-6) |
| §5.3 | Decision model 后端（Clef / Jev） | [审查后端与判定引擎](docs/reviewer.md#design-5-3) |
| §5.4 | Chat 后端与重试 | [审查后端与判定引擎](docs/reviewer.md#design-5-4) |
| §5.4.1 | 输出契约：policy-aware 信号 | [审查后端与判定引擎](docs/reviewer.md#design-5-4-1) |
| §5.4.2 | Prompt 结构 | [审查后端与判定引擎](docs/reviewer.md#design-5-4-2) |
| §5.4.3 | 校验与重试分级 | [审查后端与判定引擎](docs/reviewer.md#design-5-4-3) |
| §5.5 | 统一中间表示 | [审查后端与判定引擎](docs/reviewer.md#design-5-5) |
| §5.6 | 判定引擎 | [审查后端与判定引擎](docs/reviewer.md#design-5-6) |
| §5.6.1 | 子 agent（智能体团队）场景 | [总体架构与运行模式](docs/architecture.md#design-5-6-1) |
| §5.6.2 | `bulk` 探针：风险放大条件，不是独立闸门 | [审查后端与判定引擎](docs/reviewer.md#design-5-6-2) |
| §5.7 | 拒绝理由（reason） | [审查后端与判定引擎](docs/reviewer.md#design-5-7) |
| §5.8 | 日志与离线调优 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-5-8) |
| §5.9 | 成本与额度 | [调研证据](evidence.md#design-5-9) |
| §5.10 | 授权延续与学习 | [规则引擎与规则沉淀](docs/rules.md#design-5-10) |
| §5.11 | 超时、熔断与去重 | [审查后端与判定引擎](docs/reviewer.md#design-5-11) |
| §6 | 勿扰模式 | [总体架构与运行模式](docs/architecture.md#design-6) |
| §6.1 | 为什么不用原生 `never` | [总体架构与运行模式](docs/architecture.md#design-6-1) |
| §6.2 | 实现 | [总体架构与运行模式](docs/architecture.md#design-6-2) |
| §6.3 | 勿扰态度（attitude） | [总体架构与运行模式](docs/architecture.md#design-6-3) |
| §6.4 | 与原生 `never` 并存的判断 | [总体架构与运行模式](docs/architecture.md#design-6-4) |
| §7 | 预设与 UI 接入 | [总体架构与运行模式](docs/architecture.md#design-7) |
| §7.1 | registerAuto | [总体架构与运行模式](docs/architecture.md#design-7-1) |
| §7.2 | guarded 模式入口 | [总体架构与运行模式](docs/architecture.md#design-7-2) |
| §7.3 | 可见性 | [总体架构与运行模式](docs/architecture.md#design-7-3) |
| §8 | 配置与凭据 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-8) |
| §8.1 | 配置页 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-8-1) |
| §8.2 | 机密 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-8-2) |
| §8.3 | 规则测试 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-8-3) |
| §9 | 审计 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9) |
| §9.1 | 两个写入点 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9-1) |
| §9.2 | 记录内容 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9-2) |
| §9.2.1 | 记录会被读回用于审查 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9-2-1) |
| §9.3 | 不做 outcome 回填 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9-3) |
| §9.4 | 能得出什么、不能得出什么 | [配置、规则测试与审计](docs/configuration-and-audit.md#design-9-4) |
| §10 | 关键取舍 | [决策记录与待讨论问题](docs/decisions-and-questions.md#design-10) |
| §11 | 风险与限制 | [产品需求与边界](docs/requirements.md#design-11) |
| §11.1 | 安全边界（必须明确） | [产品需求与边界](docs/requirements.md#design-11-1) |
| §11.2 | 已知限制清单 | [产品需求与边界](docs/requirements.md#design-11-2) |
| §12 | 实施阶段 | [实施路线与验证清单](docs/implementation.md#design-12) |
| §13 | 未来：upstream 多根工作区 | [总体架构与运行模式](docs/architecture.md#design-13) |
| §14 | 待验证项 | [实施路线与验证清单](docs/implementation.md#design-14) |
| §15 | 决策记录 | [决策记录与待讨论问题](docs/decisions-and-questions.md#design-15) |
| §16 | 开放问题 | [决策记录与待讨论问题](docs/decisions-and-questions.md#design-16) |

| 附录 | 术语 | [产品术语](docs/terminology.md)（[原位置入口](docs/architecture.md#glossary)保留） |

## 整理范围

首次整理移动并重新链接原稿内容，明确独立产品定位，纠正问题状态摘要，并把产品意见单独登记。后续讨论中已确认的规则名称、默认审查入口和离线规则审核流程已同步到专题正文，见[当前规则契约](docs/decisions-and-questions.md#confirmed-rule-contract)；其余语义冲突仍保留待讨论状态。

[原始快照](docs/archive/) 保存整理前的 README.md、design.md 和 evidence.md，内容未改动。
