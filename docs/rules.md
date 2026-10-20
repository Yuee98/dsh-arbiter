# 规则引擎与规则沉淀

描述 AST 解析、匹配、规则优先级、trusted/guarded 下的语义、PTC 边界，以及离线规则建议与人工审核。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [规则引擎](#design-4)
- [离线规则建议与人工审核](#design-5-10)

---

<a id="design-4"></a>

## 规则引擎

本章“规则”均指**命令规则**；审查判定规则属于[审查策略](terminology.md#core-terms)，由判定引擎执行。

<a id="design-4-1"></a>

### 解析

**解析器**：tree-sitter-bash（与 Codex 同款语法，Codex 二进制内嵌 `tree-sitter-bash` + `shell-command/src/bash.rs`）。

- Node 侧用 `web-tree-sitter` + tree-sitter-bash WASM（纯 JS，无需构建脚本）；
- 备选：`sh-syntax`（mvdan/sh 的 JS 移植）；
- **待验证**：DSH 的 Node 运行时加载 WASM 的可行性与启动开销（见 [待验证项](implementation.md#design-14)）。

**为什么必须做 AST 而非字符串匹配**：

1. `cmd > file` 在 AST 中是 `redirected_statement` 包裹 `file_redirect`，不是裸 `command`——前缀匹配天然漏掉；
2. 拼接绕过（`echo x; gpt-relay ...`）在 AST 中是 `list` 节点，可结构化识别；
3. 重定向目标、变量赋值、子 shell、命令替换各有独立节点类型，可分别施加规则。

<a id="design-4-2"></a>

### 匹配方言

不同匹配目标用不同方言，不做全局统一：

| 匹配目标 | 方言 | 理由 |
|---|---|---|
| 命令词序列 | exact / **RE2 regex** | 需要交替集合与字符类；glob 在词序列上语义含糊 |
| 路径目标（重定向、文件参数） | **glob** | 路径是 glob 的主场，无 ReDoS 风险 |
| 命令名（`gpt-relay`） | exact | 零歧义，最快 |

<a id="design-4-2-1"></a>

#### regex 用 `re2js`，不自建安全子集

**决定：采用 [`re2js`](https://github.com/le0pard/re2js)（纯 JS 的 RE2 移植，MIT，零依赖）作为匹配引擎，不自己定义安全子集。**

早期设计考虑过"自建安全子集 + `ret` 解析审计"，否决理由：

1. **自带语法限制**：RE2 引擎根本不接受回溯引用（`\1`）、嵌套量词（`(a+)+`）、前瞻（`(?=x)`）——这些正是审计要拦的东西，引擎级拒绝比审计更可靠；
2. **线性时间保证**：RE2 用 DFA/NFA 组合，匹配时间 O(n)，不存在灾难性回溯；
3. **零依赖纯 JS**：不需要 WASM 加载，不引发 pnpm 构建脚本批准，Node 与浏览器行为一致；
4. **无需维护语法清单**：审计方案要持续跟进"哪些模式危险"；引擎方案只需 catch 编译异常。

**实测数据**（本机，re2js 2.8.8，用真实规则模式跑）：

- `^gpt-relay(?:\s|$)` 匹配 `gpt-relay send hi` → `true`（正确）
- `^gh pr (view|list|status|checks|diff)\b` 匹配 `gh pr view 42` → `true`（正确）
- 同一模式匹配 `gh pr checkout 42` → `false`（正确）
- 灾难性回溯模式 `^(a+)+$` + 输入 `a`×40 + `b`：
  - **re2js**：`false`，**0.38 ms**
  - 原生 RegExp（输入 `a`×28 + `b`）：**4,968 ms**
- 危险语法编译期即拒绝：
  - 前瞻 `(?=x)` → `RE2JSSyntaxException`
  - 后顾 `(?<=x)y` → `RE2JSSyntaxException`（除非显式开 `LOOKBEHINDS`）
  - 回溯引用 `(a)\1` → `RE2JSSyntaxException`
  - 注意：`\p{Greek}` 等 Unicode 类**可以**编译（RE2 支持），不算问题

**现有五条规则全部兼容 RE2**：用的是锚定、交替、字符类、`\s`、`\b`——RE2 原生支持。

<a id="design-4-2-2"></a>

#### 唯一保留的语义检查：`^` 锚定

RE2 接受非锚定模式，但本设计的规则语义是"整条命令（或整个命令词）匹配"。**这是语义约束，不是安全约束**——非锚定 regex 在命令匹配上几乎总是写错了（`gh pr` 会匹配到 `foo gh pr bar` 的任意位置）。

因此加载时仍做一条检查：pattern 必须以 `^` 开头。例外：允许 `(?:^|...)` 之类的显式构造（正则开头是 `^` 或 `(?:^`）。

**否定需求的表达方式**：RE2 不支持 lookahead，所以"匹配 `gh pr` 但不匹配 `gh pr checkout`"要用**规则顺序 + deny 优先**表达：

```jsonc
{ "id": "gh-pr-no-checkout", "match": { "pattern": "^gh pr checkout\b" }, "verdict": "deny" }
{ "id": "gh-pr-readonly",    "match": { "pattern": "^gh pr (view|list|status)\b" }, "verdict": "allow" }
```

第一条更精确且排在前面，`deny` 优先生效。这与四值裁决天然契合，无需否定前瞻。

<a id="design-4-2-3"></a>

#### 被否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 自建安全子集 + `ret` 审计 | 自己维护语法规则易漏；只能"拒绝已知危险模式"，无法保证安全 |
| `safer-regex` | **GPL-3.0**，与本项目许可证不兼容 |
| `redos-detector`（MIT） | 只做"评分"不做"保证"；若坚持静态检查而不换引擎，它是最佳选择（依赖 `regjsparser`） |
| `re2-wasm` | 需要 WASM 加载，维护活跃度不如 re2js |
| `regexp-tree` | 属于"审计派"，同 `redos-detector` |

**glob**：`picomatch`/`minimatch`，纯 JS，天然无回溯风险；默认拒绝 `..` 上跳模式。

<a id="design-4-3"></a>

### 规则 Schema

```jsonc
{
  "id": "relay-full-trust",
  "comment": "Relay：信任整个 CLI，包括提交内容、会话控制和后端绑定。",
  "match": {
    "node": "command",            // command | file_redirect | variable_assignment
    "kind": "regex",              // exact | regex | glob
    "pattern": "^gpt-relay(?:\\s|$)",
    "agents": ["main"]            // 可选：main | subagent | preset:<name>，缺省不限
  },
  "verdict": "allow"              // allow | deny | force-ask | force-review
}
```

`force-review` 可附带 `hint` 文本；不填写 `hint` 也必须进入审查。`hint` 只提供审查关注点，不指定审查结论。`review(default)` 是规则未能直接裁定时的兜底入口，不是可配置的 `verdict`。

**没有 `sandboxed` 字段**。早期设计里的 `sandboxed: true`（"放行但保留沙箱兜底"）已删除——它的语义完全由提交模式决定：trusted 模式本来就没有沙箱可保留，guarded 模式下 `allow` 本来就要过沙箱。字段要么无意义、要么与默认行为相同（[方案演变记录](decisions-and-questions.md#design-15) 决策记录）。

**`agents` 维度**（借鉴竞品 `dsh-permission-rules`，[证据 §14](../evidence.md#evidence-14)）：

- 取值 `main`（顶层会话）、`subagent`（子 agent）、`preset:<name>`（由 preset 组合的 agent）；
- 缺省 = 不限；
- **未知身份永不匹配**（fail-closed）——若拿不到身份候选，`agents` 受限的规则不生效；
- 典型用途：给子 agent 一套更窄的 allow 白名单（子 agent 无法弹审批，规则层是它唯一的自主空间）。

规则示例（迁移自 `agent-home.rules`）：

```jsonc
{ "id": "relay-full-trust", "match": { "node": "command", "kind": "regex",
    "pattern": "^gpt-relay(?:\\s|$)" }, "verdict": "allow" }

{ "id": "gh-pr-readonly", "match": { "node": "command", "kind": "regex",
    "pattern": "^gh pr (view|list|status|checks|diff)\\b" }, "verdict": "allow" }

{ "id": "gh-issue-readonly", "match": { "node": "command", "kind": "regex",
    "pattern": "^gh issue (view|list|status)\\b" }, "verdict": "allow" }
// 同理 gh repo / gh run / gh search
```

**匹配语义**：先检查更高优先级的 `deny`、`force-ask`、`force-review`；均未命中时，命令的每个待匹配 AST 节点都必须被 `allow` 覆盖，才能整体放行。任一节点未被覆盖 → 整条命令进入 `review(default)`。因此 `cmd1 && cmd2` 只有一半可信时不会整体放行；“默认审查”也不只指零条规则命中的情况。

<a id="design-4-4"></a>

### 五层裁决与优先级

**完整顺序：`deny > force-ask > force-review > allow > review(default)`。**

| 层 | 裁决 | 行为 | 典型场景 |
|---|---|---|---|
| 1 | `deny` | 直接拒绝，带 reason | 明确黑名单 |
| 2 | `force-ask` | 跳过审查，强制人工 | 不信任任何模型判定的高危命令族 |
| 3 | `force-review` | 必须交 reviewer；可附带 `hint` | 即使匹配 allow，也要求逐次审查 |
| 4 | `allow` | 短路放行，不审不问 | `gh pr view` 只读组 |
| 5 | `review(default)` | 交 reviewer，按常规审查策略判断 | 无规则命中，或 allow 未覆盖整个调用 |

**优先级：前四层是显式规则，层号小的优先，跨层不看配置顺序；同一层内按配置顺序。第五层是兜底路径，仅当前四层未能裁定整个调用时进入。**

这里的 `>` 表示规则与兜底路径的选择顺序，不表示审查结论的严格程度。`force-review` 与 `review(default)` 都只是“进入审查”，还没有给出批准或拒绝结论；默认审查不会覆盖一个已完整匹配的 `allow`。

**`force-review` 高于 `allow` 的意义**：可以在一个宽泛的信任范围内明确指定必须审查的操作——

```jsonc
{ "id": "relay-trust", "pattern": "^gpt-relay",                    "verdict": "allow" }
{ "id": "relay-prod",  "pattern": "^gpt-relay send.*--to-prod",    "verdict": "force-review",
  "hint": "目标是生产环境，重点看 authorized 与 scope" }
```

两条都匹配 `gpt-relay send --to-prod ...` 时，`force-review` 生效，必须审查。这由优先级决定，与 pattern 是否更精确、是否附带 `hint` 无关。

**已知副作用（有意接受）**：宽泛的 `force-review` 会让更窄的 `allow` 失效。

```jsonc
{ "id": "relay-review", "pattern": "^gpt-relay",      "verdict": "force-review" } // 宽
{ "id": "relay-send",   "pattern": "^gpt-relay send", "verdict": "allow" }        // 窄
```

此时 `gpt-relay send` 进入强制审查。接受理由：

1. **失败方向是安全的**——多审一次，而不是该审的没审；
2. 显式要求审查的规则必须得到执行；
3. 要让窄范围免审，需要缩小或删除与之冲突的 `force-review` 匹配范围。

配置页应在保存时检测这种情况（某条 `allow` 的 pattern 集合被某条 `force-review` 完全覆盖）并给出警告。

**默认审查没有规则附带的 `hint`**。全局与项目审查策略仍正常生效；需要针对某类操作增加关注点时，使用带 `hint` 的 `force-review` 规则。

**面向用户的名称**：规则编辑器使用“禁止”“必须人工审批”“必须审查”“免审放行”；执行解释和规则测试另显示“默认审查”，并给出“未命中规则”或“allow 未覆盖整个调用”的原因。两种审查入口都显示为待审查，不能提前显示为“已批准”。

**`allow` 的行为随模式变化**（不需要额外字段）：

| 模式 | 沙箱 | `allow` 的结果 |
|---|---|---|
| trusted | 无 | 直接放行，无沙箱约束 |
| guarded | `workspace-write` | 放行，但仍受沙箱约束——越界写入会被原生拒绝并走升权询问 |

<a id="design-4-5"></a>

### 双模式

两个模式由权限预设决定，`allow` 的语义随模式变化（见 [五层裁决与优先级](rules.md#design-4-4) 末尾的表）：

| 模式 | 预设 | 沙箱 |
|---|---|---|
| **trusted** | `auto`（`registerAuto` 注册） | `danger-full-access` |
| **guarded** | `workspace-write`（内置预设） | `workspace-write` |

切换命令（走官方预设 API，统一挂在 `/arbiter` 下）：

```js
// /arbiter mode trusted|guarded
ctx.commands.register({
  name: "arbiter",
  description: "arbiter: mode / status",
  handler: ({ agent, rawInput }) => {
    const [sub, arg] = rawInput.trim().split(/\s+/, 2);
    if (sub === "mode") {
      const target = arg === "guarded" ? "workspace-write" : "auto";
      ctx.permissionPresets.set(agent.session, target);
      return { kind: "success", text: `已切换到 ${arg ?? "trusted"} (${target})` };
    }
    return { kind: "success", text: currentStatusText(ctx, agent) };
  },
});
```

这里的 mode 只切换 trusted / guarded 执行边界。审批模式由用户在插件设置页选择主会话与全部子任务的设置，不再提供 `/arbiter dnd` 写入口。

**门禁判断必须改造**：官方 auto review 用 `permissionPresets.current(session) === "auto"` 判断启用，双模式下不成立（`derive()` 在 sandbox 改为 workspace-write 后返回 `workspace-write`，不再是 `auto`）。插件需要自己的启用判断，例如"当前预设 ∈ {auto, workspace-write}"。

<a id="design-4-6"></a>

### fail-closed 清单

以下情况一律 `next()` 交给后续路径（审查或人工），**绝不放行**：

1. AST 解析失败或返回 ERROR 节点；
2. 遇到未识别的节点类型（子 shell、命令替换、heredoc、后台 `&` 等，除非显式支持）；
3. 命令包含多个语句且有任一节点未命中 allow 规则；
4. 规则配置校验失败（加载期直接拒绝启动）；
5. reviewer 响应不合法或调用失败：不自动放行，转 error-escalate，再按审批模式转人工或 fallback-deny；
6. 低置信度或授权冲突未解决；
7. `unresolved_expansions` 非空（[变量展开与目录追踪](review-context.md#design-5-2-5)）；
8. 命令词本身是变量展开（`$CMD ...`）→ 视为 `opaque`。

<a id="design-4-7"></a>

### PTC（`run_code`）与内层调用

PTC 模式下，模型调用 `run_code` 执行 TypeScript 程序，程序内部通过 `tools.bash(...)` 等调用工具。这些**内层调用同样经过 `tools/pre-execute`**。

**官方 Auto Review 的过滤方式**（宿主能拦截外层；这里是官方插件主动跳过）：

```js
// 官方插件跳过外层程序，只逐次审查 tools.* 内层调用
if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return next();
// 内层调用（exec.parent !== undefined）正常走规则匹配与审查
```

**外层可以审查，但需要不同输入处理**：外层参数包含程序文本，不能直接使用 tree-sitter-bash；这不代表程序文本不能被 reviewer 审查，也不代表不能按工具名控制整个调用。初稿是否继续跳过外层、外层如何与命令规则协作，仍属 [C5](decisions-and-questions.md) 待决问题。

**内层调用正常处理**：内层 `tools.bash({ command })` 的 `arguments.command` 是真的 bash 命令，AST 能解析，规则能匹配，审查能进行。

**逐调用门禁的边界**：PTC 程序直接调用 Node 的文件、网络与子进程 API 时，没有相应的内层工具调用事件，因此内层规则与审查无法逐项拦截这些效果。即使审查外层，也只是对程序作一次准入判断，不能等同于逐效果拦截。

Node 运行时的临时进程和持久进程均在非 `danger-full-access` 模式下调用 `sandbox.confine`。当前 macOS 文件策略允许一般读取与联网，限制允许根以外的文件写入；不是所有写入都会被拒绝。程序可见 `process.env` 初始为空，不能把环境变量访问表述为必然取得宿主凭据。以上是源码事实，实际 runner 与行为仍需运行验证。

如果沿用“跳过外层”并使用 trusted 模式，则直接 Node 效果既不受本插件逐调用审查，也没有 DSH 文件沙箱约束。guarded 能增加文件写入边界，不能补足读取和联网审查。

**待决方案**：若要对 `run_code` 设置 deny／force-ask／force-review，必须先让外层进入相应判定，不能在规则匹配前无条件跳过。这是产品选择，尚未确认或实现。完整路径矩阵见[覆盖范围](architecture.md#execution-coverage)，源码出处见[证据 §22](../evidence.md#evidence-22)。

---

<a id="design-5-10"></a>

## 离线规则建议与人工审核

**规则建议只通过离线流程产生：日志 → 离线分析 → 候选规则 → 独立界面人工审核 → 加入正式规则列表。** 分析器没有修改生效规则的权限；候选在人工确认前不参与运行时匹配。

实时审批只处理当前操作，不提供“以后免审”按钮，也不在审批 reason 中附带规则提名。用户可在独立的规则管理界面直接创建规则，或审核离线建议。无论哪种方式，最终确认的都是具体匹配范围和具体行为。

**人工确认后的候选就是普通规则，与手工创建的规则语义完全相同。** 规则 Schema 不区分来源，运行时不按来源改变匹配、优先级或放行行为。

### 同轮次审批去重

仅针对**完全相同的 pending 请求**（工具名 + 参数指纹一致）、在**极短窗口**（默认 30s）内、**同一轮次**内不重复弹窗。不跨轮、不持久、不进日志聚合。这是独立的 UX 改进，不产生规则或延续授权。

**明确不做会话 grant**（竞品 `dsh-perm-gate` 的 P1 层）。理由：

1. **精确操作本来就不重复**——`rm -rf /tmp/build` 一个任务里通常只出现一次；真正高频的是"命令模式"，那已由规则层覆盖；
2. **上下文无关的免票是隐患**——批准时刻的判断是"现在这么做没问题"，复用假设"之后也没问题"，而 `rm -rf` 在不同上下文完全可能后果不同；TTL 只是粗糙缓解；
3. **与本设计的 `authorized` 维度冗余**——reviewer 每次都会读会话历史判授权，而且它是**带上下文的**（能看到这期间发生了什么）。grant 是用冻结的判断替代重新判断，而本设计本来就有重新判断能力；
4. **它省的是 token，但高频部分已被规则层吃掉**，剩下的漏网调用频率不高。

### 离线日志分析与候选

**不做在线学习**（竞品 `dsh-perm-gate` 的 `riskLearning` / `riskSediment`）。理由：

| | 在线学习 | 离线分析 |
|---|---|---|
| 输入信号 | 一次人工批准 | 历史审批记录 + 日志中可得的后续结果 |
| 信号质量 | 噪声大（用户会疲劳批准、为省事批准） | 可对照真实后果 |
| 时机 | 当次立即改变行为 | 事后分析，人工审核后才改变规则 |
| 可审查性 | 累积状态，事后难追溯 | 每批改动是显式 diff，可评审 |
| 回滚 | 需 terminate/remove 条目 | 改规则文件即可回滚 |

核心问题：**把"被批准"当成"安全"**。用户点同意可能只是信任 agent 的意图，不代表操作无害，更不说明重复做同样的事也无害。

**周期性分析器的三个产出**：

1. **高频被审但每次放行的模式** → 提名成规则（这是降本收益的来源）；
2. **反复出现的 `ask` 归因分布** → 诊断规则缺口或阈值偏差（复用 [日志与离线调优](configuration-and-audit.md#design-5-8) 指标）；
3. **反复失败或被撤销的操作** → 反向证据，考虑加 `deny` 规则。

**候选规则必须带统计依据，候选元数据与拟加入的规则分开存放**：

```yaml
- candidateId: candidate-gh-pr-view
  stats: { occurrences: 47, approved: 47, failed: 0, window: "2026-09-01..2026-10-20" }
  rule:
    id: gh-pr-readonly
    match:
      node: command
      kind: regex
      pattern: '^gh pr (view|list|status|checks|diff)\b'
      agents: [main]
    verdict: allow
    comment: "允许主 agent 免审执行 gh PR 只读查询"
```

统计展示应说明观察窗口、样本与结果可见性；“47 次全部批准、0 次可见失败”只是审核依据，不足以证明未来调用安全。

### 独立审核与规则生效

审核界面展示候选的完整规则、匹配范围、代表性日志、统计依据、与现有规则的冲突和配置 diff。用户可修改或拒绝候选；只有用户确认过的规则内容通过正常配置校验并保存后，才加入正式规则列表。之后的离线分析不能自动扩大或改写这条规则。

规则的编辑、测试、停用与删除均走普通规则管理流程。若展示“离线建议 · 人工确认”提示，只作为审核记录中的说明，不作为规则字段或运行时判断条件。具体界面见 [离线规则建议审核](configuration-and-audit.md#offline-rule-review)。

### 不生成免审候选的类别

下列清单约束**离线 `allow` 候选生成**，不创建按规则来源区分的运行时路径。运行时三档审查策略的规则另见[审查判定规则对照](approval-modes.md#rule-matrix)；两者可以复用操作分类，但不把离线候选排除项直接当成运行时拒绝规则。

| 硬类别 | 判定依据 |
|---|---|
| 不可逆删除 | `destructive = true` ∧ (`bulk` ∨ 目标非本会话创建) |
| 凭证外发 | `secrets = true` ∧ `egress = true` |
| 生产操作 | 目标命中生产环境标记（域名、路径、分支名） |
| 安全控制变更 | 权限、沙箱、审批策略本身的修改 |
| 持久化到本机外的写入 | `writes_outside_workspace` 命中非项目目录 |

**排除的理由（离线场景）**：规则是上下文无关的，而硬类别的判断本质上是上下文相关的。`rm -rf /tmp/build` 在日志里出现 47 次全部合适，**说明不了第 48 个上下文也合适**——而规则一旦写进部署配置，就丢失了"当时是哪个任务、用户说了什么、目录现在什么状态"的全部信息。

候选生成仍只考虑 AST 可完整判定的命令族，避免仅凭脚本调用的历史结果推导脚本内部行为。这些约束适用于自动建议免审规则；可以生成要求审查或禁止操作的建议，也不限制用户通过普通规则编辑器自行配置规则。

**统一运行时语义**：人工审核后的规则遵循本章同一套 AST 解析、匹配、优先级与模式约束；不保留“学习规则额外复检”开关。`allow` 与审查不变式的整体适用边界仍在 [C1、C3](decisions-and-questions.md#product-discussion) 中继续收敛，但不会按创建来源区分。

---
