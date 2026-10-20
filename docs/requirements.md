# 产品需求与边界

回答产品要解决什么问题、现有目标与边界是什么。Codex 工作流是历史灵感；当前目标已明确为完备的独立 DSH 产品。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [需求](#design-1)
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
- 规则命中完全免审（含沙箱豁免），未命中交给审查模型；
- 审查模型可替换为专用决策模型（Cloudflare Clef / TypeSafe Jev）；
- 规则、阈值、凭据可在 Web 插件页配置；
- 与官方 auto review 相同的 UI 入口与使用体验。

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

- 菜单标签固定为「自动审查 (EXP)」，文案不准确；
- `auto` 不能设为新会话默认值（每次新会话需手动选）；
- trusted/guarded 切换依赖插件自有命令，UI 预设菜单里只有一个条目；
- 主会话与子任务审批模式在插件设置页展示；宿主其他界面的状态指示能力仍需验证；
- 规则的 `force-review` 强制进入审查；可选 `hint` 只提供关注点，不能控制 reviewer 的具体判定；
- guard 模式下规则命中的外部写入仍会被拒（原生行为），需人工升权；
- 子 agent 按初稿宿主约束没有人工审批通道；审查策略由插件设置页统一选择 strict / progress，人工需求或审查故障经完整阶段链 fallback-deny；
- chat 后端无概率分布，第 ⑤ 层概率门不适用，只能用 `τ_allow_level` 替代；该阈值**未经校准**，从最保守锚点起步，靠日志逐步放宽；
- chat 后端的第 ② 层第三条（`P(critical)`）无法评估，因此 critical 只靠 `riskPoint ≥ 9` 兜；
- chat 后端有**边界锚定**风险（模型可能把不确定案例压到阈值以下），靠探针矛盾检测与直方图监控缓解，不能根除；
- Clef 的 `score` 类型 criteria 必须写满 11 项，中间级缺描述会导致评分塌向两端；
- progress 的额外代批受风险上限、明确授权与相应概率条件约束，具体参数和可编辑范围见[阈值建议](approval-modes.md#thresholds)；
- 事实段的 `completeness` 判定依赖 AST 对"解释器调用/未知二进制"的识别，识别不全时会错误地标为 `complete`（这是本设计最脆弱的判定点之一，应在实现时对常见解释器列白名单而非黑名单）；
- `probeMode: override` 下探针只置真实不置假，因此"没触发"不代表"安全"；
- RE2 不支持 lookahead/lookbehind，否定式匹配必须用"规则顺序 + deny 优先"表达；习惯 PCRE 写法的规则会在加载时报语法错误（这是有意的）；
- 子 agent 内无法弹出审批（原生 `never` 硬编码），也无法调用 ask 工具（`DELEGATED_CALLER`）；授权须由父 agent 获取后转述，或由人类直接进子会话；
- 父会话的人类消息可能因 compaction 变成摘要，导致 `parent-human` 证据失真；父不在 live 时该来源不可得（[授权证据](review-context.md#design-5-2-3-2)）；
- 子 agent 的模型可见上下文预置了"需要审批的操作会被自动拒绝"，这可能让模型连尝试都不尝试，插件无法覆盖该文案。

---
