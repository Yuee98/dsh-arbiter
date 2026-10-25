# DSH 版本维护与升级 PR 三平台分流

日期：2026-10-25。本轮继续更新 PR #29，不合并、不新增 issue，不实现 Release Action。已有三平台宿主安装与 Windows 路径修复证据保留在[上一轮报告](../2026-10-25-dsh-hosted/REPORT.md)，不改写旧结果。

## 本轮契约

- Dependabot 为 `/tests/e2e/runtime` 新增独立 npm 更新配置，每周检查、7 天 cooldown、最多一个常规更新 PR；不与根目录工具依赖混组，不自动合并。
- PR、main 与后续发布流程统一使用 `tests/e2e/runtime/package.json` 的精确版本和 `package-lock.json`；本轮不升级 DSH，仍为 0.2.1-rc.3。发布前需要新版时先完成升级 PR 和兼容验证，不在 release job 中临时选取 `latest`。
- 所有改动运行时目录的 PR 自动跑 Ubuntu、macOS、Windows smoke，适用于 Dependabot 和手动升级；普通相关 PR 与 main 保持 Ubuntu，手动入口保持明确的平台选项。
- 平台选择比较 PR base 与 checkout 合并树的整份 Git diff，不依赖作者、分支名或最后一个提交；包含新增、修改、删除、移出及 lockfile 单独更新。NUL 分隔避免文件名中的换行误判；无法读取 diff 时失败。
- smoke 仍仅证明三个已实现用例的行为，不替代关键权限、沙箱、恢复及停用／卸载的产品验收。Release Action 尚未实现，`pnpm check:release` 仍是当前机器上的检查入口。

## 验证结果

代码 head：`9c76af037043ac52d76d18e143e8412f76739568`。本机 `pnpm verify`：162 unit、46 integration、18 UI 及 R1–R9 全部通过；包含 17 项真实临时 Git 仓库／独立 Node 进程的分流回归。

[PR 自动工作流](https://github.com/Yuee98/dsh-arbiter/actions/runs/40175794511) 的事件是 `pull_request`，并非手动 dispatch。[平台选择 job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40175794511/job/121116075606) 实际输出 `runtime-change: ubuntu-24.04, macos-15, windows-2025`，随后三个平台并行执行。

| 系统 / 架构 | Smoke | 整个 job 耗时 | 证据 |
|---|---|---|---|
| darwin / arm64 | 3 passed，0 skipped／flaky | 116 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40175794511/job/121116108273) |
| linux / x64 | 3 passed，0 skipped／flaky | 92 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40175794511/job/121116108274) |
| win32 / x64 | 3 passed，0 skipped／flaky | 354 秒 | [job](https://github.com/Yuee98/dsh-arbiter/actions/runs/40175794511/job/121116108279) |

九例全部完成宿主退出与临时目录删除；每例 71 个运行产物／locale／清单指纹核验通过，Windows 换行差异单独兼容并保留原始哈希。宿主仍为 DSH 0.2.1-rc.3。

该代码 head 的全部 20 项 GitHub checks 通过，其中 GitHub 原生 `.github/dependabot.yml` 配置检查为 SUCCESS；这只证明配置被接受，不代表定时服务已经创建升级 PR。普通相关 PR／main 仅 Ubuntu、手动四种选择、机器人／人工升级、跨多个提交、删除／移出与特殊文件名、非法输入拒绝均有本机回归。

## 未运行与生效边界

- 未等待 Dependabot 定时服务创建真实升级 PR：PR #29 尚未合并，当前 main 尚无这个独立目录配置。GitHub 的配置检查通过与定时服务已实际产生更新分开记录。
- 没有发布新版本或修改 npm tag，未让发布任务临时换用另一个 DSH。
- 三平台自动分流的真实证据来自当前 PR 整份 diff 包含运行时目录的新增；普通相关 PR、main 与手动选项由真实临时 Git 仓库及独立 Node 进程回归验证，不冒充这些场景已在 main 触发。
- 未合并 PR #29；main 自动触发及定时 Dependabot 服务需待用户后续明确授权合并。

完整 GitHub 工件保存七天，本机原始日志与下载工件位于 `.local/dsh-updates-20261025/`。本目录的 `evidence.json` 留存固定代码 head、PR 触发信息、分流结果、平台 job 与检查摘要。
