# 环境与安装指纹

记录时间：2026-10-22（Asia/Shanghai）。运行 id `2026-10-22-permission-recovery-01`。

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Darwin 25），arm64 |
| DSH 版本 | **0.2.1-rc.2** |
| 宿主入口 | `/Applications/DeepSeek Harness.app`（Electron，`ELECTRON_RUN_AS_NODE=1` 运行 CLI） |
| 运行时 Node | v24.21.0 |
| 运行 profile | 每用例自建 `arb`，bundles = `dsh-base` + `dsh-web-app` + **`dsh-arbiter`（link 到本仓库）** |
| 浏览器 | Microsoft Edge 155.0.4283.45，`--headless=new --no-sandbox`，CDP |
| DSH_HOME | 每用例 `cases/<group>/home`，启动前剥离全部继承的 `DSH_*` |

## DSH 安装包 SHA-256

见 `raw/fingerprint.txt`。与本轮相关的关键项：

| 文件 | SHA-256 |
|---|---|
| `dsh/package.json` | `b67a65b9719272b2eb54093b63c121d05907da062a1393e8c9f871e1cd18f94e` |
| `dsh-permission-presets/lib/index.js` | `4f23c620145098d611d04d8363bc6716f49b26930c9141a21dc9a8df2b72ba63` |
| `dsh-session/lib/index.js` | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` |
| `dsh-tools/lib/index.js` | `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a` |
| `dsh-user-approval/lib/index.js` | `6a5ad1ba3c3dc3abbbae52e6c8c4463970ee0c1c8988cebb0d5cf2acd17ee90b` |
| `dsh-plugin-manager/lib/index.js` | `1b8bf9eb266d7b3b7f899175e3f435c89ed8baa8aabc677212759f8c6cd23132` |

## 本轮测试的 arbiter 代码版本

`raw/fingerprint.txt` 记录 `src/` 与 `lib/` 的 SHA-256。本轮跑的是**修复后**的构建：

- `src/records.ts`：新增，公开 `appendPluginRecord` 写入 + 只读 `ignorable` 记录
- `src/repair.ts`：新增，旧日志定点修复（备份、只改 arbiter 记录）
- `src/index.ts`：原生 auto 拒绝、managed 会话跟踪、卸载 drain + 回退
- `lib/`：`pnpm run build` 产物，profile 通过 `link:` 指向本仓库，因此执行的是 `lib/`

## 环境相关事实（与上一轮不同）

1. **`sandbox-exec` 现可用**：`sandbox-exec -p '(version 1)(allow default)' /bin/echo probe` → `probe`。
   上一轮记为"环境受限"的 PTC 取消因此可以真跑，本轮 F6 已完成。
2. **不再需要"完全磁盘访问"**：宿主在 `documentsDirectory` 未配置时会用 `osascript` 探测「文稿」目录，
   触发 `kTCCServiceSystemPolicyAllFiles`。本轮在隔离 profile 中配置该项后，宿主启动期间 TCC 请求为 0。
3. 仍**没有真实人类**参与除 F5 之外的任何步骤；F5 需要操作者本人点击。
