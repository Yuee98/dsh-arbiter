# 环境与安装指纹

记录时间：2026-10-20（Asia/Shanghai）。

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Darwin 25），arm64 |
| DSH 版本 | **0.2.1-rc.2** |
| CLI 版本命令 | `dsh --version` → `0.2.1-rc.2` |
| 宿主入口 | `/Applications/DeepSeek Harness.app`（Electron，`ELECTRON_RUN_AS_NODE=1` 以 Node 模式运行 CLI） |
| 运行时 Node | v24.21.0（`process.version`，见各用例 `result.json` 的 `env.node`） |
| 运行 profile | 自建 `hostcov`，bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`（`g1-h` 另加 `@deepseek-ai/dsh-experimental-auto-review`） |
| DSH_HOME | 每用例 `cases/<id>/home` |
| 日常 profile | `~/.dsh/profiles/desktop`，**本轮未修改**；bundles 仍为 base + web-app + workbuddy-connect + auto-review |

## 安装包关键文件 SHA-256

从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 重新提取后计算，
用于确认本轮实测与 evidence.md §22 的源码核对指向同一份安装。

| 安装包内路径 | SHA-256 |
|---|---|
| `dsh/package.json` | `b67a65b9719272b2eb54093b63c121d05907da062a1393e8c9f871e1cd18f94e` |
| `dsh-tools/lib/index.js` | `1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a` |
| `dsh-user-approval/lib/index.js` | `6a5ad1ba3c3dc3abbbae52e6c8c4463970ee0c1c8988cebb0d5cf2acd17ee90b` |
| `dsh-subagent/lib/index.js` | `9a9572e70fffdb100deb63326167f32bbf63016ce49c0017495dabcb95b44168` |
| `dsh-mcp-client/lib/index.js` | `758d8fc473b700b5d351158d06ce9f9e92c16e8b25497b08bb7bd2122a87f5dd` |
| `dsh-sandbox/lib/index.js` | `b56373befbfcfe281c17c8892e9a4b2cdcb96851290b3ed0ff56b08915e2f743` |
| `dsh-ptc-runtime-node/lib/index.js` | `e2d31fe1292e11f79080f65f69af24d7d288dfe8fb11948a5194051189c29d8d` |
| `dsh-tool-workflow/lib/index.js` | `9d7ccb5238318aae82cbf6ae497f00c2b45e4afa29ed430c7b5c7e7e2cd409e4` |

前五项与 evidence.md §22 已记录的 SHA 一致（`dsh-subagent` 与 `dsh-mcp-client` 亦同），
说明本轮运行的就是源码结论针对的同一安装。

## 本轮使用的测试装置

| 装置 | 作用 | 是否接触日常会话 |
|---|---|---|
| `fixtures/probe.mjs` | `tools/pre-execute` 固定 allow／deny，记录 `tools/execute`、`tools/result`、`tools.guard` | 否，只挂在用例 profile |
| `fixtures/llm-fixture.mjs` | 固定回放脚本化 tool-call 的 LLM 适配器 | 否 |
| `fixtures/mcp-test-server.mjs` | 记录每一帧 JSON-RPC 的本地 stdio MCP server | 否 |
| `fixtures/approval-sim.mjs` | 模拟审批应答器，输出一律标 `simulated: true` | 否 |
| `fixtures/tcp-receiver.mjs` | 127.0.0.1 随机端口的本地接收端 | 否 |

**注意**：`approval-sim` 是本轮唯一"代替人类"的组件。它的输出只用于证明审批 seam 可分离，
不计作人工审批；详见 REPORT.md 第 7 节。
