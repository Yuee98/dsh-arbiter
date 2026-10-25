# 冷恢复写入修复与权限生命周期补测 · 报告

运行 id `2026-10-22-permission-recovery-01`。宿主 DSH **0.2.1-rc.2**（macOS 27.0.1 / arm64），
验证对象是**正式插件** `dsh-arbiter`（profile 以 `link:` 指向本仓库，执行 `lib/` 构建产物），
不是上一轮的探针。任务与验收见 [交接文档](../../../docs/permission-recovery-followup.md)。

代码与运行证据的对应版本见 [ENVIRONMENT.md](ENVIRONMENT.md) 与 `raw/fingerprint.txt`。

## 0. 结论摘要

| 项 | 结论 | 级别 |
|---|---|---|
| F1 正式记录写入 | 改用公开 `appendPluginRecord`，冷恢复可加载、可读回；旧不兼容记录有备份式定点修复 | **正式插件运行确认** |
| F2 原生 auto 拒绝 | guarded / trusted / 未启用三档均**在权限变化前**拒绝，状态零变化；其他命令全部回归 | **正式插件运行确认** |
| F3 真实管理器停用 | 走插件页真实开关（`pluginManager.setPluginEnabled`）；在途审查完成后仍写入，停用期间新调用不受门禁 | **正式插件运行确认** |
| F3b 真实卸载 | 走插件页「卸载」（`pluginManager.removeBundle` → `pnpm remove`）：依赖删除、bundle 取消选择、路由 404；重启后不复活，关闭会话可正常重开 | **正式插件运行确认** |
| F4 收尾期新调用 | 修复前存在"trusted 会话已被停用但仍为 full-access"的窗口；修复后回退先于新调用生效 | **正式插件运行确认** |
| F5 真实人工审批 | **真人**分别点了「允许一次」与「拒绝」：`human-allow` 执行并落盘，`human-deny` 拒绝且未执行 | **正式插件运行确认（真人）** |
| F6 PTC 宿主取消 | 真实 `run_code` 被宿主以 `abort: sandbox mode changed` 取消，内层未执行，迟到 allow 未放行 | **正式插件运行确认** |

## 1. 正式代码改了什么

| 文件 | 改动 | 目的 |
|---|---|---|
| `src/records.ts`（新增） | 唯一写入点 `appendRecord` → `appendPluginRecord`；读取只认 `ignorable === true` 的 `plugin:` 记录；解析顺序为「裸导入 → 运行中宿主的安装根」 | F1。**不再回退到 `session.append`** |
| `src/repair.ts`（新增） | 旧日志定点修复：先写 `.arbiter-backup`，只给缺 `ignorable` 的 `plugin:arbiter/*` 加标记，其他事件字节不变，幂等 | F1 兼容路径 |
| `scripts/repair-session.ts`（新增） | 操作入口：`--inspect` / `--dry-run` / 交互确认 / `--force` | F1 可回退修复 |
| `src/index.ts` | ① `registerAuto` 的 admit 在权限写入前抛 `AutoEntryRejected`；② 用 `command/run`/`command/done` 区分"用户切换"与"冷恢复"；③ `managed` 会话跟踪 + 卸载 drain + 回退；④ `accepting` 在卸载时立即置假；⑤ 移除写原生 `auto` 的旧 `/arbiter mode` | F2 / F4 |
| `tests/records.test.ts`、`tests/unload.test.ts`（新增） | 记录层契约、卸载回退/不覆盖/停止接管 | 回归 |
| `eslint.config.mjs` | 为 `tests/unload.test.ts` 单独放宽 `no-unsafe-type-assertion`（stub `ContextLike` 的重载） | 让检查保持可用 |
| `validation/codex-review/.../reproduce.mjs` | R3 断言改为检查"未完成审查不开新审批且结算为 fallback-deny" | F1 之后裸 stub 无法承载记录，断言与意图对齐 |

构建/测试：`pnpm verify` 全绿（**78 tests + R1–R9 9/9**）。

<a id="f1"></a>

## 2. F1：记录写入与冷恢复

**正式代码**：`appendSessionRecord` 现在只调用 `appendRecord`；失败写 `sessionRecordErrors` 并在
`/api/arbiter/state` 的 `sessionRecords` 暴露，不再降级写入不兼容事件。

