# 实施路线与验证清单

保留早期 P0–P11 路线、[2026-10-21 完整实现交接](initial-implementation-handoff.md)与运行时验证清单。**2026-10-23 已确认：离线规则建议及其入口、生成、验证和审核流程移出首版；当前交付以[首版范围](requirements.md#first-release-scope)及各专题最新契约为准。** 先完成核心功能并积累真实日志，已有候选原型只作后续参考，首版功能入口也按新范围收敛。**第一轮七组宿主覆盖验证已于 2026-10-20 在 DSH 0.2.1-rc.2 上执行完毕**，结果见[本轮验证结果](#host-coverage-run-1)。

状态：首轮完整功能版本已实现并可在隔离 DSH 0.2.1-rc.2 profile 中试用；详细证据、初版实现选择与剩余缺口见[首轮实施报告](implementation-report.md)。产品语义仍按各专题保留讨论状态。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [首轮完整实现交接](initial-implementation-handoff.md)
- [早期实施阶段](#design-12)
- [交给 DSH agent 的宿主覆盖验证](#host-coverage-validation)
- [第一轮验证结果](#host-coverage-run-1)
- [权限 UI 与生命周期四组验证](#permission-ui-validation)
- [冷恢复修复与权限生命周期补测交接](#permission-recovery-followup)
- [首轮功能实现结果（2026-10-21）](#first-implementation-run)
- [验证总清单（按阶段安排）](#design-14)

---

<a id="design-12"></a>

## 早期实施阶段

下表保留早期 P0–P11 编号用于追溯，含尚未收敛的默认值及过时顺序；P7／P9 已按最新范围移出离线建议要求。[完整实现交接](initial-implementation-handoff.md#sequence)记录此前实施顺序，后续按当前专题契约推进：测试随模块实施，审计尽早接入，核心用户流程纳入首版；不要把早期代码示例和迁移注意直接视为对日常环境的操作授权。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 包骨架 + cordis.patch.yml + registerAuto + 空规则表 | 插件页可安装启用；菜单出现「自动审查 (EXP)」；选中后生效 |
| P1 | AST 解析 + exact/regex 规则 + allow/deny | `gh pr view` 免审；未命中交审查；规则误配在加载期报错 |
| P2 | 判定引擎（五层）+ IR + 快照构造 + `chat` 后端（含 `session`） | 未命中命令可被判定；日志含 IR 与 driver |
| P3 | `decision` 类型（REST + score/noul questions）+ 概率门 | 配好 key 后经决策模型判定；日志含完整分布 |
| P4 | 拒绝理由（模型可见模板 + 用户 display） | deny 时 agent 收到可执行理由且不含数字/外部文本 |
| P5 | **dry-run（`enforce: false`）+ 规则测试（[规则测试](configuration-and-audit.md#design-8-3)）** | 干跑只记录不拦截；测试支持裸命令/带工具名/JSON/多行输入，输出汇总 + 展开，标注被遮蔽的规则 |
| P6 | 超时 + 熔断 + 去重 | 超时进入 error-escalate；故障与风险拒绝分开计数；去重结果不跨配置和审批模式复用 |
| P7 | 配置页（规则表 + reviewer 类型/配置 + 阈值 + 探针锚点）；候选审核界面延期 | 可增删改并保存；非法 regex、criteria 不足 11 项被拒；规则管理和测试按最新契约验收 |
| P8 | guarded 执行模式与主／子任务审批模式设置 | 主会话三档、子任务统一两档；配置成功应用后按新值判定，已弹出审批保留；见[审批模式](approval-modes.md) |
| P9 | 审计日志 + 策略回放 + 质量指标（含 promoted 占比）；离线规则建议延期 | 插件内查看及直接查询 SQLite，可统计归因、误放率、锚定迹象；不要求专门导出功能。日志按既定范围保存，候选生成、验证与审核不作为首版验收 |
| P10 | 测试覆盖 + CI | 单测覆盖 AST 解析、RE2 匹配、判定引擎五层、后端响应解析；CI 跑通 |
| P11 | 发 npm + 迁移到其他设备 | `pnpm dsh plugin add dsh-arbiter` 可用 |

早期迁移设想是在目标 profile 中移除 `@deepseek-ai/dsh-experimental-auto-review`。当前[共存契约已确认](architecture.md#approval-provider-coexistence)：官方互斥、其他插件行为告警、运行中保留原审查并通知，不维护第三方名单；实际检测与恢复仍需验证。首轮只在隔离测试 profile 中配置单一 auto-review 提供者，日常 profile 的替换不随开发自动执行。

**顺序理由**：先做判定引擎 + `chat.provider: "session"`（P2）可以最早得到可用的端到端链路——无需任何新凭据（复用当前会话的 provider），能立刻验证快照构造与阈值映射；`decision` 类型只是把"取结构化结果"换成带分布的 REST 调用。即使 Clef 短期拿不到 key，插件仍然可用（规则层是独立价值）。

---

<a id="host-coverage-validation"></a>

## 交给 DSH agent 的宿主覆盖验证

建议先完成一轮宿主内的最小集成验证，再决定外层 run_code 策略及首版覆盖承诺。执行者使用 DSH agent；可比对宿主源码，但“源码里存在 hook”“模型说自己没有执行”和“插件实际阻止了 body”是不同证据。当前没有 dsh-arbiter 实现，本轮只验证宿主接入机制，不要求先完成规则引擎、reviewer 或配置 UI。（本节保留任务设计；执行结果见[下一节](#host-coverage-run-1)。）

**本轮范围只有下表标为“第一轮”的七组用例。** 后面的 1–47 是整个项目的验证总清单，不是这次 DSH agent 的任务；其中第 21、28 项与本轮重叠，也只验证表内限定的路径。标为“后续扩展”的组合另行安排，不作为本轮完成条件。

### 可直接交接的任务

> 在本机 DSH 中验证 dsh-arbiter 的工具与执行路径覆盖假设。先阅读本项目的 architecture.md「工具与执行路径覆盖范围」及 evidence.md §22，核对实际 DSH 版本和当前 profile。使用隔离的测试配置与专用测试目录，制作最小探针插件，记录 tools/pre-execute 与工具结果；对指定测试调用给出确定的允许或拒绝，以实际 body 标记、文件变化或本地 MCP server 收件记录确认是否执行。本轮只执行下表标为“第一轮”的七组用例，不执行后续扩展或文末 1–47 总清单。保存可复现的探针、用例和原始记录，将结果逐项回填 evidence.md §22，并更新覆盖矩阵。区分运行确认、运行反证、仅源码支持和未运行；遇到缺失后端或无法构造的路径，记录原因。产品策略仍待决定，不以测试配置替产品定案。

入口：[覆盖矩阵](architecture.md#execution-coverage) · [源码依据](../evidence.md#evidence-22)。本轮验证决定架构的路径，扩展组合留待后续安排：

| 顺序 | 用例 | 必须取得的证据 |
|---|---|---|
| 第一轮 | 探针加载与普通工具 allow／deny | 同一已发出的测试动作有允许成功对照；deny 时 hook 已触发且 body 未执行。记录其他监听器、原生 guard 或沙箱是否参与，避免把它们的阻止误归因给探针 |
| 第一轮 | 外层 run_code 与内层 tools.bash | 分别拒绝外层和指定内层：前者程序不启动，后者只阻止该内层 body；记录调用关联，测试 catch 后继续与至少两个并发内层调用 |
| 第一轮 | 直接 Node 效果与文件沙箱 | 用自建文件、本地网络接收端和无害子进程对比工具 hook 记录与实际效果；分别验证 full-access、workspace-write，以及允许根内／外写入 |
| 第一轮 | MCP 直接调用、PTC 内调用与资源工具 | 使用可记录收件的本地测试 MCP server，证明 deny 发生在 RPC 发出前；服务器内部效果只形成一次工具入口，不虚报逐项覆盖 |
| 第一轮 | 进程内 spawn／fork | 在子任务中真实发出同一测试调用，验证允许／拒绝、子会话身份和父会话关联；证明创建时的 never 不阻止 pre-execute 判定，并核对原生人工审批被拒的路径 |
| 第一轮 | workflow 服务直调 | 分开记录 workflow 工具入口、编排创建子任务及本地子任务自己的工具调用，验证哪些步骤没有独立工具门禁 |
| 第一轮 | 原生沙箱升权 | 区分工具准入和工具 body 内的升权审批；记录 allow 后是否仍请求原生审批及 never 下的结果。实际人工批准需真实用户操作，不能用模型答复冒充 |
| 后续扩展 | 生命周期与其他组合 | 不同 preset、子任务冷恢复／后代、MCP 工具列表变化／断连、持久 PTC、后台 workflow、Web／headless 与无 exec.agent 调用；按首版支持范围选择并注明未测组合 |
| 后续扩展 | 外部后端 subagent | 有可用测试后端时核对委派入口与外部执行记录；没有后端就标未运行。父 DSH 未观测到内部调用不能单独证明“所有外部后端都不可接入” |

### 探针与取证要求

探针只处理明确标记的测试调用，其他调用交还原链路；用固定结果排除模型审查质量和阈值的干扰。测试配置改变了挂载位置、监听顺序或原生审批处理时，必须记录。模拟审批只能证明接口行为，不能记为真实 UI 或人工审批已验证。

每个用例至少记录：用例 id、DSH 版本／平台／profile、插件挂载与工具展示模式、会话类型、有效沙箱／审批策略、实际发出的工具及参数、hook 记录、判定、body 是否开始及效果证据、工具结果、源码预期和实测差异。用 callId、rootCallId、可记录的 parent 关联和 session 标识串联，勿将 exec.parent 误当成父 agent。

验证“没有经过门禁”时，必须同时证明动作确实发生、探针在同一环境正常工作；模型没有发出调用、工具不可见、其他策略提前拒绝或日志缺失，均不能作为绕过证明。外层程序／本地服务入口有记录，也不能据此推断其内部效果逐项被审查。

文件效果只用测试夹具；测试允许根外写入时，选择专用测试工作区的受控同级目录，并核对其不在任何实际允许根内，不能直接把 /tmp 当作根外。网络效果仅向本地测试接收端发送固定无敏感数据。保留原始证据，收尾移除临时插件、进程和测试配置，不改日常会话的权限配置。

### 回填标准

| 状态 | 含义 |
|---|---|
| 运行确认 | 给定版本、环境和路径下有可复现记录支持结论；不外推到未测组合 |
| 运行反证 | 实际行为与源码解读或覆盖假设不一致，附最小复现与影响 |
| 仅源码支持 | 代码路径已核对，但没有完成对应运行实验 |
| 未运行 | 缺后端、配置、人工参与或其他条件；明确原因，不算通过 |

回报应包括已测矩阵、复现步骤、原始日志位置、差异及其对产品设计的影响。宿主验证完成后，正式插件仍需验证实际规则／reviewer／配置集成；模型判断质量与阈值留给后续评测。

---

<a id="host-coverage-run-1"></a>

## 第一轮验证结果（2026-10-20）

**一句话**：七组全部执行。第 1–5 组完全运行确认；第 6 组只覆盖基本路径；第 7 组覆盖 never／ask 下的原生结果，**真实人工审批未运行**。同时得到一项**运行反证**：`prepend` 无法让插件排在已有的 `prepend` 监听之前。

环境：DSH **0.2.1-rc.2**（与源码结论同版本）· macOS 27.0.1 / arm64 · headless 入口 · 每用例独立 `DSH_HOME` 与自建 profile · 确定性模型回放（不调用真实模型）。

**报告**：[validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md](../validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)　**复现说明**：[README.md](../validation/host-coverage/2026-10-20-host-coverage-01/README.md)　**原始证据**：同目录 `cases/<id>/` 与 `raw/case-index.json`；逐项回填见 [evidence.md §22.1](../evidence.md#evidence-22)。

| 组 | 完成情况 | 关键实测 | 未完成原因 |
|---|---|---|---|
| 1 普通工具与探针加载 | 完成 | allow 对照执行、deny 时 hook 触发且 body 未执行；插件 allow 不能绕过原生 guard | — |
| 2 `run_code` 外层与内层 | 完成 | 外层 deny 程序未启动；内层 deny 可被 catch；两个并发内层一放一拒；记录 callId／rootCallId／parent | — |
| 3 直接 Node 效果与文件沙箱 | 完成 | `fs`／`fetch`／`child_process` 均无独立门禁；workspace-write 只限写入；`/tmp` 属于允许根 | — |
| 4 MCP 工具与资源 | 完成 | deny 时服务端握手成功但无 `tools/call`／`resources/read`，拒绝在 RPC 前 | 动态列表与重连未测（后续扩展） |
| 5 进程内 spawn／fork | 完成 | 两种子任务内均实测 allow／deny；子会话含 `parentSession`；创建时 never 不阻止插件判定 | 不同 preset、冷恢复、后代、并发未测（后续扩展） |
| 6 workflow 服务直调 | 完成（基本路径） | 入口可拦截；内部创建子任务不产生 `subagent` 入口；子任务自己的调用仍受门禁 | 后台、取消、生命周期组合留待后续 |
| 7 原生沙箱升权 | 完成（含模拟标注） | 工具 allow 后仍进入原生审批；never 下拒绝且无效果；ask 无应答者时 unavailable | **真实人工审批未运行**：无用户参与，模拟结果单独标注 |

### 对设计的影响

1. **监听顺序**：`prepend` 只保证排在同类 `prepend` 监听之前；headless 组合下已有一个非探针 `prepend` 监听（源码对应 `dsh-tool-jobs`），加入官方 auto-review 后有两个。若产品承诺“规则短路先于其他审查”，需显式排序方案，或在产品表达里限定为“不保证优先于其他审查者”。已登记为 [O11](decisions-and-questions.md#question-o11)，**尚未定案**。
2. **子任务拒绝文案**：never 下原生 seam 返回 `rejected`，模型看到“the user rejected …”，实际无人参与。插件必须自己记录拒绝来源，不能沿用原生文案。
3. **外层 `run_code` 策略**：外层 deny 在实测中确实阻止了程序启动，说明外层准入是有效的粗粒度控制点；但它不覆盖程序内部效果，仍需程序审查输入（待定）。
4. **文件沙箱边界**：实测确认它只限制写入，不限制读取、网络与子进程，与现有表述一致，不需要修改。

### 仍未验证（不计作通过）

- 真实人工审批与 UI 路径；
- 外部后端 subagent（无可用后端）；
- 不同 preset、子任务冷恢复／后代、并发子会话；
- MCP 工具列表动态变化与断连重连；
- 持久 PTC、后台 workflow 与取消；
- Web 之外的 surface（headless 已测，Web／独立进程未测）；
- 插件在目标 profile 的实际安装与启用；
- 正式规则／reviewer／配置集成与模型判断质量。

**1–47 总清单没有因此完成**：本轮只执行七组，其中第 21、28 项只覆盖表内限定路径。

---

<a id="permission-ui-validation"></a>

## 权限 UI 与生命周期四组验证（2026-10-21，已运行）

用户已选择在原权限控件位置提供 arbiter 自有选择器；trusted / guarded 只在插件配置页选择，以后端会话状态区分插件已启用的 guarded 与普通工作区写入。本轮任务为验证宿主接入能力，不是重开 P0–P11 或立即改造首轮正式实现。完整任务见[权限 UI 验证](permission-ui-validation.md)，产品契约见[架构](architecture.md#permission-selector-contract)。

运行 id `2026-10-21-permission-ui-01`，DSH 0.2.1-rc.2，隔离 `DSH_HOME` + 真实 Web 客户端（headless Edge / CDP）。
报告：[REPORT.md](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md)；断言 `63 passed, 0 failed`。

| 组 | 本轮范围 | 状态 |
|---|---|---|
| U1 菜单覆盖 | 同位置 slot 覆盖、原选项保留、撤销覆盖、trusted／guarded 实际边界与会话隔离 | **运行确认**（bash 对照受本机 `sandbox-exec` 限制，越界写入用 fs 工具验证） |
| U2 原生命令同步 | 显式及裸 /permission、guarded 下同值 workspace-write 切出、auto 入口与执行边界一致性 | **运行确认**；同值切出可用公开 `session/event`+`command/run` 捕获；`/permission auto` 的 full-access 展开**受限** |
| U3 重连与恢复 | 刷新／重连、迟到状态、宿主冷恢复、新会话不误启用、独立于审计 SQLite | **运行确认** |
| U4 停用／卸载 | 仅迁移仍接管会话到工作区写入、原控件还原、在途收尾与宿主取消、关闭会话恢复 | **探针 fiber.dispose 路径运行确认**；真实 plugin_manager 停用／卸载、等待期间新调用、真实人工答复及 PTC 取消仍待补测 |

### 冷恢复修复与生命周期补测（2026-10-22，运行 id `2026-10-22-permission-recovery-01`）

本轮在**正式插件**上修复并补测。报告：[REPORT.md](../validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md)；
工程检查 `pnpm verify` 通过（78 tests + R1–R9）。完整任务见[交接](permission-recovery-followup.md)。

| 项 | 修复 | 状态 |
|---|---|---|
| F1 记录写入 | 新增 `src/records.ts`，只调用公开 `appendPluginRecord`；失败只记录，不回退 `session.append`。新增 `src/repair.ts` 与 `scripts/repair-session.ts` 处理旧日志（备份、只改 arbiter 记录、幂等） | **运行确认**：真实"写→关→退宿主→重启→重开"，记录 `ignorable: true` 且可读回；移走审计目录后仍恢复 |
| F2 原生 auto 拒绝 | `registerAuto(admit)` 在权限写入前抛 `AutoEntryRejected`；用 `command/run`/`command/done` 区分用户切换与冷恢复；删除写原生 auto 的旧 `/arbiter mode` | **运行确认**：guarded / trusted / 未启用三档均拒绝且状态零变化；其他命令回归 |
| F3 真实管理器停用／卸载 | 管理器开关及 removeBundle 路径已运行 | **基本操作运行确认**；与在途请求的重叠需按[复核](../evidence.md#permission-recovery-review)补测 |
| F4 收尾期新调用 | 新增 managed、accepting、drain（≤30s）与回退逻辑 | **真实收尾窗口未覆盖**；已有产物只证明回退后写入被挡住，不能认定并发绕过已修复 |
| F5 真实人工审批 | 真人分别允许／拒绝 | **真人答复运行确认**；审批中切换已补测（换不同预设并经公开命令调用成功） |
| F6 PTC 取消 | — | **运行确认**：`abort: sandbox mode changed`，内层未执行，迟到 allow 未放行 |

**新确立的实现约束（在原有四条之上）**

5. 记录必须用 `appendPluginRecord`；该包在 profile 未声明时由 `src/records.ts` 按"裸导入 → 运行中宿主安装根"解析。
6. 卸载必须先 `accepting = false`、等待在途、再回退；回退前折叠会话自身权限，已是 workspace-write + ask 的不写事件。
7. `registerAuto` 的 admit 没有参数；区分"用户切换"与"恢复旧 auto 会话"只能借助 `command/run` 生命周期，属于推断。

**本轮确立的实现约束（接入前必须满足）**

1. 选择器必须通过 `ctx.slots.inject('conversation.input.permission', …)` 注册，并使用**负** `priority`（数值越低越优先）。
2. 同值 `/permission` 的退出意图只能在 `session/event` 的 `command/run` 上观察，且状态写入必须 defer 到下一拍（commit 内 append 会重入报错）。
3. 会话启用记录必须用 `appendPluginRecord`（带 `ignorable: true`）。当前实现里的 `session.append('plugin:arbiter/decision', …)` 会让冷读拒绝整份日志。
4. 审批挂起时 composer 被宿主禁用，退出入口需要 `session.command()` 或原生控件。

既有首轮实现与七组覆盖结果不证明本轮四组能力已完成。该轮验证没有自行决定原生 auto 取舍；2026-10-22 用户已确认拒绝该原生入口，后续正式修复与补测见下节。

<a id="permission-recovery-followup"></a>

## 冷恢复修复与权限生命周期补测（2026-10-22，已运行）

本轮用户要求 DSH agent 修复正式写入与原生入口拒绝，并补齐真实生命周期验证；已在**正式插件**上完成大部分，
详细交接见[任务文档](permission-recovery-followup.md)，结果见[本轮报告](../validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md)。

| 项目 | 内容 | 当前状态 |
|---|---|---|
| F1 | 正式插件记录改用 appendPluginRecord；真实冷恢复、无 SQLite 对照、旧日志副本兼容／修复 | **已修复，运行确认**：真实"写→关→退宿主→重启→重开"、审计目录移走对照、备份式修复（5 单测） |
| F2 | 原生 auto 在权限变更前拒绝，保持原状态；自有入口与其他命令回归 | **已实现，运行确认**：guarded／trusted／未启用三档零副作用；同值切出与其他预设回归 |
| F3 | 实际插件管理器停用与卸载，检查依赖、收尾、回退和会话恢复 | **管理器基本操作确认**：热停用、卸载、重启不复活及会话重开成立；在途重叠待屏障补测 |
| F4 | 收尾窗口内同会话／其他会话的新调用，命令失败与并发时序 | **需补测真实窗口**：原裁决已在停用步骤前完成，不能由回退后写入失败推断 active > 0 时没有绕过 |
| F5 | 真人实际答复、切出及真实管理器操作下的审批链结算 | **真人答复运行确认**；切换已补测：切到 read-only 后真人批准 → `human-allow`，执行仍被沙箱挡住 |
| F6 | 真实已启动 run_code／PTC 的沙箱切换取消，迟到结果与部分效果 | **运行确认**：`abort: sandbox mode changed`，内层未执行，迟到 allow 未放行 |

`pnpm verify` 通过：**78 tests + R1–R9 9/9**；R3 的断言已按 F1 的新约束调整（裸 stub 无法承载 ignorable 记录）。
F5 由操作者本人用自己的浏览器打开宿主的 token URL 完成，驱动只观察 `approval/decided`，没有代点。

<a id="permission-lifecycle-run"></a>

### 时序修正与真实并发补测（2026-10-22，run id `2026-10-22-permission-lifecycle-02`）

上一轮的时序方法有误，本轮先更正再补测；报告见
[REPORT.md](../validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md)。

| 项 | 结果 |
|---|---|
| 夹具时序 | 等待**前**记录 `<callId>-started.json`，按 `<callId>-release` 可控释放；`callId` 取自生产代码 `review/start` 轨迹 |
| 驱动闸门 | 以 `unload/stop-admission` 轨迹为闸门提交并发调用，而非"点完开关即视为停用" |
| **复现的实现缺陷** | 卸载顺序 `停接管 → 等 active → 回退` 使 drain 窗口内的新调用继承旧 `danger-full-access`，写出 workspace 外文件 |
| **修复** | 改为 `停接管 → 立即回退 → 等待在途 → 释放`；修复后同一场景被沙箱挡住，文件未生成 |
| 回归 | `tests/unload.test.ts` 新增顺序断言，已验证在旧顺序下失败 |
| 审批挂起时切换 | **可以**：`/permission read-only` 与 `/permission workspace-write` 均成功，审批保持挂起（更正上一轮结论） |
| 停用/卸载期间的审批 | 均保留、仍为 `approval/asked`、可继续答复 |
| 同一会话并行工具入口 | **实测存在**：同一步骤两个 `read` 并发进入 gate（+0ms / +6ms），各自裁决并成功 |

`pnpm verify`：**79 tests + R1–R9 9/9**。

---

<a id="first-implementation-run"></a>

## 首轮功能实现结果（2026-10-21）

首轮按[完整实现交接](initial-implementation-handoff.md#sequence)推进到可试用版本，不再停留在骨架或 mock：

- 宿主：真实 `tools/pre-execute`、`/arbiter` 命令、配置页、SQLite 审计、会话裁决记录；
- 规则：保守 shell 读取器、exact／RE2／glob、四值优先级、复合命令覆盖、规则测试；
- 审查：不可变 ReviewSnapshot、chat 与 decision 适配器、`arbiter-policy-v1` 判定引擎；
- 模式：主会话三档、子任务两档，人工允许／拒绝／未决结束与 fallback-deny 分开；
- 离线：本地候选生成、人工审核、normal 与 progress 回放。

工程检查 `pnpm verify` 通过（66 个单元测试 + R1–R9 复现 9/9 PASS）；真实 DSH headless 集成 14 个用例、146 项断言通过；Web 配置保存、冲突、校验、测试、日志、分析与回放路由在隔离 Web profile 中实测。真实人工审批与 decision 网络未运行，模拟审批在证据中单独标注。

完整报告与复现命令见[首轮实施报告](implementation-report.md)。

---

<a id="design-14"></a>

## 验证总清单（按阶段安排）

**以下 1–47 覆盖整个项目周期，不要求现在全部验证，也不是本轮 DSH agent 的交接范围。** 原来的“实施前需要运行时确认”措辞不准确：许多条目依赖当时尚未实现的解析器、reviewer、配置页或真实样本。

| 验证时机 | 原条目编号 | 范围与前置条件 |
|---|---|---|
| 本轮宿主覆盖验证 | 21、28 的部分内容 | 仅执行上方“第一轮”七组用例；其余组合和正式插件集成留待后续 |
| 对应模块设计／实现前 | 1、2、3、4、6、7、9、26、33 | 按模块需要做 API、依赖或数据可达性实验；不要求一次性验证，也不阻塞本轮覆盖结论 |
| 对应功能实现后 | 18、20、27、29、31、32、34、38、45、46、47 | 验证解析、规则、配置、审计及 UI 的实际行为；目前缺少被测实现 |
| reviewer 可运行并有样本后 | 5、8、10–17、19、24、25、30、35–37、39–44 | 评测模型质量、成本、阈值、输入预算及恢复参数，不能用宿主探针替代 |
| 后续版本恢复离线规则建议设计后 | 22、23 | 结合真实日志重新确定生成与验证机制；候选有效性及审核流程不纳入首版验收 |

编号保留用于追溯。旧条目中的示例数值和待决方案不因此成为发布标准；实际执行前按当前产品契约确认用例，下方“新增验收”同样在相应功能实现或评测阶段执行。

1. **Shell 解析与静态词解码接入**：2026-10-22 已确认 `unbash` 为优先候选，验证具体版本、DSH Node 与浏览器支持、解析错误及未知结构处理、静态／动态区分、引号／转义／拼接／空参数、字节边界与性能。按[独立状态契约](rules.md#matching-uncertainty)分别记录结构、词值和事实，验证嵌套错误、遍历上限、条件“或”三态传播、无关适用范围排除及相关高优先级未知阻止 allow 短路；实际匹配与测试共用转换和求值。匹配器按[完整匹配与大小写](rules.md#matcher-semantics)验证，不沿用旧前缀查找和强制 `^`。原条目为 tree-sitter WASM 的运行时、加载开销与内存验证，保留作替代方案，不表示已采用 unbash 或已完成宿主接入；
2. **插件能否贡献 system prompt 上下文段**（官方 tool-bash 有此先例，需确认插件侧 API）；按已确认的[执行指引放置方案](architecture.md#agent-instruction-placement)，验证主／子 agent 的覆盖、作用范围与压缩后保留；
3. **`permissionPresets.set()` 能否从斜杠命令 handler 调用**（官方 `/permission` 走该路径，需确认权限）；
4. **Clef API 可达性**（网络环境、Workers AI 账户开通）；
5. **Neuron 实际消耗**（按 1.5K tok/次估算是否准确）；
6. **`session.append` 自定义事件**是否需要在服务器端注册 schema（`sandbox/mode` 的先例是否要求白名单）；
7. **`plugins.bundle.config` 槽位对第三方包的可用性**（官方文档示例为 acme 包，应可用，需实测）；
8. **chat 后端在目标模型上的首次合法率与重试后合法率**（决定默认 `maxRepairRetries` 是否够；建议至少测 `glm-5.3-flash` 与 DeepSeek 系各一）；
9. **`ctx.llm.stream()` 是否允许插件在 pre-execute 内同步等待完整流**（流式 API 在阻塞路径上的用法，需确认取消信号传递）；
10. **`stop` 参数对 JSON 输出的实际帮助**（不同 provider 对 stop 的实现差异较大，可能无效）；
11. **`risk` 各级别的实测失败率与误放率**——运行时只能得失败率**下界**（`tools/result` 的 `isError`）；真正的误放率需要人工复核样本（[能得出什么、不能得出什么](configuration-and-audit.md#design-9-4)）。该数据决定 `τ_allow_level` 能否从 3 放宽；
12. **`risk`/`riskScore` 直方图是否出现阈值附近堆积**（锚定风险的实证）；
13. **探针矛盾检出率**（`risk ≤ 3` 却 `destructive`/`secrets`）——若偏高，说明锚点定义或 prompt 表述有问题，需调整定义而非加重重试；
14. **secrets 与正常认证的区分**——用正常认证和凭证材料外发样本验证探针定义；R1 的最终规则待确认，不能靠命令名或“曾被批准”代替判定；
15. **`score` 的 11 级 criteria 是否真的被区分**——检查 `probabilities` 是否集中在少数等级上，若是则中间锚点形同虚设；
16. **progress 的额外代批质量**——按同份信号、同配置版本的 normal 基线识别 promoted，并人工复核误放与授权范围；占比本身不作为误放结论；
17. **事实段对判定质量的实际影响**——对比开启/关闭事实段时，reviewer 的 `ask` 率与误判率是否改善；若无改善则说明 token 花得不值；
18. **`opaque` 识别的覆盖率**——统计实际命令中调用解释器/脚本的比例，以及被误标为 `complete` 的样本（这是 [已知限制清单](requirements.md#design-11-2) 列出的最脆弱判定点）；
19. **`probeMode: override` 的误判率**——override 命中而人工认为判错的样本数；若接近零可考虑默认开启，否则保持 `assist`；
20. **与竞品并存时的行为一致性**——若同时装 `dsh-permission-rules`，验证本插件的 allow 短路确实先于它执行，且它的 deny 仍能拦下本插件未命中放行的命令；
21. **子 agent 的识别与接入范围**——源码字段为 `session.header.parentSession`；验证进程内 fork／spawn、不同 preset、冷恢复与后代均进入插件。外部后端没有本地子 Session，须另行集成，不能使用同一字段假定内部已覆盖；
22. **离线候选生成的有效性（后续版本，待重新设计）**——待真实日志积累后再确定样本、指标与验收标准，旧稿的接受比例阈值不作为首版要求；
23. **离线候选与正式规则的边界（后续版本）**——未确认候选不影响运行时；确认后与内容相同的手工规则行为一致；可选来源提示不参与匹配；重新分析不会自动修改已确认规则；
24. **`bulk` 的判定一致性**——同一命令族（如 `rm -rf build/` 与 `rm -rf *`）判过是否稳定；若 `bulk` 频繁误判，需调整 prompt 中的 bulk 定义而非加重重试；
25. **bulk 组合规则评测**——用同批样例确定 R4、R6 等条件及 progress 扩展范围；normal / strict 的审查结果应一致，progress 的额外代批在审查阶段形成，不通过兜底覆盖；不得同时保留相互冲突的规则；
26. **re2js 在 DSH 运行时内的加载与性能**——本地实测 0.38ms，但需在 `pre-execute` 同步路径上验证；同时确认 ESM import 在 Loader 动态加载下正常；
27. **现有五条规则迁移到 RE2 后行为不变**——用同一批真实命令跑对照（旧实现 vs re2js）；
28. **工具与执行路径覆盖**——按[覆盖矩阵](architecture.md#execution-coverage)做集成验证：原生工具、外层 `run_code` 的最终产品策略、内层 bash／MCP 的并发及拒绝传播、直接 Node 效果与沙箱、MCP 工具和资源的动态注册、workflow 服务直调、不同 profile 与无 `exec.agent` 路径；源码已确认可接入不替代端到端验证；
29. **熔断的 turn 边界**——确认计数在 turn 切换时重置（README 措辞为 "per turn"，无源码确认）；
30. **超时与恢复参数评测**——8s 仅为 reviewer 超时初值；结合延迟、故障恢复、重复拒绝和成本评测等待、重试、熔断阈值与恢复方式，不预设固定发布值；
31. **变量展开的覆盖率**——`$HOME`/`$PWD`/同命令内赋值的静态求值能覆盖多少真实命令；`unresolved_expansions` 触发 partial 的比例；
32. **`cd` 追踪的正确性**——构造 `cd /tmp && rm -rf build` 这类用例，确认目标判定为 `/tmp/build` 而非工作区内；
33. **父会话 `deriveMessages()` 在 compaction 后的信息损失**——构造长父会话触发压缩，检查人类消息原文是否还在；若严重，改用事件日志扫描（[授权证据](review-context.md#design-5-2-3-2)）；
34. **父不在 live 时的降级**——父会话销毁后子 agent 的审查是否正常（应不注入父证据且 `parent_authorization_present = null`）；
35. **reviewer 对授权原文与转述的区分**——相同内容和范围的 parent-human / session-human 应按同一标准判定；比较仅 relay、原文 + relay、转述超出原文范围、授权撤回与原文缺失等情况，不能因来自父会话就降低 authorized，也不能把两次呈现计成两次批准；
36. **重试识别的准确率**——同一指纹重复出现时，reviewer 是否按层级正确处理（尤其 `invariant` 的重试应直接 deny）；
37. **`overlaps_denied_effect` 的召回**——`find -delete` vs `rm -rf` 这类同效果不同写法的识别率；若偏低，考虑在 facts 里直接列出重叠的具体路径而非只给布尔；
38. **裁决历史冷恢复的性能与保留能力**——正常审查使用内存；验证长会话中限量读取 `pluginRecordOf` 的代价，以及重开、插件重载、compaction 后原始记录是否仍可读。会话记录不足时验证 SQLite 补缺、共同事件去重与缺失标记；该项随恢复模块验证，不扩充本轮七组覆盖验证；
39. **`history.maxItems = 40` 是否合适**——实测长 turn（50+ tool call）下，40 条是否足以让 reviewer 看清近期上下文；若频繁触发 `history_truncated` 且判定质量下降，考虑调高；
40. **`CUSTOM_RULES` / `PROJECT_RULES` 的实际收益**——对比有/无这两段时，reviewer 的 `ask` 率与判定准确率变化；若几乎无差别，说明它们只是占 token；
41. **`role` 与 `evidence` 双字段是否被正确区分**——构造"人类说'删掉 build，但别碰 /etc'"这类同时含授权与限制的消息，验证 reviewer 没有把限制当成授权的一部分；
42. **`toolCallArgumentMaxChars = 200` 是否够**——统计被截断的比例，以及截断后 reviewer 是否仍能理解"刚才做了什么"；若截断率高且判定质量下降，考虑提到 400；
43. **tokenx 的实测偏差**——用真实命令/中文文本对比 tokenx 估算与后端返回的 `usage.input_tokens`；若系统性低估 >10%，考虑调低 `maxInputTokens` 或加系数；
44. **`maxInputTokens = 10000` 是否合适**——统计实际估算分布，看有多少次触发截断；若长期贴顶，说明预算偏小，或某些段膨胀异常；
45. **五层优先级的实际效果**——验证 `deny > force-ask > force-review > allow > review(default)`；force-review 无 hint 也强制审查；完整 allow 不被默认审查覆盖；无命中及复合命令仅部分被 allow 覆盖时进入默认审查；
46. **主／子任务模式独立配置**——父为 normal、子任务为 progress 等组合遵循各自设置；全部子任务统一生效且无单独覆盖；授权证据等级不会因模式选择而提升；
47. **规则测试输出在多条时的可读性**——实测 20 条命令的汇总视图，检查列宽与遮蔽列是否仍然清晰；若过于拥挤，考虑折叠未命中行或按判定分组。

新增验收（随对应功能实现／评测执行，不纳入本轮宿主覆盖验证）：

- 无已有用户配置时，按[已确认默认值](configuration-and-audit.md#initial-defaults)初始化为 chat + 跟随会话、guarded、主 normal／子 strict、空规则表；安装不自动接管会话，文档示例不自动变成预设规则。已有用户配置不被初始默认值覆盖。
- Reviewer 配置按[已确认交互](configuration-and-audit.md#reviewer-configuration)接入 DSH 模型列表：chat 用一个 select 选择具体模型或跟随会话，decision 手填对应字段；同名模型可区分，凭据不回显。
- [一次性 Reviewer 测试](configuration-and-audit.md#reviewer-test-ui)由后端用点击时草稿及固定合成样例发请求，经过正式解析／校验及修复重试，不被命令规则短路，不执行工具或发起人工／兜底处理；跟随会话禁用测试，保存不强制测试且不自动发模型请求。
- 测试弹窗展示本次模型、耗时、结果及可展开的逐次返回／校验信息，取消或关闭时传递取消；关闭后不保留测试状态、历史、配置版本关联或正式审批记录，不影响真实审批统计、运行时熔断或当前有效配置。
- 配置保存与生效状态正确区分；后端或输入协议变化不丢弃、重审已有结果；旧响应仍按原协议解释，日志记录各阶段实际配置；新请求不跨配置复用旧缓存。
- 已形成的 allow / deny / escalate 保留；尚未作出的后续判定使用新配置；已弹出审批跨配置变更仍维持人工处理。
- review-escalate 与 error-escalate 在两种人工可用性下得到正确结果；日志及历史输入保留完整链；fallback-deny 只结束当前调用，不取消其他独立调用、不被解释成人工拒绝。
- 人工审批仍有效且未回答时保持 pending；无答案而实际结束时为 human-abort，适配器不放行，审计保留原因，不计作人类反对或危险判定。人工答案与关闭事件并发时只能结算一次。
- 执行 agent 能获得受阻原因与恢复指引；父／子会话人类原话和父级转述按实际来源注入，不自动生成 human-allow。父级原话明确覆盖操作与范围时可支持 explicit，不再受父会话来源上限限制；纯转述仍不单独制造明确授权。
- 用户只回答“同意”时连同对应提问或操作进入证据；验证 ask 工具的真实人类答复事件映射与截断行为，不把普通工具输出当作授权。验证常驻指引能减少无变化重试、正确报告受阻，同时不让模型每次拒绝都立即询问用户。
- normal / strict 对同一信号、同一常规策略给出相同审查结论，区别仅在插件人工审批处理；预设自动批准范围为 normal = strict ⊆ progress，比较不包含人工批准。
- chat / decision 对同类操作使用统一授权标准，不能一个因使用 chat 要求 explicit、另一个因使用 decision 接受 implied；分别评测点值与分布的校准及实际效果。
- 三档均不因审批模式禁止 agent 使用 ask 或聊天；父会话为 strict / progress 也可以补充授权。验证 legacy 阻塞、timed pending、迟到答复和宿主对子 agent 的限制；ask pending 不映射成 human-abort，旧调用不因迟到答复自动执行。
- 普通设置以三档和命令规则为入口；若实现高级设置，验证自定义状态、恢复默认、normal / strict 共用配置以及每档 tooltip。高级字段范围按界面与评测结果细化。

---
