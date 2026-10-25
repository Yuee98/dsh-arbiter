# 权限 UI 与生命周期：U1–U4 运行验证报告

运行 id：`2026-10-21-permission-ui-01`。
宿主：DSH **0.2.1-rc.2**（macOS 27.0.1 / arm64），安装指纹见 [ENVIRONMENT.md](ENVIRONMENT.md)。
断言：`node scripts/check.mjs` → **63 passed, 0 failed**（只读已记录产物，不重跑宿主）。

本轮**只验证 U1–U4**，没有重跑首轮七组或 1–47 清单，没有修改 DSH 核心，也没有改动日常 profile。
所有用例都在独立 `DSH_HOME`、独立 profile、独立 workspace 和独立浏览器 profile 中运行。

## 0. 证据分级怎么读

每个结论都标了来源：

| 标记 | 含义 |
|---|---|
| **运行确认** | 本轮真实宿主 + 真实 Web 客户端产生的事件／截图／文件效果 |
| **源码支持** | 只读核对安装包源码，本轮未运行到该路径 |
| **夹具** | 由确定性 LLM 适配器或探针提供的可控条件，不是模型或人类行为 |
| **受限** | 公开接口能观察到，但不能满足契约要求的语义 |
| **未运行** | 本轮没有条件执行，保留未知 |

**探针不是产品代码。** `probes/pui-probe/` 用公开 API 复现"插件启用状态 + 门禁 + 卸载顺序"，
真实浏览器与真实宿主是这一轮的运行主体。截图见 `raw/artifacts/<group>/`。

## 1. 版本与指纹

```
dsh 0.2.1-rc.2 · node v24.21.0 · macOS 27.0.1 arm64
dsh/package.json         b67a65b9…18f94e   (与 evidence.md §22 / 七组一致)
dsh-tools/lib/index.js   1e53932e…0a442a   (一致)
dsh-user-approval        6a5ad1ba…17ee90b  (一致)
```

`dsh-permission-presets`、`dsh-client-ui-permission-presets`、`dsh-session`、
`dsh-plugin-manager`、`dsh-hmr` 的 SHA 记录在 [ENVIRONMENT.md](ENVIRONMENT.md)。

<a id="u1"></a>

## 2. U1：权限菜单覆盖与双执行边界 —— **运行确认**

### 2.1 同位置覆盖

- `conversation.input.permission` 是**单值（single）session 作用域 slot**，由 `dsh-client-ui-conversation` 在 composer 中声明。
- 选择器必须走公开的 `ctx.slots.inject('conversation.input.permission', …)` 注册：conversation 在该 slot 上的声明晚于插件启动，直接 `ctx.slots.register` 会抛
  `slot "conversation.input.permission" is not declared`（本轮实测到该错误）。
- **优先级方向与直觉相反：数值越低越先渲染。** `SlotCore.entriesOfSlot` 按 `priority` 升序排序后取第一个；
  native 控件注册在 priority 0，探针注册在 **priority −1** 才真正占据该位置。
  同一 priority 上再注册会直接抛 `single slot … already has a registration`。
- 实测结果：`[data-slot="conversation.input.permission"]` 内只有自有选择器（`nativeControl: false`, `puiPresent: true`），
  **没有出现两个选择器**；下拉里保留宿主全部其他选项 `read-only` / `workspace-write` / `danger-full-access`，不提供 `auto`。
- 截图：`raw/artifacts/u1/u1-01-slot-initial.png`、`u1-02-enabled-guarded.png`。

### 2.2 撤销覆盖

移除客户端注册后，原生控件立即回到同一位置（`cellText: "工作区内修改"`, `nativeControl: true`, `puiPresent: false`），
而 **后端启用状态不变**（`enabled: true`, `revision` 不变）。
裁剪见 `u1-09-override-removed.json/.png`。这一步与 U4 的整插件卸载分开验证。

### 2.3 trusted / guarded 的实际边界

两档都在真实宿主里跑了一个 allow、一个 deny、一个越界写入：