**真实链路**（`raw/f1/`）：

```
产生裁决 → 写记录 → 关闭页面 → SIGTERM 宿主 → 重新启动 → 重开会话
```

| 检查 | 结果 |
|---|---|
| 记录带 `ignorable` | `plugin:arbiter/decision` 的 `ignorable: true`（`f1-01-written.json`），全库无任何非 ignorable 的 `plugin:` 事件 |
| 冷恢复可加载 | 重启后会话事件数 29，两个会话都正常加载（`f1-02-cold-restart.json`） |
| 插件读回 | 重启后再产生一条裁决，判定历史从 1 条变 2 条，`callId`/`tool`/`result` 保留（`f1-03-read-back.json`） |
| 缺审计库对照 | 移走 `home/arbiter` 后重启：`auditPresentNow: true`（插件按需重建），记录仍在，`sessionRecords.ready: true`（`f1-04-audit-removed.json`） |

> 注：`auditPresentNow: true` 是因为插件加载时会重新创建审计库；真正被验证的是**记录的恢复不依赖它**——
> 移走目录前写入的记录在重启后依然读回。

**旧记录兼容**（`src/repair.ts` + `tests/repair.test.ts`，5 个单测）：只改 arbiter 记录、保留其他事件原文、
先备份、幂等；`foreignNonIgnorable` 只报告不改写。真实旧日志（上一轮 28 帧的会话）检查结果为 0 处需修。
**日常 profile 的历史迁移未执行**（超出本轮范围）。

<a id="f2"></a>

## 3. F2：原生 auto 拒绝

**实现**：`registerAuto(admit)` 的 admit 在 `apply()` 写预设/旋钮**之前**同步执行；在 arbiter 的配置作用域内
（`config.enabled`）且存在进行中的 `/permission` 命令时抛 `AutoEntryRejected`，错误文案指向自有菜单。
冷恢复一个**已存 auto 身份**的旧会话时 admit 放行（否则整份日志无法加载），并计数记录。

**真实宿主结果**：

| 场景 | 命令结算 | 权限事实变化 |
|---|---|---|
| guarded（`f2-01-guarded`） | `error: 此入口不受 Arbiter 支持…` | 无：`preset/sandbox/approval` 前后完全一致 |
| trusted（`f2-trusted-01`） | 同上 | 无：仍是 `danger-full-access`；**没有先扩权** |
| 未启用 arbiter（`f2-00-not-enabled`） | 同上 | 无 |
| 切换若干次后再 auto（`f2-05`） | 同上 | 无 |

**回归**：`/permission workspace-write`（同值退出，`f2-03`）、`read-only` / `danger-full-access` / `workspace-write`
（`f2-04`）、未知预设失败（`f2-06`）全部按宿主语义成功/失败，状态与命令结果一致。
`command/run` 观察者只在**成功**时被后端当作退出意图——拒绝的 auto 不会停用 arbiter。

**自有入口**：本轮没有把正式客户端选择器接入会话启用状态（见第 7 节），因此"两档都能通过正式入口启用"
只用后端层面（`permissionPresets` 未写入 auto）证明，**客户端 UI 未验证**。

<a id="f3"></a>

## 4. F3：真实插件管理器停用／卸载

**操作入口**：Web 插件页的 `启用 dsh-arbiter` 开关（`role="switch"`），它调用
`remote.pluginManager.setPluginEnabled(entryId, enabled)`；**没有**使用探针路由或 `ctx.fiber.dispose()`。

| 检查 | 结果 |
|---|---|
| 停用生效 | 开关 `true → false`，`/api/arbiter/state` 由 **200 → 404**（`f3-03-disabled.json`） |
| 热停机 | **是**：路由立即消失、插件不再挂载，不需要重启 |
| 在途审查 | 9s 审查进行中停用：审查仍完成（`review-allow`），工具执行并写字（`f3-06`/`f3-07`），**未被取消** |
| 停用期间新调用 | 走宿主自身策略，无 gate、无报错、文件效果正常（`f3-08`） |
| 重新启用 | 开关 `false → true`，路由恢复 200，配置完整（`f3-05`） |
| 会话回退 | 见 F4：卸载时把仍受管会话回退为 `workspace-write + ask` |

### 4.1 真实卸载（`removeBundle`）

