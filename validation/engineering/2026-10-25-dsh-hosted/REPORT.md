# GitHub-hosted DSH 安装与 E2E 验证

运行日期：2026-10-25。目标是确认 GitHub-hosted runner 能安装固定版公开 DSH 并运行当前插件，进而替换尚未部署的 self-hosted 工作流。此次只验收基础 smoke，不扩大为首版产品功能验收。

## 运行方式

- Node 24.21.0、pnpm 11.7.0、Playwright 1.64.1、Chromium。
- 公开 npm CLI `@deepseek-ai/dsh@0.2.1-rc.3`，独立 `package-lock.json` 锁定依赖树；通过 `npm ci` 安装，按清单允许必要的安装脚本。
- 每例创建独立 `DSH_HOME`、profile 和工作区，链接当前 checkout 的实际构建；Node 直接启动公开 CLI，操作真实宿主页面与插件。
- 三例使用三个 worker，并行验证旧配置面板和真实接口、宿主语言切换／刷新、初始配置区域 axe；不发送模型请求，不使用人工点击或模型凭据。
- 逐例读取 `environment.json` 与 `cleanup.json`，核对 DSH 版本、71 个运行产物／locale／清单指纹及宿主退出和临时目录删除。

## 平台结果

最终复测 head：`6630f4b83fc0157eb41f56087e9c9ebf2b6e08cf`（Windows 路径修复后的完整代码），[运行 #40174279573](https://github.com/Yuee98/dsh-arbiter/actions/runs/40174279573)：**success**。

| 系统 / 架构 | Runner | Smoke | 整个 job 耗时 | 证据 |
|---|---|---|---|---|
| darwin / arm64 | macos-15 | 3 passed，0 skipped／flaky | 115 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40174279573/job/121111501741) |
| linux / x64 | ubuntu-24.04 | 3 passed，0 skipped／flaky | 85 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40174279573/job/121111501791) |
| win32 / x64 | windows-2025 | 3 passed，0 skipped／flaky | 344 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40174279573/job/121111501748) |

九次隔离宿主均为 DSH 0.2.1-rc.3、Node 24.21.0；每例 71 个文件指纹核验通过，`profileRemoved` 与 `processExited` 均为 true。保留各平台原始哈希，跨平台核验兼容 Windows checkout 的 CRLF／LF 差异。此耗时是这次实际运行值，不能当作后续 CI 的固定预算；Windows 浏览器依赖准备占 207 秒，适合手动兼容矩阵，日常基准系统采用 Ubuntu。

同一代码 head 的 [PR 自动 Ubuntu smoke](https://github.com/Yuee98/dsh-arbiter/actions/runs/40174282203) 也已通过，证明路径触发实际生效。`pnpm verify` 通过 145 unit、46 integration、18 UI 与 R1–R9；该 head 的全部 16 项 GitHub checks 通过。main 触发需待本分支合并，未把手动或 PR 运行冒充 main 运行。

## 探测中发现的问题

1. [第一轮](https://github.com/Yuee98/dsh-arbiter/actions/runs/40173323447)在 Linux、macOS 各通过三个 smoke；Windows 在 checkout 阶段因历史证据目录的路径超过传统 Windows 限制失败，未进入宿主安装或运行。后续在该临时 runner 上先设置 Git `core.longpaths=true`，不改写历史证据。
2. [第二轮](https://github.com/Yuee98/dsh-arbiter/actions/runs/40173597743)在 Linux、macOS 各通过三个带 `@smoke` 标签的用例及清理断言。Windows 已通过长路径 checkout；当时浏览器安装在 DSH 安装之前，Windows Server 的 Media Foundation 准备明显更慢。为先取得独立 DSH 安装证据，提交后续顺序修正并再次 dispatch，取消了该轮 Windows job；因此该轮总状态是 cancelled，不能将整个 matrix 写成通过。
3. 后续把固定版 DSH 安装和 `--version` 记录前置，并给浏览器安装单独设置五分钟上限；详细后续结果见平台表。没有修改 DSH 核心、monkey patch、跳过或预期失败用例。
4. [Windows 独立补测](https://github.com/Yuee98/dsh-arbiter/actions/runs/40173874237)成功安装固定版 DSH 并启动三个隔离宿主；语言／刷新和 axe 两例通过，配置面板 smoke 因 `sessionRecords.ready=false` 失败，三例均完成清理。根因是插件定位宿主安装根目录时仅查找 `/node_modules/…`，Node 在 Windows 的 CLI 参数包含反斜杠。修复仅在查找分隔符时统一为 `/`，保留原始根路径交给 Node 原生解析；新增 POSIX、Windows 盘符、混合分隔符、UNC、桌面版入口与非宿主参数六项回归，不放宽 `sessionRecords.ready=true` 断言。最终补测结果另列，不覆盖失败证据。

## 工作流决策与范围

- 日常使用 GitHub-hosted `ubuntu-24.04`：相关代码／locale／构建 PR 和 main 自动 smoke，与普通 CI 同时运行。
- 手动 `platforms` 可选单个平台或 `all`，三平台 matrix 独立运行，失败不取消其他平台；不让普通 PR 等待完整平台矩阵。
- `pnpm test:e2e:dsh:smoke` 只筛选 `@smoke`，`pnpm test:e2e:dsh` 保留完整入口。当前仅有三个已实现用例，完整产品场景随各功能加入，不能用空测试代表计划场景。
- 发布前／DSH 升级执行平台基础兼容验证；每个声明支持系统仍需真实权限、文件边界、命令／沙箱、恢复与停用／卸载验收。通用 UI 在基准系统主测，Windows 的路径、启动器与进程树清理单独关注。
- 自动审批功能测试使用真实宿主和插件、确定性 Reviewer。真实模型质量与真人审批单列证据，不纳入日常 smoke 的外部依赖。
- 本报告不证明裸安装默认流程、正式权限选择器、实际工具审批／执行、恢复或卸载等首版功能已完成，也不由 smoke 直接宣布某系统完整受支持。
- 分支手动及 PR 自动触发的证据与 main 触发分开记录；本工作流合并后才会在 main 自动运行。

GitHub 工件保存七天；本目录的 `evidence.json` 留存运行／job 链接、固定 head、结果与清理摘要。完整下载工件及原始日志保留在本机 `.local/dsh-hosted-20261025/`，未覆盖旧验证报告。