| 场景 | 插件判定 | 宿主执行结果 | 文件效果 |
|---|---|---|---|
| guarded + allow（写 workspace 内） | allow | 成功 | `ws/guarded-allow.txt` 存在 |
| guarded + deny（探针 deny 标记） | deny | 未执行 | 文件不存在 |
| guarded + 越界写入（workspace 外） | **allow** | **`file access denied under workspace-write mode`** | 文件不存在 |
| trusted + 同一次越界写入 | allow | 成功 | `outside/trusted-outside.txt` 存在 |

第三行是本轮最关键的执行边界证据：**插件 allow 不能豁免宿主文件沙箱**，这正是 guarded 与 trusted 的实际差别，
而不是菜单文字。第四行证明切换执行边界**不等于停用**：会话仍 `enabled: true`，只把 `boundary` 从 `guarded` 改为 `trusted`。

### 2.4 状态隔离

第二个会话从未启用：`enabled: false`, `boundary: null`, 且该会话**没有任何 `gate/*` 事件**；
第一个会话同期有 12 条 gate 事件。普通工作区写入不会因为"宿主值恰好也是 workspace-write"而被误接管。

> **环境限制**：本机 `sandbox-exec` 在宿主进程内无法应用策略，`workspace-write` 下的 bash 会被 fail-closed 拒绝。
> 因此文件边界用 fs `write` 工具验证。**受限**：本轮没有用 bash 复现同一写入对照。

<a id="u2"></a>

## 3. U2：原生命令同步 —— **运行确认，含一处能力缺口**

### 3.1 同值切换（重点）

前置条件：arbiter + guarded，宿主值已经是 `workspace-write`。执行 `/permission workspace-write` 后：

```
seq 24  command/run   { name: "permission", args: " workspace-write", source: { kind: "user" } }
seq 25  plugin:pui/disabled { reason: "permission-command" }
seq 26  command/done  { kind: "success", text: "preset workspace-write" }
```

- **宿主值确实没变**（`hostValueUnchanged: true`）；
- **没有追加** `permission/preset` 或 `sandbox/mode`（`noKnobEvents: true`）——与 evidence.md §22.4 的源码判断一致；
- 但 `command/run` 在 handler 调用之前就写入会话日志，因此**用户退出意图仍可被公开观察到**；
- 退出后该会话不再被接管：后续调用 `gatesAfterExit: []`，且宿主按自己的值正常执行（`u2-02-post-exit.json`）。

**结论：同值 `/permission workspace-write` 的退出意图可以通过公开 `session/event` + `command/run` 捕获，
不需要轮询、不需要改写宿主私有方法。**

实现约束（本轮实测）：`session/event` 观察者在宿主 commit 内部运行，此时 `session.append` 会因重入被拒绝。
必须把状态写入 defer 到下一拍（`queueMicrotask`）。这一点对产品实现是硬约束，已单独记录。

### 3.2 显式切换

- `/permission read-only` → `permission/preset: read-only` + `sandbox/mode: read-only`，宿主值改变。
- `/permission danger-full-access` → `preset` + `sandbox/mode: danger-full-access` + `approval/policy: never`，并有宿主注入的 `agent/inbox/spliced` 提示。
- 三种显式切换后 `enabled: false`，与"已退出 arbiter"一致。

### 3.3 裸 `/permission`

真实弹出选择器只列宿主预设（仅可查看／工作区内修改／完全权限／自动审查，最后一项标注 `EXP` 与
"无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查"）；自有"自动审查（Arbiter）"**不在**这个弹窗里，
说明两条入口没有互相污染。截图：`raw/artifacts/u2/u2-05-bare-picker.png`。

### 3.4 `/permission auto` 与 guarded —— **能力缺口**

实测（探针用 `registerAuto` 提供 live integration）：

```
seq 57  permission/preset { preset: "auto" }
seq 58  sandbox/mode      { mode: "danger-full-access" }
seq 59  plugin:pui/disabled { reason: "permission-command" }
```

- `auto` 被宿主接受，并按 `AUTO_PRESET_SPEC` 展开为 **`danger-full-access` + ask**；
- 我们的后端在 `command/run` 时已经退出 arbiter，因此**不会静默把 guarded 扩大后继续接管**；
- 但**宿主侧存在一个真实中间状态**：如果产品在该命令上"先看配置边界、再决定是否放行"，`auto` 的固定 full-access
  会在插件退出之前已经生效。本轮顺序（先退出、后由宿主展开）避免了它，但这是实现顺序带来的性质，不是接口保证。
