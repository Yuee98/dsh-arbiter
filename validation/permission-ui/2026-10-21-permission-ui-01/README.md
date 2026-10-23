# 权限 UI 与生命周期验证 · 2026-10-21-permission-ui-01

运行 id：`2026-10-21-permission-ui-01`。对象：DSH **0.2.1-rc.2**（macOS 27.0.1 / arm64）+ 一个只使用公开 API 的验证探针。

- 结论与逐项证据：[REPORT.md](REPORT.md)
- 固定断言：`node scripts/check.mjs` → **63 passed, 0 failed**
- 环境与指纹：[ENVIRONMENT.md](ENVIRONMENT.md)、`raw/fingerprint.txt`
- 最短复现：[REPRO.md](REPRO.md)
- 机器可读结果：`raw/results.json`、`raw/check-results.json`

## 目录

```
probes/pui-probe/       宿主探针（index.js）与客户端选择器（client.js）
probes/llm-fixture.mjs  确定性 LLM 适配器（回放工具调用，不做模型判定）
scenarios/              U1–U4 的确定性回合脚本
scripts/                run.mjs（隔离宿主）、u1–u4.mjs（驱动）、check.mjs（断言）、cdp.mjs（浏览器）
cases/<group>/          每个用例的隔离 DSH_HOME、profile、workspace、截图和 JSON
raw/artifacts/<group>/  用例产物的副本（截图、事件、请求、stderr）
raw/results.json        汇总索引
```

## 复现

```sh
cd validation/permission-ui/2026-10-21-permission-ui-01
node scripts/u1.mjs "$PWD/cases/u1" 57531        # U1
PUI_AUTO=1 node scripts/u2.mjs "$PWD/cases/u2" 57532   # U2（宿主 /permission auto 需要 live integration）
node scripts/u3.mjs "$PWD/cases/u3" 57533        # U3（含两次宿主冷重启）
PUI_HOLD=1 PUI_DRAIN_MS=12000 node scripts/u4.mjs "$PWD/cases/u4" 57534 main      # U4 主体
PUI_HOLD=1 PUI_DRAIN_MS=0     node scripts/u4.mjs "$PWD/cases/u4a" 57535 approval  # U4 人工审批等待
node scripts/check.mjs                            # 读取 raw/results.json 并断言
```

每个驱动自己启动并关闭宿主（子进程随驱动退出），每个用例一个独立 `DSH_HOME`。
真实浏览器是 headless Edge，通过 CDP 驱动；截图在每个 `cases/<group>/` 下。

## 装置边界

| 文件 | 作用 | 是否真实 |
|---|---|---|
| `probes/llm-fixture.mjs` | 回放脚本化的工具调用 | **否**，确定性夹具 |
| `probes/pui-probe/index.js` | 用公开 API 模拟"插件启用状态 + 门禁 + 卸载顺序" | **否**，验证探针，不是产品代码 |
| `probes/pui-probe/client.js` | 在 `conversation.input.permission` 注册自有选择器 | **否**，验证探针 |
| headless Edge + CDP | 真实 Web 客户端点击、输入、刷新、断网 | **是** |
| 宿主 `dsh` CLI（Web profile） | 真实会话、真实沙箱、真实命令与事件 | **是** |

`approval.request` 的应答者由探针提供并保持挂起；**没有真实人类点击**，因此"人工审批保留"只证明请求不被插件改写或撤销，不证明真实人类的最终答复路径。
