# 冷恢复写入修复与权限生命周期补测交接

日期：2026-10-22。状态：**F1–F6 均已有运行证据；在途重叠、新调用窗口与审批中切换经[时序补测](../validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md)结案**。首轮运行 id `2026-10-22-permission-recovery-01`，补测运行 id `2026-10-22-permission-lifecycle-02`。本轮结果外推边界见[结果复核](../evidence.md#permission-recovery-review)。

入口：[原生 auto 拒绝契约](architecture.md#native-auto-rejection) · [生命周期](architecture.md#permission-lifecycle) · [已验证能力](permission-ui-validation.md) · [结果复核](../evidence.md#permission-ui-review) · [PU 登记](decisions-and-questions.md#permission-ui-decision) · [本轮报告](../validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md)

## 已确认的产品要求

用户已确认：在 arbiter 提供审批能力的配置作用域内，**拒绝原生 `/permission auto`**，两档都适用；自有权限菜单仍可启用 trusted／guarded。拒绝必须在权限变更前发生，保持原有启用状态和宿主权限，不能先切 full-access、先退出 arbiter 或事后纠偏。命令失败不得被 command/run 观察者当成成功切出。

冷恢复、记录写入与权限裁决解耦的既定需求保持不变。插件停用／卸载停止新接管，保留在途审查与人工请求的正常收尾，再将仍受管会话回退到 workspace-write + ask；宿主取消继续按真实来源处理。真实管理器操作、等待期间新调用、真实人工答复及 PTC 取消尚未验证，不预设这些场景已经通过。

本轮修复正式会话记录写入、落地入口拒绝，并完成以下 F1–F6 的针对性验证与必要的最小接入修正。复用已有覆盖结果，不重跑全部七组或 1–47 清单，不扩展为模型质量评测、全部 UI 重写或新策略设置。

## F1：修复正式会话记录写入与冷恢复

- 全面查找正式代码的 `plugin:arbiter/*` 写入，尤其 `src/index.ts` 的 decision 记录；统一通过目标 DSH 的公开 `appendPluginRecord` 路径写入并验证 `ignorable: true`。不能只改探针，也不能在失败时回退到不兼容的直接 append。
- 解决公开包入口、类型与模块身份接入，正式代码不硬编码本机安装目录、不修改 DSH 核心。写入失败仍按既定记录异常处理，保留当前内存与权限结果；不要为修复日志格式增加执行前持久化门槛。
- 在真实正式插件上走“产生裁决并写入→关闭会话→退出宿主→重启→重开”，检查宿主能加载、插件能读回摘要、原始裁决链／callId 保留。另做缺失审计 SQLite 的对照，不能仅验证热进程内存中的数据。
- 对已写入的不兼容记录提供可回退的定点兼容／修复路径，并在测试副本验证：先备份、只处理已知 arbiter 记录、保留原文与其他宿主事件，不删除整份会话、不全局放宽未知事件检查。核对旧原生 auto 身份是否还会阻止恢复。日常 profile 的历史迁移不在本轮执行范围。

## F2：落地并补测原生 auto 拒绝

- 优先验证公开 `registerAuto(admit)` 的同步拒绝回调：安装包源码显示它在修改预设／旋钮之前执行。也可选择不注册入口的实现，但必须满足明确反馈、共存检查、自有入口及旧 auto 会话恢复要求；不能只从自有菜单隐藏 auto。
- 在 guarded、trusted、当前未启用 arbiter 的会话中分别测试原生命令；检查错误反馈、命令结算、插件启用状态、实际 sandbox／approval policy、会话事件及并发工具效果。拒绝前后状态应保持一致，guarded 不能短暂变成 full-access。
- 覆盖直接 `/permission auto`、`session.command()` 路径，以及原生选择器若仍展示 auto 时的选择行为。拒绝反馈应引导使用会话权限菜单中的“自动审查（Arbiter）”；这不是 review-deny 或 human-deny，不新增审批链阶段。
- 自有入口启用 trusted／guarded 不得调用已拒绝的原生 auto；实际菜单已经接入时用正式路径验证，若仍需最小客户端探针，报告中明确区分“机制探针”与“正式 UI 已完成”。
- 回归成功的 `/permission workspace-write` 同值切出、read-only／danger-full-access 切出，以及失败命令保持原状态。观察回调内不得重入 append；区分意图、内存生效、延后持久化和 command/done，不能在拒绝 auto 时提前停用 arbiter。

## F3：真实插件管理器停用／卸载

- 分别通过实际插件管理器的公开停用与卸载入口触发，记录实际 API、作用域和运行时效果；不能仅调用探针 unload route 或 `ctx.fiber.dispose()` 代替。若管理器只保存配置并要求重启，必须标为该行为，不能称作已完成热卸载验证。
- 在有在途模型审查时操作，至少覆盖正常 allow 收尾与模型结束后转人工的路径；验证 reviewer、approval 服务、会话写入、UI 与其他依赖在所需阶段仍然可用，最终资源可以释放。
- 核对停止新接管、收尾、回退、撤销 UI 覆盖及卸载完成的真实顺序。仅仍受管会话回退为 workspace-write + ask；已由用户切成 read-only 等模式的会话不覆盖；用户规则、配置和审计数据保留。
- 卸载后重开关闭会话，验证无残留 auto／启用状态导致无法加载或错误重启用；报告明确实际覆盖哪些存活／关闭会话，不外推为全部历史会话均已处理。

## F4：收尾等待期间的新调用与并发时序

- 用可控延迟 reviewer／待处理人工请求形成真实等待窗口。在停止接管之后、回退及资源释放之前，发起同一会话和另一个会话的新调用，记录是否进入 gate、何时进入 body、实际沙箱与文件效果；不要只看最终 UI 状态。
- 新调用不能在旧 trusted 权限下因 gate 已撤销而免审执行。可等待权限迁移完成后按宿主新权限处理，或明确结束该次调用；记录具体选择与原因，不冒充人工拒绝，也不自动批准。未受管会话不应被无关等待错误接管。
- 已有在途审批链继续推进所需的后续阶段不能因资源拆除过早失败或死锁；已有 review-allow 不被重写，工具最终是否执行仍尊重实际宿主约束。不得自动重放已结束或已产生部分效果的调用。
- 将 command/run、内存状态、持久化、command/done、stop-admission、drain、rollback、body-dispatch／result 关联到时间线，验证权限命令失败与并发提交不会形成未审查窗口。无需为此增加新的用户设置或执行前二次审查流程。

## F5：真实人工审批答复

- 区分切出 arbiter、真实管理器停用和卸载；在原审批已经弹出时观察其是否保留，并在具备真人参与条件时验证实际“允许一次”“拒绝”的结算及工具效果，检查裁决链准确记录 human-allow／human-deny。
- 验证模型审查结束后需转人工时，收尾阶段仍能使用所需通道；等待本身不是 human-abort，不因卸载任意代批／代拒或制造超时结论。沿用既定超时、取消及宿主通道规则，记录长等待是否阻止卸载完成。
- 模型／浏览器自动化代点、模拟 answerer、定时返回 allowed-once 均须标为模拟，不能记作真实人工路径通过。没有真人参与条件时提供可复现场景与待操作步骤，保留未完成状态，不阻塞其余可完成任务。

## F6：真实 run_code／PTC 的宿主取消

- 使用已经启动的真实 run_code，内层停在审查或人工等待，随后切换会话沙箱；观察外层与内层 signal、审批／reviewer 请求、工具返回及实际文件效果，和普通工具等待作对照。不能只手动触发自造 AbortController。
- 优先尝试先在 trusted／full-access 启动 PTC，再切到 workspace-write 触发取消。此前本机 sandbox-exec 不可用，不自动证明这条方向也无法验证；若仍受限，保留实际错误及最小复现，不修改核心或绕过宿主沙箱来制造 PASS。
- 验证被取消的请求不会因迟到的 allow 执行 body，已发生的部分效果被如实保留，不自动重试。取消来源不伪装成 human-deny 或 review-deny；进程退出不要求后台请求继续运行。

## 工作边界、验证与交付

在现有仓库工作，保留其他会话的未提交改动。只为本轮目标修改正式代码及必要依赖、测试和文档；不改 DSH 核心、不发布、不合并、不迁移日常 profile。使用独立 DSH_HOME、测试 profile／会话／工作区，先核对目标版本和关键文件指纹。

对正式代码运行适当的回归与仓库必需检查；测试应针对冷恢复、拒绝前无副作用、命令失败不退出、真实生命周期及并发时序，不仅断言字段名或改写探针结果。真实人工、可控 reviewer 夹具、源码推断与真实宿主运行分别标注，既有 63 项产物断言不算本轮新增证据。

在 `validation/permission-ui/<新的 run-id>/` 保存 REPORT.md、源码／构建指纹、探针或测试代码、复现步骤、原始事件／结果／文件效果及必要截图；不覆盖 `2026-10-21-permission-ui-01`。明确记录测试实际执行的代码版本，变更探针后保留与运行对应的版本。报告不包含凭据、认证 token 或 Cookie。

分别回填本文件结果表、[实施清单](implementation.md#permission-recovery-followup)、[PU 登记](decisions-and-questions.md#permission-ui-decision)、[架构接入状态](architecture.md#design-7)、[会话记录说明](configuration-and-audit.md#decision-history-recovery)和[证据](../evidence.md#permission-ui-review)，并更新 README 的真实实现状态。保留旧报告，只新增更正及新证据；若公开接口无法满足契约，登记准确边界与最小替代，不擅自改变已确认的拒绝策略。

结束时逐项报告：正式代码修了什么、哪些是正式插件运行确认、哪些只在探针／模拟中确认、哪些因环境或真人条件未完成，以及剩余风险。收尾关闭本轮测试进程、撤销隔离配置的临时探针，保留复现材料。

| 项目 | 当前状态 | 结果 |
|---|---|---|
| F1 正式记录写入与旧记录兼容 | **已修复，运行确认** | `src/records.ts` 只走 `appendPluginRecord`；真实"写→关→退宿主→重启→重开"通过，两条记录均 `ignorable: true`；移走审计目录后仍恢复；`src/repair.ts` 提供备份式定点修复（5 个单测） |
| F2 原生 auto 拒绝 | **已实现，三档运行确认** | guarded / trusted / 未启用三档都在权限变化前失败，`preset/sandbox/approval` 零变化；同值 workspace-write、read-only、danger-full-access、未知预设全部回归 |
| F3 真实管理器停用／卸载 | **基本停用／卸载运行确认；与在途请求重叠待补测** | 开关／卸载确实触发管理器，依赖删除、404、重启不复活及会话重开保留。驱动把延迟结束后才写的请求日志当成在途信号，不能据此确认 9s／12s 审查与管理器操作重叠 |
| F4 收尾期间新调用 | **回退后写入被挡住已确认；真实收尾窗口未覆盖** | 保留产物中原裁决已在停用步骤前完成，之后回退再提交新调用，未证明 active > 0 的窗口无绕过。需可控屏障与另一已受管会话／独立并发调用补测；正式源码关闭接管时仍直接 next、等待后才回退，不能据此结案 |
| F5 真实人工审批 | **真人允许／拒绝运行确认；审批中切换未验证** | 真人两条裁决链及工具效果保留。切换测试点击的 workspace-write 恰为当前值，原生控件对此直接返回；公开 session.command 因无 bridge 未实际调用，不能推出没有公开切出入口 |
| F6 PTC 宿主取消 | **运行确认** | trusted 启动的真实 `run_code` 被宿主以 `abort: sandbox mode changed` 取消；内层未执行；迟到 review-allow 未放行；外层已产生效果保留 |

运行环境说明：本轮 `sandbox-exec` 已可用，因此 F6 不再是"环境受限"；宿主"完全磁盘访问"需求通过隔离 profile 配置
`documentsDirectory` 消除（TCC 请求数为 0）。

详细证据与逐项边界见[本轮报告](../validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md)。

## 结果复核与下一次补测（2026-10-22）

原始报告保留，当前完成状态以本文件结果表和[复核证据](../evidence.md#permission-recovery-review)为准。产品契约保持不变，不将以下测试缺口改成新的宿主限制：

1. 夹具应在等待之前记录 review-started，并由可控屏障释放；驱动断言目标 callId 的审查仍未结束、active > 0 后，再操作管理器及提交新调用。原 reviewer-requests.jsonl 在延迟结束后才写，不能作为开始信号；F3 的在途保留也应据此补测。
2. 新调用必须真正在 stop-admission 与 drain-end／rollback 之间到达工具入口；不要仅提交被会话串行队列延后的新消息。至少覆盖另一已启用且已受管的会话，以及合适的独立并发工具入口，保留前后对照、实际 sandbox 与 body 效果。未受管的新会话不能替代这个对照。
3. 审批挂起时选择一个不同于当前值的预设，例如当前 workspace-write 时选择 read-only；通过最小客户端接入实际调用公开 session.command，记录返回、command/run、权限事件及审批状态。无 bridge 只说明测试桥未提供，不证明宿主拒绝；再分别测试真实管理器停用／卸载期间审批保留。

补测另建 run-id，保留真实运行的夹具／驱动版本和时序，不改写本轮原始报告。正式客户端选择器仍按既定方案实施，旧日常日志迁移仍不在本轮范围。

### 下一次补测的执行结果（run id `2026-10-22-permission-lifecycle-02`）

上面三条缺口已按原计划处理，报告见 [REPORT.md](../validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md)。

| 复核点 | 本轮结果 |
|---|---|
| 夹具时序 | 改为**等待前**写 `<callId>-started.json`，并按 `<callId>-release` 可控释放；`callId` 取自生产代码的 `review/start` 轨迹，不再依赖固定 sleep |
| 驱动闸门 | 以 `unload/stop-admission` 轨迹作为提交并发调用的闸门，而不是"点完开关即视为停用" |
| 新调用并发 | 改为**另一已受管会话**（trace 断言其 `gate/entered` 早于停用），并在回退前后分别保留文件对照 |
| 审批切换 | 改用**不同预设**（workspace-write → read-only），并经真实公开通道 `sessions.binding(id).session.command(...)`，记录返回、`command/run`/`command/done` 与审批状态 |

**由此复现并修复了一个真实实现缺陷**：上一轮的卸载顺序是 `停接管 → 等待在途 → 回退`，
使 drain 窗口内到达的调用在**旧 trusted 权限**下免审执行。已改为**回退先于等待**，
并新增能捕获旧顺序的回归测试。详见报告第 1 节与 `raw/t2-failure/`（修复前）、`raw/t2/`（修复后）。

**更正上一轮的一个结论**：审批挂起时**可以**切出。上一轮点击的是已选中的 workspace-write，
原生控件在同值时直接 return，因此没有发出命令；这不是宿主封锁。本轮实测：
`/permission read-only` 与 `/permission workspace-write` 在审批挂起时均成功，审批保持挂起。

**切换后的真人结算已取得**：审批挂起时切到 `read-only`，真人点「允许一次」→ `approval/decided: allowed-once`、
裁决 `human-allow`，但执行仍被 read-only 沙箱挡住（`Operation not permitted`）。即审批决定裁决、不放宽权限。

**同一会话并行已实测**：宿主在同一步骤内按 `maxParallelToolCalls`（默认 10）并发派发，是否并行由工具的
`isConcurrencySafe` 决定（`read`/`web_search` 为 `true`，`bash` 不是）。两个 `read` 的 `gate/entered` 相隔 6ms，
各自独立裁决并都成功。原先"会话串行队列"的理由不成立。

**仍未验证**：无遗留并发项。
