# 权限选择器与生命周期：宿主能力验证

日期：2026-10-21。状态：**方案已选；U1–U4 已在本机隔离环境运行验证**（运行 id `2026-10-21-permission-ui-01`）。本任务只验证不依赖上游修改的可行性，未做正式权限菜单或全插件改造。

**后续确认（2026-10-22）**：用户已确认拒绝原生 `/permission auto`，并授权正式冷恢复修复及 F1–F6 补测；见[新交接](permission-recovery-followup.md)。下文保留首轮任务与当时结果，不将探针卸载外推为真实插件管理器已验证。

入口：[产品契约](architecture.md#permission-selector-contract) · [生命周期](architecture.md#permission-lifecycle) · [源码补核](../evidence.md#permission-ui-source) · [实施清单](implementation.md#permission-ui-validation) · [本轮报告](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md) · [环境与指纹](../validation/permission-ui/2026-10-21-permission-ui-01/ENVIRONMENT.md)

## 已定前提与范围

用户选择由 arbiter 在原权限控件位置提供自己的选择器，保留宿主其他权限选项，以一个“自动审查（Arbiter）”入口控制当前会话启停。trusted / guarded 只在插件配置页选择，与 normal / strict / progress 审批模式分开。

后端区分“arbiter 已启用 + guarded”和普通工作区模式，即使它们都是 workspace-write + ask。启用状态需要恢复，不能依赖审计 SQLite 或浏览器本地状态。宿主原生 auto 仍固定为 danger-full-access + ask；本轮不修改 DSH 核心源码、不篡改其原生预设定义。

只验证以下 U1–U4 四组；不重跑原七组覆盖验证或 1–47 总清单，不扩大为完整功能实现、模型质量评测、发布或日常 profile 迁移。可以编写最小宿主／客户端探针和生命周期夹具，保留复现材料；正式实现改造留在独立实施会话。

## 验证环境与证据规则

1. 使用隔离 DSH_HOME、测试 profile、会话和独立测试文件；不关闭或卸载日常 profile 的插件，不改用户真实会话权限。先记录真实 DSH 版本、运行方式、相关包版本及文件指纹，不将旧提取包自动视为当前安装版本。
2. 优先用公开 slot、会话、命令和沙箱 API。修改核心源码、私有 monkey patch、DOM/CSS 隐藏和定时纠偏只能作为另列的受限方案，不能计作当前不改上游方案已通过。
3. 每项分别标注：运行确认、仅源码支持、受限／不支持、未运行。源码有接口、模拟通过、真实浏览器交互通过是不同证据；没有条件完成的部分保留未知，不猜测 PASS。
4. 使用真实 Web 客户端操作权限选择器并保存截图／交互记录；同时观察实际后端状态与工具效果。UI 标签变化不等于门禁或沙箱已变化。
5. 可用 allow／deny 探针和可控延迟审查服务排除模型随机性；这些是接入／生命周期夹具，不是模型质量或真实人工审批验证。人工审批等待可保留供观察，自动化代点或模拟应答须明确标注，不能称作真实人类审批。
6. 原始材料保存在 `validation/permission-ui/<run-id>/`，已有目录不覆盖。保留探针、配置差异、复现命令、截图、日志和结果索引；报告不包含凭据、认证 URL token、Cookie 等连接秘密。

每个关键切换至少关联同一 sessionId 的：操作入口、插件后端启用状态、配置中的执行边界、宿主最近选择及派生预设、实际 sandbox mode／approval policy、相关会话事件与工具入口／body 标记。字段和 API 不存在时如实注明，不能把建议字段当成已存在接口。

## U1：权限菜单覆盖与双执行边界

| 检查 | 需要确认的行为 |
|---|---|
| 同位置覆盖 | 在 `conversation.input.permission` 注册自己的选择器；确认注册优先级能覆盖原控件，只有一个有效权限选择器，保留其他宿主权限选项及相应确认行为 |
| 撤销覆盖 | 仅移除客户端覆盖时，原控件能恢复；该动作本身不自动启用、停用或改写后端权限。与 U4 整插件卸载分开验证 |
| trusted / guarded | 从插件配置选择并应用两档后，单一自动审查入口均能启用 arbiter。切换执行边界不等于停用；未启用会话不被配置保存顺带接管 |
| 实际执行 | 两档都运行一个可观察的插件 deny 和 allow 对照；再用受控文件写入证明 guarded 仍保留写入边界。越界测试目录必须确认不在工作区、临时目录等允许根内；不得自动批准提权 |
| 状态隔离 | 普通工作区写入与 arbiter + guarded 即使宿主组合相同，也有不同后端启用状态和门禁行为；第二个未启用会话不被误接管 |

回填 slot 声明、覆盖优先级规则及生命周期 API；区分代码里支持 shadowing 与目标 Web 中实际成功。记录浏览器端和宿主端分别需要哪些依赖，不将只替换文字认作完整方案。

**本轮结果（运行确认）**

| 检查 | 实际行为 |
|---|---|
| 同位置覆盖 | `conversation.input.permission` 是 `kind: 'single'`、`scope: 'session'`。必须用公开的 `ctx.slots.inject(slot, …)` 注册：该 slot 由 conversation 在插件之后声明，直接 `register` 会抛 `slot … is not declared`。**`entriesOfSlot` 按 priority 升序取第一个，数值越低越优先**；native 在 0，自有选择器须用负值（本轮 −1）。同一 priority 重复注册直接抛错。实测该位置只有一个控件，`nativeControl: false` |
| 保留其他选项 | 下拉同时列出 `read-only` / `workspace-write` / `danger-full-access`；`auto` 不在自有菜单里 |
| 撤销覆盖 | 移除注册后原生控件回到同位置（`工作区内修改`），后端 `enabled` 与 `revision` 不变 |
| trusted / guarded | 切边界不改变 `enabled`，只改 `boundary`；两档都用同一入口启用 |
| 实际执行 | guarded：插件 allow 后宿主返回 `file access denied under workspace-write mode`，越界文件不存在；同一写入在 trusted 下成功落盘。**插件 allow 不能豁免文件沙箱** |
| 状态隔离 | 第二个会话 `enabled: false` 且零 `gate/*` 事件；宿主值同为 workspace-write 也不构成接管依据 |

依赖：浏览器端需要 `slots`（含 `inject` 声明面）、会话投影或等价的状态读取、`sessions.binding()` 取 live session；
宿主端只需要 `tools/pre-execute`、`sessions`、`connection.fetch`（可选）与公开的会话事件写入。没有 CSS 隐藏或 DOM 改写。

## U2：原生 /permission 命令切换同步

| 检查 | 需要确认的行为 |
|---|---|
| 切到其他权限 | 通过真实 `/permission read-only`、`/permission workspace-write`、`/permission danger-full-access` 路径切出；新调用不再由 arbiter 接管，宿主保持所选权限，UI 与后端一致 |
| 同值／no-op | **重点：arbiter + guarded 下执行 `/permission workspace-write`，原生值可能完全没变，也不追加 permission/preset 或 sandbox/mode。验证能否仍观察用户切出意图并关闭 arbiter**；不能只用变更事件测试替代 |
| auto 命令 | 验证 `/permission auto` 是否能同步到 arbiter 的启用状态并遵守配置中的执行边界；guarded 时是否会先扩大为 full-access，以及是否存在可被工具调用利用的中间状态。如不能满足，明确说明限制与替代入口 |
| 状态与失败 | 比较显式命令、裸 `/permission` 弹出的选择器、自有权限菜单的行为；命令失败不得提前写成已成功切换，插件自身调整沙箱也不能被误判为用户退出 |

必须给出命令执行意图的实际观测／接入点、时序和相关 API。若公开接口只能观察值变化，不能捕获同值命令，应明确判定这部分受限；不要用轮询、反复切回或改写宿主私有方法掩盖缺口。

**本轮结果（运行确认，1 项能力缺口）**

| 检查 | 实际行为 |
|---|---|
| 切到其他权限 | `/permission read-only` 追加 `permission/preset` + `sandbox/mode: read-only`；`danger-full-access` 另加 `approval/policy: never` 与宿主注入的提示消息。切出后 `enabled: false` |
| 同值 / no-op | **重点已通过**。guarded 下再执行 `/permission workspace-write`：宿主值不变，**没有** `permission/preset` 或 `sandbox/mode`，但 `command/run` 已先行写入日志；据此关闭 arbiter，后续调用零 gate 事件 |
| auto | `registerAuto` 存活时 `/permission auto` 被接受，宿主按固定 spec 展开为 `danger-full-access` + ask（`permission/preset: auto` → `sandbox/mode: danger-full-access`） |
| 状态与失败 | 显式命令、裸 `/permission` 弹窗、自有菜单三条路径互不污染；命令失败会以 `command/done: error` 记录（本轮观测到一次参数被补全污染的失败，未被当作成功） |

**接入点与时序**：`session/event` → `type === 'command/run'` → `data.name === 'permission'` → `data.args`。`command/run` 在 handler 之前 commit，
因此同值切换也可见。**硬约束**：该回调运行在宿主 commit 内部，此时 `session.append` 会被判为重入并抛错，状态写入必须 defer 到下一拍。

**能力边界**：本轮接受原生 auto 后，宿主会展开为 full-access，无法把该预设配置成 guarded。2026-10-22 复核确认，公开的 autoAdmit 在权限修改前同步执行；拒绝准入或不注册该入口的路径尚未补测，因此不把“不能修改组合”表述为“不能拒绝进入 auto”。用户现已确认[拒绝原生入口](architecture.md#native-auto-rejection)，只隐藏菜单不足以满足契约，正式实现与补测见[新交接 F2](permission-recovery-followup.md)。

保留产物的退出记录在 full-access 写入之后：U2 seq 57 为 auto、58 为 sandbox/mode、59 才是 disabled。补测应验证内存／持久化生效点、命令失败与并发新调用，不把观察到 command/run 等同于退出完成；拒绝 auto 时也不得提前停用原有 arbiter 状态。

## U3：页面刷新、断连重连与会话恢复

| 检查 | 需要确认的行为 |
|---|---|
| 前端生命周期 | 宿主保持运行时刷新页面、关闭再连接、断连重连；不触发会话启停或重置沙箱，恢复后展示后端当前状态 |
| 最新状态优先 | 断连期间通过另一连接或命令切换状态；旧页面重连后不以旧缓存／乐观值覆盖新状态，不消费旧连接的迟到响应 |
| 冷恢复 | 重启隔离宿主并重新打开已有会话，分别核对启用会话、已停用会话与新会话；无启用证据时不根据 workspace-write 自动启用 |
| 独立于审计 | 在隔离环境暂时移走／禁用测试审计库，保留会话数据，验证启用状态恢复不依赖 SQLite；审计失败也不能改变实际接管状态 |

回填启用状态实际保存在哪里、恢复顺序及宿主状态与插件状态发生分歧时的表现。若只能热重连、不能冷恢复，分别报告，不能合并成“恢复已通过”。

**本轮结果（运行确认）**

| 检查 | 实际行为 |
|---|---|
| 前端生命周期 | 刷新页面不重置会话与沙箱；重连后显示后端当前状态（`自动审查（Arbiter · guarded）`, `selected: "__arbiter__"`） |
| 最新状态优先 | 页面断网期间由第二个连接禁用；重连后采用新值。页面乐观启用后立刻被第二连接禁用时，最终状态是禁用，旧值没有复活 |
| 冷恢复 | 重启宿主 → 重新打开同一会话 → `enabled: true`，`pui/restored` 记录 `boundary: guarded`；重启后门禁仍生效。新会话 `enabled: false` |
| 独立于审计 | 移走 `home/arbiter` 后重启，启用状态仍恢复（`auditPresent: false`，`restored` 再次出现） |

**状态保存在哪里**：会话日志中的可忽略插件记录（`plugin:pui/enabled` / `plugin:pui/disabled`，`ignorable: true`），
冷读时按序折叠；不是审计 SQLite，也不是浏览器本地状态。恢复顺序：宿主加载会话 → 观察者折叠记录 → 重新断言 `sandbox/mode` 与 `approval/policy`。

**关键前提（本轮实测失败后修正）**：`session.append('plugin:…')` 写出的记录**不带 `ignorable`**，
宿主冷读会以 `unknown to this harness and not marked ignorable` 拒绝整份日志。必须用 `dsh-session` 的
`appendPluginRecord(session, type, data)`。这一点直接影响现有 `plugin:arbiter/decision` 实现。

## U4：停用／卸载与在途请求收尾

| 检查 | 需要确认的行为 |
|---|---|
| 停用／卸载回退 | 区分仅客户端撤销、整插件停用、整插件卸载、宿主进程退出；整插件停用／卸载后，只将仍由 arbiter 接管的 trusted／guarded 会话回退到 workspace-write + ask，停止新接管并还原原生控件 |
| 不覆盖其他会话 | 已切为 read-only、普通 workspace-write 或 danger-full-access 的会话保持用户所选权限；用户规则、配置、日志保留 |
| 模型在途 | 使用可控延迟审查请求，在切出及卸载期间观察是否由插件主动中止、能否收到结果并推进后续处理、依赖何时释放、卸载是否等待。至少覆盖 allow 收尾与需转人工的后续路径 |
| 人工等待 | 已弹出的人工审批不因模式切换／卸载自动批准、拒绝或被记成人工拒绝；观察保留及最终结束路径。未取得真实人类答复时，保留该部分验证限制 |
| 宿主取消边界 | 对照普通等待与运行中 run_code／其内层等待，验证沙箱切换触发的宿主取消。记录取消来源、顺序、模型可见结果，不能把取消伪装为 human-deny 或 review-deny；进程退出不承诺后台请求继续 |
| 卸载后恢复会话 | 再次打开已关闭／持久化的测试会话，检查是否遗留 auto 身份导致缺少 integration 而无法加载。明确仅当前存活会话已迁移，还是已验证关闭会话也能恢复；不能自动推断所有历史会话都已处理 |

记录异步 disposer 的实际等待顺序、UI 与门禁撤销顺序、服务可用期限。单独的单元／生命周期夹具不能代替真实 DSH 热卸载；插件卸载与强制进程终止分别报告。

**本轮结果（运行确认；人工审批受限；PTC 取消未运行）**

| 检查 | 实际行为 |
|---|---|
| 停用／卸载回退 | 客户端撤销只还原控件，不动后端。整插件卸载按 `dispose-begin → dispose-wait(每 250ms) → dispose-drained → dispose-rollback → dispose-end` 执行，把仍受管会话回退到 `workspace-write + ask` |
| 不覆盖其他会话 | 用户已切到 `read-only` 的会话在卸载时 `dispose-skip: not-managed`，没有 rollback 事件，最终 mode 仍是 `read-only` |
| 模型在途 | 8 s 延迟审查：`review/inflight` → `dispose-begin`（active 1 个调用）→ 等待 7.8 s → `review/settled outcome: done, signalAborted: false` → `gate/released` → `dispose-drained` → rollback。**插件没有主动取消**，结果仍推进后续处理（工具写入成功） |
| 人工等待 | 审批 `approval/asked` 已写入并挂起时切出：切换成功，**没有** `approval/decided`，未被代批／代拒／记成 human-deny；会话随即退出 arbiter。**没有真实人类答复** |
| 宿主取消边界 | **未运行**。本机 `sandbox-exec` 不可用，构造不出"沙箱切换触发 PTC 取消"的真实场景；源码依据保留，不记为运行通过 |
| 卸载后恢复会话 | 重启后重新打开关闭的会话：日志正常加载（只有 `ignorable: true` 的记录），`enabled: false`、`reason: "plugin-unload"` 持久，未被重新启用（`restored: []`） |

**限制与顺序说明**：以上卸载路径由探针在 `ctx.effect` 的异步 disposer 中实现，是"目标顺序的最小实现"，
不是 DSH 原生热卸载的替身；真实 `plugin_manager.setPluginEnabled` 的运行时重组合未在本轮触发。
强制进程终止（`SIGKILL`）未与优雅卸载做对照，未报告。

## 交付与文档回填

在独立运行目录提供 `REPORT.md`、最短复现步骤、探针与结果索引。报告至少包含：版本／指纹、U1–U4 逐项结论、期望与实际差异、源码位置、截图／事件／body 证据、公开接口边界，以及能否不改上游实现完整方案。

将结果回填本文件下表、[实施验证状态](implementation.md#permission-ui-validation)、[源码与运行证据](../evidence.md#permission-ui-source)及[架构接入说明](architecture.md#design-7)；若发现产品契约无法满足，另在[决策登记](decisions-and-questions.md#permission-ui-decision)记下缺口与建议，不擅自改成另一套交互或把失败记作成功。保留原有验证记录，不覆盖原七组和首轮实现报告。

收尾关闭测试进程、撤销隔离 profile 的临时探针，保留复现材料；不要执行发布、合并或日常 profile 迁移。

| 组 | 当前运行状态 | 结果与证据 |
|---|---|---|
| U1 菜单覆盖与双执行边界 | **运行确认** | 自有选择器以 priority −1 占据 `conversation.input.permission`（单值 slot），宿主其余选项保留；撤销覆盖原生控件回归且不改后端；guarded 下插件 allow 仍被宿主 fs 沙箱拒绝、trusted 下同一写入成功；第二个未启用会话无 gate 事件。[详情](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md#u1) |
| U2 原生命令同步 | **同值切出运行确认；原生 auto 拒绝路径待补测** | 同值切出可由 command/run 观察；已接受的原生 auto 会展开 full-access。本轮没有测试 autoAdmit 拒绝或不注册该入口，不能据此断言不存在公开拒绝路径。[详情](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md#u2)、[复核](../evidence.md#permission-ui-review) |
| U3 重连与会话恢复 | **运行确认** | 刷新保持后端状态；断连期间由第二连接改状态后重连采用新值；迟到响应未复活旧值；冷重启恢复启用与边界；新会话不误启用；移走审计目录后仍恢复。[详情](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md#u3) |
| U4 停用／卸载与在途收尾 | **探针 fiber.dispose 路径运行确认；真实管理器卸载、人工答复、PTC 取消未完成** | 客户端撤销不等于停用；探针等待 7.8 s 在途审查后回退并保留 read-only，会话重开正常。人工请求仍挂起但无真实答复；真实 plugin_manager 重组合、收尾期间新调用及 PTC 取消待补测。[详情](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md#u4) |
