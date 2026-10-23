# dsh-arbiter

面向 DSH 的独立权限与自动审查插件，将命令规则与 auto review 放在同一套产品中。

**首版范围更新（2026-10-23）**：聚焦审批、会话启停与执行边界、规则管理和测试、配置、日志与恢复。离线规则建议及其入口、生成、验证和审核流程移到后续版本，待真实日志积累后重新设计。下文首轮报告中的相关功能是已有原型记录，不作为当前首版交付要求，见[产品范围](docs/requirements.md#first-release-scope)。

**首版默认值（2026-10-24 已确认）**：chat + 跟随会话模型、guarded、主会话 normal／子任务 strict、空命令规则表；安装不自动接管会话。预设规则留待实际使用后评估，正文与实施验收见[初始默认值](docs/configuration-and-audit.md#initial-defaults)。

状态（2026-10-21，返修后）：**首轮完整功能版本已实现并可在隔离的 DSH 0.2.1-rc.2 profile 中试用**。已接入真实 `tools/pre-execute` 门禁、chat 审查后端、三档审批模式、人工与兜底结算、配置页、SQLite 审计、会话裁决记录和离线规则建议。评审提出的 R1–R9 已修复并纳入 `pnpm verify` 回归（R3 仍是生命周期夹具，真实 DSH 在途热更新未跑；R8 另经真实 Web 候选确认）；真实模型质量、真实人工审批、decision 后端网络与 Web 点击操作仍未验证，详见[首轮实施报告](docs/implementation-report.md)和[返修记录](docs/implementation-review-remediation-2026-10-21.md)。

后续已确认采用[同位置 arbiter 权限选择器](docs/architecture.md#permission-selector-contract)：菜单控制会话启停，trusted / guarded 在插件配置页选择。U1–U4 已验证基础接入与探针收尾。

## 2026-10-22 修复与补测

用户确认[拒绝原生 `/permission auto`](docs/architecture.md#native-auto-rejection)后，本轮在**正式插件**上完成了
[冷恢复修复与 F1–F6 补测](docs/permission-recovery-followup.md)（运行 id `2026-10-22-permission-recovery-01`，
报告 [REPORT.md](validation/permission-ui/2026-10-22-permission-recovery-01/REPORT.md)，`pnpm verify` 78 tests + R1–R9 全绿）：

- **已修复**：会话裁决记录改用公开 `appendPluginRecord`（此前 `session.append` 写的事件缺少 `ignorable`，会让宿主的冷读器**拒绝整份会话日志**）；新增旧日志的备份式定点修复；原生 `/permission auto` 在权限变化前被拒绝；卸载时按"停止接管 → 等待在途 → 回退仍受管会话"执行。
- **运行确认**：真实"写→关→退宿主→重启→重开"；guarded／trusted／未启用三档 auto 拒绝且零副作用；插件页真实开关停用；回退后的越界写入未落地；真实 `run_code` 被宿主以 `abort: sandbox mode changed` 取消。在途重叠与收尾窗口的新调用仍需[屏障补测](docs/permission-recovery-followup.md)。
- **真人确认**：操作者本人点了「允许一次」与「拒绝」，分别落到 `human-allow`（执行并落盘）与 `human-deny`（未执行）。
- **时序补测修正了一个实现缺陷**：卸载时若先等待在途再回退权限，drain 窗口内到达的调用会在旧 `danger-full-access` 下免审执行。
  已改为**回退先于等待**，并补了能在旧顺序下失败的回归测试（[补测报告](validation/permission-ui/2026-10-22-permission-lifecycle-02/REPORT.md)）。
- **更正**：审批挂起时**可以**切出（上一轮点击的是已选中的同值预设，控件直接返回）；停用与卸载期间已弹出的审批均保留。
- **卸载也验证了**：插件页「卸载」删依赖、取消 bundle 选择、路由 404，重启后不复活，关闭会话可重开。
- **仍未完成**：正式客户端选择器接入会话启停、日常 profile 历史日志迁移。
- **审批挂起期间已补测**：切换到不同预设（`read-only`）与显式同值命令均成功，审批保持挂起；停用与卸载期间审批同样保留。
  真人随后批准那次调用：裁决为 `human-allow`，但执行仍被 `read-only` 沙箱挡住——审批决定裁决、不放宽权限。
- **同一会话并行工具入口**：宿主确实会并发派发同一 step 内的 `read`/`web_search`（`isConcurrencySafe`），
  已实测两个 `read` 同时进入 gate、各自独立裁决。

首轮报告里的"真实人工审批、真实模型质量、decision 后端网络、Web 点击"仍未验证，状态不变。

## 从这里开始

| 阅读目的                               | 文档                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| 首轮实现了什么、如何试用、证据与缺口   | [首轮实施报告](docs/implementation-report.md)           |
| 统一术语、规则分类与判定阶段           | [产品术语](docs/terminology.md)                         |
| 比较三档策略、主／子任务设置与配置生效 | [审批模式与审查策略](docs/approval-modes.md)            |
| 了解产品目标、现有范围与边界           | [产品需求](docs/requirements.md)                        |
| 了解执行链、审批模式与子 agent         | [总体架构](docs/architecture.md)                        |
| 理解命令规则、优先级和规则沉淀         | [规则引擎](docs/rules.md)                               |
| 理解授权证据、历史与输入预算           | [审查上下文](docs/review-context.md)                    |
| 理解模型接口与最终判定                 | [审查后端与判定引擎](docs/reviewer.md)                  |
| 了解配置体验、规则测试和记录           | [配置、规则测试与审计](docs/configuration-and-audit.md) |
| 首轮实现交接与状态回填                 | [实现交接](docs/initial-implementation-handoff.md)      |
| 查看计划和需要实测的假设               | [实施与验证](docs/implementation.md)                    |
| 继续产品讨论或追溯方案变化             | [决策与待讨论问题](docs/decisions-and-questions.md)     |
| 核对宿主约束、技术来源和生态背景       | [调研证据](evidence.md)                                 |

## 已实现的功能

| 模块           | 当前状态                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DSH 插件接入   | `tools/pre-execute` 门禁、`/arbiter` 命令、auto 预设注册、配置页与只读状态；普通工具、MCP、`run_code` 外层与 PTC 内层在入口处进入同一判定 |
| 命令规则       | 自带的保守 shell 读取器、exact／RE2 regex／glob、四值裁决、作用范围、优先级、复合命令覆盖、规则测试                                       |
| 自动审查       | 不可变 ReviewSnapshot、来源标记的授权证据、历史与先前裁决、token 预算、chat 与 decision 两种适配器、版本化判定策略                        |
| 审批与生命周期 | 主会话 normal／strict／progress、子任务 strict／progress；人工审批、human-abort、fallback-deny 与 error-escalate 分开记录                 |
| 配置           | 配置页“保存并应用”，文件为唯一可编辑来源，并发冲突拒绝，内容快照与生效记录，无效配置回退到上一份有效配置                                  |
| 审计与恢复     | 内存裁决、DSH 会话 `plugin:arbiter/decision` 最小记录、SQLite 完整审计、异步有界队列、恢复、默认 30 天／1 GiB 清理                        |
| 界面           | 状态与覆盖、模式 tooltip、规则表与测试、reviewer、策略与高级设置、日志筛选／详情、离线建议审核                                            |
| 离线建议原型（延期） | 已有本地历史聚合、确定性候选、统计与代表案例、修改／拒绝／确认添加；该原型保留为参考，相关首版任务和验收已移出                         |

## 本地安装与试用

目标运行时：DSH desktop **0.2.1-rc.2**（macOS）。以下步骤均使用隔离的 `DSH_HOME`，不会修改日常 `~/.dsh`。

1. 从 shipped Web 模板创建隔离 profile（本机 CLI 入口见下方说明）：

```sh
export DSH_HOME=/tmp/dsh-arbiter-trial
DSH_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" "$DSH_CLI" --profile arbiter --from-default-profile web --dump-config
```

2. 安装本包并启动该 profile：

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" "$DSH_CLI" plugin --profile arbiter add /Volumes/sandisk/code/dsh-arbiter
ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" "$DSH_CLI" --profile arbiter --no-open --port 56111
```

如果环境里已有可用的 `dsh` 命令，等价于 `dsh plugin --profile arbiter add <path>` 与 `dsh --profile arbiter`。安装的其他方式：在 Web 的 **Plugins → Add plugin** 中选择本地路径；本包尚未发布到 npm，不要求公开发布才能试用。

3. 打开终端输出的带 token URL，登录后进入 **Plugins → dsh-arbiter**。配置页提供状态、规则、reviewer、策略与高级设置、日志；已有原型中的离线建议入口需随首版范围收敛，暂不作为试用与验收目标。

4. 第一次试用建议：

- 在“规则”页添加 `^gh pr view\\b` 的 allow 规则（带 `/workspace` 内的 redirect allow 规则），运行规则测试，再让 agent 实际调用；
- 将 reviewer 保持为 `chat` + `provider: session`，不选没有凭据的 decision 后端；
- 在“日志”页确认规则短路没有调用 reviewer，审查允许/拒绝分别记录；

当前首轮实现的斜杠命令：`/arbiter status`、`/arbiter test <command>`、`/arbiter mode trusted|guarded`。其中 mode 属于早期入口；最新产品方案将 trusted / guarded 放在插件配置页，通过权限选择器切换会话启用状态，待上述验证后改造。审批模式仍在配置页选择。

## 数据与边界

- 配置：profile 的 `cordis.patch.yml`；页面和文件走同一校验与应用路径。
- 审计：`$DSH_HOME/arbiter/arbiter.db`，默认保留 30 天或 1 GiB；清理只删除 SQLite 审计。
- 会话裁决：`plugin:arbiter/decision`，用于会话内展示与冷恢复优先读取。
- 已接入：原生工具、MCP 工具（RPC 前）、外层 `run_code`、PTC 内层调用、进程内子任务工具调用。
- 不逐项覆盖：`run_code` 内直接调用 Node `fs`／`fetch`／`child_process` 的效果、workflow 内部编排步骤、MCP 服务端内部执行、bash 启动后的子进程内部行为。
- 停止或卸载不自动清理用户规则与日志；不自动修改日常 profile，不自动应答沙箱升权。

## 开发与验证

使用 mise 固定 Node 24.21.0、pnpm 11.7.0 和 actionlint 1.7.12；CI 使用同一份 `mise.toml`。

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm verify
```

| 命令                     | 检查内容                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `pnpm typecheck`         | 严格检查源码、测试、脚本与 TSX 客户端                             |
| `pnpm lint`              | 类型感知 ESLint，零警告，禁止行内禁用与 focused/disabled tests    |
| `pnpm format:check`      | 检查格式；`pnpm format` 单独执行格式化                            |
| `pnpm check:unused`      | Knip 检查未使用文件、导出与依赖                                   |
| `pnpm check:workflows`   | actionlint 检查 GitHub Actions 工作流                             |
| `pnpm test`              | 66 个单元测试（规则、策略、配置、reviewer、快照、审计、离线建议） |
| `pnpm build`             | 清理 `lib/` 后输出 ESM JS／声明文件，并用 esbuild 生成浏览器半侧  |
| `pnpm check:build`       | 临时消费者验证导入、声明文件正反例和客户端 bundle 工厂            |
| `pnpm check:regressions` | 运行评审提供的 R1–R9 复现脚本（生命周期夹具，不启动 DSH）         |
| `pnpm verify`            | 顺序执行以上全部检查、测试、构建与 R1–R9 回归                     |

真实 DSH 集成证据：`validation/arbiter-integration/2026-10-21-arbiter-01/`（14 个用例，含真实 pre-execute、真实会话记录、真实 SQLite、模拟人工审批单独标注）。运行：

```sh
cd validation/arbiter-integration/2026-10-21-arbiter-01
node scripts/run-case.mjs
node scripts/check.mjs
```

现有设计专题、归档与 `validation/` 资料不纳入工程的格式、Lint、类型与 Knip 检查。构建只包含 `src/`；`lib/`、依赖目录与测试产物不提交。

CI 在所有 PR、main 推送和手动触发时运行单个 `Verify` job。Dependabot 每周检查 npm 开发依赖和 Actions 更新，通过 PR 验证，不自动合并。