- **缺口**：公开接口无法在 `/permission auto` 生效前阻止它的 full-access 展开。若产品要求"guarded 下 auto 不得扩为 full-access"，
  只能拒绝该命令或改菜单文案，不能在事后纠正。

<a id="u3"></a>

## 4. U3：重连与会话恢复 —— **运行确认**

| 检查 | 结果 |
|---|---|
| 页面刷新 | 后端状态不变（`enabled: true, revision: 1`），重连后界面仍显示"自动审查（Arbiter · guarded）" |
| 断连期间由另一连接改变状态 | 页面离线时后端被第二个连接置为 `enabled: false`；重连后**采用新状态**（选择器回到 `workspace-write`） |
| 迟到响应 | 页面乐观启用后立刻被第二连接禁用，最终状态是**禁用**，旧值没有复活 |
| 冷重启恢复 | 重启宿主后重新打开同一会话：`enabled: true`，`pui/restored` 记录了 `boundary: guarded` |
| 重启后门禁 | 新调用仍被门禁判定（`gate/deny`），文件未生成 |
| 新会话不误启用 | 重启后新建会话 `enabled: false`、`boundary: null` |
| 独立于审计 SQLite | 把 `home/arbiter` 整个移走后重启，启用状态仍恢复（`auditPresent: false`，`restored` 再次出现） |

**启用状态保存在会话日志里的可忽略插件记录中**（`plugin:pui/enabled` / `plugin:pui/disabled`，`ignorable: true`），
冷读时按顺序折叠。审计 SQLite 不参与，也不影响恢复。

### 4.1 冷恢复的关键前提（本轮实测到的硬约束）

第一次冷恢复直接失败：

```
session "…" contains event type "plugin:pui/enabled" (seq 3) unknown to this harness
and not marked ignorable; refusing to interpret the log
```

`session.append('plugin:…')` 写出的记录**没有** `ignorable` 标记；宿主冷读会因此拒绝整份日志。
必须改用 `appendPluginRecord(session, type, data)`（`@deepseek-ai/dsh-session`），它才会带上 `ignorable: true`。
**这一点直接命中当前 arbiter 实现里的 `session.append('plugin:arbiter/decision', …)`**——见第 6 节。

<a id="u4"></a>

## 5. U4：停用／卸载与在途收尾 —— **运行确认，人工审批受限**

### 5.1 客户端覆盖撤销 ≠ 停用

移除选择器注册后原生控件回归，后端 `enabled` 与 `revision` 都不变（`u4-01-override-removal.json`）。

### 5.2 整插件卸载

探针在 `ctx.effect` 的异步 disposer 中执行目标顺序：**停止接管 → 等待在途 → 只回退仍受管的会话 → 释放**。
实测时间线（`u4-03-inflight-unload.json`）：

```
t=22299  review/inflight      (8s 延迟审查开始)
t=22715  dispose-begin        active: [call-0]
t=22716… dispose-wait         每 250ms 一次，共等待 7.8s
t=30300  review/settled       outcome: "done"   signalAborted: false
t=30301  gate/released
t=30537  dispose-drained      waitedMs: 7822
t=30537  dispose-rollback     → workspace-write + ask
t=30537  dispose-end / unload-disposed
```

- **插件没有主动取消在途审查**：`outcome: "done"`，`signalAborted: false`；
- 审查结果仍推进了后续处理（工具执行完成，`ws/u4-slow-allow.txt` 写入成功）；
- **回退发生在 drain 之后**，顺序正确；
- 卸载后有 7.8 秒的等待窗口，宿主可以在这个时候完成收尾。

### 5.3 不覆盖用户已切换的权限

新会话先启用 arbiter，再用原生 `/permission read-only` 切出。卸载时该会话被**跳过**（`dispose-skip: not-managed`），
没有 `dispose-rollback`，最终 `sandbox/mode` 序列末尾仍是 `read-only`（`u4-06-user-switched.json`）。