停用与卸载是管理器里的两个入口，本轮都做了。卸载走插件页的「卸载 dsh-arbiter」（`removeBundle` → `pnpm remove`）：

| 检查 | 结果 |
|---|---|
| 依赖被删除 | `package.json` 的 `dependencies['dsh-arbiter']` 消失（`f3u-04-removed.json`） |
| bundle 取消选择 | `dsh.profile.bundles` 只剩 base + web-app |
| 路由消失 | `/api/arbiter/state` → **404** |
| **重启后不复活** | 用管理器写好的 profile 直接重启：路由仍 404，bundles 仍无 `dsh-arbiter`（`f3u-05-after-restart.json`） |
| 关闭会话可重开 | 该会话仍加载（21 条事件），权限保持 `workspace-write + ask`，原生控件显示"工作区内修改" |
| 在途审查 | 12s 审查进行中卸载：审查仍 `review-allow` 并写出 `ws/f3ui-slow.txt`，随后插件被移除（`f3u-06-inflight.json`） |

> 卸载测试里有个坑值得记录：第一次重启用驱动默认的"重建 profile"逻辑跑，profile 被重新写回带 `dsh-arbiter`，
> 于是出现"卸载后重启又存在"的假象。改为 `reuseProfile: true` 复用管理器写的 manifest 后，结论才是可信的。

<a id="f4"></a>

## 5. F4：收尾期的新调用（本轮发现并修复的真实缺口）

**修复前的真实观察**（trusted 部署，慢审查 9s）：

```
t0       开始 F4SLOW（审查挂起）
t0+2.8s  插件页停用 arbiter（路由 404）
t0+3s    同会话提交 F4NEW  → 宿主按 danger-full-access 直接执行 → 写出 workspace 外 f4-new.txt
```

即：**gate 已撤销、但会话权限尚未回退**，新调用在旧 trusted 权限下免审执行。这正是交接文档 F4 要求排除的情形。

**修复**：`managed` 记录被 gate 实际接管过的会话；卸载 disposer 依次
`accepting=false → 等待在途（≤30s）→ 只回退仍受管且权限确实更宽的会话 → 释放`。
回退前会折叠会话自身权限，**已是 workspace-write + ask 的会话不写多余事件**，用户已切走的会话不碰。

**修复后**（`raw/f4/`）：

| 检查 | 结果 |
|---|---|
| 回退先于新调用 | 会话日志：`plugin:arbiter/decision`(05:38:40.088) → `sandbox/mode: workspace-write`(05:38:40.394) → 新调用 |
| 新调用被挡住 | `f4-new.txt` **不存在**，工具返回沙箱拒绝（`isError: true`） |
| 在途审查不被取消 | `review-allow` 仍写入，原调用成功写出 `ws/f4-slow.txt` |
| 第二会话 | 未受管，按宿主策略执行 |

<a id="f6"></a>

## 6. F6：PTC 宿主取消（真实运行）

从 **trusted（danger-full-access）** 启动真实 `run_code`，内层 `tools.bash` 停在 10s 审查中，随后
`/permission workspace-write`：

| 观察 | 值 |
|---|---|
| 外层启动 | `ws/f6-outer-started.txt` 已写出（外层确实跑了） |
| 内层 | `f6-inner.txt` **不存在** |
| 宿主结果 | `Error: code run failed (abort): sandbox mode changed` |
| 迟到的 allow | 记录 `review-allow`，但**没有驱动 body** |
| 取消来源 | 宿主沙箱切换，不是 review-deny / human-deny |

这与文档要求一致：取消按真实来源记录，已产生的部分效果（`f6-outer-started.txt`）如实保留，未重放。

<a id="f5"></a>

## 7. F5：真实人工审批 —— **真人答复，运行确认**

操作者用自己的浏览器打开宿主的 token URL（与驱动共用同一个隔离宿主、同一个会话），
在页面上分别点了「允许一次」和「拒绝」。驱动只观察 `approval/decided`，**没有代点**。

| 真人操作 | `approval/decided` | 裁决链 | 工具 | 文件效果 |
|---|---|---|---|---|
| 允许一次（`raw/f5h/`） | `allowed-once` | `review(default) → review-escalate → human-allow` | 执行，`isError: false` | `ws/f5-ask.txt` 存在（`F5-ASK`） |
| 拒绝（`raw/f5d/`） | `rejected` | `review(default) → review-escalate → human-deny` | **未执行**，`Error: Not executed [human-deny]: the user rejected this call.` | `ws/` 为空 |

