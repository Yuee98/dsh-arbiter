# 产品需求与边界

回答产品要解决什么问题、现有目标与边界是什么。Codex 工作流是历史灵感；当前目标已明确为完备的独立 DSH 产品。

状态（2026-10-21）：首轮完整功能版本已实现并可在隔离 DSH 0.2.1-rc.2 profile 中试用；产品语义未定项仍按本文与[决策记录](decisions-and-questions.md)保留讨论状态。实现证据、初版选择与剩余缺口见[首轮实施报告](implementation-report.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [需求](#design-1)
- [首版范围与后续功能](#first-release-scope)
- [风险与限制](#design-11)

---

<a id="design-1"></a>

## 需求

<a id="design-1-2"></a>

### 产品定位

构建一个完备的独立 DSH 插件产品，统一提供 permission rules 与 auto review。Codex 侧的个人工作流只记录为历史灵感，不再以迁移该工作流或复刻其语义作为产品定义与验收依据。

这项定位来自用户在本轮讨论中的明确修正。初版来源案例见 [历史灵感](../evidence.md#design-1-1)；后续提出的目标用户、交互、评测和分发建议仍处于讨论阶段，见 [产品讨论登记](decisions-and-questions.md#product-discussion)。

<a id="design-1-3"></a>

### 核心痛点

1. **无命令级白名单**：DSH 每次工具调用都要走审查或人工审批，无法表达"信任整个 `gpt-relay` CLI"这类确定性规则；
2. **审查模型不可选**：官方 auto review 强制使用当前对话模型，成本高、延迟大、无法独立调优；
3. **规则不可沉淀**：审批结论无法转化为持久规则，重复审批同一类命令；
4. **无多根工作区**：见 [上游多根工作区](architecture.md#design-13)，属 upstream 议题，本设计不解决。

<a id="design-1-4"></a>

### 目标

- 单一插件提供「确定性规则 + 模型审查」两级门禁；
- 规则 allow 完整命中时免模型审查，未能裁定时交给审查模型；guarded 下仍受工作区文件沙箱约束，allow 不自动批准沙箱提权；
- 审查模型可替换为专用决策模型（Cloudflare Clef / TypeSafe Jev）；
- 规则、阈值、凭据可在 Web 插件页配置；
- [Reviewer 配置](configuration-and-audit.md#reviewer-configuration)中 decision 手填接口、模型与凭据引用，chat 用一个 select 选择 DSH 具体模型或跟随会话。[测试 Reviewer](configuration-and-audit.md#reviewer-test-ui)用草稿及固定合成样例直接请求模型，结果只在一次性弹窗展示；跟随会话时禁用测试，测试与保存独立，首次默认 chat + 跟随会话模型。
- 在原权限控件位置提供 arbiter 选择器，保留宿主其他权限选项，以单一自动审查入口启用／停用当前会话；
- trusted / guarded 执行边界在插件配置页选择，与会话启用状态及三档审批模式分开；切换、恢复与卸载见[权限选择器契约](architecture.md#permission-selector-contract)。
- arbiter 提供审批能力的配置作用域内拒绝原生 `/permission auto`，失败不改变当前权限或启用状态；自动审查使用自有菜单入口，见[入口拒绝契约](architecture.md#native-auto-rejection)。
- 审批拒绝在宿主工具调用位置展示带 Arbiter 来源的橙色标记、简短原因与详情入口；仅结束当前调用，由 agent 判断如何继续或向用户说明受阻。工具执行失败仍由宿主展示，见[拒绝提示与会话继续](architecture.md#approval-rejection-feedback)。
- 会话和日志共用同一个[调用详情](configuration-and-audit.md#call-detail)界面，按“概览／判定依据／原始材料”分层；会话入口直接定位对应记录，审计材料缺失时按可用的内存／会话裁决信息展示并说明缺失。
- [日志列表](configuration-and-audit.md#log-list)提供分页，默认仅显示时间、工具与单行操作摘要、最终裁决，点击查看详情；支持搜索和筛选，查看历史页时保持阅读位置，不因新记录到来自动跳页。
- [规则管理](configuration-and-audit.md#rule-management)使用精简列表与行内展开编辑，共用头部开关和行为下拉；多个匹配条件使用“或”，工具参数使用 JSONPath（RFC 9535）取值，条件内支持“任一／全部”、默认任一，两者在未选中值时均不匹配。路径按普通参数处理，不依赖命令级路径识别；修改统一进入草稿并保存应用。
- [规则显示名称](configuration-and-audit.md#rule-naming)默认采用自动摘要，可自定义并恢复自动生成；名称允许重复，与稳定 ID 分开，历史按当时名称及规则快照展示。[保存校验](configuration-and-audit.md#rule-validation)区分阻断错误与非阻断告警／环境提示，不增加二次确认或强制测试。
- [命令匹配](rules.md#command-matching)按 AST 拆分独立命令，统一可静态确定的字面量及词间空格，保留参数边界、动态表达式和无法可靠转换的原文；原始书写可通过工具参数条件匹配。优先复用现成解码，`unbash` 为优先候选，接入由实现侧验证。
- [匹配方式](rules.md#matcher-semantics)统一检查整个选中值，默认大小写敏感，可逐条件忽略；取消 RE2 的强制 `^`，glob 使用固定的 `/` 分段语义并包含点号内容。[结构解析、词取值和事实提取](rules.md#matching-uncertainty)独立记录，条件区分匹配／不匹配／无法判断；高优先级相关规则未知或覆盖不足时 allow 不短路，词值或事实未知本身不全局禁止放行。
- [规则测试区](configuration-and-audit.md#rule-test-ui)默认折叠，支持命令、参数 JSON 和调用记录带入；使用整份当前草稿，分别解释本规则是否匹配与最终规则路径，详细取值和遮蔽原因按需展开。测试不执行工具或调用 reviewer，输入或规则改变后标记旧结果需要重测。

<a id="first-release-scope"></a>

### 首版范围与后续功能（2026-10-23 已确认）

首版聚焦核心审批流程、会话启停与执行边界、规则管理及测试、配置保存与生效、结构化日志及调用详情、恢复与保留清理。先在真实使用中积累调用与审批记录，再据实际样本设计规则建议。

**初始默认值（2026-10-24 已确认）**：Reviewer 使用 chat + 跟随会话模型，执行边界 guarded，主会话 normal、子任务 strict，命令规则为空。安装不自动接管会话；首版不附带预设规则，实际使用一段时间后再评估是否加入预设。完整约定见[首版初始默认值](configuration-and-audit.md#initial-defaults)。

**UI 国际化（2026-10-25 已确认）**：新版 UI 实现时同步将插件自有中文文案抽取到 locale 资源，并接通宿主 i18n；英文翻译留到首版发布前统一补齐。各 UI 功能验收时就验证翻译调用及中文回退，发布验收再检查英文覆盖、语言切换与布局。issues 和设计文档现阶段继续使用中文。具体范围见[UI 文案与国际化](configuration-and-audit.md#ui-i18n)。

**离线规则建议移到后续版本，暂缓细化设计。** 候选生成、候选的批量回放验证、专用审核流程及其入口均不纳入首版开发与验收。已有原型和早期方案保留为参考，不以“已有实现”决定首版范围；生成方式、泛化约束、验证机制、模型配置、触发方式与具体 journey 待恢复讨论时确定。

日志继续按[已确认的保存范围](configuration-and-audit.md#audit-capture)记录，沿用默认 30 天／1 GiB 及高级保留设置，不为未来建议功能增加额外采集、专用数据模型或无限保留要求。手工规则管理与规则测试属于首版。实时审批只处理当前操作；未来离线候选仍须由用户确认具体范围后才能成为普通规则，不能自动改变生效配置。

<a id="design-1-5"></a>

### 非目标

- 不修改 DSH 核心包（不改 `writableRoots`、不 fork 沙箱）；
- 不实现多根工作区（另提 upstream issue，见 [上游多根工作区](architecture.md#design-13)）；
- 不实现跨会话持久化 grant（保持会话级语义）。

---

<a id="design-11"></a>

## 风险与限制

<a id="design-11-1"></a>

### 安全边界（必须明确）

1. **trusted 模式下沙箱不存在**，规则与审查是唯一防线。规则写宽 = 全开；
2. **解析器是启发式**：`bash script.sh` 内部写什么文件、`$VAR` 展开后是什么，AST 看不到。定位与 Codex `prefix_rule` 一致——防误放行、提确定性，**不防恶意构造**；
3. **规则表是安全的单点**：规则文本质量 = 授权边界，需像 `extra-policy.md` 一样认真写注释与范围；
4. **reviewer 可能误判**：官方亦如此（"可能误放行不安全动作"）；概率门 + ask 桶兜底是缓解，非保证；
5. **PTC 直接 Node 效果没有逐工具门禁**：外层 `run_code` 可拦截，但直接文件、网络与子进程 API 不会产生独立的内层工具审查。如果跳过外层并使用 trusted，这些效果不受插件审查或 DSH 文件沙箱约束；guarded 只补充文件写入边界，不能补足读取与联网审查。见 [PTC（run_code）与内层调用](rules.md#design-4-7)及[完整覆盖范围](architecture.md#execution-coverage)；
6. **审查者的信息源限于快照**：决策模型不做主动探索，因此"审查者没发现问题"只等于"快照里没有证据"，不等于"动作安全"。变量展开只做有限静态解析（[变量展开与目录追踪](review-context.md#design-5-2-5)），未解析变量一律使该调用失去自动 allow 资格；
7. **凭证外发的旧规则存在冲突**：旧稿仅在 `secrets ∧ egress ∧ auth = none` 时拒绝，但 secrets 的定义已排除正常认证；新[矩阵 R1](approval-modes.md#rule-matrix)建议去掉授权条件，明确凭证材料外发的处理。该规则待确认，旧方案的模型漏判风险不能被视为已经解决；
8. **`chat` 类型没有概率分布**，第 ⑤ 层概率门失效，只能用 `τ_allow_level` 替代；`chat.provider: "session"` 同样如此。四种探针仍在，不变式 1–2 仍生效；
9. **progress 扩大审查代批范围**：代码按审查策略判定，但仍依赖模型信号质量。promoted 占比只能作为诊断信息，不能单独证明安全或滥用；具体范围见[策略矩阵](approval-modes.md#rule-matrix)。

<a id="design-11-2"></a>

### 已知限制清单

- 宿主原生 auto 固定为 `danger-full-access + ask`，不能通过 registerAuto 配成 guarded；本产品采用自有权限选择器及后端会话状态，基础覆盖与同值切出已有[运行证据](permission-ui-validation.md)，正式入口拒绝及真实生命周期仍待[本轮修复／补测](permission-recovery-followup.md)；
- 原生 `auto` 不能设为新会话默认值；新会话不会因插件已安装或配置了 guarded 而自动启用 arbiter；
- trusted / guarded 放在插件配置页，原 `/arbiter mode` 命令属于首轮实现入口，不作为当前产品契约；
- 主会话与子任务审批模式在插件设置页展示；宿主其他界面的状态指示能力仍需验证；
- 规则的 `force-review` 强制进入审查；可选 `hint` 只提供关注点，不能控制 reviewer 的具体判定；
- guarded 下规则或审查放行后，超出沙箱允许范围的写入仍可能失败；agent 须按宿主机制显式申请单次提权；
- 子 agent 按初稿宿主约束没有人工审批通道；审查策略由插件设置页统一选择 strict / progress，人工需求或审查故障经完整阶段链 fallback-deny；
- chat 后端无概率分布，第 ⑤ 层概率门不适用，只能用 `τ_allow_level` 替代；该阈值**未经校准**，从最保守锚点起步，靠日志逐步放宽；
- chat 后端的第 ② 层第三条（`P(critical)`）无法评估，因此 critical 只靠 `riskPoint ≥ 9` 兜；
- chat 后端有**边界锚定**风险（模型可能把不确定案例压到阈值以下），靠探针矛盾检测与直方图监控缓解，不能根除；
- Clef 的 `score` 类型 criteria 必须写满 11 项，中间级缺描述会导致评分塌向两端；
- progress 的额外代批受风险上限、明确授权与相应概率条件约束，具体参数和可编辑范围见[阈值建议](approval-modes.md#thresholds)；
- 事实提取的缺口识别依赖对脚本／解释器／未知二进制的保守处理，不能从外层 AST 宣称已知所有副作用；事实状态不得混同结构完整性或成为文本规则的全局否决开关，见[独立状态契约](rules.md#matching-uncertainty)；
- `probeMode: override` 下探针只置真实不置假，因此"没触发"不代表"安全"；
- RE2 不支持 lookahead/lookbehind，否定式匹配必须用"规则顺序 + deny 优先"表达；习惯 PCRE 写法的规则会在加载时报语法错误（这是有意的）；
- 子 agent 内无法弹出审批（原生 `never` 硬编码），也无法调用 ask 工具（`DELEGATED_CALLER`）；授权须由父 agent 获取后转述，或由人类直接进子会话；
- 父会话的人类消息可能因 compaction 变成摘要，导致 `parent-human` 证据失真；父不在 live 时该来源不可得（[授权证据](review-context.md#design-5-2-3-2)）；
- 子 agent 的模型可见上下文预置了"需要审批的操作会被自动拒绝"，这可能让模型连尝试都不尝试，插件无法覆盖该文案。

---
