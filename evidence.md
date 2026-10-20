# 调研证据与生态背景

> 资料快照：2026-10-20。源码条目针对本机 DSH 0.2.1-rc.2；价格、版本、下载量与竞品描述均保留当时口径。§18 的 ask 等待机制补充及 §22 的执行路径覆盖已重新读取本机安装包，并纠正 §13／§18 的父会话字段名；其余条目未重新核验。标为推定或推论的内容仍是推断。

入口：[README](README.md) · [设计导航](design.md) · [决策与待讨论问题](docs/decisions-and-questions.md)

原证据清单保留 §1–§21 编号，新增 [§22 执行路径覆盖核对](#evidence-22)。文末归并了原设计中的[个人配置灵感](#design-1-1)、[调研结论与竞品对照](#design-2)、[成本与额度](#design-5-9)，作为设计背景，不作为产品需求或当前市场状态声明。

本文件记录设计所依赖的源码核对、文档依据、实测与推断，供后续实现时复核，不能把源码核对等同于运行实测。凡标注"源码"的，均已从 DSH 0.2.1-rc.2 安装包（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）中提取实现代码确认。

---

<a id="evidence-1"></a>

## 1. 工具流水线

| 事实 | 来源 |
|---|---|
| `tools/pre-execute` 是可重排 waterfall，签名 `(exec, next)` | `dsh-tools/lib/index.js` |
| 返回 `{kind:"allow"\|"deny"\|"ask"\|"cancel"}`；`allow` 短路后续门禁 | 同上 |
| `exec` 字段：`token, callId, rootCallId, name, arguments, agent?, parent?, schema?, signal, deferContext, concludeTurn` | 同上 `createExecution` |
| `exec.arguments` 是 deepFreeze 后的解析参数 | 同上 |
| 流水线顺序：`pre-execute` → 单调 guard → `execute` → `post-execute` → `finalizeContent` → `result` | 同上 |
| `pre-execute` 明确禁止改写参数（日志与呈现会与实际执行脱节） | `dsh-tools/README.zh.md` |
| 监听器用 `ctx.on("tools/pre-execute", fn, { prepend: true })` 注册，包在 `ctx.effect(function*(){...})` 里 | `dsh-experimental-auto-review/lib/index.js:461` |

<a id="evidence-2"></a>

## 2. 审批 seam

| 事实 | 来源 |
|---|---|
| 结果词汇只有 `allowed-once` / `rejected` / `cancelled` / `unavailable` | `dsh-user-approval/lib/index.js:31-34` |
| `never` 策略在 waterfall 分发**之前**返回 `rejected` | 同上 `decide()`: `if (this.effectivePolicy(session) === "never") return "rejected";` |
| 请求只携带 `agent, toolName, callId, reason, displayReason, signal`，**不含工具参数** | `dsh-user-approval/README.zh.md` 已知限制 |
| 应答者是 `approval/request` waterfall 监听器，返回结果即作答，`next()` 委托 | 同上 |
| 无 `allow-always`、已记住规则、撤销、授权存储 | 同上已知限制 |
| `never` 会向模型注入句子："Approval prompts are disabled in this session…do not request sandbox escalation" | `dsh-user-approval/lib/index.js:39` |

<a id="evidence-3"></a>

## 3. 沙箱

| 事实 | 来源 |
|---|---|
| `writableRoots(policy)` 返回 `[policy.workspaceRoot, "/tmp", tmpdir()]`，`read-only` 返回空 | `dsh-sandbox/lib/index.js:166` |
| fs 围栏（`SandboxedFileSystem.checkedTarget`）与 Seatbelt profile（`seatbeltProfileArgs`）**共用** `writableRoots` | `dsh-fs-sandbox/lib/index.js:160`、`dsh-sandbox-local/lib/index.js:72` |
| `workspace-write` 拒绝时抛 `FS_SANDBOX_DENIED`，附 marker 与升权提示 | `dsh-fs-sandbox/lib/index.js:157-165` |
| Seatbelt profile 形如 `(deny file-write*)` + `(allow file-write* (subpath <root>))` | `dsh-sandbox-local/lib/index.js:64-73` |
| `danger-full-access` 下 `bash-sandbox.execute()` 直接 `super.execute(spec)`，**不 confine** | `dsh-bash-sandbox/lib/index.js:67-68` |
| `SandboxPolicyService.resolve()` 用 `session?.header.cwd` 派生 workspaceRoot | `dsh-sandbox-policy/lib/index.js:141-148` |
| `writableRoots` 无扩展点，policy 类型为闭集 `{mode, workspaceRoot}` | 同上两份源码 |
| 文档明确："每个会话只有一个主要工作区根目录——额外可写根目录不属于 `SandboxExecutionPolicy`" | `dsh-sandbox-policy/README.zh.md` 已知限制 |

<a id="evidence-4"></a>

## 4. 升权（escalation）

| 事实 | 来源 |
|---|---|
| `sandbox_permissions` + `justification` 必须在**执行前**提供（`approveBashEscalation` 在 execute 开头调用） | `dsh-tool-bash/lib/index.js:658` |
| `approveEscalation()` 走 `ctx.approval.request()`，返回 `allowed-once` 时给出更宽模式 | `dsh-sandbox/lib/index.js:99-123` |
| 升权目标是 `danger-full-access` 时，批准后整次调用无围栏 | `dsh-bash-sandbox/lib/index.js:67` |
| `never` 策略下升权被 waterfall 前拒绝 | 见 [证据 §2](evidence.md#evidence-2) |
| 拒绝结果附 `[sandbox: escalation available — retry this exact command once with sandbox_permissions...]` | `dsh-sandbox/lib/index.js:76` |
| bash 工具描述要求："a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way" | `dsh-tool-bash/lib/index.js:250` |

<a id="evidence-5"></a>

## 5. 权限预设

| 事实 | 来源 |
|---|---|
| base bundle 定义三个预设：`read-only`+ask、`workspace-write`+ask、`danger-full-access`+**never** | `dsh-base/cordis.patch.yml:264-277` |
| `AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" }`（写死） | `dsh-permission-presets/lib/index.js:58-61` |
| `AUTO_PRESET = "auto"`，`CUSTOM_PRESET = "custom"`，两者为保留名 | 同上:50-52 |
| `registerAuto(admit)` 单槽，重复注册抛 `preset "auto" is already registered` | 同上:258-268 |
| `names` = 配置预设 + `auto`（仅当已注册） | 同上:239-243 |
| `catalog()` 的 `defaultOptions` 只含配置预设（auto 不能当新会话默认值） | 同上:245-251 |
| `derive()` 在 sandbox 不匹配时返回其他预设计名，auto 不再是 `current` | 同上:295-306 |
| auto 身份在 `approval === "never"` 时也匹配（供子 agent 的 `never` 使用） | 同上:302 |
| 切换预设通过 `permissionPresets.set(session, name)`，写 `sandbox/mode` 与 `approval/policy` 事件 | 同上:349-360 |
| 客户端硬编码「自动审查 / Auto review」文案与 EXP 标记、风险确认 | `dsh-client-ui-permission-presets/lib/client.js`（locale 字符串命中） |
| 插件无法通过通用 API 发布其他预设 | `dsh-permission-presets/README.zh.md` |

<a id="evidence-6"></a>

## 6. 官方 auto review 实现

| 事实 | 来源 |
|---|---|
| 约 500 行，`export { apply, inject, name }` | `dsh-experimental-auto-review/lib/index.js` |
| `inject = ["approval","llm","permissionPresets","sessions","tools","workingDirectory"]` | 同上 |
| 启用判断：`permissionPresets.current(agent.session) !== AUTO_PRESET → next()` | 同上:463 |
| 跳过 `run_code` 外层：`exec.parent === undefined && exec.name === RUN_CODE_NAME` | 同上:462 |
| reviewer 用最新 request header 的 provider/model | `README.zh.md`「模型看到什么」 |
| `never` 下 reviewer 的 deny 终审；否则转 `askUser` | 同上:479-483 |
| `REVIEW_POLICY` 固定，含 low/medium/high 定义、来源角色规则（human-instruction / direct-parent / constraint / checkpoint / fact） | 同上:21-45 |
| 响应只接受 `{risk, decision, reason?}` 的三种合法组合 | 同上 |
| 不提供：确定性豁免、持久 grant、可配置策略、重试层 | `README.zh.md` 已知限制 |
| 无文件沙箱；外层 `run_code` 与 PTC 程序内直接 Node 效果不经 inner-tool review | 同上 |
| 卸载时把存活 auto 会话迁移到 `danger-full-access` 并写 `never` 审批策略 | 同上 |

<a id="evidence-7"></a>

## 7. 配置与凭据

| 事实 | 来源 |
|---|---|
| 插件页声明三个配置槽：`plugins.item`、`plugins.bundle.config`（键=包名）、`plugins.row.config`（键=`包名#行id`） | `dsh-client-ui-plugin-manager/README.zh.md`「配置页」 |
| 页面用 `view: 'page'` 渲染带保存控件的表单；离开丢弃暂存 | 同上 |
| 浏览器半侧需 `dsh.client` + `platform: "web"`，导出 `./client` | 官方伴生包 `package.json`（如 `dsh-client-ui-settings-web-search`） |
| `dsh-client-modules` 只把说明符恰为包名的浏览器半侧挂到那行 Loader | `dsh-client-ui-plugin-manager/README.zh.md` |
| Settings 服务编辑 `.volatile()` 字段，写 profile 的 Cordis patch | `dsh-settings/README.zh.md` |
| 自带页面的插件用 `ctx.inject(['settings'], …)` 注册 `configure({ auto: false }, ctx.fiber)` | 同上 |
| 凭据 seam：配置只写引用名，UI 只报存在性/来源/可写性，不回显值 | `dsh-credentials/README.zh.md` |
| `config-editor` 写入前验证完整候选值，与 profile 变更和 HMR 串行 | `dsh-config-editor/README.zh.md` |

<a id="evidence-8"></a>

## 8. 命令与上下文贡献

| 事实 | 来源 |
|---|---|
| `ctx.commands.register({ name, description, input?, handler })`，handler 返回 `success`/`error` + UI 文本 | `dsh-commands/README.zh.md` |
| 命令在 UI 命令平面执行，不产生模型消息 | 同上 |
| 插件可贡献 system prompt 段落（tool-bash 贡献 `tool:bash`，auto review 贡献上下文） | `dsh-tool-bash/lib/index.js:381`、`dsh-sandbox-policy/lib/index.js:122-128` |
| 会话自定义事件用 `session.append(type, data)` + `sessionProjections.register` 折叠 | `dsh-sandbox-policy/lib/index.js:40-42`、`dsh-permission-presets/lib/index.js:189-200` |

<a id="evidence-8-1"></a>

## 8.1 LLM 调用服务

| 事实 | 来源 |
|---|---|
| `ctx.llm.stream({provider, model, messages})` 返回分片流（block-start / text-delta / usage / finish） | `dsh-llm/README.zh.md`「最小组合」 |
| 提供方由适配器包注册，`ctx.llm.listProviders()` 列出路由 | 同上 |
| 插件可注册自己的适配器：`ctx.llm.registerAdapter(providers, adapter)`；重复路由以 `DUPLICATE_ADAPTER` 失败 | `dsh-llm/README.zh.md`、`dsh-llm/lib/index.js:1842` |
| `GenerateOptions` 采样字段只有 `temperature` / `maxTokens` / `stop`——**无 `tool_choice`、`top_p`、penalty** | `dsh-llm/README.zh.md` 已知限制 |
| `prefill`、逐工具 `strict`、内容块 `cache` 提示均为"无产生方"的变体（未实现） | 同上 |
| **无 `response_format` / `json_schema` 结构化输出能力** | `dsh-llm/lib/index.js` 全文无相关字段；适配器侧同样无 |
| 终止失败携带稳定 code：`NO_ADAPTER`/`MISSING_CREDENTIAL`/`AUTH`/`RATE_LIMIT`/`QUOTA`/`CONTEXT_WINDOW_EXCEEDED` | `dsh-llm/README.zh.md` |
| 服务自身不重试；重试属于 `dsh-llm-retry` | 同上 |
| 工具调用内容块类型为 `{ type: "tool-call", ... }` | `dsh-llm/lib/index.js:1031` |

<a id="evidence-9"></a>

## 9. 插件打包与分发

| 事实 | 来源 |
|---|---|
| 第三方包示例：`dsh-workbuddy-connect@0.7.8` 已在 npm，无 scope，peer 锁 `0.2.1-rc.2` | `npm view`；本机 profile `node_modules` |
| 需要 `cordis.patch.yml` 声明插件行（`- insert: [{id, name}]`） | 同上包；`dsh-experimental-auto-review/cordis.patch.yml` |
| `package.json` 的 `dsh.bundle.patch` 指向该文件；无此声明会被判 `not-a-bundle` | `dsh-plugin-manager/README.zh.md` |
| `engines.dsh` 不满足会在下载前拒绝；git/tarball 安装需 `git ls-remote` 可达 | 同上 |
| 依赖构建脚本会触发 pnpm `pendingBuilds`，需用户批准 | 同上 |
| 无官方市场目录；npm + 插件管理器是事实渠道 | 安装包字符串："There is no official market; Discover lists only the index sources the user adds." |
| `OPTIONAL_BUNDLES` 是官方策展的 10 个随装包，第三方进不去 | `dsh-app-boot` 源码 |

<a id="evidence-10"></a>

## 10. Codex 侧对照

| 事实 | 来源 |
|---|---|
| Codex 内嵌 tree-sitter-bash 与 `shell-command/src/bash.rs`；语法节点含 `redirected_statement`、`file_redirect`、`heredoc_redirect`、`subshell`、`compound_statement`、`variable_assignment`、`expansion` | Codex 二进制字符串 |
| "exec-policy allow behavior (including any sandbox bypass) takes precedence" | 同上 |
| 审批选项含：`just this once`、`grant these permissions for this turn`、`allow this host for this conversation`、`allow these permissions for this session`、`don't ask again for commands that start with`、`allow this host in the future` | 同上 |
| 用户配置：`approval_policy = "on-request"`、`approvals_reviewer = "auto_review"`、`sandbox_mode = "workspace-write"` | `~/.codex/config.toml` |
| 命令规则文件 5 条 `prefix_rule` | `~/.codex/rules/agent-home.rules` |
| 工具级豁免：`send_message_to_thread.approval_mode = "approve"` | `~/.codex/config.toml:9-10` |
| 项目信任级 11 条，机制为"项目级配置（hooks/exec policies）的加载门槛"，不改变沙箱与审批 | 二进制提示语 |

<a id="evidence-11"></a>

## 11. 决策模型

| 事实 | 来源 |
|---|---|
| Clef：`choice` / `noul` / `score` 三种问题类型，**无自由文本输出** | Cloudflare 模型文档 output schema |
| `noul` 返回 `{type:"noul", noul:<0..1>}`；`choice` 返回 `{type:"choice", choice, probabilities, confidence}`；`score` 返回 `{type:"score", score, legend, probabilities, confidence}` | 同上 |
| `noul` 支持 `criteria.true` / `criteria.false` 描述两端含义 | 同上 |
| 单次请求支持 1–64 个 questions；`state` 可为字符串或结构化数据；`images` 最多 4 张 | 同上 |
| Clef 64k context（Jev 32k）；Apache 2.0 开放权重；Jev API 兼容 | Cloudflare 发布文、TypeSafe 发布文 |
| Pricing：Clef $0.240/M tok（21,818 neurons/M）、clef-omni $0.150/M、clef-flash $0.038/M（3,455 neurons/M） | Workers AI 定价页 |
| 免费档：10,000 Neurons/天，日重置 00:00 UTC | 同上 |
| Jev：$0.042/M tok 输入，输出免费；70–500ms；RLCD 校准训练 | TypeSafe 发布文 |

<a id="evidence-12"></a>

## 12. Codex Guardian（审查模型）实现细节

从 Codex 二进制提取的证据，用于判断"AST 解析结果是否进入审查输入"。

| 事实 | 来源 |
|---|---|
| `shell-command/src/parse_command.rs` 产出 `ParsedCommand`（tree-sitter 解析的产物） | Codex 二进制路径字符串 |
| `ParsedCommand` 出现 14 次，**全部位于 `shell-command` 模块上下文中**；Guardian 审查链的字段里没有它 | 二进制字符串分析 |
| 危险命令判定独立于模型：`command_safety/is_dangerous_command.rs`、`windows_dangerous_commands.rs`、`powershell_tree_sitter.rs` | 同上 |
| **结论：AST 只用于权限判定与危险检查，不序列化进审查请求** | 由上述两点推定 |
| Guardian 提示词含"Respect the latest applicable user instructions and their scope. Do not allow an action contrary to an applicable user restriction." | 二进制字符串（完整段落见下） |
| Guardian 提示词要求表达不确定性："If historical authorization remains uncertain, keep that uncertainty in your assessment"、"do not invent permission or broaden an earlier grant" | 同上 |
| Guardian 具备主动检索能力：提示词提到 "Empty results, incomplete pages, truncation, unavailable tools, and timeouts"，说明它可搜索/分页/调用工具 | 同上 |
| Guardian 输出含分数：字段 `risk_score`、`confidence_score`、`review_threshold`、`persist_scores` | 二进制配置字段 |
| Guardian 输入含来源标注：`guardian_source_order_guidance`、`retained_source`、`client_authored`、`harness_authored`、`inherited_user_message`、`guardian_retained_omissions` | 同上 |
| Guardian 其他配置：`classifier_instructions`、`max_action_tokens`、`max_classifier_instruction_tokens`、`async_classifier_mode`、`async_classifier_conversation_token_limit`、`free_guardian`、`review_scope`、`max_tool_call_lag` | 同上 |
| Guardian 策略可扩展：`guardian_policy_config`、`guardian_extra_policy`（与 `[auto_review].policy/extra_policy` 对应） | 同上 |

**Guardian 提示词完整段落**（从二进制提取，原文）：

> Respect the latest applicable user instructions and their scope. Do not allow an action contrary to an applicable user restriction. Empty results, incomplete pages, truncation, unavailable tools, and timeouts do not establish that no restriction or revocation exists. If historical authorization remains uncertain, keep that uncertainty in your assessment and apply the existing security policy; do not invent permission or broaden an earlier grant. Explain any material retrieval limitation in your rationale. Keep the required output format unchanged.

**对设计的推论**：

1. Codex 的分层是"AST 判定 + 能检索的审查者"，两者输入不重叠；
2. 若本设计采用 **单次无状态审查者**（Clef），结构化事实是必要的补偿——Codex 的审查者能自己查，Clef 不能；
3. 若采用 **reviewer subagent**（如 `dsh-auto-review` 的 read/glob/grep 子 agent），应跟随 Codex——不送事实段，让审查者自己查证；
4. `risk_score` + `review_threshold` 的存在印证了本设计"分数化 + 阈值判定"的方向，官方已在用标量版本。

<a id="evidence-13"></a>

## 13. 子 agent 的审批策略固定为 never

| 事实 | 来源 |
|---|---|
| 子 agent 创建时 approval policy **硬编码为 `"never"`**，与父会话策略无关 | `dsh-subagent/lib/index.js:408` `captureDelegatedPolicyOverrides()`：`approvalPolicy: parent.ctx.get("approval") === void 0 ? void 0 : "never"` |
| 该值以 `source: "delegation"` 事件写入子会话日志 | 同上 `appendDelegatedPolicyOverrides()`:425-436 |
| `permissionPreset` 仅在父为 `auto` 或 `danger-full-access` 时继承 | 同上:410-412 |
| `sandboxMode` 继承父会话的显式覆盖（不继承部署默认与一次性 grant） | 同上:411 |
| `never` 在 **waterfall 分发之前**结算为 `rejected`，应答器收不到请求 | `dsh-user-approval/lib/index.js:175`：`if (this.effectivePolicy(session) === "never") return "rejected";` |
| 子会话 header 通过 `parentSession` 标识归属；`parentSessionId` 是控制消息字段，不能混用 | `dsh-subagent/lib/index.js:343–355` `childSessionMeta()`、`:39–48` 控制消息 schema；本轮 §22 已纠正 |
| 子 agent 的模型可见上下文预置固定文案 | `dsh-subagent/lib/index.js:363` `SUBAGENT_DELEGATION_CONTEXT`（"operations that require approval are rejected automatically"） |
| 注释原文确认设计意图 | 同上:403-404："the approval policy is pinned to `'never'` regardless of the parent's own policy" |

<a id="evidence-14"></a>

## 14. 竞品生态调研（2026-10-20）

npm 上 `dsh-plugin` 关键词有数千包，权限/审查类至少 8 个实现。下载量为近 30 天。

| 包 | 版本 | 月下载 | 核心机制 |
|---|---|---|---|
| `dsh-perm-gate` | 5.3.2 | 12,403 | 确定性优先分层门禁：P0 硬拒 → P1 会话授权 → P2 静态规则 → P3 LLM 分类器 → P4 ask |
| `dsh-auto-review` | 0.13.7 | 7,587 | `approval/request` 应答器 + **read-only reviewer subagent**（fork，read/glob/grep） |
| `dsh-permission-rules` | 0.7.20 | 7,374 | Claude Code 风格声明式规则，`tools/pre-execute` waterfall，含网络策略代理 |
| `dsh-auto-approve` | 0.7.1 | 2,020 | `sandboxed-auto` 预设，只审沙箱升权请求（约 2% 调用） |
| `dsh-auto-review-router` | 0.4.0 | 332 | 可配置审查模型 + 人工回退 + 目录授权记忆 |
| `dsh-auto-review-plus` | 0.1.3 | 501 | 带会话上下文的审查 + 逐会话模型选择 |
| `@jhckevin/dsh-auto-review` | 0.6.2-rc.1 | 330 | 原生 Auto Review 的兼容性适配 |

### 关键竞品事实

| 事实 | 来源 |
|---|---|
| `dsh-permission-rules` 的 `allow` **不短路**，严格 `next()` 委托（"downstream listeners are never short-circuited"） | 其 README |
| 它的 `argv` 维度**已处理重定向目标**："Argument tokens include redirect targets (`echo x > /etc/passwd` feeds `/etc/passwd` to `args`/`anyArg`)" | `docs/rules-format.en.md` |
| 它有 `agents` 维度区分身份：`main` / `subagent` / `preset:<name>`，"Unknown identity (no candidates) never matches, so agent-scoped rules fail closed" | 同上 |
| 它的规则支持项目级 `.dsh/rules.yaml` 层级合并（`searchUp`） | 其 README |
| 它有 ReDoS 防护：拒绝嵌套量词与重叠交替分支 | `docs/rules-format.en.md` |
| 它的 `ask` 走官方 seam；**不自己启动 reviewer subagent** | 同上 |
| `dsh-auto-review` 用 read-only reviewer subagent，工具白名单 `[read, glob, grep]`，`maxDepth` 保持不可再委派 | 其 README |
| 它支持 `reviewerModel` / `reviewerModelProvider` 覆盖（**可换模型**） | 同上 |
| 它默认审 `bash` 和 `write`，其余工具委托给人 | 同上 |
| 它**没有处理子 agent 的 `never` 场景** | 全文无相关说明 |
| `dsh-perm-gate` 有原则："Sub-agents inherit but cannot mint"（子 agent 继承权限但不能铸造新授权） | 其 README:80 |
| `dsh-perm-gate` 实现了 callId 对表的升权自动应答（`trustEscalation`）："the exact call the gate cleared (matched by `callId`) is answered here instead" | 其 README |
| `dsh-auto-approve` 明确对比官方 auto review 的七条劣势（无沙箱/审每次/模型不可换/无确定性兜底/不可配置/失败即拒/Headless 不可用） | 其 README |

### 结论

| 本项目的能力 | 生态现状 |
|---|---|
| 规则命中零 token（短路 allow） | **无竞品实现**（`dsh-permission-rules` 明确不短路） |
| 决策模型 + 概率分布 + 概率门 | **无竞品实现**（全部为 chat 模型 + 自由文本） |
| DND strict/progress 双档 | **无竞品实现** |
| 子 agent `never` 场景处理 | **无竞品实现**（`dsh-perm-gate` 只有 "inherit but cannot mint" 原则） |
| 判定引擎五层（探针/不变式/推导表/概率门） | **无竞品实现**（最接近的是 `dsh-perm-gate` 的 P0-P4 分层） |
| 可检索 reviewer subagent | `dsh-auto-review` 已实现 |
| 可配置 reviewer 模型 | `dsh-auto-review` 已实现 |
| 声明式规则 + 网络策略 + 热重载 | `dsh-permission-rules` 已实现且更完整 |

### `dsh-perm-gate` 详细资料（补充 [证据 §14](evidence.md#evidence-14)）

| 事实 | 来源 |
|---|---|
| 版本 5.3.2，`engines.dsh` 覆盖 17 个 rc 版本，含 `0.2.1-rc.2`（本机版本） | npm metadata |
| `engines.node >= 24`（注意：比本设计假设的 `^22.19 \|\| >=24` 更严） | 同上 |
| dist-tags 按 DSH 版本线分流：`dsh-0.2.1-rc.2` → 5.3.2 | 同上 |
| 导出子路径含 `./grant`、`./shell`、`./engine`、`./allowlist`、`./classifier` | 同上 |
| 判定链 P0 硬拒 → P1 会话 grant → P2 静态规则 → P3 LLM 分类器（默认关）→ P4 ask | 其 README |
| P0 覆盖：凭证材料、受保护路径修改、危险 shell；**不可被 grant/规则/分类器/人覆盖** | 同上 |
| 命令匹配用 argv 分解，含 `sh -c`/`bash -c` 递归下钻、管道检测、重定向目标、`rm -rf` 识别 | 同上 |
| 命令修饰符语法：`word#flag`，如 `rm#recursive` 匹配 `rm -rf`（含 `env rm -rf` 与 `sh -c "rm -rf /"`） | 同上 |
| 会话 grant：`(tool, canonical fingerprint)` + `TTL` + `maxUses`；**子 agent 继承但不能铸造** | 同上 |
| 危险关键词预设黑名单（继承自 dsh-approval-gate）：`rm -rf`、`push --force`、`drop table`、`mkfs`、`git reset --hard`、`docker system prune` 等，大小写不敏感子串匹配 | 同上 |
| `trustEscalation`：按 callId 对表自动应答沙箱升权请求 | 同上 |
| `llmAssist`：OpenAI 兼容 LLM 判 `safe` / `risky:<category>`；硬类别（deletion/credential/remote/system/bulk）**永远 ask** | 同上 |
| 判定链只在 `gatePresets`（默认 `permissive`/`permissive-full`）内生效；其他预设下**整个 gate 停机**（含 P0） | 同上 |
| 五个权限档：`permissive`（workspace-write+ask）、`permissive-full`（danger-full-access+ask）、`permissive-snet`（必问人）、`permissive-mech`（机器裁决）、`permissive-yolo`（模型代答） | 同上 |
| 网络策略：本地 HTTP/CONNECT 代理，opt-in（默认关）；明确声明是"协作式策略层，不是强制边界"，Node.js `fetch` 不受拦截 | 同上 |
| Windows AppContainer 沙箱（beta），`sandboxEnabled` 默认 false | 同上 |
| 审计：JSONL 事件流 + 浏览器通知条 + 审批记录页 | 同上 |
| 有 `sessionSweep`（每小时清理归档会话的授权链数据） | 同上 |
| 有 ReDoS 防护与"loud fail on malformed rules" | 同上 |

**结论补充**：`dsh-perm-gate` 是架构最接近的竞品（同样 pre-execute 门禁 + 分级判定 + 权限档），但它的"分级"是**规则/关键词/二值分类**，不是概率判定；它的"豁免"是**会话 grant**，不是规则短路。二者在 `pre-execute` 队首、权限档注册、升权应答三处冲突，不能共存。

### `dsh-perm-gate` 的豁免与学习机制（补充 [证据 §14](evidence.md#evidence-14)）

| 事实 | 来源 |
|---|---|
| 会话 grant 为 `(tool, canonical fingerprint)` + `TTL` + `maxUses`；**"re-running with a different target never reuses authority"**（目标换则授权不复用） | 其 README |
| grant 来源之一：审批面板 "repeat-allow this type this session" 按钮 | 同上 |
| 另一条路 "allow every occurrence" **写进 `permissions.yaml` 的 allow 白名单**（`approveAllowEverywhere`），不是 spawn grant | 同上 |
| 在线学习 `riskLearning`（默认关）：中性风险 ask + 人工批准 + 实际执行成功（`tools/result` 结算）→ 计数；达 `riskThreshold`（默认 3）且 fingerprint 匹配 → 自动放行 | 同上 |
| `riskSediment`（默认开）：达阈值的样本**固化成确定性 allow 规则**，命中直接放行且不调 LLM | 同上 |
| **硬类别永不学习**：`deletion`/`credential`/`remote`/`system`/`bulk` 保持人工 ask，"never learned, so repeated approvals can never sediment them into an auto-allow" | 同上 |
| 学习状态存于 `$DSH_HOME/perm-gate/learning.json`，不写进 YAML 规则文件 | 同上 |
| 明确记录了一次实测教训："Denying on the model's word was measured live: a benign `git commit -F …` graded `remote` produced an auto-deny with no panel and no grant to retry with." | 同上 |
| 因此设计成：**分类器只能 allow，不能 deny**（"the deny path belongs to the deterministic layers alone"） | 同上 |
| 五个权限档（`permissive` / `permissive-full` / `snet` / `mech` / `yolo`）通过**替换整个 `permission.config.presets` 表**嵌入；patch 必须重述三个内置档，`test/patch-presets.spec.ts` 钉住 key 集合 | 同上 |
| `gatePresets` 默认 `['permissive','permissive-full']`；其他预设下**整个 gate 停机**（含 P0） | 同上 |
| 无人值守三档：`snet`（必问人）、`mech`（机器裁决，不问人不问模型）、`yolo`（模型代答，不问人） | 同上 |
| 网络策略是本地 HTTP/CONNECT 代理，opt-in，改写子进程 proxy 环境变量；**自述为"协作式策略层，不是强制边界"** | 同上 |
| 网络策略覆盖表：curl/wget/git/Go/Python requests 覆盖；**Node.js fetch 不覆盖**；raw socket/DNS/QUIC/直连 IP 均不覆盖 | 同上 |
| DSH 自身流量默认不拦截（`networkUnattributed: allow`），理由是"reviewing them would let the host block itself" | 同上 |
| 有 `scriptReview`（默认开）：调脚本时读取脚本体（有界、不执行）展示给模型/人/确定性网 | 同上 |
| 有 `credentialPaths` / `denyKeywordsExtra` 等"只增不减"的扩展列表，故意不提供替换预设列表的操作 | 同上 |

<a id="evidence-15"></a>

## 15. `bulk` 探针的竞品依据

| 事实 | 来源 |
|---|---|
| `dsh-perm-gate` 的 LLM 分类类别为 `safe` / `risky:<category>`，硬类别含 `deletion` / `credential` / `remote` / `system` / `bulk` | 其 README |
| 硬类别保持人工 ask、**永不学习**（"never learned, so repeated approvals can never sediment them into an auto-allow"） | 同上 |
| 分类器**只能 allow，不能 deny**（"the deny path belongs to the deterministic layers alone"），因为实测过误 deny：`git commit -F …` 被判 `remote` 导致无可申诉的自动拒绝 | 同上 |
| 我们的三探针（secrets/destructive/egress）覆盖其 `credential`/`deletion`/`remote`；`system` 与 `bulk` 未覆盖 | 对照分析 |
| `system` 可通过 AST 确定性识别（`sudo`/`systemctl`/`launchctl`/`crontab`/`/etc` 路径/包管理器/shell rc），不需要概率探针 | AST 能力分析 |
| `bulk` 部分可 AST 推导（通配符、`-r`/`--recursive`、`find -delete`、目录目标），但真实规模仍需语义判断 | 同上 |
| 我们的探针会喂硬不变式（可 deny），权重高于竞品（其硬类别只保持 ask）→ 探针应更少更确定 | 设计权衡 |
| `bulk` 设成独立 deny 会误伤正常批处理（`rm -rf build/`、批量格式化、`find -delete` 清产物） | 场景分析 |
| 修正方案：`bulk` 作风险放大条件，`destructive ∧ (bulk ∨ auth=none) → 不自动 allow` | [bulk 探针](docs/reviewer.md#design-5-6-2) |
| `bulk ∧ egress`（无 secrets）不硬拒——批量推送/上传是常见工作流 | 同上 |

<a id="evidence-16"></a>

## 16. regex 引擎选型（re2js）

| 事实 | 来源 |
|---|---|
| `re2js` 2.8.8，MIT，**零依赖纯 JS**（Go regexp 移植），提供 `RE2JS.compile()` / `.test()` / `.testExact()` / `RE2JS.matches()` | npm metadata + 其 README |
| 线性时间保证：DFA/NFA 组合，O(n)；无灾难性回溯 | 其 README |
| 不支持前瞻 `(?=x)`、后顾 `(?<=x)`（除非显式 `LOOKBEHINDS` flag，且 captureless）、回溯引用 `\1` | 实测编译异常 |
| 支持 flags：`CASE_INSENSITIVE`、`DOTALL`、`MULTILINE`、`LONGEST_MATCH`、`LOOKBEHINDS`、`DISABLE_UNICODE_GROUPS` | 其 README |
| conformance test 跑 RE2 官方测试数据（约 580 万行，可全量采样） | 其 README |
| 实测 `^gpt-relay(?:\\s\|$)` 匹配 `gpt-relay send hi` → true | 本机实测 |
| 实测 `^gh pr (view\|list\|status\|checks\|diff)\\b` 匹配 `gh pr view 42` → true，`gh pr checkout 42` → false | 本机实测 |
| 实测 `^(a+)+$` + `a`×40 + `b`：re2js **0.38 ms**（返回 false）；原生 RegExp 在 `a`×28 时已 **4,968 ms** | 本机实测 |
| 替代品 `re2-wasm` 1.0.2（Apache-2.0，需 WASM 加载）、`safer-regex` 0.3.0（**GPL-3.0**，不兼容）、`redos-detector` 6.1.4（MIT，但只评分不保证，依赖 `regjsparser`）、`regexp-tree` 0.1.27（审计派） | npm metadata |
| 结论：用 re2js 替代"自建安全子集 + ret 审计"，校验逻辑从"维护语法清单"简化为"catch 编译异常 + `^` 锚定检查" | [匹配方言](docs/rules.md#design-4-2) |

<a id="evidence-17"></a>

## 17. shell 环境与变量展开的可达性

| 事实 | 来源 |
|---|---|
| `dsh-shell-env` 提供每次 shell 调用的受信 `DSH_*` 环境；`collect(execution)` 返回 `DSH_HOME`、`DSH_SHELL=1`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR` 等 | `dsh-shell-env/lib/index.js:84-107` |
| 插件可注册自己的 `DSH_*` contributor（`ctx.shellEnv.register`），键名受 `DSH_ENV_KEY_SUFFIX` 与保留键限制 | 同上:60-80 |
| `bash-local` 的 spawn env 为 `{...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv}`（`NO_COLOR=1`/`TERM=dumb`/`PAGER=cat`/`GIT_PAGER=cat`） | `dsh-bash-local/lib/index.js:22-27, 120-127` |
| 每次 `bash` 调用都是 `bash -c <command>` 新进程，**会话内不共享 shell 状态**（`cd`/`export` 不跨调用） | `dsh-bash-local/lib/index.js:140-146` |
| 因此：同命令内赋值可静态求值；跨命令的环境变量只能靠 `process.env` 推测，不可信；脚本内部变量完全不可见 | 由上述三点推定 |
| PTC 外层 `run_code` 的过滤条件：`exec.parent === undefined && exec.name === RUN_CODE_NAME` → 跳过 | `dsh-experimental-auto-review/lib/index.js:463` |
| `exec.parent !== undefined` 表示内层调用，来源为 `ptc-inner`（`mode: "ptc-inner"`） | 同上:202, 289-310 |
| 官方 README 承认："外层 `run_code` transport 及 PTC 程序内直接 Node 效果不经过 inner-tool review" | `dsh-experimental-auto-review/README.zh.md` |
| 官方 auto review **无独立超时**，只绑 `exec.signal`；`dsh-auto-review` 用 `reviewerTimeoutMs` 默认 60000，`dsh-perm-gate` 用 20s | 三者 README / 源码 |
| `dsh-auto-review` 熔断："3 consecutive denials, or 6 of the last 10 verdicts, **per turn**" | 其 README |

<a id="evidence-18"></a>

## 18. 父会话授权证据的可达性

| 事实 | 来源 |
|---|---|
| 本地子会话的 `session.header.parentSession` 标识父会话；外部后端没有本地子 Session | `dsh-subagent/lib/index.js:343–355, 1764–1834`；本轮 §22 已纠正原 `parentSessionId` 误记 |
| 父 agent 发给子 agent 的消息 source 为 `{ kind: "agent-message", form: "relay", senderSessionId }` | `dsh-subagent/lib/index.js:444-464` |
| 人类消息的 source 为 `{ kind: "user" }` | `dsh-session` / `dsh-subagent` 的 `createUserMessage` 路径 |
| `ctx.sessions.get(id)` 可查 live session；`session.deriveMessages()` 给出派生的模型历史 | `dsh-session/README.zh.md:32-47` |
| `deriveMessages()` 返回的是**压缩后的派生历史**，compaction 会摘要旧消息 | 同上 + compaction 机制 |
| 子 agent **不能**调用 ask 工具：`userQuestions.assertLiveRoot` 对非 root 抛 `DELEGATED_CALLER` | `dsh-user-questions/lib/index.js:534` |
| 该限制的原文理由："an owned child has no human answerer and would block forever, while a lineage-bearing session resumed as a new runtime root may ask normally" | 同上:650-660 |
| `agents.roots()` 返回无 owner 的顶层 agent；`agents.get(id)` 查 live agent；`agents.list()` 列全部 | `dsh-agent/lib/index.js:596-620` |
| 因此 `approval` 与 `userQuestions` 两条通道对子 agent 均封死，只有 `agent-message` 双向开放 | 由上述事实推定 |

<a id="ask-timing"></a>

### 补充：ask 等待、继续与答复来源

本轮直接读取 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中的包，`dsh/package.json` 为 **0.2.1-rc.2**。以下是本机该版本的源码和包文档核对，不表示已验证用户当前 preset 的运行配置。

| 事实 | 来源 |
|---|---|
| `tool-ask-user` 配置默认 `mode: legacy`；可选 `mode: timed`，timed 默认 timeout 为 120 秒 | `dsh-tool-ask-user/lib/index.js:211–220`、该包 `README.zh.md`“使用本包” |
| timed 允许单次正数 timeout；`-1` 调用阻塞式 ask，等答案或取消。legacy 不提供超时后 pending 的 schema | 同上 `:8–10, 118–121, 180–199` |
| timed 前台超时返回 `{ pending: true, callId, message }`；提示继续独立工作，问题仍可回答，超时不构成许可 | 同上 `:19–27, 180–199`；`dsh-user-questions/lib/index.js:613–649` |
| 有 UI 接手时，倒计时及编辑／聚焦行为由 Client 管理；无人接手时 Host 到 deadline 返回 pending，不取消整个 Turn | `dsh-user-questions/README.zh.md`“提出问题”“职责”；`lib/index.js:294–379`。因此 120 秒不是所有 UI 状态下的绝对最长等待 |
| 迟到答复由 `createUserMessage` 产生，source.kind 为 `user-question-reply`；内容带 `answer_to_pending_question`、callId、原 questions 与 answers | `dsh-user-questions/lib/index.js:552–586` |
| 前台等待内收到的答案作为 ask 工具结果返回；不能只筛 `source.kind === "user"` 就覆盖全部人类答复 | `dsh-tool-ask-user/lib/index.js:180–199`、该包 `README.zh.md`“工具调用历史与结果” |
| 存活且由另一 agent 拥有的子 agent 仍以 DELEGATED_CALLER 被拒绝；计时模式不改变 ownership 限制 | `dsh-user-questions/lib/index.js:531–535, 613–615` |

源码校验：`dsh-tool-ask-user/lib/index.js` SHA-256 为 `1db15abff879ad09bfc64c0edaa764f5dc773d43c09fb05dea4eb44a1e274268`；`dsh-user-questions/lib/index.js` 为 `e1c51afac2e31be8593c6426976e5f31dbe2a709b85ae1ea43ed406146f54265`。只读取安装包，未修改宿主配置。

<a id="evidence-19"></a>

## 19. 先前裁决的可读回性

| 事实 | 来源 |
|---|---|
| 插件会话记录用 `appendPluginRecord(session, type, data)` 写入，类型须匹配 `^plugin:[a-z0-9][a-z0-9._-]*(?:/...)*$`，自动带 `ignorable: true` | `dsh-session/lib/index.js` `PLUGIN_RECORD_TYPE`、`#appendRecord` |
| 读回用 `pluginRecordOf(event)`，返回 `{ type, seq, time, data }`，非插件记录返回 undefined | `dsh-session/lib/index.js:1306` |
| 会话日志是 append-only 且事件 deepFreeze，**不能修改历史记录** | 同上 |
| 官方 auto review 的历史构造：`user/message` 中 `source.kind === "tool"` 的记录**直接跳过**（工具结果不进历史） | `dsh-experimental-auto-review/lib/index.js:255` |
| 官方只把 `assistant/message` 里的 `tool-call` 块加入历史，`role: "fact"`，含 `name` + `arguments` | 同上:289-295 |
| 官方历史**无长度上限**（全部塞入） | 同上，全文无 slice/cap |

<a id="evidence-20"></a>

## 20. 项目指令链与规则来源的取舍

| 事实 | 来源 |
|---|---|
| DSH 的 `agent-instructions` 加载**全局 + 项目**整条链：`$DSH_HOME/AGENTS.md` → `<agentsHome>/AGENTS.md` → 项目根到 cwd 每层目录的 `AGENTS.md`/`CLAUDE.md`（+ `.local.md` overlay） | `dsh-agent-instructions/README.zh.md` |
| 默认候选文件名 `["AGENTS.md", "CLAUDE.md"]`；overlay 为 `.local.md`；`.git` 标记项目根 | `dsh-agent-instructions/lib/index.js:17` |
| base 组合给该链 **65,536 字节**预算；超限时较宽泛的文件先省略，最具体的最后截断 | 其 README |
| 官方 auto review 把这些整段作为 `PROJECT_INSTRUCTIONS` 注入审查请求 | `dsh-experimental-auto-review/lib/index.js:256-264, 325-326` |
| 官方 `isProjectInstruction` 判据：`source.kind === "agent-instructions"` | 同上:95-97 |
| 官方 `isCheckpoint` 判据：`source.kind === "compact-checkpoint"` | 同上:99-101 |
| 官方 `isDirectParentInstruction` 判据：`source.kind === "agent-message"` 且 `senderSessionId === parentSession` | 同上:103-105 |
| 官方 `textRole` 四角色：`human-instruction` / `direct-parent-instruction` / `checkpoint` / `fact` | 同上:121-126 |
| 生态已有 `.dsh/` 目录约定：`dsh-permission-rules` 用 `<cwd>/.dsh/rules.yaml` | 其 `docs/rules-format.en.md` |
| 结论：不注入整条 AGENTS.md 链（绝大部分与审查无关），改用 `CUSTOM_RULES`（配置页全局）+ `PROJECT_RULES`（工作区根目录 `.dsh/arbiter.md`，不 searchUp） | [用户规则来源](docs/review-context.md#design-5-2-3-1) |

<a id="evidence-21"></a>

## 21. Token 估算方案

| 事实 | 来源 |
|---|---|
| DSH 自身用固定密度启发式：`CHARS_PER_TOKEN = 4`，`Math.ceil(text.length / 4) + BLOCK_OVERHEAD` | `dsh-token-meter/lib/index.js:16, 30-44` |
| `dsh-token-meter` 自述"文本和未声明图片定价的路由使用固定启发式规则"；精确计费需提供方分词器 | 其 README |
| `tokenx` 2.2.0：2 kB、零依赖、MIT；95%+ 平均准确率，单样本 ≥90% | npm metadata + 其 README |
| tokenx 校准基准是 OpenAI `o200k_base`；对 CJK/西里尔/希腊/带重音拉丁/emoji 有内置规则 | 其 README |
| tokenx 实测偏差（其 README 给出）：`Cat article (zh) 9,057 → 8,953`（-1.15%）；`ja` -4.21%；`Team chat (en) 293 → 285`（-2.73%） | 同上 |
| `gpt-tokenizer` 4.1.0 解包体积 28 MB；`js-tiktoken` 1.0.21 解包体积 22 MB | npm `dist.unpackedSize` |
| 完整 tokenizer 只对 GPT 系准确；Clef 基于 Qwen backbone（`Qwen3.8-27B` / `Qwen3.5-9B`），Jev 为自研架构 | Cloudflare 发布文（Clef 架构） |
| 结论：用 tokenx 估算，`maxInputTokens = 10000` 即截断值，不设隐藏边际 | [输入预算](docs/review-context.md#design-5-2-6) |

---

<a id="evidence-22"></a>

## 22. 工具与执行路径覆盖核对

2026-10-20 只读提取本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`；`dsh/package.json` 版本为 **0.2.1-rc.2**。本节是源码核对，未安装 dsh-arbiter、未修改宿主配置、未执行端到端拦截实验。产品使用的[覆盖矩阵及待验证项](docs/architecture.md#execution-coverage)由下列依据整理。

下表路径均相对安装包内 `dsh/node_modules/@deepseek-ai/`，行号对应本次打包后的 JavaScript，不是仓库 TypeScript 行号。

| 已确认的宿主机制 | 源码／随包文档出处 |
|---|---|
| 工具先进入 `tools/pre-execute`，处理 ask 后再运行单调 guard，允许才分发 body；插件 allow 不会绕过 guard | `dsh-tools/lib/index.js:3310–3367, 3391–3415` |
| `run_code` 是 registry 的保留 transport，其 body 前也经过同一流水线；`tools.restrict()` 不能指定该保留名称，但 pre-execute 可以判断它 | `dsh-tools/lib/index.js:1186, 2871–2900, 3001, 3075, 3310–3326` |
| 官方 Auto Review 主动跳过没有 `exec.agent` 的调用及外层 `run_code`，不是宿主没有门禁 | `dsh-experimental-auto-review/lib/index.js:461–464` |
| PTC binding 派发真实参数，继承 agent、rootCallId，并添加 `parent: exec.token`，通过 registry scheduler 执行内层工具 | `dsh-tools/lib/index.js:1362–1380` 及相邻调度逻辑 |
| 内层工具拒绝可被 PTC 程序 catch，不强制外层失败；审批或重试不回滚之前已发生的效果 | `dsh-experimental-auto-review/README.zh.md`“工具拒绝”；`dsh-tools/README.zh.md`“PTC” |
| 临时与持久 Node 进程均在非 full-access 模式调用 `sandbox.confine`；direct Node API 不产生 `tools.*` 派发 | `dsh-ptc-runtime-node/lib/index.js:1138–1165, 1605–1628`；该包两种运行时的使用说明；`dsh-experimental-auto-review/README.zh.md`“已知限制” |
| macOS Seatbelt profile 是 allow default + deny file-write + writableRoots 例外；该配置不是读取或网络限制 | `dsh-sandbox-local/lib/index.js:65–74`；此结论仅针对该文件沙箱配置 |
| Node 的程序可见环境被清空；不可将直接读取 `process.env` 等同于读到宿主凭据 | `dsh-ptc-runtime-node/lib/process.js:1053–1072`、`lib/persistent-process.js:1005–1013` |
| MCP bridge 以规范化公开名注册工具，body 内发送 `client.callTool`；工具身份原本为 serverName + rawName，名称有长度／字符规范化及 hash 后缀 | `dsh-mcp-client/lib/index.js:52–104, 127–153` |
| MCP 的连接、stdio server 启动和工具发现发生在 client 生命周期中；没有作为模型工具逐次派发 | `dsh-mcp-client/lib/index.js:14–46, 127–130, 512–522, 676`；stdio 由 MCP SDK 创建进程，此处未调用会话 sandbox |
| MCP 列举资源、列举模板、读取资源均有正式工具 wrapper；body 才调用资源 provider／MCP client | `dsh-mcp-resources/lib/index.js:53–97`、`dsh-mcp-client/lib/index.js:685–699` |
| 进程内 spawn／fork 形成本地 Agent，继承或挂载 composition；全局及所属上层 scope 的监听器可接收派发，仍受 Cordis base filter 限制 | `dsh-subagent/lib/index.js:343–386, 1794–1834`；`dsh-subagent-spawn-in-process/lib/index.js`、`dsh-subagent-fork-in-process/lib/index.js`；`dsh-scope/lib/index.js:315–338` |
| 子会话创建时审批策略设为 `never`；审批服务在 `approval/request` waterfall 前返回 rejected。该限制不关闭前面的工具 pre-execute | `dsh-subagent/lib/index.js:403–412, 425–436`；`dsh-user-approval/lib/index.js:172–176`；工具 gate 见本表首项 |
| 委派工具是 `defineTool`，可审查整个委派；外部后端使用 run/result，没有本地 child Agent，官方也明确其内部保留原生权限系统 | `dsh-tool-subagent/lib/index.js:382–442`；`dsh-subagent/lib/index.js:1764–1834`；`dsh-subagent/README.zh.md`“已知限制”；`dsh-experimental-auto-review/README.zh.md`“已知限制” |
| workflow 工具可进工具门禁，但实现直接调用 PTC runtime 和 `subagents.startActivation`，不产生对应的 `run_code`／委派工具入口 | `dsh-tool-workflow/lib/index.js:270–277, 385–407`；`dsh-workflow-ptc/lib/index.js:301–347, 421–440` |
| `run_code` body 内部可另外请求升权；升权结果只用于该次程序执行，嵌套工具仍有自己的策略 | `dsh-tools/lib/index.js:1248–1276`；该包 `README.zh.md` 的 sandbox_permissions 说明 |

关键源码 SHA-256：

| 安装包内路径 | SHA-256 |
|---|---|
| `dsh/package.json` | `b67a65b9719272b2eb54093b63c121d05907da062a1393e8c9f871e1cd18f94e` |
| `dsh-tools/lib/index.js` | `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a` |
| `dsh-mcp-client/lib/index.js` | `758d8fc473b700b5d351158d06ce9f9e92c16e8b25497b08bb7bd2122a87f5dd` |
| `dsh-subagent/lib/index.js` | `9a9572e70fffdb100deb63326167f32bbf63016ce49c0017495dabcb95b44168` |

仍需运行验证：插件实际挂载与 listener 顺序、各 preset／profile／子会话的覆盖、并发 PTC 的拒绝传播和关联日志、MCP 动态注册及资源工具、文件沙箱实效、workflow／后台路径、原生升权。源码未提供统一接入的外部后端内部效果，应列为需要单独集成，不能仅列成“跑一次测试即可支持”。

### 22.1 2026-10-20 宿主机实测（第一轮七组）

**本节把上面的源码核对与运行验证分开记。** 上面是只读源码结论；下面是在同一台机器、
同一安装包上真实启动 DSH 跑出来的结果。运行实验使用隔离 profile 与确定性模型回放，
没有实现或安装 dsh-arbiter，没有调用真实模型或真实人工审批。

**环境**：DSH **0.2.1-rc.2**（与上面源码核对同版本，无需降级说明）· macOS 27.0.1 / arm64 ·
headless 入口 + 自建 profile（`dsh-base` + `dsh-headless`）· 每用例独立 `DSH_HOME` ·
文件沙箱按用例为 `workspace-write`／`danger-full-access` · 审批按用例为 `ask`／`never` ·
工具展示按用例为 `native`／`ptc`。

**复现材料与全部原始证据**：[validation/host-coverage/2026-10-20-host-coverage-01/](validation/host-coverage/2026-10-20-host-coverage-01/README.md)。
报告：[REPORT.md](validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)；
环境与安装指纹（含 SHA-256）：[ENVIRONMENT.md](validation/host-coverage/2026-10-20-host-coverage-01/ENVIRONMENT.md)；
用例事实总表：`raw/case-index.json`。

#### 22.1.1 探针加载与普通工具（运行确认）

最小探针挂在 profile 用户层，只对显式标记的测试调用给固定 allow／deny，其余 `next()`。

| 结论 | 证据 |
|---|---|
| 同一动作 allow 时 body 执行并写出标记文件；deny 时 hook 已触发、无 `tools/execute`、标记文件不存在、工具结果为 isError | `cases/g1-a-bash-allow/`、`cases/g1-b-bash-deny/` 的 `probe.jsonl` 与 `ws/` |
| 探针不处理时交还原链路，body 正常执行 | `cases/g1-c-bash-pass/` |
| 插件 `{kind:"allow"}` 不能绕过 `ctx.tools.guard()`：guard 拒绝后 body 未执行 | `cases/g1-e-guard-vs-probe-allow/`（对照 `g1-f`） |

**运行反证（影响设计）**：`prepend: true` 不能让插件排在已有的 `prepend` 监听之前。
实测数组在默认挂载与 `prepend` 挂载下都是 `[非探针 prepend, 探针 decide, 探针 sentinel]`；
并存官方 auto-review bundle 时为 `[非探针 prepend ×2, 探针 decide, 探针 sentinel]`
（与源码中 `dsh-tool-jobs`、`dsh-experimental-auto-review` 都以 `{prepend:true}` 注册吻合）。
Cordis `waterfall` 用 `unshift` 插入 prepend 监听，而宿主 bundle 早于 profile 层注册。
因此“用 prepend 抢队首、保证规则短路先于其他审查”的说法不成立（`g1-a`／`g1-g`／`g1-h`）。

#### 22.1.2 外层 `run_code` 与内层工具（运行确认）

| 结论 | 证据 |
|---|---|
| 外层 deny 时程序没有启动：程序首行写的标记文件不存在，无任何内层 `ptc` 记录 | `cases/g2-b-outer-deny/` |
| 内层 deny 只阻止该内层 body：程序 catch 到 `ToolCallError` 后继续，另一个内层调用成功，外层 `isError:false` | `cases/g2-c-inner-deny-catch/` |
| 两个并发内层调用各自进入 pre-execute，一放一拒互不取消 | `cases/g2-d-concurrent-inner/` |

**调用关联实测**：内层 `callId` = `<外层 callId>:ptc:<n>`，`rootCallId` 等于外层 callId，
`parent` 为 execution token（`Symbol(dsh.tool.execution)`），会话日志的
`tool/ptc-dispatch` 记录 `parentCallId`／`subCallId`／`rootCallId` 与之吻合。
`parent` 不是父 agent 标识，父会话关联须读 `session.header.parentSession`。

#### 22.1.3 直接 Node 效果与文件沙箱（运行确认）

| 结论 | 证据 |
|---|---|
| `run_code` 内的 `fs`／`fetch`／`child_process` 不产生独立工具门禁：探针只看到外层 `run_code`，而三类效果都实际发生 | `cases/g3-a-full-access/`、`g3-b-workspace-write/` 的 `probe.jsonl`、文件标记、`network-receipt.jsonl`、子进程 stdout |
| 文件沙箱只限制写入：workspace-write 下根外写入 EPERM／`Operation not permitted`，而本地 HTTP 与子进程照常 | 同上 |
| `/tmp` 在实际允许根内，不能当作根外；根外须用受控同级目录 | `cases/g3-g-workspace-write-tmp/`（写 `/tmp` 成功） |
| 读取不受 workspace-write 限制 | `cases/g3-h-workspace-write-read-outside/` |
| 文件工具与 bash 的写入边界一致（同一 `writableRoots` 派生） | `g3-d`（write 被原生沙箱拒）、`g3-f`（根内成功）、`g3-e`（full-access 同一路径成功）、`g3-c`（bash 根外失败） |

#### 22.1.4 MCP 工具与资源（运行确认）

| 结论 | 证据 |
|---|---|
| MCP 工具 deny 发生在 RPC 发出前：服务端已完成 `initialize`／`tools/list`，但没有收到 `tools/call` | `cases/g4-b-mcp-direct-deny/mcp-receipt.jsonl`（对照 `g4-a`） |
| `run_code` 内的 MCP 调用同样逐次进入 pre-execute；被拒的那次没有到达服务器 | `cases/g4-c-mcp-inside-run-code/` |
| 资源工具 `list_mcp_resources`／`read_mcp_resource` 可审查；deny 时服务端没有 `resources/read` | `cases/g4-d`／`g4-e` |

服务器内部效果仍只有一次工具入口，本轮不声称逐项覆盖。

#### 22.1.5 进程内 spawn／fork（运行确认）

| 结论 | 证据 |
|---|---|
| spawn 与 fork 的子任务内工具调用都进入同一 pre-execute，allow 执行、deny 不执行 | `cases/g5-a`／`g5-b`／`g5-c`／`g5-e` |
| 子会话身份可从 `session.header` 读取：`parentSession`／`origin:"subagent"`／`delegationDepth:1`，探针记录同值 | `cases/g5-b-spawn-child-deny/sessions/` |
| 子会话创建时写入 `approval/policy {policy:"never", source:"delegation"}`，但不阻止插件先行 allow | `g5-a`／`g5-e` 的执行结果与子会话日志 |
| 子任务中交给原生 ask 的调用被 never 直接 `rejected`，模型看到 “the user rejected tool …”（无人参与） | `cases/g5-d-child-ask-never` 的 `approval/asked`／`approval/decided` |

#### 22.1.6 workflow 服务直调（运行确认 · 基本路径）

| 结论 | 证据 |
|---|---|
| workflow 工具入口经过 pre-execute；入口 deny 后没有创建任何子任务 | `cases/g6-a-workflow-tool-deny/`（无 `subagent/descriptor`） |
| workflow 内部创建子任务**不产生** `subagent` 工具入口；直调 `subagent` 的对照则产生 | `cases/g6-d-workflow-vs-direct-delegation/` |
| 子任务自己的工具调用仍走各自的 pre-execute（deny 生效、allow 生效） | `cases/g6-b`（子 bash deny）、`g6-c`（allow） |

后台、取消与生命周期组合未运行。

#### 22.1.7 原生沙箱升权（运行确认 + 模拟标注）

| 结论 | 证据 |
|---|---|
| 工具 allow 之后 body 内仍会请求原生升权审批；`never` 下结果为 rejected，操作没有产生效果（bash 与 run_code 各一例） | `cases/g7-a`／`g7-b` 的 `approval/asked`→`approval/decided` |
| `ask` 策略下没有可用应答者时为 `unavailable`（fail closed），即使插件没有规则 | `cases/g7-c-bash-escalate-no-tool-rule/` |
| **模拟**应答证明 seam 可分离且结果会被采纳（allowed → 生效；rejected → 不生效） | `cases/g7-d`／`g7-e`／`g7-f`，日志带 `simulated: true` |

**真实人工审批未运行**：没有真实用户点击批准或拒绝，模拟结果不计作 UI 或人工审批已验证。

#### 22.1.8 本轮仍未验证

不同 preset、子任务冷恢复与后代、并发子会话、MCP 工具列表动态变化与断连重连、
持久 PTC、后台 workflow 与取消、Web/headless 以外的 surface、外部后端 subagent、
真实人工审批，以及插件在不同 profile 上的实际安装。源码结论不外推到这些组合。

---



---

<a id="design-1-1"></a>

## 历史灵感：Codex 侧的个人配置

用户在 Codex 中已部署一套由 agent-home 仓库维护的审批与授权体系，包含四部分：

| 配置 | 内容 | 源文件 |
|---|---|---|
| Auto-review 附加策略 | 授权延续、私有会话通信、批量执行、合并收尾 | `policies/codex-auto-review/extra-policy.md` |
| 命令前缀白名单 | `gpt-relay` 全信任；`gh` 五组只读子命令 | `~/.codex/rules/agent-home.rules` |
| 项目信任级 | 11 个 `trust_level = "trusted"` 项目 | `~/.codex/config.toml` |
| 工具级豁免 | `send_message_to_thread` 免审批 | `~/.codex/config.toml` |

<a id="design-2"></a>

## 调研结论摘要

完整证据见 [evidence.md](evidence.md)。关键事实：

1. **工具流水线**：`tools/pre-execute` 是可重排 waterfall，返回 `allow`/`deny`/`ask`/`cancel`；返回 `allow` 即短路后续所有门禁（含审查与审批）。
2. **权限预设**：`dsh-permission-presets` 只有一个插件可用槽位 `registerAuto(admit)`，名字固定为 `auto`，旋钮写死为 `{ sandbox: "danger-full-access", approval: "ask" }`。
3. **auto review 实现**：约 500 行，明确"不提供可配置策略、持久 grant、确定性工具豁免"；reviewer 使用当前 agent 的 provider/model。
4. **沙箱**：可写根由核心函数 `writableRoots(policy)` 派生，fs 围栏与 Seatbelt profile 共用；插件无法注入额外根。
5. **审批语义**：`never` 策略在 waterfall 分发前确定性拒绝；结果词汇只有 `allowed-once`/`rejected`/`cancelled`/`unavailable`。
6. **配置面**：插件页有 `plugins.bundle.config` 槽位可注册配置表单；机密走 credentials seam，配置中只写引用名。
7. **子 agent**：进程内子 agent 的 approval policy **硬编码 `never`**，与父会话无关；`never` 在 waterfall 分发前拒绝，任何应答器收不到请求（[子 agent 场景](docs/architecture.md#design-5-6-1)）。
8. **LLM 调用**：`ctx.llm.stream()` 是提供方无关的统一入口；采样只有 `temperature`/`maxTokens`/`stop`，**无 `tool_choice`、无 `response_format`、无 prefill**（[Chat 后端与重试](docs/reviewer.md#design-5-4)）。
9. **Codex 对照**：AST 只用于权限判定，不进入审查输入；其 Guardian 是**可检索**形态、输出 `risk_score` + `review_threshold`（[证据 §12](evidence.md#evidence-12)）。
10. **竞品现状**：`dsh-perm-gate`（12.4k/月）、`dsh-auto-review`（7.6k）、`dsh-permission-rules`（7.4k）三个主流实现；**短路 allow、概率分布审查、DND 双档、子 agent 处理均无竞品实现**（[证据 §14](evidence.md#evidence-14)）。

<a id="design-2-1"></a>

### 与竞品的关系

本设计**不依赖**任何竞品，但可与其并存：

| 竞品 | 与本设计的关系 |
|---|---|
| `dsh-permission-rules` | 可并存于 waterfall 的后续位置，承接未命中的规则（它的 `allow` 不短路，正好符合"我不管"语义）。若同时使用，规则来源会分散，需明确哪层是权威 |
| `dsh-auto-review` | 可并存（它在 `approval/request`，本设计在 `pre-execute`）。但两者都会消耗 token，不建议同时启用审查 |
| `dsh-perm-gate` | 功能重叠最大（pre-execute 门禁 + 升权自动应答 + 分级判定 + 多权限档）。**二选一，不并存**，详见 [与 dsh-perm-gate 的详细对比](evidence.md#design-2-2) |

**可借鉴的设计**（不引入依赖，只抄思路）：

- 竞品的 `agents: [main | subagent | preset:<name>]` 匹配维度（已采纳，[规则 Schema](docs/rules.md#design-4-3)）；
- `dsh-perm-gate` 的 "Sub-agents inherit but cannot mint" 原则（[O1](docs/decisions-and-questions.md#question-o1)）；
- `dsh-auto-review` 的 reviewer subagent 形态——**本设计不采纳**（延迟代价，[审查者形态：只做无状态单次调用](docs/reviewer.md#design-5-2-1)）

<a id="design-2-2"></a>

### 与 `dsh-perm-gate` 的详细对比

`dsh-perm-gate`（5.3.2，12.4k 月下载，支持 17 个 DSH rc 版本，含本机的 `0.2.1-rc.2`）是**唯一与本设计架构同层**的竞品：它也在 `tools/pre-execute` 上做门禁、也有分级判定、也提供权限档。因此必须逐项对照，判断是"借鉴"还是"重复造轮子"。

**它的五级判定链**：

| 级 | 决策 | 内容 |
|---|---|---|
| P0 | deny | 确定性硬拒：凭证材料、受保护路径修改、危险 shell |
| P1 | allow | 精确的**会话 grant**（`(tool, fingerprint)` + TTL + maxUses） |
| P2 | deny/allow/ask | 静态规则链（黑名单优先 → allow → ask） |
| P3 | allow/deny/ask | 可选 LLM 语义分类器（默认关闭） |
| P4 | ask | 官方审批 seam |

**逐项对照**：

| 维度 | `dsh-perm-gate` | 本设计 | 判断 |
|---|---|---|---|
| 判定分层 | P0–P4 五级 | 检查点/不变式/类别导出/推导表/概率门五层 | **结构同构**（都是"确定性优先、模型兜底"） |
| 硬拒不可覆盖 | P0 单调，grant/规则/分类器/人都不能推翻 | 不变式（三条）+ 不参与任何概率门 | **等价** |
| 命令解析 | `argv` 分解 + `sh -c` 递归下钻 + 管道/重定向/`rm -rf` 识别 | tree-sitter AST + 结构分类 | **本设计更强**（有 ERROR 节点可 fail-closed，能识别子 shell/heredoc/复合语句） |
| 规则来源 | 单个 YAML 文件（`permissions.yaml`）+ 设置页可编辑 | 配置页 + 计划中的项目级文件（[O3](docs/decisions-and-questions.md#question-o3)） | 竞品更成熟（有 preset 黑名单、一键恢复） |
| 豁免机制 | **会话 grant**（精确指纹 + TTL + 次数）+ 在线学习沉淀 | 同轮去重；离线候选经独立人工审核成为普通规则（[规则沉淀](docs/rules.md#design-5-10)） | **各有取舍**：它的运行时沉淀更自动；本设计要求人工确认具体匹配范围，不把历史批准直接转为未来授权 |
| 升权自动应答 | `trustEscalation`：callId 对表自动批 | **已放弃**（[方案演变记录](docs/decisions-and-questions.md#design-15) 决策记录：审批请求不携带机器可读目标） | **竞品更激进**；本设计认为不安全 |
| 模型审查 | `llmAssist`：OpenAI 兼容 LLM 判 `safe`/`risky:<category>`，硬类别永远 ask | 五层引擎 + Clef 概率分布 + `authorized` 维度 | **本设计更强**（有概率门、有授权正交维度、有探针） |
| 权限档 | 五个自定义档（`permissive` / `permissive-full` / `snet` / `mech` / `yolo`），只在 `gatePresets` 内生效 | 一个 `auto` 预设（`danger-full-access` + `ask`）+ guarded 模式 | **竞品更灵活**（但它靠改 preset 表，本设计靠 `registerAuto` 单槽） |
| 无人值守 | `yolo` 档：模型代答、危险阻断 | 自动审批 strict/progress 两档，具体规则见[策略整理稿](docs/approval-modes.md) | 本产品的模式与规则仍在设计，具体效果待验证 |
| 网络策略 | 内置 HTTP/CONNECT 代理（opt-in，明确声明是"协作式策略层"非强制边界） | 无 | **竞品独有** |
| 子 agent | "inherit but cannot mint"（继承但不铸造） | [子 agent 场景](docs/architecture.md#design-5-6-1)：设置页统一选择 strict/progress，记录完整判定链 | 本产品已取代旧的父模式继承方案；人工通道覆盖仍需验证 |
| 审计 | JSONL 事件流 + 浏览器通知条 + 审批记录页 | 会话事件 + 离线回放脚本 | 竞品更成熟（有 UI） |
| 测试/兼容 | 17 个 DSH rc 版本，有 `.compat-results/` 运行时验证 | 未实现 | 竞品遥遥领先 |
| 平台 | Windows AppContainer 沙箱（beta）+ 跨平台基础功能 | macOS 为主 | 侧重不同 |

**结论：重叠约 60%，但重叠的是"骨架"，差异在"内核"。**

三项真正冲突（不能共存）：

1. **都占 `tools/pre-execute` 的队首**——它靠 `prepend` 抢在最前，本设计也 `prepend`。两者同时装，执行顺序取决于加载顺序；
2. **都定义权限档**——它往 preset 表里塞五个自定义档，本设计用 `registerAuto` 单槽注册 `auto`。`registerAuto` 只允许一个注册者，而它的档位是配置项（`gatePresets`），**理论上可共存**，但两者的"自动审查"语义会打架；
3. **都做升权自动应答**——它在 `approval/request` 上按 callId 自动批，本设计放弃了这个（理由见 [方案演变记录](docs/decisions-and-questions.md#design-15)）。同时装会出现两个应答器争抢。

**可借鉴但不必自研的部分**（若最终决定不自研）：

- **"allow every occurrence" 写进 `permissions.yaml`**（不是 spawn grant）——持久规则是可参考的机制；本产品采用离线建议与独立人工审核入口，当前审批不直接创建未来免审规则（[规则沉淀](docs/rules.md#design-5-10)）；
- **硬类别永不学习**（`deletion`/`credential`/`remote`/`system`/`bulk`）——本设计分别维护离线免审候选限制与运行时审查判定规则；人工确认后的正式规则不按来源区别处理（[规则沉淀](docs/rules.md#design-5-10)、[审查规则矩阵](docs/approval-modes.md#rule-matrix)）；
- 网络代理策略层（虽然它自己坦承是"协作式"而非强制，且 Node.js `fetch` 不受拦截）；
- `word#recursive` 这种命令修饰符语法（`rm#recursive` 匹配 `rm -rf`），比纯 regex 更可读；
- 五档权限设计中的 `permissive-full` vs `permissive` 沙箱/审批解耦——本设计的 trusted/guarded 双模式已覆盖同等语义。

**明确不值得借鉴的**：

| 它的机制 | 不采纳理由 |
|---|---|
| 会话 grant（精确指纹 + TTL + 次数） | 精确操作本就不重复；上下文无关的免票有隐患；与 `authorized` 维度冗余（[规则沉淀](docs/rules.md#design-5-10)） |
| 在线学习（`riskLearning` / `riskSediment`） | "被批准"≠"安全"；离线分析有 hindsight、可评审、可回滚（[规则沉淀](docs/rules.md#design-5-10)） |
| 五档权限表整体替换 | 必须重述三个内置档，每次 DSH 新增档位都要跟进（它为此写了测试钉 key 集合）；`registerAuto` 单槽不需要承担该维护负担 |
| `trustEscalation` 自动应答升权 | 审批请求不携带机器可读目标，自动应答等于用不可信输入批准整次无围栏调用（[方案演变记录](docs/decisions-and-questions.md#design-15) 决策记录） |

**本设计真正独有的**（竞品都没有）：

1. **决策模型的概率分布 + 概率门**——它只有 LLM 的 `safe`/`risky` 二值分类，没有分布、没有 `confidence: null` 语义、没有 τ 阈值；
2. **授权强度作为正交维度**（`authorized` 0–10 + 三级导出）——它的 P2 只有 allow/deny/ask，没有"授权程度"这个维度；
3. **three probes → 不变式**（`secrets`/`destructive`/`egress` 的确定性组合）——它的 P0 靠关键词黑名单，没有结构化探针；
4. **AST 结构分类 + 事实段**（[事实完整性闸门](docs/review-context.md#design-5-2-2)）——它的 argv 分解没有"完备性闸门"的概念；
5. **子 agent 完整处理**——它只有一句 "inherit but cannot mint"；
6. **离线候选 + 独立人工审核 + 普通规则管理**——本产品将建议生成与生效分开，人工确认后统一规则语义；早期方案中的来源分支与学习规则复检已取消（[当前规则契约](docs/decisions-and-questions.md#confirmed-rule-contract)）。

**建议的判断**：

如果目标只是"命令白名单 + 少弹窗"，**直接用它**，它的成熟度（兼容 17 个版本、有 UI、有网络策略）远超自研。

如果目标是"决策模型 + 概率判定 + 结构化探针"，**自研**——但应当**借鉴它的 grant 设计、规则语法和网络层思路**，并且明确不与它同时安装（两者在 `pre-execute` 队首冲突）。

**一个中间路线**：自研只做"审查层"（不含规则引擎），把自己插在它的 P3 位置——但它的 P3 是内部实现，没有对外扩展点，这条路走不通。

---

<a id="design-5-9"></a>

## 成本与额度

Clef 系列在 Workers AI 的定价与免费额度（已核实）：

| 模型 | 价格 | Neuron 密度 | 免费日额度 | 约合调用数/天（1.5K tok/次） |
|---|---|---|---|---|
| Clef | $0.240/M tok | 21,818/M | ~458K tok | ~300 |
| Clef-omni | $0.150/M | 13,636/M | ~733K tok | ~490 |
| Clef-flash | $0.038/M | 3,455/M | ~2.9M tok | ~1,900 |

- 免费档：10,000 Neurons/天（00:00 UTC 重置）；
- Clef 64k context（Jev 32k），对历史段增长更友好；
- Apache 2.0 开放权重，可本地部署规避数据外发；
- Jev（TypeSafe）：$0.042/M tok，输出免费，API 与 Clef 兼容，可后续切换。

**降本三招**：规则层先短路（零 token）→ 历史段裁剪（fork 时可加）→ 便宜型号（flash）做热路径。