### 5.4 卸载后重新打开关闭的会话

重启宿主并用公开 `agents.resume({ resumeSessionId })` 重新打开：
会话**能正常加载**（日志里只有 `ignorable: true` 的插件记录），回退状态持久（`enabled: false`, `reason: "plugin-unload"`），
并且**没有被重新启用**（`restored: []`）。这回答了"是否因残留 auto 身份而无法恢复"：本轮没有残留 auto 身份，
因为探针从不把会话写成 `auto` 预设。

### 5.5 已弹出的人工审批 —— **受限**

在 `approval/asked` 已写入、请求仍挂起时，通过公开 `session.command('/permission danger-full-access')` 切出：

- 切换**成功**（`{ matched: true }`）；
- `approval/decided` **没有出现**：插件既没有代批、也没有代拒，也没有把它记成 human-deny；
- 会话随即退出 arbiter（`enabled: false`, `reason: "permission-command"`）；
- 截图 `u4-07-pending-approval.png` 显示审批条仍在界面上（`等待审批` / `pui probe: manual approval probe` / `拒绝` / `允许一次`），
  对话区仍显示"深度求索中，用时 59 秒"——**请求没有被撤销、也没有被自动结算**。

**限制**：应答者是探针提供的挂起实现，**不是真实人类**。因此本项只证明
"模式切换不会自动批准／拒绝已弹出的人工审批"，**不证明**真实人类的最终答复路径与 UI 保留行为。
同时观察到：审批挂起时 composer 被宿主禁用，用户无法用斜杠命令切换；产品必须走 `session.command()` 或原生控件。

### 5.6 宿主取消边界 —— **未运行**

本轮**没有**运行 `run_code`／PTC 内层调用在沙箱切换时的宿主取消。原因是本机 `sandbox-exec` 无法应用策略，
`workspace-write` 下的 bash 直接 fail-closed，构造不出"沙箱切换触发 PTC 取消"的真实场景。
源码侧（evidence.md §22.4）已记录 `dsh-tools` 会取消受影响的运行中 PTC 调用；**本轮不据此记为运行通过**。

<a id="gaps"></a>

## 6. 期望与实际的差异（必须处理的实现约束）

| # | 发现 | 影响 | 处置建议 |
|---|---|---|---|
| D-1 | slot 优先级**数值越低越优先**，且单值 slot 同优先级会抛错 | 覆盖率依赖 `priority < 0`；与"priority 越大越优先"的常见直觉相反 | 写进架构接入说明；产品固定用一个负优先级常量 |
| D-2 | slot 必须通过 `slots.inject` 注册（声明晚于插件启动） | 直接 `register` 会在真实 Web 启动时失败 | 接入说明写明；不要用 boot 顺序取巧 |
| D-3 | `session/event` 回调内 `append` 会被判为重入 | 退出意图必须在下一拍写入 | 产品实现用显式队列／`queueMicrotask`，不要在同一回调里写 |
| D-4 | `session.append('plugin:…')` 不带 `ignorable`，冷读会**拒绝整份日志** | 直接影响恢复，且会波及整个会话 | 必须改用 `appendPluginRecord`；现有 `plugin:arbiter/decision` 需要核对写入路径 |
| D-5 | `/permission auto` 固定展开 `danger-full-access + ask` | guarded 下无法在生效前阻止扩张 | 只能"先退出再交给宿主"或拒绝该命令；不能事后纠正 |
| D-6 | 审批挂起时 composer 被禁用 | 用户无法用斜杠命令切出 | 需要 `session.command()` 或原生控件作为并行入口 |
| D-7 | 本机 `sandbox-exec` 不可用 | bash 在 workspace-write 下 fail-closed | 记录为环境限制；文件边界用 fs 工具验证 |

<a id="verdict"></a>

## 7. 不改上游能否成立

**能成立，但有两处必须按上面的约束实现，另有一处需要产品决策。**

- 菜单覆盖、撤销回退、trusted／guarded 双边界、会话隔离、同值命令退出、刷新与重连、冷恢复、
  审计库缺失下的恢复、卸载回退与在途收尾，**全部只依赖公开 API 即已运行通过**。
