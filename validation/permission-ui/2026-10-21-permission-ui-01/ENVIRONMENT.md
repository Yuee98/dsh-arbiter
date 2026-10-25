# 环境与安装指纹

记录时间：2026-10-21 / 2026-10-22（Asia/Shanghai）。

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Darwin 25），arm64 |
| DSH 版本 | **0.2.1-rc.2**（`app.asar/dsh/package.json`） |
| 宿主入口 | `/Applications/DeepSeek Harness.app`（Electron，`ELECTRON_RUN_AS_NODE=1` 运行 CLI） |
| 运行时 Node | v24.21.0 |
| 运行 profile | 每个用例自建 `pui`，bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` |
| 浏览器 | Microsoft Edge 155.0.4283.45，`--headless=new --no-sandbox`，CDP |
| DSH_HOME | 每用例 `cases/<group>/home`，启动前剥离全部继承的 `DSH_*` |

## 安装包关键文件 SHA-256

`raw/fingerprint.txt` 由 `scripts/fingerprint.sh` 生成：

| 安装包内路径 | SHA-256 |
|---|---|
| `dsh/package.json` | `b67a65b9719272b2eb54093b63c121d05907da062a1393e8c9f871e1cd18f94e` |
| `dsh-tools/lib/index.js` | `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a` |
| `dsh-user-approval/lib/index.js` | `6a5ad1ba3c3dc3abbbae52e6c8c4463970ee0c1c8988cebb0d5cf2acd17ee90b` |
| `dsh-sandbox-policy/lib/index.js` | `772ca58f0f786d6cb4d839deb621634c31097c13228d81b14e3f3153d0524924` |
| `dsh-permission-presets/lib/index.js` | `4f23c620145098d611d04d8363bc6716f49b26930c9141a21dc9a8df2b72ba63` |
| `dsh-client-ui-permission-presets/lib/client.js` | `d35ea0b7c74ad66481bd33fa38fc7d7751edf4336e11c0058a992464862cc119` |
| `dsh-session/lib/index.js` | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` |
| `dsh-plugin-manager/lib/index.js` | `1b8bf9eb266d7b3b7f899175e3f435c89ed8baa8aabc677212759f8c6cd23132` |
| `dsh-hmr/lib/index.js` | `143b445f1b303be83d56f9e7d3992e1a4885850c08f1082065d332ba7a70ae0a` |

`dsh/package.json`、`dsh-tools`、`dsh-user-approval` 三项与
`validation/host-coverage/2026-10-20-host-coverage-01/ENVIRONMENT.md` 及 evidence.md §22 记录的 SHA 一致，
说明本轮运行的就是既有源码结论针对的同一安装。

## 本轮遇到的环境限制

1. 宿主进程内的 `sandbox-exec` 无法应用策略（`sandbox_apply: Operation not permitted`）。
   因此 `workspace-write` 下的 **bash** 调用会被宿主 fail-closed 拒绝（`SANDBOX_UNAVAILABLE`）；
   文件边界改用 fs `write` 工具验证（fs 沙箱是纯路径判定，不受该限制影响）。
   这是验证环境的限制，不是产品行为，也不影响权限选择器与生命周期的结论。
2. 父会话导出了 `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_PROFILE` 等变量。首轮未剥离时，
   provider 与 profile 实际来自日常 desktop 环境。`scripts/run.mjs` 现在启动前删除全部 `DSH_*`
   再显式设置 `DSH_HOME`，隔离宿主已复核（boot graph 中不含日常 bundle）。
3. 未取得真实人类审批：`approval/request` 的应答者是探针提供的挂起实现，不构成人类答复。
