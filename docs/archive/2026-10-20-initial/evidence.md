# 调研证据清单

本文件记录设计所依赖的**实测事实**及其来源，供后续实现时复核。凡标注"源码"的，均已从 DSH 0.2.1-rc.2 安装包（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）中提取实现代码确认。

---

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

## 2. 审批 seam

| 事实 | 来源 |
|---|---|
| 结果词汇只有 `allowed-once` / `rejected` / `cancelled` / `unavailable` | `dsh-user-approval/lib/index.js:31-34` |
| `never` 策略在 waterfall 分发**之前**返回 `rejected` | 同上 `decide()`: `if (this.effectivePolicy(session) === "never") return "rejected";` |
| 请求只携带 `agent, toolName, callId, reason, displayReason, signal`，**不含工具参数** | `dsh-user-approval/README.zh.md` 已知限制 |
| 应答者是 `approval/request` waterfall 监听器，返回结果即作答，`next()` 委托 | 同上 |
| 无 `allow-always`、已记住规则、撤销、授权存储 | 同上已知限制 |
| `never` 会向模型注入句子："Approval prompts are disabled in this session…do not request sandbox escalation" | `dsh-user-approval/lib/index.js:39` |

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

## 4. 升权（escalation）

| 事实 | 来源 |
|---|---|
| `sandbox_permissions` + `justification` 必须在**执行前**提供（`approveBashEscalation` 在 execute 开头调用） | `dsh-tool-bash/lib/index.js:658` |
| `approveEscalation()` 走 `ctx.approval.request()`，返回 `allowed-once` 时给出更宽模式 | `dsh-sandbox/lib/index.js:99-123` |
| 升权目标是 `danger-full-access` 时，批准后整次调用无围栏 | `dsh-bash-sandbox/lib/index.js:67` |
| `never` 策略下升权被 waterfall 前拒绝 | 见 §2 |
| 拒绝结果附 `[sandbox: escalation available — retry this exact command once with sandbox_permissions...]` | `dsh-sandbox/lib/index.js:76` |
| bash 工具描述要求："a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way" | `dsh-tool-bash/lib/index.js:250` |

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

## 8. 命令与上下文贡献

| 事实 | 来源 |
|---|---|
| `ctx.commands.register({ name, description, input?, handler })`，handler 返回 `success`/`error` + UI 文本 | `dsh-commands/README.zh.md` |
| 命令在 UI 命令平面执行，不产生模型消息 | 同上 |
| 插件可贡献 system prompt 段落（tool-bash 贡献 `tool:bash`，auto review 贡献上下文） | `dsh-tool-bash/lib/index.js:381`、`dsh-sandbox-policy/lib/index.js:122-128` |
| 会话自定义事件用 `session.append(type, data)` + `sessionProjections.register` 折叠 | `dsh-sandbox-policy/lib/index.js:40-42`、`dsh-permission-presets/lib/index.js:189-200` |

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

## 13. 子 agent 的审批策略固定为 never

| 事实 | 来源 |
|---|---|
| 子 agent 创建时 approval policy **硬编码为 `"never"`**，与父会话策略无关 | `dsh-subagent/lib/index.js:408` `captureDelegatedPolicyOverrides()`：`approvalPolicy: parent.ctx.get("approval") === void 0 ? void 0 : "never"` |
| 该值以 `source: "delegation"` 事件写入子会话日志 | 同上 `appendDelegatedPolicyOverrides()`:425-436 |
| `permissionPreset` 仅在父为 `auto` 或 `danger-full-access` 时继承 | 同上:410-412 |
| `sandboxMode` 继承父会话的显式覆盖（不继承部署默认与一次性 grant） | 同上:411 |
| `never` 在 **waterfall 分发之前**结算为 `rejected`，应答器收不到请求 | `dsh-user-approval/lib/index.js:175`：`if (this.effectivePolicy(session) === "never") return "rejected";` |
| 子会话通过 `parentSessionId` 标识归属（可用于插件识别） | `dsh-subagent/lib/index.js:346` `childSessionMeta()`、`:41` schema |
| 子 agent 的模型可见上下文预置固定文案 | `dsh-subagent/lib/index.js:363` `SUBAGENT_DELEGATION_CONTEXT`（"operations that require approval are rejected automatically"） |
| 注释原文确认设计意图 | 同上:403-404："the approval policy is pinned to `'never'` regardless of the parent's own policy" |

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