- 不需要修改 DSH 核心，不需要发布私有 monkey patch，不需要 DOM/CSS 隐藏，也不需要轮询纠偏。
- 两处必须遵守：**slot 用 `slots.inject` + 负优先级**；**启用记录用 `appendPluginRecord`**。
  后者若不改，冷恢复会直接失败——这是当前实现里已经存在的隐患，不是本轮新引入的。
- 一处需要产品决策：**`/permission auto` 在 guarded 下的语义**。公开接口不能阻止宿主把 auto 展开成 full-access；
  可选方案是"先退出、再让宿主展开"（本轮采用，行为可解释）或直接不提供该入口。
  这属于契约层面的取舍，已登记到决策文档，没有擅自改动产品契约。

<a id="status"></a>

## 8. 逐项状态总表

| 组 | 检查 | 状态 |
|---|---|---|
| U1 | 同位置覆盖（单选择器、保留其他选项） | 运行确认 |
| U1 | 撤销覆盖恢复原生控件、不改后端 | 运行确认 |
| U1 | trusted／guarded 双档 allow／deny／越界 | 运行确认（bash 对照受限） |
| U1 | 普通工作区会话不被误接管 | 运行确认 |
| U2 | 显式 `/permission read-only` / `danger-full-access` | 运行确认 |
| U2 | **同值 `/permission workspace-write` 退出意图** | 运行确认（需 defer 写入） |
| U2 | 裸 `/permission` 选择器 | 运行确认 |
| U2 | `/permission auto` 与 guarded | 运行确认 + **能力缺口**（无法阻止 full-access 展开） |
| U3 | 刷新、断连重连、迟到响应 | 运行确认 |
| U3 | 冷重启恢复、新会话不误启用 | 运行确认 |
| U3 | 独立于审计 SQLite | 运行确认 |
| U4 | 客户端撤销 vs 整插件卸载 | 运行确认 |
| U4 | 只回退仍受管会话 | 运行确认 |
| U4 | 在途模型审查不被插件取消、卸载等待 | 运行确认（8s 延迟夹具） |
| U4 | 已弹出人工审批不代批／代拒 | **受限**（没有真实人类） |
| U4 | 宿主取消（run_code／PTC） | **未运行**（本机沙箱限制） |
| U4 | 卸载后重新打开关闭会话 | 运行确认 |

<a id="index"></a>

## 9. 原始证据索引

| 组 | 索引 | 关键截图 |
|---|---|---|
| U1 | `raw/artifacts/u1/u1-steps.json` | `u1-01-slot-initial.png`, `u1-03-guarded-allow.png`, `u1-05-guarded-outside.png`, `u1-07-trusted-outside.png`, `u1-09-override-removed.png` |
| U2 | `raw/artifacts/u2/u2-steps.json` | `u2-01-same-value.png`, `u2-05-bare-picker.png`, `u2-06-auto.png` |
| U3 | `raw/artifacts/u3/u3-steps.json` | `u3-01-refresh.png`, `u3-02-disconnect.png`, `u3-04-cold-restart.png`, `u3-07-audit-removed.png` |
| U4 | `raw/artifacts/u4/u4-main-steps.json` | `u4-01-override-removal.png`, `u4-05-reopen.png` |
| U4 审批 | `raw/artifacts/u4a/u4-approval-steps.json` | `u4-07-pending-approval.png` |

每个用例目录还保留了会话日志（`home/sessions/**/session.v4.jsonl.zstd`）、
`home/pui/events.jsonl`（探针事件）、`requests.jsonl`（确定性模型的请求回放）与 `stderr.txt`。
本报告与 JSON 均不含认证 token、Cookie 或连接秘密。

## 10. 收尾

- 每个驱动的宿主都是驱动进程的子进程，驱动退出即停止；本轮结束后没有残留监听端口。
- 隔离 profile、隔离 `DSH_HOME`、测试 workspace 与测试会话都留在 `cases/` 下作为复现材料。
- 日常 profile（`~/.dsh/profiles/desktop`）未被安装插件、未被修改。
- 未发布、未迁移、未合并。
