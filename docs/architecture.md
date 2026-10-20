# 总体架构与运行模式

描述单插件的执行链、命名与包结构、子 agent、审批模式、预设接入和上游扩展边界。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [命名与目标运行时](#naming)
- [总体设计](#design-3)
- [工具与执行路径覆盖范围](#execution-coverage)
- [子 agent（智能体团队）场景](#design-5-6-1)
- [审批模式](#design-6)
- [预设与 UI 接入](#design-7)
- [未来：upstream 多根工作区](#design-13)
- [术语](#glossary)

---

<a id="naming"></a>

## 命名与目标运行时

> 确定性命令规则 + 校准型决策模型审查，用于 DSH 的审批与权限判定。

- 包名：`dsh-arbiter`（npm，无 scope）
- 插件名 / 行 id：`arbiter`
- 状态：设计稿（待评审）
- 日期：2026-10-20
- 目标运行时：DSH desktop 0.2.1-rc.2（macOS）
- 相关证据：[evidence.md](../evidence.md)

**命名理由**：本设计与竞品的核心区别是"模型只报事实，allow/ask/deny 全部由代码算"——代码的职责是**仲裁**。`perm-gate` / `permission-rules` / `auto-review` 都在强调"关卡"或"复查"，而 arbiter 强调的是"谁来做最终判定"。

---

<a id="design-3"></a>

## 总体设计

<a id="design-3-1"></a>

### 一个插件，两层门禁

原讨论中曾计划两个独立插件（命令规则 / auto review fork），最终合并为一个包。合并理由：

1. **消除监听器顺序依赖**：两个插件各自 `prepend` 抢 waterfall 队首时，先后取决于加载顺序，而"规则短路先于审查"是省 token 的前提，不能建立在加载顺序上；实测还表明 `prepend` 不能让插件排在宿主内置监听之前（[覆盖范围](#execution-coverage)），该风险不只存在于插件之间；
2. **状态共享**：规则判定结果、会话模式、审查上下文需要共享，跨插件传递没有干净的官方通道；
3. **预设槽位互斥**：`registerAuto()` 是单槽，两个包都注册会抛错，物理上不可能共存。

```
工具调用
  │
  ├─ pre-execute（插件，唯一监听器）
  │    ├─ 解析命令（tree-sitter AST）
  │    ├─ 匹配规则表
  │    │    ├─ deny            → 拒绝（带 reason）
  │    │    ├─ force-ask       → 跳过审查，进入人工处理
  │    │    ├─ force-review    → 强制审查，可附带 hint
  │    │    ├─ allow           → 完整覆盖时放行（短路，零 token）
  │    │    └─ review(default) → 前四层未能裁定整个调用时，默认审查
  │    │
  │    └─ 审查路径：构造快照 → 后端产出信号 → 判定引擎应用审查策略
  │         ├─ review-allow    → 放行
  │         ├─ review-deny     → 拒绝
  │         ├─ review-escalate → 进入人工处理
  │         └─ error-escalate  → 审查故障，进入人工处理
  │
  └─ 原生执行（trusted 模式：无沙箱；guarded 模式：原生沙箱）
```

人工处理同时检查审批模式和审批通道：可发起审批时等待 `human-allow / human-deny / human-abort`；需要人工审批但当前模式不发起或通道不可用时为 `fallback-deny`。该边界不限制 agent 使用 ask 或聊天。各阶段含义以[产品术语](terminology.md#decision-stages)为准；宿主执行结果与权限判定分开记录。

<a id="design-3-2"></a>

### 包结构

```
dsh-arbiter/
├── package.json
│   ├── "type": "module", main/exports → lib/index.js, lib/client.js
│   ├── "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
│   │            "client": { "platform": "web", "inject": [...] } }
│   ├── dependencies: re2js ^2.8.8, picomatch ^4, tokenx ^2.2.0, web-tree-sitter
│   ├── peerDependencies: @deepseek-ai/cordis ~4.0.5,
│   │    @deepseek-ai/dsh-tools 0.2.1-rc.2,
│   │    @deepseek-ai/dsh-permission-presets 0.2.1-rc.2, ...
│   └── engines.node: ^22.19.0 || >=24.0.0
├── cordis.patch.yml          # insert 一行：id: arbiter
├── lib/
│   ├── index.js              # 宿主半侧：apply(ctx, config)
│   ├── client.js             # 浏览器半侧：配置页
│   └── types/*.d.ts
├── locale/{zh,en}.json
└── README.md
```

**命名约定**（全项目统一，改动时需同步）：

| 位置 | 取值 |
|---|---|
| npm 包名 | `dsh-arbiter` |
| cordis 插件 `name` | `arbiter` |
| `cordis.patch.yml` 行 id | `arbiter` |
| 配置槽位 key（`plugins.bundle.config`） | `dsh-arbiter` |
| locale 命名空间 | `arbiter` |
| 设置与会话事件 | 审批模式读取插件设置；配置生效记录与 `arbiter/mode` 等事件字段待统一 |
| plugin record 前缀 | `plugin:arbiter/*` |
| 插件自有数据目录 | `$DSH_HOME/arbiter/` |
| 斜杠命令 | `/arbiter`（执行模式子命令 `mode` 与只读 `status`；审批模式在设置页选择） |
| 错误前缀 | `arbiter: ...` |

模块划分（同一包内）：

| 模块 | 职责 |
|---|---|
| `rules/parse` | tree-sitter-bash 解析、节点抽取、规范化 |
| `rules/match` | exact / RE2 regex（re2js）/ glob 匹配 |
| `rules/verdict` | 四值裁决 + 双模式解析 |
| `reviewer/snapshot` | 审查输入构造（分段、预算、截断） |
| `reviewer/budget` | token 估算（tokenx）、逐条累加截断、硬兜底 |
| `reviewer/backends/decision` | `state`+`questions` REST 调用（Clef/Jev 兼容）、响应映射 |
| `reviewer/backends/chat` | `ctx.llm.stream()`、0–10 点值解析、校验、修复式重试；`provider: session` 变体 |
| `reviewer/ir` | 统一中间表示（分布/点值、三探针、降级标记） |
| `reviewer/engine` | 五层判定：检查点 / 不变式 / 类别导出 / 推导表 / 概率门 |
| `reviewer/reason` | 模型可见模板 + 用户 display 文案 |
| 审批模式处理（模块名待定） | 读取主／子任务模式、选择审查策略、分发人工与兜底路径 |
| `preset` | registerAuto、模式切换命令 |
| `config` | 配置 schema、校验 |
| `audit` | 审计日志 |

<a id="design-3-3"></a>

### 数据流（trusted 模式，规则命中）

```
模型调用 bash(command="gpt-relay send ...")
  → pre-execute：解析 → 命中 allow 规则
  → 返回 { kind: "allow" }
  → 原生执行（danger-full-access 下不 confine）
  → 完成，零 token，零审批
```

一步到位，无失败无重试。这是与 Codex `exec-policy allow（含 sandbox bypass）` 的等价语义。

---

<a id="execution-coverage"></a>

## 工具与执行路径覆盖范围

核对对象为本机安装的 **DSH 0.2.1-rc.2（macOS 27.0.1 / arm64）**。2026-10-20 重新读取安装包源码，同日完成第一轮宿主机实测。下表的“能力”列区分两类依据：**源码**表示调用链已确认；**实测**表示在隔离 profile 中用探针真实跑过，逐项见[覆盖范围证据](../evidence.md#evidence-22)与[本轮报告](../validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)。两类都**不表示 dsh-arbiter 已实现**，也不外推到未测的 profile、preset 与 surface。

统一接入点是 `tools/pre-execute`：调用进入 DSH 工具流水线时，可以在工具主体执行前作出权限判定。能拦截入口，不等于能观察该工具实现内部的每一个效果；程序直接调用宿主服务，也不一定经过工具流水线。

**监听顺序**（实测）：headless 组合下，`tools/pre-execute` 里除探针外还有一个 `prepend` 监听；加入官方 auto-review bundle 后变成两个——与源码中 `dsh-tool-jobs` 和 `dsh-experimental-auto-review` 都以 `{prepend:true}` 注册一致。两者都早于 profile 层，插件再用 `prepend` 只能排到同组之前、**仍在这些监听器之后**（`g1-a`／`g1-g`／`g1-h`）。因此“规则短路先于其他审查”不能仅靠 `prepend` 保证，见 [O11](decisions-and-questions.md#question-o11)。

| 工具／执行路径 | 接入能力 | 依据 | 实测限制与未验证项 |
|---|---|---|---|
| 直接调用注册工具，如 bash、文件编辑、web、终端工具 | 可在工具主体开始前取得工具名、参数和调用身份，允许或拒绝整个调用 | 源码 + 实测 | 探针 allow／deny 在 bash 与 `write` 上均生效；web／终端等工具未逐一实测（同属 registry 派发）。shell AST 仅适用于相应命令参数 |
| bash／终端启动的脚本、程序及其子进程 | 能审查启动它们的工具调用 | 源码 + 实测 | `g3-c`／`g3-i` 显示子进程不产生独立门禁，探针只看到 `bash` 本身；脚本内部文件操作、网络请求不能逐项过同一门禁。审查输入是否含脚本正文仍是另一项能力 |
| **外层 `run_code`** | 可接入；外层也走 pre-execute，参数包含程序文本 | 源码 + 实测 | `g2-b` 实测外层 deny 时程序未启动（标记文件不存在、无内层派发）。官方 Auto Review 主动跳过外层，本插件是否跳过仍是产品待决项；需要单独的程序审查输入，不能送入 bash AST |
| **`run_code → tools.bash` / `tools.<其他工具>`** | 每个实际发出的内层调用分别进入工具流水线，带真实参数、`parent` token 和 `rootCallId` | 源码 + 实测 | `g2-c`／`g2-d` 实测内层 deny 可被程序 catch、外层继续；两个并发内层各自进入 pre-execute，一放一拒互不取消。`callId` 形如 `<outer>:ptc:<n>`，`parent` 是 execution token 而非 agent。已发生效果不回滚 |
| **`run_code → tools.mcp__…`** | MCP 工具已注册到同一 registry，使用同样的内层派发路径，可在 MCP 请求发出前拦截 | 源码 + 实测 | `g4-c` 实测内层 MCP 调用逐次进入 pre-execute，被拒的那次未到达服务器。动态工具列表、schema 更新、命名规范化与服务断连未测 |
| **`run_code` 直接调用 Node API**：`fs`、`fetch`、`child_process` 等 | **没有逐效果的工具门禁**；只能控制外层程序准入。Node 运行时在非 full-access 下调用沙箱 | 源码 + 实测 | `g3-a`／`g3-b` 实测三类效果都实际发生而探针只看到外层 `run_code`；文件沙箱只改写入边界，不限制读取、网络或子进程。宏观准入不等于逐项审查 |
| **直接调用 MCP 工具**：`mcp__<server>__<tool>` | MCP bridge 将工具注册到 DSH，body 内才发送 `client.callTool`，因此入口可拦截 | 源码 + 实测 | `g4-b` 实测 deny 时服务端已完成握手但**没有收到 `tools/call`**，即拒绝发生在 RPC 之前。服务器内部的数据库、文件、二次网络请求不能逐项拦截；DSH 会话文件沙箱也不等于远端服务的执行沙箱 |
| MCP 资源工具：`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | 都注册为普通 DSH 工具，可审查 server、URI 等参数 | 源码 + 实测 | `g4-d` 实测 list／read 到达服务端；`g4-e` 实测 deny 时服务端没有 `resources/read`。资源访问授权仍由服务端负责；模板工具未单独实测 |
| MCP server 启动、连接、工具发现／重连及服务内部操作 | **不由上述逐工具门禁覆盖**；MCP client 直接创建 transport、发现工具 | 源码 | 本轮未测重连与动态列表；不承诺整个 MCP 协议／服务生命周期受控 |
| **通过委派工具创建 subagent** | 委派本身是工具调用，能审查任务、目标后端及参数 | 源码 + 实测 | `g5-a`／`g6-d` 实测 `subagent`／`subagent_fork` 入口可审查。批准委派不替代子任务的逐调用判定 |
| **进程内 subagent：spawn／fork** | 子任务为本地 Agent，工具调用走同一宿主流水线；全局／所属上层作用域监听器可接收其事件 | 源码 + 实测 | `g5-a…g5-e` 实测两种子任务的工具调用都进入 pre-execute（allow 执行、deny 阻止）；子会话 header 含 `parentSession`／`origin:"subagent"`／`delegationDepth`。创建时 `approval/policy: never` 不阻止插件先行 allow。不同 preset、冷恢复、后代与并发会话未测；`exec.parent` 不能用于识别 subagent |
| **进程外／外部后端 subagent** | 可审查经工具发起的委派；通用外部后端路径只管理 run/result，没有本地子 Session | 源码 | **未运行**：本轮无可用外部后端。不能承诺共享本插件策略，需单独集成 |
| workflow 工具及其编排路径 | workflow 工具入口可拦截；其实现直接调用 PTC runtime 与 subagent 服务，内部步骤不会自动产生对应的 `run_code`／委派工具门禁 | 源码 + 实测 | `g6-a` 实测入口 deny 后没有创建子任务；`g6-d` 实测 workflow 内部创建子任务**不产生** `subagent` 入口，而直调委派会；`g6-b`／`g6-c` 实测子任务自己的工具调用仍受各自门禁。后台、取消与生命周期组合未测 |
| 沙箱升权：bash／`run_code` 的 `sandbox_permissions` | 工具入口可见参数；工具主体内部另调用原生审批服务 | 源码 + 实测 | `g7-a`／`g7-b` 实测工具 allow 后仍进入 `approval/asked`，`never` 下被拒且无效果；`g7-c` 实测无应答者时为 `unavailable`。**真实人工审批未运行**；allowed-once 只由模拟应答器产生（日志标 `simulated: true`）。插件 allow 不等于已批准升权 |

**运行环境也影响覆盖**：表中结论只适用于插件实际安装并生效的 Host／profile。Web、headless、独立 DSH 进程和外部 agent 不因一个实例启用插件而自动覆盖。官方 Auto Review 自身会跳过没有 `exec.agent` 的调用；本产品是否接管这类程序化调用、缺少会话时如何取策略与授权，仍待定义。

**产品表达建议，待确认**：把“本次调用是否经过插件判定”“可见内容到哪一层”“当前执行沙箱”分别展示。对外可承诺“审查已接入的 DSH 工具调用”，不能仅凭这些 hook 承诺“所有动作均已审查”。配置页展示静态支持范围，单次调用详情展示实际接入与判定情况。

---

<a id="design-5-6-1"></a>

## 子 agent（智能体团队）场景

按本轮对目标 DSH 版本的源码复核与实测，进程内子 agent 创建时审批策略固定为 `never`，原生审批服务会直接拒绝；**这不阻止 pre-execute 中的插件先行审查**——`g5-a`／`g5-e` 中子会话日志写着 `approval/policy: never`，插件 allow 仍让子任务工具执行成功。外部后端不具有相同的接入保证，见[覆盖范围](#execution-coverage)与[调研证据](../evidence.md#evidence-22)。插件不通过修改宿主限制来开放子任务审批。

实测还暴露一处文案偏差：子任务中交给原生 ask 的调用被 `never` 直接判为 `rejected`，模型看到的是 “the user rejected tool …”，但其实没有人类参与（`g5-d`）。插件应自己记录拒绝来源，不能直接沿用原生结果文案。

**当前设置约定**：在插件设置页单独选择所有子任务共用的 strict 或 progress，不提供 normal，也不提供每个 subagent 独立开关。子任务不再继承父会话的审批模式；旧 O6 结论已由本轮决定取代。完整设置范围见[审批模式](approval-modes.md#mode-selection)。

| 路径 | 处理 |
|---|---|
| 命令 allow / deny | 照常匹配，allow 仍受当前执行边界约束 |
| force-review / review(default) | 应用插件设置页选择的子任务审查策略 |
| review-allow / review-deny | 执行对应权限结论 |
| force-ask / review-escalate / error-escalate | 无人工通道，记录来源后 fallback-deny，仅结束当前调用 |

主会话为 normal 而子任务为 progress 时，子任务仍使用 progress。设置成功应用后，所有子任务的后续判定使用新设置，不需要逐个切换；在途请求遵循统一的[配置生效边界](approval-modes.md#configuration-activation)。

**授权证据与模式分开**：子任务仍可读取本会话人类消息、父会话人类消息及父 agent 转述，具体内容和来源标记见[授权证据](review-context.md#design-5-2-3-2)。选择 progress 本身不产生 explicit 授权。

<a id="subagent-recovery"></a>

### 受阻后的模型行为指引

按用户提出的沟通顺序，作为执行 agent 的 instruction 整理，不构建新的跨 agent 自动授权协议：

1. 子 agent 先判断能否用其他允许的方案完成目标，例如缩小操作范围或改用不需要该权限的方法；不能只换命令写法重复被禁止的效果。
2. 确实受阻时，向父 agent 报告未完成部分、待执行操作、判定链与具体原因。
3. 父 agent 可通过宿主可用的 ask 工具取得针对具体操作与范围的授权，再转述给子 agent；子 agent 提交带新证据的请求，由 reviewer 重新判断。父会话的审批模式不限制这种提问。
4. 转述仍不足时，子 agent 反馈缺少的证据；父 agent 可通过 ask 工具或普通消息引导用户进入子会话直接授权，再由子 agent 继续。

“拒绝是否强烈”不新增为评分。恢复方式应看实际原因：缺授权或范围不清可以补证据；服务故障需要恢复服务；命令 deny、仍生效的固定禁止条件或 force-ask 所需的实际人工批准不能用转述替代。新请求可以因证据或操作变化得到不同结论，之前的拒绝记录保持不变。

父级提问不把子任务切成 normal；strict / progress 也不禁止父 agent 使用 ask 或聊天补充授权。该指引仍受宿主实际通道限制；授权聊天消息属于证据，不能伪装为一次 human-allow。插件不保证转述后必定放行，也不强制 agent 依次重试所有步骤。

### 插件与证据契约的职责

插件提供可区分的结果和完整原因，读取并标明父／子授权证据来源，并提供上述行为指引的接入方式；不负责代替父 agent 发起提问、转述或批准。指引如何注入宿主仍需实现验证。

reviewer 的输入可同时包含父会话人类原话及父 agent 转述。人类原话明确覆盖子任务当前操作、目标与范围时，可以支持 explicit，不因来自父会话而封顶 implied；转述用于关联任务，不能扩大原话的授权范围。只有转述而没有足够原始授权时，仍不能凭转述制造 explicit。具体规则见[授权证据](review-context.md#design-5-2-3-2)。

<a id="agent-instruction-placement"></a>

### 指引放置（方案已确认）

采用用户确认的**简短的常驻说明 + 随拒绝结果提供的具体提示**。执行 agent 需要知道插件结果的含义与可用的沟通路径，具体替代方案和是否需要求助由模型根据任务决定；不把整段恢复流程写成必须逐步执行的脚本。

| 位置 | 内容 |
|---|---|
| reviewer 的 system prompt | 原始人类授权的识别、父／子会话原话采用相同标准、转述与原话的关系；这是审查契约 |
| 执行 agent 的 system 上下文 | 简短说明审批未通过的调用未执行；按原因寻找允许的替代方案，避免无变化的重复尝试 |
| subagent 的附加上下文 | 确实受阻时向父 agent 报告具体操作、原因与所需协助；取得新证据或改变范围后再提交 |
| 父 agent 的附加上下文 | 子任务求助时判断是否需要询问用户；提问写清操作与范围，转述保持原意；仅在原始授权仍不足时建议子会话直接确认 |
| 工具拒绝结果 | 实际判定链、原因及适用于当前状态的恢复提示，不把所有 deny 都写成“请用户批准” |

subagent 的简短说明草案：

> 审批未通过的工具调用没有执行。先根据原因尝试允许的替代方案；确实受阻时，向父 agent 报告待执行操作、受阻原因及所需协助。补充授权或改变操作范围后可重新提交；不要在条件未变时仅换写法重复同一受阻效果。

父 agent 的对应草案：

> 子任务因权限受阻并求助时，先判断能否调整方案；需要补充授权时，可通过宿主可用的 ask 工具或聊天说明具体操作与范围，并将答复准确转述给子任务。审批模式不限制这种提问。子任务审查可使用父会话人类原话；仅在授权仍无法核对或不足时，引导用户进入子会话直接确认。

这里常驻的是稳定语义，当前模式、故障细节和具体缺失证据随当次结果提供。放置方案已确认，具体文字可在实现与评估中调整；注入能力、父子会话覆盖与压缩后的保留情况需要在目标宿主验证。注入执行指引有助于模型恢复，但权限判定仍由插件执行。

**启用判断**：不能仅判断原生预设名称是否为 auto。初稿指出子 agent 的 approval 固定为 never，预设派生结果可能为 custom；插件需要自己的启用条件，见[双模式](rules.md#design-4-5)。

---

<a id="design-6"></a>

## 审批模式（旧称 DND）

审批模式同时选择审查策略和人工介入方式；审查策略由审查判定规则与判定阈值组成。产品契约和三档规则矩阵统一维护在[审批模式与审查策略](approval-modes.md)，本章只保留执行接入和宿主边界。

<a id="design-6-3"></a>

### 三档模式与人工处理

| 模式 | 审查策略 | 新产生的人工请求 |
|---|---|---|
| normal：交互审批 | 自动审查，使用常规审查策略 | 审批通道可用时交人决定 |
| strict：自动审批 | 与 normal 相同 | fallback-deny |
| progress：自动审批 · 推进 | 有条件扩大代批范围 | fallback-deny |

主会话可选三档，子任务只可选 strict / progress；都由用户在插件设置页统一配置。规则入口、审查、故障、人工和兜底阶段分别记录，例如 force-review → review-escalate → fallback-deny。故障可经 error-escalate 进入同一人工处理流程。

表中的“人工请求”仅指插件人工审批。三档都不限制 agent 使用 ask 或聊天补充授权、澄清问题；force-ask 与宿主 ask 工具是不同概念。名称与 tooltip 草案统一见[模式设置](approval-modes.md#mode-selection)。

配置变更不丢弃或重算已有结果，包括 allow / deny / escalate；旧响应沿用原请求协议解释并继续处理。已弹出的人工审批保留，尚未作出的后续判定按已生效配置执行；不在执行前增加独立的二次模式检查。各状态的生效边界见[配置生效](approval-modes.md#configuration-activation)。

### 宿主限制与实现细节

<a id="design-6-1"></a>

#### 为什么不直接切换原生 never

审批模式与宿主审批策略分开。按初稿的源码证据，原生 never 在审批 waterfall 分发前就拒绝请求，且旧文案可能误称“用户拒绝”。插件应在自身路径保留实际的来源与兜底原因，不能把原生策略作为三档模式的完整实现。

对于具备人工通道的主会话，插件管理 normal / strict / progress 的人工处理策略；对子任务则遵守宿主已有的通道限制。模式选择不扩大沙箱权限，不改变原生预设的能力边界。

<a id="design-6-4"></a>

#### 原生审批关闭与 guarded 升权

原生 never 或其他通道限制只决定能否请求人工，不会自动选择更宽松的审查策略。normal 也可能因宿主通道不可用而 fallback-deny；日志应写清通道原因。

在 guarded 下，即使命令 allow 或 review-allow，实际越界仍需遵守宿主机制。插件不自动应答沙箱升权；自动审批模式能否可靠避免所有宿主升权弹窗必须在实现时验证，不能只用“预判越界”充当覆盖保证。该限制不等同于 trusted 下所有工作区外操作均被拒绝。

第一轮实测（`g7-a`／`g7-b`／`g7-c`）确认了工具准入与升权审批是两道独立判定：插件 allow 之后，body 内的 `sandbox_permissions` 仍触发 `approval/asked`；`never` 下被拒且没有效果，`ask` 下无应答者时为 `unavailable`。**真实人工审批尚未验证**，模拟应答只证明 seam 可分离。

<a id="design-6-2"></a>

#### 配置应用与状态展示

模式来自插件设置；旧的会话级 arbiter/dnd 状态和 /arbiter dnd 切换入口退出当前方案。具体设置字段名尚未定稿。

配置必须校验并应用成功后才显示“已生效”；状态页显示主会话、子任务各自当前模式。/arbiter status 可只读展示同一信息，不提供 agent 自行扩大代批范围的写入口。

记录实际判定时使用的配置版本、模式和完整阶段链，用于解释配置生效前后的差异；版本记录不意味着每次执行前额外重判。设置服务是否支持所需应用时机仍需验证。

---

<a id="design-7"></a>

## 预设与 UI 接入

<a id="design-7-1"></a>

### registerAuto

```js
ctx.effect(() => {
  const dispose = ctx.permissionPresets.registerAuto(() => {
    // admit：选中或恢复前同步执行
    if (!config.enabled) throw new Error("arbiter: plugin disabled in policy config");
  });
  return dispose;
}, "arbiter preset");
```

约束（已核实）：

- 单槽，官方 auto review 必须从 profile bundles 移除；
- 名字固定 `auto`，旋钮固定 `danger-full-access + ask`；
- 客户端硬编码「自动审查 (EXP)」文案与风险确认对话框，插件侧改不了（用户接受）；
- `auto` 不能作为新会话默认值（设置页只列配置预设）；
- 卸载时必须照抄官方迁移：把仍处于 auto 的会话切到 `danger-full-access`，否则会话卡在"无审查者的全权模式"。

<a id="design-7-2"></a>

### guarded 模式入口

通过 `/arbiter mode guarded` 切到内置预设 `workspace-write`，UI 会显示为「工作区内修改」。

<a id="design-7-3"></a>

### 可见性

原稿已预留插件向 system prompt 贡献运行时上下文的方案。[执行指引](#agent-instruction-placement)复用这一入口；不再另设一套重复的长说明。下面只展示状态信息，具体注入 API 及主／子会话覆盖仍需验证：

```
当前执行模式：trusted（无沙箱兜底）
当前审批模式：strict（自动审批，不新发起人工审批）
规则命中数：allow 42 / deny 0 / force-ask 1
```

如果保留运行时状态注入，配置变更后需反映实际生效值；当次调用的具体结果、原因和恢复提示由工具结果提供，历史上下文中的旧状态不覆盖新的有效状态。

---

<a id="design-13"></a>

## 未来：upstream 多根工作区

本设计不解决多根工作区，但相关发现值得作为上游议题：

**现状**：`writableRoots(policy)` 硬编码 `[workspaceRoot, "/tmp", tmpdir()]`；`SandboxPolicyService.resolve()` 用 `session.header.cwd` 派生 workspaceRoot；fs 围栏与 Seatbelt profile 共用该函数。

**最小改动方案**：

1. `dsh-sandbox` 的 `writableRoots(policy)` 接受 `policy.workspaceRoots`（复数，主根为首）——**一处改动，fs/bash 两层同时生效**；
2. `dsh-sandbox-policy`：policy 类型加字段，`resolve()` 从 workspace 注册表补成员根；
3. `dsh-workspace`：workspace 记录加有序 `memberPaths`（复用规范路径唯一机制）；
4. `renderPolicyContext` 枚举全部可写根（模型需要知道边界）；
5. workspace controller API + Web UI 的"添加文件夹"入口。

**安全约束**：成员根的增删必须是用户显式操作，不能是模型可调用的工具。

**过渡方案**：子 agent 委派（`subagent` 支持 cwd，子 agent 有自己的会话与沙箱边界），每文件夹一个，原生权限齐全。

---

<a id="glossary"></a>

## 附录：术语入口

术语已统一维护在[产品术语与判定阶段](terminology.md)。本锚点保留以兼容旧引用；本章不再维护另一份术语定义。
