# 环境与指纹

运行 id `2026-10-22-permission-lifecycle-02`，记录时间 2026-10-22（Asia/Shanghai）。

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Darwin 25），arm64 |
| DSH | **0.2.1-rc.2** |
| 运行时 | Node v24.21.0，`ELECTRON_RUN_AS_NODE=1` |
| profile | 每用例自建 `arb`，bundles = base + web-app + `dsh-arbiter`（`link:` 到本仓库） |
| 浏览器 | Microsoft Edge headless，CDP |
| DSH_HOME | 每用例 `cases/<group>/home`，启动前剥离全部继承 `DSH_*` |

## 本轮特有的测试装配

| 文件 | 作用 | 是否影响产品行为 |
|---|---|---|
| `probes/barrier-llm.mjs` | 确定性模型；审查请求在**等待前**写 `<callId>-started.json`，并阻塞到 `<callId>-release` 出现 | 否，只决定夹具何时回答 |
| `probes/command-bridge/` | 测试用客户端插件，把 `sessions.binding(id).session.command(text)` 暴露到 `window.__dshCommand` | 否，只转发并原样返回 |
| `ARBITER_TRACE_PATH` | 开启正式代码的只读生命周期轨迹 | 否，默认关闭且不参与判定 |

`command-bridge` 需要同时具备 Node 半边（`index.js`）与浏览器半边（`client.js` + `dsh.client`），
并且要以**真实目录拷贝**（不是 symlink）装进 profile，客户端 bundle 才会被 webserver 提供。

## 正式代码指纹

`raw/fingerprint.txt` 记录 `src/` 与 `lib/` 的 SHA-256。本轮改动集中在：

- `src/index.ts`：回退顺序、`lifecycle()` 轨迹点、`managed`/accepting 相关逻辑
- `tests/unload.test.ts`：新增顺序回归测试

## 环境事实

1. `sandbox-exec` 可用，F6 类场景可真实运行。
2. 宿主不再需要"完全磁盘访问"：profile 配置 `documentsDirectory` 后，TCC 请求为 0。
3. 除 `t5-human.mjs` 标注的窗口外，本轮没有真人参与；夹具与自动化点击与真人路径分开记录。
