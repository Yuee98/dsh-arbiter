# 配置、规则测试与审计

描述配置 UI 与文件、凭据、规则测试、审计记录和离线调优。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [日志与离线调优](#design-5-8)
- [配置与凭据](#design-8)
- [审计](#design-9)

---

<a id="design-5-8"></a>

## 日志与离线调优

每次审查记录完整信号（不进模型上下文，仅落日志与审计）。两套后端记录的形状不同：

```jsonc
// Clef
{ "ts": "...", "callId": "...", "tool": "bash", "rule": "gh-pr-readonly | null",
  "source": "clef", "repairs": 0,
  "riskDist": { "5": 0.05, "6": 0.80, "7": 0.08, "8": 0.04, "9": 0.02, "10": 0.01 },
  "riskScore": 6.13, "riskClass": "medium",
  "authDist": { "7": 0.05, "8": 0.55, "9": 0.28, "10": 0.12 },
  "authClass": "explicit",
  "secrets": 0.02, "destructive": 0.01, "egress": 0.97,
  "driver": "derivation_row", "verdict": "allow",
  "tau": { "gate": 0.8, "auth": 0.8, "critical": 0.25 } }

// chat
{ "ts": "...", "callId": "...", "tool": "bash", "rule": null,
  "source": "chat", "repairs": 1,
  "riskDist": null, "riskPoint": 6, "riskClass": "medium",
  "authDist": null, "authPoint": 8, "authClass": "explicit",
  "secrets": false, "destructive": false, "egress": true,
  "driver": "derivation_row", "verdict": "ask",
  "tau": { "allow_level": 3, "gate": null, "critical": null } }
```

**离线回放的问题**：

- Clef：`τ_gate` 从 0.8 降到 0.7 会多放行 N 个，其中多少事后看不该放？
- chat：`τ_allow_level` 从 3 放宽到 4 会多放行 N 个，其中多少是误放？——**按级别统计误放率**是点值相对自报置信度的核心优势。

**校准流程（chat 后端）**：

```
1. 初始保守：τ_allow_level = 3
2. 积累日志：每次判定记录 riskPoint + 最终结果（用户批准/拒绝、事后是否出问题）
3. 定期核算：每个 riskPoint 上"被证明不该放行"的比例
4. 放宽阈值：若某个级别累计样本足够且误放率 < 容忍度，才提高 τ_allow_level
```

**后端质量指标**：

- 各后端首次合法率、重试后合法率、平均延迟；
- 各后端 `ask` 占比（过高说明阈值或后端能力不匹配）；
- 后端切换次数与原因分布；
- **`riskPoint` / `riskScore` 直方图**——异常堆积在 `τ_allow_level` 附近是边界锚定的直接证据（[Prompt 结构](reviewer.md#design-5-4-2)），需检查 prompt 表述；
- **矛盾检出率**（`risk ≤ 3` 却 `destructive`/`secrets`）——过高说明锚点定义或 prompt 有问题，应调整定义而非加大重试；
- **各 `driver` 分布**——`invariant` 占比高说明规则层有缺口（该进 allowlist 的没进）。

<a id="design-8"></a>

## 配置与凭据

<a id="design-8-1"></a>

### 配置页

插件页的 `plugins.bundle.config` 槽位（键 = 包名），`view: 'page'` 渲染带保存按钮的表单：

```tsx
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: 'dsh-arbiter',
  locale: 'arbiter',
}, ({ t, view }) => <RulesForm t={t} />))
```

需要包内声明 `dsh.client`（`platform: "web"` + inject）并导出 `./client`；浏览器半侧与包的 Loader 行同生共死。

持久化走 Settings 服务：`ctx.inject(['settings'], s => s.settings.configure({ auto: false }, ctx.fiber))`，保存写入 profile 的 Cordis patch（`config-editor` 负责校验与并发保护）。

**配置 UI 与配置文件必须功能完全一致**（单一真相源、schema 驱动、双向同步、冲突拒绝），具体实现方案与复杂度评估见 [O8](decisions-and-questions.md#question-o8)。

页面上编辑的东西：

| 分组 | 字段 | 校验 |
|---|---|---|
| 规则表 | id / comment / match{node,kind,pattern,agents} / verdict / hint | regex 可编译性（re2js）、`^` 锚定、glob 合法性、四值 verdict 枚举、allow 被 force-review 覆盖时警告 |
| Reviewer 类型 | `type`: `decision`（默认）\| `chat` | 枚举（二选一，不做自动回退） |
| decision 配置 | `url` / `model` / `apiKeyRef` / `timeoutMs` | URL 格式、凭据存在性 |
| chat 配置 | `provider`（含 `session` 特殊值）/ `model` / `temperature` / `maxTokens` / `timeoutMs` | provider 存在性、数值范围 |
| Reviewer 超时 | `reviewerTimeoutMs`（旧稿初值 8000ms，发布值待评测） | 正整数 |
| 熔断 | `breaker.mode`（preset/custom/off）、`preset`（strict/balanced/lenient）、自动审批下提前熔断选项（字段名待定） | 枚举、预设阈值约束；与审批模式的 strict 含义分开 |
| 审查预算 | `reviewBudget`（默认 null = 不限，仅提示不阻断） | 正整数或 null |
| 后端成本标记 | `costTier`（free/paid，用于成本估算显示） | 枚举 |
| 授权证据流 | `evidence.maxItems`（20）/ `evidence.parentHumanItems`（5）/ `evidence.parentEvidenceFloor`（1） | 正整数、floor ≤ parentHumanItems |
| 总输入预算 | `maxInputTokens`（10000） | 正整数 |
| 历史与裁决预算 | `history.maxItems`（40） | 正整数 |
| 用户自定义规则 | `customRules`（自由文本，2000 字符上限） | 长度 |
| 项目规则文件 | `projectRules.enabled`（true）/ `projectRules.files`（`.dsh/arbiter.md`, `.arbiter.md`） | 布尔、相对路径 |
| checkpoint 上限 | `context.checkpointMaxItems`（3） | 正整数 |
| tool call 参数上限 | `context.toolCallArgumentMaxChars`（200） | 正整数 |
| 探针预置 | `probeMode`：`assist`（默认）\| `override`（[判定引擎](reviewer.md#design-5-6) ① 层） | 枚举 |
| 判定阈值（decision） | 风险／授权概率门槛、风险上限、critical 门槛，按所选审查策略应用 | normal / strict 共用；与 chat 授权标准一致，数值待评测；高级编辑范围见下文建议 |
| 判定阈值（chat） | 风险点值上限、授权点值下限，按所选审查策略应用 | normal / strict 共用；数值待评测，不因后端不同改变所需授权类别 |
| 判定策略调整 | progress 对部分常规 review-escalate 条件的调整 | 具体条件留待评测；不在普通设置页逐条暴露 |
| chat 后端 | temperature（0）/ maxTokens（300）/ output（json\|tool） | 范围 |
| 执行模式 | trusted / guarded | 枚举；决定执行边界 |
| 审批模式 | 主会话 normal / strict / progress；所有子任务统一 strict / progress | 用户在本设置页选择；不提供单个子任务覆盖 |
| 凭据 | 显示"已设置/未设置/来源"，可写入 | 见 [机密](configuration-and-audit.md#design-8-2) |

**配置生效约定**：以校验并成功应用为生效点。已有结果继续推进，不因后端或输入协议变更丢弃、重审；旧响应按原请求协议解释。已弹出的人工审批保持等待，尚未作出的后续判定使用新配置；已经结算或开始执行的调用不追溯。保存失败或应用失败时不能显示“已生效”。不额外增加每次执行前检查模式的产品步骤，具体在途边界见[配置生效与在途请求](approval-modes.md#configuration-activation)。

主会话与子任务的审批模式在当前插件配置作用域内统一应用，不再使用子任务继承父模式或会话级 DND 覆盖。配置页显示当前生效值，建议初始值与具体字段名仍见[模式选择](approval-modes.md#mode-selection)。

<a id="advanced-policy-settings"></a>

#### 配置分层与高级设置（方案建议）

已定的日常入口是**三档审批模式 + 命令规则**。用户希望特定命令放行、禁止或每次审查时，优先编辑命令规则；无需先理解模型点值与概率。模式选择旁始终提供[tooltip](approval-modes.md#mode-selection)，说明插件人工审批与 agent 提问的区别。

建议另设折叠的“高级设置”入口，不用“开发者设置”暗示只有插件开发者才能调整。可按实现成熟度开放判定阈值、内置判定规则的有限参数或开关、超时和重试参数；具体字段与可调范围仍需评测，不承诺一开始支持任意代码或完整自定义策略语言。上方配置表是字段清单，不表示所有项目都进入普通设置页。

建议保持三档选择，调整策略后附“已自定义”标记，展示相对预设的变化并提供恢复默认、导出及已有案例回放入口。normal / strict 的常规策略共用一份配置，避免高级设置使两者重新分叉；progress 调整作为额外部分表达。自定义不改变命令规则优先级、force-ask 需要实际人工审批、故障不自动放行等产品契约。

上述分层是当前建议，需在界面设计时确定具体可编辑字段；不为本轮讨论新增复杂的策略编辑器实现要求。宿主 ask 的 legacy / timed 设置归宿主管理，不随插件审批模式自动切换。

<a id="offline-rule-review"></a>

#### 离线规则建议审核

规则管理中提供独立的离线建议审核界面，入口与当前操作的审批分开。实时审批只处理当前操作；离线分析只生成候选，不修改正式规则。

每个候选展示拟加入的规则内容、匹配范围、代表性日志与统计依据，以及相对现有配置的 diff 和规则冲突。用户可以修改、拒绝或确认添加；确认后通过正常配置校验，保存为普通规则，与手工创建的规则使用同一列表和编辑、测试、停用、删除流程。

候选的统计信息留在审核记录中，不进入运行时规则 Schema。可选的“离线建议 · 人工确认”提示仅说明来源，不改变执行行为。完整契约见 [离线规则建议与人工审核](rules.md#design-5-10)。

<a id="design-8-2"></a>

### 机密

**不把 API key 写进配置**。走 credentials seam：

```yaml
- id: arbiter
  name: dsh-arbiter
  config:
    reviewer:
      type: decision                         # decision | chat
      decision:
        url: https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/cloudflare/clef
        model: clef-flash
        apiKeyRef: CLOUDFLARE_API_TOKEN      # 引用名，不是值
        timeoutMs: 8000
```

配置页只显示凭据状态（存在性、来源、可否写入），**永不回显值**。写入走凭据存储 API。`chat` 类型复用已有 provider 的凭据，无需在本插件配置任何密钥；`decision` 类型需要自己的 `apiKeyRef`。

---

<a id="design-8-3"></a>

### 规则测试

配置规则时最需要的是**即时反馈**：这条命令会走哪条规则、为什么是它、我写的 `allow` 为什么没生效。五层裁决（[五层裁决与优先级](rules.md#design-4-4)）让这个判断不再直观，因此测试工具是必需品而非附加功能。

**UI 与 CLI 共用同一实现，输出一致。**

#### 纯函数约束

测试**只走到规则层 + AST 解析**，明确不做的事：

| 不做 | 原因 |
|---|---|
| 调用 reviewer | 有 token 成本与延迟，且测试期间模型不可用会失败 |
| 写审计记录 | 测试不是真实判定 |
| 执行命令 | 测试是静态分析 |
| 改会话状态 | 无副作用 |

测试输出规则层选择的路径：`deny` / `force-ask` / `force-review` / `allow` / `review(default)`。其中 `force-review` 与 `review(default)` 两种审查入口均表示“将交给 reviewer，本次未调用”，不是审查结论，也不表示必须询问人。`review(default)` 不属于配置的 verdict 枚举。

#### 输入形态

| 形态 | 示例 |
|---|---|
| 裸命令 | `gh pr checkout 42`（按 bash 处理） |
| 带工具名 | `bash: gh pr checkout 42`；`read: /etc/passwd` |
| JSON | `{"tool":"bash","args":{"command":"..."}}`（精确控制参数，调试用） |
| 多条 | **一行一条**（UI 用 textarea，CLI 不带参数时进入多行模式） |

**为什么用换行而不支持 `&&` 分隔**：命令本身可能含 `&&`，用分隔符会混淆。

#### 输出：汇总 + 展开

**汇总视图**（默认，多条时唯一可用形态）：

```
规则路径          命令                           命中规则           被遮蔽
───────────────   ─────────────────────────────   ────────────────   ─────────────────────
allow             gh pr view 42                  gh-pr-readonly
force-ask         gh pr checkout 42              gh-pr-checkout     gh-pr-readonly(allow)
force-review      gpt-relay send --to-prod       relay-prod         relay-trust(allow)
review(default)   git push origin main           (未命中)
review(default)   npm install                    (未命中)

5 条：1 allow / 1 force-ask / 1 force-review / 2 review(default)
```

- 路径使用完整名称，避免把强制审查误读为提示、把默认审查误读为人工审批；
- **遮蔽列只在有遮蔽的行显示**，无遮蔽时列宽收缩，输出保持紧凑；
- 未命中显示 `(未命中)`，路径为 `review(default)`；部分节点命中 allow 时显示已命中规则与未覆盖节点，并说明为何整条调用仍进入默认审查。

**展开视图**（UI 点行 / CLI `--verbose`）——三块：

```jsonc
// ① 判定
{ "verdict": "force-ask", "rule": "gh-pr-checkout", "index": 3 }

// ② 匹配到的全部规则，按优先级排序
[
  { "index": 3, "id": "gh-pr-checkout", "verdict": "force-ask", "effective": true },
  { "index": 1, "id": "gh-pr-readonly", "verdict": "allow",      "effective": false }
]

// ③ 解析与事实
{
  "parse": { "status": "ok", "statements": 1, "nodes": ["command"] },
  "argv": ["gh", "pr", "checkout", "42"],
  "completeness": "complete",
  "probes_preset": []
}
```

**`effective: true` / `effective: false` 就是"被遮蔽"的机器表示**——这是回答"我写的 allow 为什么没生效"的唯一方式。

#### CLI 形态

```
$ /arbiter test
> gh pr view 42
> gh pr checkout 42
> git push origin main

allow             gh pr view 42          gh-pr-readonly
force-ask         gh pr checkout 42      gh-pr-checkout     ← 遮蔽 gh-pr-readonly(allow)
review(default)   git push origin main   (未命中)

3 条：1 allow / 1 force-ask / 1 review(default)
```

`/arbiter test <cmd>` 只测一条；不带参数进入多行输入。

#### 与 dry-run 的关系

两者不同：

| | 规则测试（[规则测试](configuration-and-audit.md#design-8-3)） | dry-run（`enforce: false`） |
|---|---|---|
| 对象 | 用户输入的命令 | 真实发生的工具调用 |
| 时机 | 配置规则时 | 运行时 |
| 是否执行 | 否（纯静态） | 是（照常执行，只记录"本该怎样"） |
| 输出 | 命中哪条规则 | 判定序列 + 实际下游结果 |

两者互补：dry-run 验证"真实流量会怎样"，测试验证"我写的这条规则对不对"。

---

<a id="design-9"></a>

## 审计

<a id="design-9-1"></a>

### 两个写入点

| 位置 | 内容 | 用途 |
|---|---|---|
| **插件自有 JSONL**（`$DSH_HOME/arbiter/decisions.jsonl`） | 完整判定记录（含 IR、探针、阈值、driver） | 离线回放、阈值调优、规则挖掘 |
| **会话日志**（`plugin:arbiter/*` 记录） | 精简结论（verdict + ruleId + driver + reason） | 会话内可审计、可随会话恢复 |

会话日志用 `dsh-session` 的 plugin record API：

```js
appendPluginRecord(session, "plugin:arbiter/decision", {...});
```

类型必须匹配 `PLUGIN_RECORD_TYPE` 语法（`^plugin:[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*$`），且记录自动带 `ignorable: true`——旧版本读器会安全忽略。

**会话日志是 append-only 且事件 deepFreeze**，所以不能修改已写记录，只能用 `callId` 关联后续记录。

<a id="design-9-2"></a>

### 记录内容

记录完整判定链，区分命令规则入口、审查、故障、人工、兜底与实际执行结果。`review-escalate` 和 `error-escalate` 可以得到相同的 fallback-deny，但前者是策略要求人工，后者是审查没有正常完成；不能合并成无来源的 deny。人工处理区分 human-allow / human-deny / human-abort，后者记录没有取得决定的结束原因。字段名仍为建议稿，阶段含义以[产品术语](terminology.md#decision-stages)为准。

```jsonc
// JSONL（字段形式为建议；本例采用审查规则矩阵中的生产变更人工处理方案）
{
  "ts": "...", "sessionId": "...", "callId": "...", "configRevision": "cfg-12",
  "tool": "bash", "command": "deploy --target prod",
  "sessionKind": "subagent", "approvalMode": "progress", "executionMode": "guarded",
  "trace": [
    { "stage": "rule", "result": "force-review", "ruleId": "deploy-review" },
    { "stage": "review", "result": "review-escalate", "decisionRules": ["R5"],
      "reason": "production_change_requires_human" },
    { "stage": "fallback", "result": "fallback-deny", "reason": "automatic_mode_no_human" }
  ],
  "result": "fallback-deny", "execution": "not-started"
}

// 会话记录可以精简信号，但保留完整阶段链及具体原因
{ "callId": "...", "tool": "bash", "configRevision": "cfg-12",
  "trace": ["force-review", "review-escalate", "fallback-deny"],
  "result": "fallback-deny", "reason": "automatic_mode_no_human" }

// 已弹出的审批被结束，但没有批准或拒绝答案；仍等待中的请求不写这个终态
{ "callId": "...", "tool": "bash", "configRevision": "cfg-12",
  "trace": ["force-review", "review-escalate", "human-abort"],
  "result": "human-abort", "reason": "approval_dismissed", "execution": "not-started" }
```

模型有效输出的原始信号、实际命中的判定规则与阈值同时保存在完整记录中；故障记录保存错误码、尝试次数与失败阶段，不补造风险分数。发生人工审批时保留原请求及其配置版本，即使等待期间设置已改变。

上例的单个 configRevision 适用于整条链没有跨版本的情况。配置在处理中改变时，分别记录模型请求使用的后端／协议／配置版本，以及各后续阶段实际使用的配置版本；不覆盖已写阶段，不假装旧响应由新后端产生。具体字段设计留给实现，语义遵循[配置生效](approval-modes.md#configuration-activation)。

#### 判定依据与授权证据的展示建议

以下为产品表达建议，尚未确认 UI 或字段方案。两者主要建立在结构化记录上，在单次调用详情中展开；不需要各自建立一套新的权限系统。

| 内容 | 回答的问题 | 建议记录与展示 |
|---|---|---|
| 判定依据 | 这次为什么放行、拒绝或转人工？ | 命令规则 id／版本、审查策略与命中的判定规则、相关信号与阈值、完整阶段链、人工结果或兜底原因；区分权限决定和宿主执行结果 |
| 授权证据 | 当时有哪些人类指令或审批记录支持这项操作？ | 实际提供给 reviewer 的输入片段及来源、session／message 标识、ask 的问题与答案、父会话原始人类消息与 agent 转述的区分，以及摘要／截断情况 |

授权证据首先是判定前的审查输入，记录保留的是当时输入的可追溯来源；后续新请求也可以读取仍适用的原始授权和先前裁决。因此它不只是事后日志，但历史记录本身不会自动创造或延续授权。没有进入审查的规则短路调用，也不能展示成“模型已检查授权”。

界面应区分“提供给审查的证据”和“系统／reviewer 明确报告引用的证据”。不能从最终允许结果反推模型一定使用了某条消息，也不要求保存或展示模型内部推理。证据保留方式、脱敏与展示字段待定；语义来源见[授权证据流](review-context.md#design-5-2-3-2)。

<a id="design-9-2-1"></a>

#### 记录会被读回用于审查

`plugin:arbiter/decision` 不只是审计产物——审查时会用 `pluginRecordOf(event)` 扫当前会话，把最近的受阻调用及其完整阶段链提取为[先前裁决](review-context.md#design-5-2-4)。fallback-deny 和 human-abort 不能被解释成人类反对或风险判定；error-escalate 不能被解释成有效的风险评估。

这意味着记录里的字段有双重职责：

| 字段 | 审计用途 | 审查用途 |
|---|---|---|
| 阶段链与原因 | 归因统计 | 区分规则拒绝、审查拒绝、人工拒绝、人工未决结束、审查故障和兜底受阻 |
| `fingerprint` | 去重 | 识别"同一动作重试" |
| `effect` | 事后分析 | 识别"换写法但同效果" |
| 规则与判定规则标识 | 规则使用率 | 指出实际命中的条件，不能仅凭最终 deny 推断 |

因此这些字段**不可省略**，且格式变更需要考虑向后兼容（旧记录缺 `effect` 时，`overlaps_denied_effect` 退化为 false）。

<a id="design-9-3"></a>

### 不做 outcome 回填

**决定：不在运行时回填"这次操作后来怎样"。**

可行性已核实——有三个信号源：

| 信号源 | 内容 | 可靠性 |
|---|---|---|
| `tools/result` 事件 | 工具结果的 `isError`，同步触发 | 高，但**只回答"工具成功了吗"，不回答"效果对不对"** |
| `session/event` 观察者 | 后续工具结果、用户消息、回滚事件 | 中，但"用户不满"是自由文本，判断需要额外语义分析 |
| `dsh-workspace-changes` | 文件改动追踪 | 只覆盖文件写，不覆盖 bash 的任意副作用（`rm` 不走 fs 服务） |

**不做的理由**：

1. **`toolOk` 信息量太低**——`rm -rf` 成功执行不代表放行正确；
2. 真正有价值的信号（用户显式撤销/回滚）**在会话日志里本来就有**，不需要运行时回填；
3. 运行时回填要维护 pending 表、会话结束清理、多进程一致性，成本高而收益已知不足。

**替代方案：纯离线分析读会话日志**：

```
session/query 读全部会话事件
  → 关联 tool/call 与 tool/result（按 callId）
  → 统计 allow 类判定的工具失败率
  → 交叉 §5.10 的候选生成
```

零运行时开销、崩溃安全、不需要插件维护状态。

<a id="design-9-4"></a>

### 能得出什么、不能得出什么

| 指标 | 可得性 |
|---|---|
| 各 verdict 的分布 | 直接统计 |
| allow 后工具失败的**下界** | 可得（`isError`） |
| **误放率**（放行了但其实不该放） | **不可得**——需要人工标注 |
| 阈值调整的模拟效果 | 可得（离线回放 IR） |

**[待验证项](implementation.md#design-14) 第 11 项的措辞据此修正**：运行时只能得"失败率下界"，真正的误放率需要人工复核样本。

---
