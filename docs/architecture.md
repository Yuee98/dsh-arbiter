# 总体架构与运行模式

描述单插件的执行链、命名与包结构、子 agent、审批模式、预设接入和上游扩展边界。

状态（2026-10-21）：首轮完整功能版本已实现并可在隔离 DSH 0.2.1-rc.2 profile 中试用；产品语义未定项仍按本文与[决策记录](decisions-and-questions.md)保留讨论状态。实现证据、初版选择与剩余缺口见[首轮实施报告](implementation-report.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [命名与目标运行时](#naming)
- [总体设计](#design-3)
- [工具与执行路径覆盖范围](#execution-coverage)
- [子 agent（智能体团队）场景](#design-5-6-1)
- [审批模式](#design-6)
- [预设与 UI 接入](#design-7)
- [权限选择器与启用状态（已确认）](#permission-selector-contract)
- [切换、停用与卸载](#permission-lifecycle)
- [审批拒绝的展示与会话继续](#approval-rejection-feedback)
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
3. **预设槽位互斥**：`registerAuto()` 是单槽，两个提供者不能同时成功拥有该槽；这不保证另一插件不会留下独立监听器。本轮用户已确认 arbiter 替代官方 Auto Review，两者互斥，其他宿主 guard 照常生效。

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
│   ├── "type": "module", main/exports → lib/index.js, lib/client.cjs
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
│   ├── client.cjs            # 浏览器半侧：配置页
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
| 插件自有数据目录 | `$DSH_HOME/arbiter/`，按持久化 DSH 数据实例归属；同实例审计共享库，保留 profile／项目／会话标识，见[数据归属](configuration-and-audit.md#audit-retention) |
| 斜杠命令 | `/arbiter status` 等只读入口；trusted / guarded 与审批模式均在设置页选择。初版 `/arbiter mode` 不是当前产品切换入口 |
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

核对对象为本机安装的 **DSH 0.2.1-rc.2（macOS 27.0.1 / arm64）**。2026-10-20 重新读取安装包源码，同日完成第一轮宿主机实测。下表的“能力”列区分两类依据：**源码**表示调用链已确认；**实测**表示在隔离 profile 中用探针真实跑过，逐项见[覆盖范围证据](../evidence.md#evidence-22)与[本轮报告](../validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)。两类都**不表示 dsh-arbiter 已实现**，也不外推到未测的 profile、preset 与 surface。2026-10-21 的首轮插件实现已复用这些入口并补充了插件级集成验证；插件自身已接入的路径与仍未验证的组合见[首轮实施报告](implementation-report.md#3-检查命令与结果)。

统一接入点是 `tools/pre-execute`：调用进入 DSH 工具流水线时，可以在工具主体执行前作出权限判定。能拦截入口，不等于能观察该工具实现内部的每一个效果；程序直接调用宿主服务，也不一定经过工具流水线。

**监听顺序**（实测）：headless 组合下，`tools/pre-execute` 里除探针外还有一个 `prepend` 监听；加入官方 auto-review bundle 后变成两个——与源码中 `dsh-tool-jobs` 和 `dsh-experimental-auto-review` 都以 `{prepend:true}` 注册一致。两者都早于 profile 层，插件再用 `prepend` 只能排到同组之前、**仍在这些监听器之后**（`g1-a`／`g1-g`／`g1-h`）。因此“规则短路先于其他审查”不能仅靠 `prepend` 保证，见 [O11](decisions-and-questions.md#question-o11)。

| 工具／执行路径 | 接入能力 | 依据 | 实测限制与未验证项 |
|---|---|---|---|
| 直接调用注册工具，如 bash、文件编辑、web、终端工具 | 可在工具主体开始前取得工具名、参数和调用身份，允许或拒绝整个调用 | 源码 + 实测 | 探针 allow／deny 在 bash 与 `write` 上均生效；web／终端等工具未逐一实测（同属 registry 派发）。shell AST 仅适用于相应命令参数 |
| bash／终端启动的脚本、程序及其子进程 | 能审查启动它们的工具调用 | 源码 + 实测 | `g3-c`／`g3-i` 显示子进程不产生独立门禁，探针只看到 `bash` 本身；脚本内部文件操作、网络请求不能逐项过同一门禁。审查输入是否含脚本正文仍是另一项能力 |
| **外层 `run_code`** | 可接入；外层也走 pre-execute，参数包含程序文本 | 源码 + 实测 | `g2-b` 实测外层 deny 时程序未启动（标记文件不存在、无内层派发）。本轮已确认先规则后程序文本审查，不能送入 bash AST；长程序允许带明确标记截断，详见[PTC 契约](rules.md#design-4-7) |
| **`run_code → tools.bash` / `tools.<其他工具>`** | 每个实际发出的内层调用分别进入工具流水线，带真实参数、`parent` token 和 `rootCallId` | 源码 + 实测 | `g2-c`／`g2-d` 实测内层 deny 可被程序 catch、外层继续；两个并发内层各自进入 pre-execute，一放一拒互不取消。`callId` 形如 `<outer>:ptc:<n>`，`parent` 是 execution token 而非 agent。已发生效果不回滚 |
| **`run_code → tools.mcp__…`** | MCP 工具已注册到同一 registry，使用同样的内层派发路径，可在 MCP 请求发出前拦截 | 源码 + 实测 | `g4-c` 实测内层 MCP 调用逐次进入 pre-execute，被拒的那次未到达服务器。动态工具列表、schema 更新、命名规范化与服务断连未测 |
| **`run_code` 直接调用 Node API**：`fs`、`fetch`、`child_process` 等 | **没有逐效果的工具门禁**；只能控制外层程序准入。Node 运行时在非 full-access 下调用沙箱 | 源码 + 实测 | `g3-a`／`g3-b` 实测三类效果都实际发生而探针只看到外层 `run_code`；文件沙箱只改写入边界，不限制读取、网络或子进程。宏观准入不等于逐项审查 |
| **直接调用 MCP 工具**：`mcp__<server>__<tool>` | MCP bridge 将工具注册到 DSH，body 内才发送 `client.callTool`，因此入口可拦截 | 源码 + 实测 | `g4-b` 实测 deny 时服务端已完成握手但**没有收到 `tools/call`**，即拒绝发生在 RPC 之前。服务器内部的数据库、文件、二次网络请求不能逐项拦截；DSH 会话文件沙箱也不等于远端服务的执行沙箱 |
| MCP 资源工具：`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | 都注册为普通 DSH 工具，可审查 server、URI 等参数 | 源码 + 实测 | `g4-d` 实测 list／read 到达服务端；`g4-e` 实测 deny 时服务端没有 `resources/read`。资源访问授权仍由服务端负责；模板工具未单独实测 |
| MCP server 启动、连接、工具发现／重连及服务内部操作 | **不由上述逐工具门禁覆盖**；MCP client 直接创建 transport、发现工具 | 源码 | 本轮未测重连与动态列表；不承诺整个 MCP 协议／服务生命周期受控 |
| **通过委派工具创建 subagent** | 委派本身是工具调用，能审查任务、目标后端及参数 | 源码 + 实测 | `g5-a`／`g6-d` 实测 `subagent`／`subagent_fork` 入口可审查。本轮确认将委派入口纳入规则与审查；批准委派不替代子任务的逐调用判定 |
| **进程内 subagent：spawn／fork** | 子任务为本地 Agent，工具调用走同一宿主流水线；全局／所属上层作用域监听器可接收其事件 | 源码 + 实测 | `g5-a…g5-e` 实测两种子任务的工具调用都进入 pre-execute（allow 执行、deny 阻止）；子会话 header 含 `parentSession`／`origin:"subagent"`／`delegationDepth`。创建时 `approval/policy: never` 不阻止插件先行 allow。不同 preset、冷恢复、后代与并发会话未测；`exec.parent` 不能用于识别 subagent |
| **进程外／外部后端 subagent** | 可审查经工具发起的委派；通用外部后端路径只管理 run/result，没有本地子 Session | 源码 | **未运行**：本轮无可用外部后端。不能承诺共享本插件策略，需单独集成 |
| workflow 工具及其编排路径 | workflow 工具入口可拦截；其实现直接调用 PTC runtime 与 subagent 服务，内部步骤不会自动产生对应的 `run_code`／委派工具门禁 | 源码 + 实测 | `g6-a` 实测入口 deny 后没有创建子任务；`g6-d` 实测 workflow 内部创建子任务**不产生** `subagent` 入口，而直调委派会；`g6-b`／`g6-c` 实测子任务自己的工具调用仍受各自门禁。后台、取消与生命周期组合未测 |
| 沙箱升权：bash／`run_code` 的 `sandbox_permissions` | 工具入口可见参数；工具主体内部另调用原生审批服务 | 源码 + 实测 | `g7-a`／`g7-b` 实测工具 allow 后仍进入 `approval/asked`，`never` 下被拒且无效果；`g7-c` 实测无应答者时为 `unavailable`。**真实人工审批未运行**；allowed-once 只由模拟应答器产生（日志标 `simulated: true`）。插件 allow 不等于已批准升权 |

**运行环境也影响覆盖**：表中结论只适用于插件实际安装并生效的 Host／profile。Web、headless、独立 DSH 进程和外部 agent 不因一个实例启用插件而自动覆盖。**用户已确认：首版不接管没有 `exec.agent` 的程序化工具调用，明确列为覆盖边界。** 这类调用交回宿主原流程，其他工具校验与 guard 仍按各自契约处理；跳过 arbiter 不记作 review-allow、deny 或人工结果。

这里的“无 agent 调用”具体指工具执行 API 的调用方省略 `ToolExecutionInput.agent`，如自行调用 `ctx.tools.execute(...)`。源码与官方提醒插件文档支持这项能力，但本轮尚未找到随附业务插件实际采用此方式的确定调用点，也未运行该场景；不得描述为已验证的常见后台路径。正常模型工具调用携带 agent，PTC 内层继承外层身份；自动化、headless 或后台运行本身不意味着没有 agent。插件直接使用 Node／宿主服务而不进入工具 registry，则是另一个既有的逐工具门禁覆盖边界，不能与省略 agent 的工具执行混为一谈。详见[源码澄清](../evidence.md#agentless-tool-api)。

**子任务归属契约（本轮确认）**：委派和向现有子任务发送消息，是发起 agent 自己的工具调用，按其规则与审查模式处理；子任务内部的调用由子任务所在执行环境审查，父端不重复接管其内部每次调用，也不把委派批准记作后续执行授权。`send_message` 的工具包装源码支持接入，独立运行验证尚待补充；外部后端内部的原生审查能力不因此成为本插件已覆盖。workflow 内部服务直调仍按上表的入口与内部边界表达。

**产品表达建议，待确认**：把“本次调用是否经过插件判定”“可见内容到哪一层”“当前执行沙箱”分别展示。对外可承诺“审查已接入的 DSH 工具调用”，不能仅凭这些 hook 承诺“所有动作均已审查”。配置页展示静态支持范围，单次调用详情展示实际接入与判定情况。

<a id="approval-provider-coexistence"></a>

### 审批提供者共存与冲突（已确认）

arbiter 替代官方 Auto Review，两者在重叠作用域内互斥；宿主沙箱和其他 guard 保持正常作用。**不维护第三方互斥插件名单**：仅官方做明确互斥识别，其他插件按可观测的 tools/pre-execute、审批相关接口等行为提示可能冲突，不据此自动停用 arbiter。正常宿主 guard 属于执行约束，不因参与权限限制就视为互斥审批插件。

| 状态 | 已确认的行为 |
|---|---|
| arbiter 尚未接管，官方 Auto Review 已实际运行 | 阻止 arbiter 接管审批；保留设置、规则测试、历史与诊断入口，提示关闭官方并提供打开插件管理的入口 |
| arbiter 运行后发现官方冲突 | 保留已有门禁及当前模式、规则、在途结果和审查流程；弹一次通知并持续显示冲突状态 |
| 其他插件出现可能影响审批的接口行为 | 轻量告警，展示可取得的接口与来源信息，继续按原模式审查 |
| 官方仅安装、已关闭且不再运行 | 不据此阻止 arbiter 接管；不能只依据磁盘开关判断已停止 |
| Auto 槽实际注册失败 | 如实显示该入口未能接管及可取得的诊断；不能假装完整启用。这是注册能力约束，不是第三方名单策略 |
| 冲突消除 | 重新核对 arbiter 是否实际生效及当前宿主预设，再清除冲突状态 |

**告警与审批分开**：同一连续冲突期只提醒一次；关闭通知表示已读，不表示冲突解除。通知不等待用户回答后才放行工具，不把全部调用改成 force-ask，也不因检测到其他监听器而把正常调用记成 error-escalate。strict／progress 中 force-ask 会按既有契约 fallback-deny，因此统一强制人工会改变整档模式的行为，不采用该方案。不自动关闭其他插件。

官方冲突使用一次弹窗，其他潜在冲突使用轻量通知；设置或状态界面持续显示尚未解决的问题。没有连接前端的 headless 场景保留状态与日志，可用界面重连后读取当前状态。前端覆盖层与 Modal／Toast 的源码能力已有依据，具体检测、通知及重连仍需运行验证，见[冲突检测证据](../evidence.md#conflict-detection-source)。

Auto 槽只允许单一注册，所以在 arbiter 运行后启用官方可能只是配置已保存或官方加载失败；必须核对实际运行状态及清理结果，不能推断双重审查已发生。关闭冲突插件也可能改变宿主预设，恢复时需要核对 arbiter 的实际生效状态，不能仅凭官方开关变为关闭就显示问题已解决。

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

**启用判断**：读取插件的实际会话启用状态及所属覆盖范围，不能只比较原生预设名称。子任务可能因宿主旋钮组合而显示不同预设；不能据此漏掉已接管范围内的调用。父子范围映射需在接入中验证，不改变子任务共用 strict / progress 的既定设置；见[权限选择器契约](#permission-selector-contract)。

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

宿主已有能力与限制（源码核对，不等于下述新接入已实测）：

- Auto 为单槽，官方 Auto Review 与 arbiter 不同时接管；安装与关闭提示按[共存契约](#approval-provider-coexistence)，不因开发自动移除日常 profile 的 bundle；
- **宿主权限预设服务**固定 `auto = danger-full-access + ask`，不是官方 Auto Review 插件自行选择；`registerAuto(admit)` 只接收准入回调，不能配置沙箱。改成工作区沙箱后，派生预设不再是 auto；
- 原生权限控件的 Auto 文案与确认逻辑由宿主前端提供；原生控件不能通过 `registerAuto` 改名，不代表插件不能在相同 slot 提供自己的控件；
- `auto` 不能作为新会话默认值（设置页只列配置预设）；
- 官方卸载会将仍为 auto 的会话切到 `danger-full-access` 并主动取消在途审查；arbiter 不照抄该回退与取消行为，目标见[生命周期契约](#permission-lifecycle)。

用户已选择不依赖上游修改的**同位置权限选择器方案**。不改 DSH 核心包、不篡改 AUTO_PRESET_SPEC，也不把工作区沙箱伪报为原生 auto。源码依据与待验证边界见[权限 UI 补核](../evidence.md#permission-ui-source)。

**实测补正（2026-10-21）**：`/permission auto` 在 `registerAuto` 存活时被宿主接受，并**立即**按固定 spec 展开为
`danger-full-access` + ask。该实测只证明"准入已接受后 auto 只能展开成固定组合"，不证明没有公开的拒绝路径。
2026-10-22 复核确认 `apply()` 在写预设／旋钮之前同步调用 `autoAdmit`。

**拒绝已实现并运行确认（2026-10-22，运行 id `2026-10-22-permission-recovery-01`）**：arbiter 在
`registerAuto(admit)` 的回调中抛出 `AutoEntryRejected`。因为该回调先于任何权限写入执行，guarded、trusted 以及
未启用 arbiter 的会话在 `/permission auto` 上都会**在权限变化之前**失败，`permission/preset`、`sandbox/mode`、
`approval/policy` 均不追加，错误反馈指向自有菜单。宿主**没有**先扩为 full-access 的窗口。见
[本轮报告](../validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md#f2)。

<a id="permission-selector-contract"></a>

### 权限选择器与会话启用状态（已确认）

插件在 `conversation.input.permission` 位置提供自己的权限选择器，保留宿主其他权限选项，并提供单一“自动审查（Arbiter）”入口；具体显示名称可调整。trusted / guarded 放在插件配置页，不在权限菜单中拆成两个独立入口。该方案的产品方向已确认；基础 slot 覆盖、命令同步、重连及探针卸载还原已于 2026-10-21 验证。正式拒绝入口、真实管理器及其他新增场景按[本轮交接](permission-recovery-followup.md)修复／补测，不能外推为全部生命周期已通过。

#### 接入约束（本轮实测确立）

| 约束 | 内容 | 权重 |
|---|---|---|
| slot 注册面 | 必须用 `ctx.slots.inject('conversation.input.permission', …)` 注册。该 slot 由 conversation 在插件之后声明，直接 `register` 会抛 `slot … is not declared` | 硬约束 |
| 覆盖优先级 | `conversation.input.permission` 是 `kind: 'single'`。`SlotCore.entriesOfSlot` 按 **priority 升序**取第一个，**数值越低越优先**；native 在 0，自有控件必须用负值。同一 priority 重复注册直接抛错 | 硬约束，与常见直觉相反 |
| 命令同步接入点 | 只观察 `session/event` 的 `type === 'command/run'`、`data.name === 'permission'`、`data.args`。该事件在 handler 之前 commit，因此同值切换也可见 | 硬约束 |
| 观察者内写入 | `session/event` 观察者运行在宿主 commit 内部，此时 `session.append` 会被判为重入并抛错；状态写入必须 defer 到下一拍 | 硬约束 |
| 启用记录 | 必须用 `dsh-session` 的 `appendPluginRecord(session, type, data)`（写 `ignorable: true`）。`session.append('plugin:…')` 不带该标记，冷读会拒绝整份日志 | 硬约束，影响恢复 |
| 退出入口 | 审批挂起时 composer 被宿主禁用，斜杠命令不可用；自有菜单需要直接调用 `session.command()` 或依赖原生控件 | 接入注意 |
| auto 语义 | 原生 `/permission auto` 拒绝；自有选择器通过后端独立状态启用 trusted／guarded，不借助原生 auto 承载启用状态 | 拒绝**已实现并运行确认**；自有选择器的会话启停仍未接入正式客户端 |
| auto 恢复 | `admit` 无参数，无法直接区分"用户切换"与"恢复已存 auto 身份的旧会话"。实现用公开的 `command/run` / `command/done` 生命周期区分：有进行中的 `/permission` 命令即视为用户切换并拒绝，否则视为恢复并放行 | 推断而非接口保证，已登记缺口 |
| 卸载顺序 | `accepting = false` → **立即回退**仍受管且权限确实更宽的会话 → 再等待在途（≤30s）→ 释放。回退必须先于等待：停接管后到达的调用已不受门禁保护，只能靠宿主权限约束 | 已运行确认；顺序由集成用例与回归测试双重固定 |
| 卸载范围 | 用公开的 `sessions.list()` 枚举存活会话并折叠其准入记录，不只处理"本进程门禁见过的会话"；回退写失败时该会话保持 fail-closed，teardown 期间到达的调用被拒绝而不是按旧权限放行 | 集成用例覆盖 `sessions.list` 与失败回退；真实宿主重启用例覆盖冷恢复后的回退 |
| 继承受管的子任务 | 子任务的沙箱是宿主在委派时捕获的，插件不会主动放宽它。因此根会话停用、边界改回 guarded、总开关关闭或卸载时，仍受管的子任务也要把捕获到的沙箱收窄；子任务的审批策略由宿主固定为 `never`，插件不改写。发现存活会话时按**实际范围**（父链解析）判定，而不是按"有没有自己的记录"，否则继承子任务会在发现阶段被误删。 | 集成用例覆盖 `sessions.list` 返回的未观察子任务、trusted → guarded 变更、API 停用与卸载；真实宿主用例覆盖子任务委派 |
| 总开关关闭 | `enabled: false` 只是停止门禁，不等于权限已回收。配置激活时对所有受管会话先做一次收窄（主会话回到 `workspace-write + ask`），冷启动再补做一次；**之后才被打开的会话**在它第一次调用进入门禁、插件即将让行之前收窄，收窄无法确认时拒绝该调用而不是放行。记录保留，重新开启仍可恢复。 | 集成用例覆盖 trusted → 总开关关闭、事后打开的会话与未受管会话不被改写 |
| 准入失败的安全方向 | 记录先于放宽写；guarded 启用后若宿主未确认 `workspace-write`（写入被拒或根本没有沙箱事件），启用失败并写一条停用记录补偿。之后的每次门禁调用也按**实际沙箱**复核：guarded 配置下无法重新确认时该调用直接拒绝，而不是按旧记录继续审查放行。teardown 的收窄写入有界重试；最终重试校验完整目标（主会话 `workspace-write + ask`，子任务仅沙箱），只有全部满足才清除 fail-closed。 | 集成／卸载用例覆盖记录顺序、拒绝写入、批准策略单独失败、guarded 复核失败与状态上报 |
| 显式停用 | API 停用的前置条件是把仍未收窄的会话收窄并确认；宿主拒绝收窄时返回失败并**保留门禁**，不写停用记录。针对继承受管的子任务停用同样先收窄其沙箱，否则新的停用记录会让它带着父会话的宽权限脱离门禁。原生权限切换由用户自己选择目标权限，不适用该前置条件。 | 集成用例覆盖"沙箱写入被拒时停用不生效"与"停用继承子任务先收窄" |
| 退出即结算 | 任何让会话离开门禁的动作（原生切出、API 停用、发现阶段失去受管资格）都要先结算权限：父会话原生切出只改父的沙箱，继承受管的子任务仍持有委派时捕获的权限，因此退出必须收窄整棵子树（子任务的 `never` 审批不改写）；`discover()`/`scopeFor()` 丢弃覆盖前同样收窄，不能只从集合里删除。 | 集成用例覆盖原生切出后的子任务、冷恢复后由发现阶段重分类的子任务；卸载用例覆盖 `sessions.list()` 路径 |
| fail-closed 可恢复 | fail-closed 是"复核触发器"而非终态：每次调用先重试收窄并校验完整目标，确认后清除标记并继续按准入处理；只有仍无法确认才拒绝。否则一次瞬时写入失败会让该会话在本插件生命周期内永久不可用。 | 集成用例覆盖"失败时拒绝、宿主恢复后放行"两个方向；卸载用例覆盖重试清除 |
| 启用失败不撤保护 | 重新启用一个已被受管的会话时，若 guarded 无法确认，不能写停用记录：那会把仍有宽权限的会话变成无门禁。保留原记录并标记 fail-closed，等后续确认后恢复。只有此前未受管的会话才撤回这次新启用。 | 集成用例覆盖"已受管会话再次启用失败后仍受管且被拒绝" |
| 缺失沙箱事件不等于安全 | 会话日志里没有 `sandbox/mode` 时不能当成"已经很窄"：部署默认可能是 full-access。受管会话一律显式写下目标值（启用、复原、收窄、卸载都如此），再按写下的实际值判断；只有观察到 `workspace-write`/`read-only` 才算安全。主会话还要求审批为 `ask`，子任务只要求不是 full-access（授权策略由宿主固定）。 | 集成用例覆盖无沙箱事件时的 guarded 启用与首次调用；卸载用例覆盖无事件的主会话被显式写入 |
| 卸载顺序的反例 | 先等待在途再回退时，drain 窗口内到达的调用会在旧 `danger-full-access` 下免审执行（2026-10-22 实测复现：写出 workspace 外文件，回退事件晚于该次执行） | 已修复，见[补测报告](../validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md) |
| 记录写入 | 只能用 `appendPluginRecord`（`ignorable: true`）；该包在 profile 未声明时按"裸导入 → 运行中宿主安装根"解析 | 运行确认 |

| 概念 | 用户入口与作用范围 | 含义 |
|---|---|---|
| 会话启用状态 | 当前会话权限选择器 | 选择自动审查后接管该会话的新调用；切到其他权限模式后停止接管新调用。安装插件或打开配置页不自动启用任何会话 |
| 执行边界 | 插件配置页的 trusted / guarded | 在该插件配置作用域内，决定已启用会话放行后是否仍受工作区文件沙箱约束；改变它不等于停用 arbiter |
| 审批模式 | 插件配置页的主会话三档／子任务两档 | 选择审查策略及插件是否新发起人工审批，与启用状态和执行边界分开 |

**首次默认配置（2026-10-24 已确认）**：执行边界 guarded，主会话 normal、子任务 strict；安装不自动启用任何会话。Reviewer 与初始规则等完整默认值见[初始配置](configuration-and-audit.md#initial-defaults)。

| 当前会话选择 | arbiter 状态 | 实际宿主执行边界 |
|---|---|---|
| 自动审查 + trusted | 启用 | `danger-full-access + ask`；由自有入口应用，不调用已拒绝的原生 auto |
| 自动审查 + guarded | 启用 | `workspace-write + ask`；宿主派生预设可能显示 workspace-write，插件控件仍明确显示 arbiter 已启用及 guarded |
| 宿主其他权限模式 | 停用 | 应用用户选择的宿主权限，不因该组合与 guarded 相同就继续接管 |

启用状态由后端管理，并保留恢复所需的会话信息；前端只显示后端确认的状态。不能用 `current === auto` 或 `current ∈ {auto, workspace-write}` 代替启用状态，也不能从“没有审计记录”推断已停用。持久化依托宿主会话机制等独立运行状态，不依赖审计 SQLite；具体事件字段、写入与宿主权限切换的原子性待验证。新会话或缺少启用证据的会话不能仅因插件已安装、配置中选择 guarded 或宿主为 workspace-write 就被自动接管。

**范围解析**：每次门禁与 teardown 都用同一份解析。子任务沿有界父链向上找最近的带记录祖先，记录停用则整支不算受管；父链不可解析或成环一律不接管。对外视图与记录里的 `rootSessionId` 是父链顶端的主会话，不是直接父会话（多层委派时两者不同）。fork 会复制父会话日志前缀，因此记录只对写入它的会话生效，子分支不继承父会话的启用。

**实现（#4，`src/host/admission.ts`、`src/host/session-admission.ts`）**：每次启用／停用写一条 `plugin:arbiter/admission` 可忽略记录（`version`、`sessionId`、`rootSessionId`、`enabled`、`boundary`、`at`），折叠时取最新有效记录；同一会话上较近的停用记录优先于祖先的启用记录。子任务沿 `header.parentSession` 向上解析，只有最近的带记录祖先启用时才受管；父链不可解析或成环一律不接管。启用顺序是**先写记录（门禁已覆盖），再放宽沙箱**；显式停用（API）先把仍被插件放宽的会话收窄回 `workspace-write + ask` 再写停用记录，而原生命令切出由用户自己选择权限、记录不覆盖。折叠同时接受"记录之后成功完成的 `/permission <preset>` 命令对"与"没有命令在途时的 `permission/preset`"作为退出证据：同值切换不写任何权限事件，只有命令对能证明意图；而来自其他入口（选择器直接 `presets.set()`）的预设写入没有命令对，其本身即持久证据。命令进行中写入的预设不计，失败命令也不能借自己的半截写入退出。记录携带写入时的 `sessionId`：fork 会复制父会话日志前缀，属于其他会话的记录不计入本会话，避免子分支继承父会话的启用状态。`/api/arbiter/sessions` 返回后端确认的 `enabled`／`boundary`／`admissionRevision`／`seq`，不提供按会话覆盖边界。

权限菜单选择及受支持的原生命令切换必须同步到同一个后端状态。尤其是 guarded 下再次执行 `/permission workspace-write`：即使实际沙箱／审批值已经相同，也必须能够表达用户退出 arbiter 的意图；不能只监听值变化事件。原生 `/permission auto` 按下节拒绝；其他命令失败也不得提前停用 arbiter。观察命令意图、更新内存状态与延后持久化的时序必须保持一致；公开接口若有限制应回填缺口，不能把“没有事件”记作同步成功。

<a id="native-auto-rejection"></a>

#### 原生 auto 入口拒绝（2026-10-22 已确认）

在 arbiter 作为审批提供者的配置作用域内，**原生 `/permission auto` 不作为支持入口，trusted／guarded 两档均拒绝**。自有菜单中的“自动审查（Arbiter）”正常启用两档，其他宿主权限命令仍正常切出。该约定不干预其他独立 profile 的官方 Auto Review。

拒绝必须发生在权限变更之前，保持会话原有的启用状态、执行边界、宿主沙箱／审批策略及已有在途请求；不得先进入 full-access、先停用 arbiter，再提示错误或事后回退。`command/run` 只表示命令开始，不能据此提交一次成功的退出。通过 `session.command()` 或原生选择器到达同一原生命令时，也不能绕过该约定。

反馈明确指向自有菜单，例如“此入口不受 Arbiter 支持。请在会话权限菜单中选择‘自动审查（Arbiter）’。”这是权限入口错误，不伪装为 review-deny、human-deny 或审批链的新阶段。若采用不注册入口的实现，需核对错误反馈、自有入口、既有 auto 会话迁移及共存检测；若保留注册，则补测准入回调拒绝及其副作用边界。字段与注册方案留给实现，结果要求不变。

前端卸载、页面刷新、断连重连都不自行改变会话权限。重连后以当前后端状态恢复展示，不用旧页面的乐观状态重新启用／停用会话。原生权限控件保留为覆盖撤销后的回退；不能通过修改 DOM 或隐藏文字来伪造接管状态。

**运行验证（2026-10-21）**：上述四条前端生命周期均已在真实 Web 客户端上确认——刷新保持后端状态；断连期间由第二连接改变状态后重连采用新值；迟到响应未复活旧值；移除客户端覆盖后原生控件回归且后端 `enabled`／`revision` 不变。冷恢复、新会话不误启用、审计库缺失下的恢复也均已确认；启用状态保存在会话日志的可忽略插件记录中，不依赖审计 SQLite。

<a id="design-7-2"></a>

### trusted / guarded 设置入口

两档在插件配置页选择，使用既定的“保存并应用”流程。保存成功后对作用域内已启用会话的后续调用应用对应执行边界；未启用会话不因修改该设置而被启用或改写权限。审批模式仍独立选择。旧稿和首轮实现中的 `/arbiter mode trusted|guarded` 是早期入口，不再作为当前产品方案。

guarded 下，规则 allow、review-allow 或 human-allow 只完成插件准入，不能豁免宿主文件沙箱；越界写入仍可能失败，agent 可按宿主机制显式申请单次提权，插件不自动批准该升权。trusted 下没有这层工作区写入限制，其他宿主 guard 仍生效。

<a id="permission-lifecycle"></a>

### 切换、停用与卸载

| 动作或状态 | 目标契约 |
|---|---|
| 切入自动审查 | 校验插件可接管及共存条件后，启用当前会话并应用配置中的执行边界；失败不得显示已启用 |
| 切到其他权限模式 | 停止接管新调用，按用户选择应用宿主权限；不把切换解释为对已有请求的批准或拒绝 |
| 模型审查已经发出 | 不会仅因切出或插件卸载而主动取消；保留已有快照、协议与结果，允许推进收尾，遵守[配置生效边界](approval-modes.md#configuration-activation) |
| 人工审批已经弹出 | 不会仅因切出或卸载而撤销、代批或记作 human-deny；保留宿主请求等待其实际结果 |
| 停用／卸载整个插件 | 停止新接管，将仍由 arbiter 接管的会话回退到“工作区写入”（`workspace-write + ask`）；已切到其他权限模式的会话保持原样。收尾后释放资源、撤销 UI 覆盖，保留用户规则、配置与日志 |

“不主动取消”不等于保证宿主取消后仍继续。DSH 会在沙箱模式变化时取消受影响的运行中 PTC／run_code；其内部模型或人工等待也可能随调用取消。应记录真实取消原因，不能伪装成人工拒绝或普通 review-deny。进程退出也不承诺后台审查继续运行。

卸载可有等待在途请求收尾的阶段；需要验证模型返回后仍可完成后续处理、人工请求保留时是否阻塞卸载、资源释放是否过早，以及已关闭会话恢复时是否残留不可恢复的 auto 身份。以上是目标与工程验证项，不宣称已经实现完整热卸载或冷恢复。仅客户端断连／覆盖层卸载不等于停用整个插件。

本轮只验证[权限菜单、命令、重连与卸载四组能力](permission-ui-validation.md)，不重新执行全部宿主覆盖清单或扩大到完整功能实现。

**运行验证（2026-10-21）**：探针通过 `ctx.fiber.dispose()` 验证 `stop new work → drain → roll back managed sessions → release` 的最小实现；
在途 8 s 审查未被插件取消（`outcome: done`、`signalAborted: false`），卸载等待 7.8 s 后才回退并释放；
已切 `read-only` 的会话被跳过而非被改写；关闭会话在卸载后重新打开可正常加载且不被重新启用。
**仍未验证**：真实人类审批答复、`run_code`／PTC 在沙箱切换下的宿主取消（本机 `sandbox-exec` 不可用）、
DSH 原生 `plugin_manager` 热卸载与强制进程终止。

还需验证真实管理器停用／卸载时的依赖拆除顺序，以及等待收尾期间新调用如何处理；单个在途调用完成不证明该等待窗口内的新调用已被妥善处理。

本轮后续已授权修复正式会话记录写入与原生入口拒绝，并补测真实管理器、新调用、人工答复及 PTC 取消。收尾等待期间的新调用不得在旧 trusted 权限下绕过门禁执行；可等待迁移到宿主目标权限后处理，或明确结束当前调用，不冒充人工拒绝。已有审批链继续推进所需的资源应保留，不能因拆除过早而失败或死锁。具体任务、证据分级及未完成项见[修复与补测交接](permission-recovery-followup.md)。

**正式补测后的复核（2026-10-22）**：管理器基本停用／卸载及真人答复已取得运行证据；原驱动等待的日志写在延迟结束之后，
在途与收尾窗口一度不能结案。这两项均已由[时序补测](../validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md)结案：
夹具改为等待前记录并以可控屏障释放，由此复现并修复了"先 drain 后回退"的真实缺陷；
审批中切换也不是宿主封锁——换不同预设并经公开 `session.command` 调用成功，审批保持挂起。
产品要求不变。

<a id="design-7-3"></a>

### 可见性

原稿已预留插件向 system prompt 贡献运行时上下文的方案。[执行指引](#agent-instruction-placement)复用这一入口；不再另设一套重复的长说明。下面只展示状态信息，具体注入 API 及主／子会话覆盖仍需验证：

```
当前执行模式：trusted（无沙箱兜底）
当前审批模式：strict（自动审批，不新发起人工审批）
规则命中数：allow 42 / deny 0 / force-ask 1
```

权限控件与状态页应显示后端确认的启用状态、实际执行边界和审批模式；不能只显示宿主派生的预设名称。如果保留运行时状态注入，配置变更后需反映实际生效值；当次调用的具体结果、原因和恢复提示由工具结果提供，历史上下文中的旧状态不覆盖新的有效状态。

<a id="approval-rejection-feedback"></a>

#### 审批拒绝的展示与会话继续（2026-10-22 已确认）

Arbiter 只负责自己产生的审批拒绝提示，工具执行结果、执行失败及沙箱错误的展示由 DSH 宿主负责。审批已允许但执行失败时，保留原有允许裁决，不由插件重新标记为审批拒绝，也不另建一套工具结果界面。

拒绝提示沿用宿主工具调用的布局与交互，在对应调用位置增加橙色图标和“Arbiter 已拒绝”标记，展示一行简短原因，并提供“查看详情”入口。会话入口按会话与调用标识直接打开日志中同一条记录的[调用详情](configuration-and-audit.md#call-detail)，共用同一个界面和三层信息结构，不另建审批详情页。橙色和图标用于醒目提示及区分来源，具体样式适配宿主主题；普通审批拒绝不额外弹窗或逐次弹 toast。真实阶段与终态仍须区分，不能把 `fallback-deny` 或 `human-abort` 写成“用户拒绝”。原生组件的复用程度与具体打开方式留待接入验证，不把本节需求记作已经实现。

拒绝仅结束当前工具调用，不由 Arbiter 主动中断整段会话或决定任务结束。插件将可区分的结果、实际判定链、原因及适用的运行时提示返回给执行 agent；例如输入截断应作为事实说明，不能自动等同于拒绝原因。用户侧摘要可以简短，agent 收到的信息应足以支持后续判断，具体原因合成见[拒绝理由](reviewer.md#design-5-7)。

agent 根据结果决定下一步：存在符合授权与策略的方案时继续；需要信息或授权时说明具体需求；判断任务无法推进时，结束当前轮并回复用户说明受阻与已完成部分。插件不要求每次拒绝后都向用户发消息，也不以恢复指引鼓励绕过仍生效的禁止条件。主／子 agent 的常驻说明与具体提示沿用[执行指引](#agent-instruction-placement)。

实时审批仍只处理当前操作，不在拒绝提示中加入“以后免审”捷径；首版规则创建与修改使用独立规则管理流程，[离线建议审核](configuration-and-audit.md#offline-rule-review)移到后续版本。

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
