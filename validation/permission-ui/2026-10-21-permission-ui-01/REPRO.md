# 最短复现步骤

前置：DSH 0.2.1-rc.2 安装在 `/Applications/DeepSeek Harness.app`，Node v24.21.0，
Edge 可用（headless CDP）。**不需要**任何真实模型或 API key：LLM 是确定性回放夹具。

```sh
cd validation/permission-ui/2026-10-21-permission-ui-01

# 0. 指纹（确认跑的是同一份安装）
./scripts/fingerprint.sh

# 1. U1 菜单覆盖 + 双执行边界
node scripts/u1.mjs "$PWD/cases/u1" 57531

# 2. U2 命令同步（auto 需要 live integration）
PUI_AUTO=1 node scripts/u2.mjs "$PWD/cases/u2" 57532

# 3. U3 刷新 / 断连 / 冷重启 / 审计库缺失（内部会重启宿主两次）
node scripts/u3.mjs "$PWD/cases/u3" 57533

# 4. U4 卸载与在途收尾
PUI_HOLD=1 PUI_DRAIN_MS=12000 node scripts/u4.mjs "$PWD/cases/u4"  57534 main
PUI_HOLD=1 PUI_DRAIN_MS=0     node scripts/u4.mjs "$PWD/cases/u4a" 57535 approval

# 5. 断言（只读已记录产物）
node scripts/check.mjs     # → 63 passed, 0 failed
```

每个驱动会：

1. 在 `cases/<group>/` 下创建独立 `DSH_HOME`、profile `pui`、`ws/`（工作区）与 `outside/`（越界目录）；
2. 写入 `home/storages/workspace.json`，把默认工作区指向该用例的 `ws/`；
3. **删除继承的全部 `DSH_*` 环境变量**后再设置 `DSH_HOME`（否则会串到日常 profile）；
4. 启动真实 `dsh --profile pui --no-open --port <port>`，用 token 换 cookie；
5. 用 CDP 驱动 headless Edge：输入、点选择器、刷新、断网、重启；
6. 结束后 `SIGTERM` 宿主（驱动退出时宿主随之退出）。

## 单独复现某一项

```sh
# 只看 U2 的同值切换
node -e '
const r=require("./raw/results.json").U2.sameValue;console.log(JSON.stringify(r,null,2))'
```

```sh
# 重放 U3 的冷恢复（不重跑浏览器）
node -e '
const {boot}=await import("./scripts/run.mjs");
const h=await boot("cases/u3", 57540);
// 浏览器步骤省略；用 curl + cookie 调 /api/pui/*
await h.stop();'
```

## 已知环境前提

- 宿主进程内 `sandbox-exec` 不可用 → `workspace-write` 下 bash 会 fail-closed。文件边界一律用 fs `write` 工具验证。
- 审批应答者是探针的挂起实现，**没有真实人类点击**；截图里的"允许一次/拒绝"按钮没有被点过。
- 无头 Edge 需要 `--no-sandbox`（本机 Crashpad 目录不可写，见 `ENVIRONMENT.md`）。

## 探测端点（仅存在于探针 profile）

| 端点 | 作用 |
|---|---|
| `GET /api/pui/state` | 所有 live 会话的启用状态（折叠自会话日志） |
| `GET /api/pui/status?sessionId=` | 单个会话状态 + live 会话列表 |
| `GET /api/pui/session-events?sessionId=` | 会话事件（含 `ignorable` 标记） |
| `GET /api/pui/events` | 探针 JSONL 日志 |
| `GET /api/pui/active` | 当前在途调用 |
| `POST /api/pui/enable` `{sessionId,boundary,origin}` | 启用（等价于选择器） |
| `POST /api/pui/disable` `{sessionId,reason}` | 停用 |
| `POST /api/pui/resume` `{sessionId}` | 冷恢复（`agents.resume`） |
| `POST /api/pui/unload` `{drainMs}` | 触发插件卸载顺序 |
| `GET /api/pui/sandbox?sessionId=` | 实际 sandbox mode / approval policy |