两条路径的会话完整序列都是 `tool/call` → `approval/asked` → `approval/decided` → `plugin:arbiter/decision`
（`human-allow` / `human-deny`）→ `tool/result` → `turn/end`，权限事实全程保持 `workspace-write + ask`。

截图：`raw/f5h/f5h-01-pending.png`（等待审批）、`raw/f5h/f5h-02-result.png`、`raw/f5d/f5h-02-result.png`。

**审批挂起期间切换 —— 受限，且发现了真实的入口封锁**：审批等待时 composer 被禁用（`composerUsable: false`），
原生权限控件虽然能展开、选项也能点到，但**不追加 `permission/preset`，审批保持挂起**（`raw/f5s/`）。
会话日志里 `command/run` 为 0、`permission/preset` 只有初始那一条。也就是说：**审批挂起时没有公开入口可以切出 arbiter**，
只能等审批结束。这不是插件 bug，是宿主在等待人工审批时封锁了权限入口；已登记为限制。

**关于 token**：操作者链接中的一次性 token 已从所有产物与日志中清除（`token=<redacted>`）。

## 8. 不改上游 vs 已修

- **已在不改 DSH 核心的前提下完成**：记录写入、冷恢复、旧日志兼容、原生 auto 拒绝、真实管理器停用、
  卸载 drain 与回退、PTC 取消观察。
- **公开接口的真实边界**：
  - `registerAuto` 的 admit **没有参数**，无法区分"用户切换"与"恢复旧会话"；本轮用 `command/run`/`command/done`
    这一个公开信号来区分，属于推断而非接口保证，已在架构文档登记。
  - `pluginManager.setPluginEnabled` 是**停用**，不是 `removeBundle` 卸载。
  - 记录写入依赖运行中宿主的安装根；profile 未声明该包时由 `src/records.ts` 的解析顺序兜底。

## 9. 剩余限制

| # | 限制 | 说明 |
|---|---|---|
| L1 | 审批挂起期间切换/停用的保留行为未验证 | 本轮只做了"原会话内真人答复" |
| L2 | 审批挂起期间无法切出 | 宿主封锁 composer 与原生权限控件；不是插件可控范围 |
| L3 | 客户端选择器未接入启用状态 | 本轮 F2 的自有入口只在后端层面成立 |
| L4 | 冷恢复用 `agents.resume` 重开 | 没有覆盖所有历史会话，只覆盖被打开的那一个 |
| L5 | auto 恢复放行依赖命令生命周期推断 | admit 无参数，见第 8 节 |
| L6 | 回退窗口最长 30s | 超时仍有在途调用时会记录 warning 并回退 |

## 10. 证据索引

| 组 | 产物 |
|---|---|
| F1 | `raw/f1/f1-01-written.json` … `f1-04-audit-removed.json` |
| F2 | `raw/f2/f2-00-state.json` … `f2-06-failed-command.json`；trusted：`raw/f2t/f2-trusted-01.json` |
| F3 | `raw/f3/f3-01-baseline.json` … `f3-08-while-disabled.json`；卸载：`raw/f3u/` |
| F4 | `raw/f4/f4-01-baseline.json`、`f4-02-drain.json`、`f4-03-reenable.json` |
| F5 | `raw/f5h/`（允许一次）、`raw/f5d/`（拒绝）；挂起期间切换：`raw/f5s/f5s-02-switch.json` |
| F6 | `raw/f6/f6-00-baseline.json`、`f6-01-switch.json`、`f6-02-settled.json` |
| 指纹 | `raw/fingerprint.txt` |

每个 `cases/<group>/` 还保留了隔离 `DSH_HOME`、profile、会话日志、`reviewer-requests.jsonl` 与 `stderr.txt`。
本报告与 JSON 不含认证 token、Cookie 或连接秘密。

## 11. 收尾

测试宿主都是驱动的子进程，驱动退出即停止；本轮结束时未留监听端口。隔离 profile、
`DSH_HOME`、workspace 与会话留在 `cases/` 作为复现材料。日常 profile
（`~/.dsh/profiles/desktop`）未安装插件、未修改。未发布、未合并。