### `dsh-perm-gate` 详细资料（补充 §14）

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

### `dsh-perm-gate` 的豁免与学习机制（补充 §14）

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
| 修正方案：`bulk` 作风险放大条件，`destructive ∧ (bulk ∨ auth=none) → 不自动 allow` | 本设计 §5.6.2 |
| `bulk ∧ egress`（无 secrets）不硬拒——批量推送/上传是常见工作流 | 同上 |

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
| 结论：用 re2js 替代"自建安全子集 + ret 审计"，校验逻辑从"维护语法清单"简化为"catch 编译异常 + `^` 锚定检查" | 本设计 §4.2 |

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

## 18. 父会话授权证据的可达性

| 事实 | 来源 |
|---|---|
| 子会话的 `session.header.parentSessionId` 标识父会话（`SESSION_ID_SCHEMA`） | `dsh-subagent/lib/index.js:41,47` |
| 父 agent 发给子 agent 的消息 source 为 `{ kind: "agent-message", form: "relay", senderSessionId }` | `dsh-subagent/lib/index.js:444-464` |
| 人类消息的 source 为 `{ kind: "user" }` | `dsh-session` / `dsh-subagent` 的 `createUserMessage` 路径 |
| `ctx.sessions.get(id)` 可查 live session；`session.deriveMessages()` 给出派生的模型历史 | `dsh-session/README.zh.md:32-47` |
| `deriveMessages()` 返回的是**压缩后的派生历史**，compaction 会摘要旧消息 | 同上 + compaction 机制 |
| 子 agent **不能**调用 ask 工具：`userQuestions.assertLiveRoot` 对非 root 抛 `DELEGATED_CALLER` | `dsh-user-questions/lib/index.js:534` |
| 该限制的原文理由："an owned child has no human answerer and would block forever, while a lineage-bearing session resumed as a new runtime root may ask normally" | 同上:650-660 |
| `agents.roots()` 返回无 owner 的顶层 agent；`agents.get(id)` 查 live agent；`agents.list()` 列全部 | `dsh-agent/lib/index.js:596-620` |
| 因此 `approval` 与 `userQuestions` 两条通道对子 agent 均封死，只有 `agent-message` 双向开放 | 由上述事实推定 |

## 19. 先前裁决的可读回性

| 事实 | 来源 |
|---|---|
| 插件会话记录用 `appendPluginRecord(session, type, data)` 写入，类型须匹配 `^plugin:[a-z0-9][a-z0-9._-]*(?:/...)*$`，自动带 `ignorable: true` | `dsh-session/lib/index.js` `PLUGIN_RECORD_TYPE`、`#appendRecord` |
| 读回用 `pluginRecordOf(event)`，返回 `{ type, seq, time, data }`，非插件记录返回 undefined | `dsh-session/lib/index.js:1306` |
| 会话日志是 append-only 且事件 deepFreeze，**不能修改历史记录** | 同上 |
| 官方 auto review 的历史构造：`user/message` 中 `source.kind === "tool"` 的记录**直接跳过**（工具结果不进历史） | `dsh-experimental-auto-review/lib/index.js:255` |
| 官方只把 `assistant/message` 里的 `tool-call` 块加入历史，`role: "fact"`，含 `name` + `arguments` | 同上:289-295 |
| 官方历史**无长度上限**（全部塞入） | 同上，全文无 slice/cap |

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
| 结论：不注入整条 AGENTS.md 链（绝大部分与审查无关），改用 `CUSTOM_RULES`（配置页全局）+ `PROJECT_RULES`（工作区根目录 `.dsh/arbiter.md`，不 searchUp） | 本设计 §5.2.3.1 |

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
| 结论：用 tokenx 估算，`maxInputTokens = 10000` 即截断值，不设隐藏边际 | 本设计 §5.2.6 |
