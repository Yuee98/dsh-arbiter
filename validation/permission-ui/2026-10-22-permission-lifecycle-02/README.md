# 生命周期时序修正与真实并发补测 · 2026-10-22-permission-lifecycle-02

对象：**正式插件** `dsh-arbiter`（profile `link:` 到本仓库，执行 `lib/` 构建产物），宿主 DSH 0.2.1-rc.2。

- 结论与更正：[REPORT.md](REPORT.md)
- 环境与指纹：[ENVIRONMENT.md](ENVIRONMENT.md)、`raw/fingerprint.txt`

上一轮 `2026-10-22-permission-recovery-01` 保留原样；本轮的**第一件事是更正它的三个测试错误**（见报告第 0 节）。

## 本轮的核心

1. 夹具改成**等待前记 `review-started` + 可控释放屏障**，不再用固定 sleep 猜时序。
2. 驱动以生产代码的 `unload/stop-admission` 轨迹为闸门提交并发调用，而不是"点完开关就当已停用"。
3. 由此复现出一个**真实实现问题**：卸载时先 drain 再回退，使 drain 窗口内的新调用继承旧 trusted 权限。
   修复为**回退先于 drain**，并补了能在旧顺序下失败的回归测试。

## 目录

```
scripts/    env/host/browser/cdp/drive/session-log/barrier
            t2.mjs（停用窗口）、t5.mjs（挂起时切换）、
            t5-human.mjs（真人）、t5-lifecycle.mjs（停用/卸载时审批）
probes/     barrier-llm.mjs（可控释放的确定性模型）
            command-bridge/（测试用客户端桥，公开 session.command）
cases/      每组的隔离 DSH_HOME、profile、会话、barrier 轨迹、截图
raw/        汇总产物 + fingerprint.txt
```

## 复现

```sh
cd validation/permission-ui/2026-10-22-permission-lifecycle-02
node scripts/t2.mjs "$PWD/cases/t2" 58031                       # 停用窗口内的并发调用
node scripts/t5.mjs "$PWD/cases/t5" 58651                       # 审批挂起时的两种切换
node scripts/t5-lifecycle.mjs "$PWD/cases/t5l-disable" 58691 disable
node scripts/t5-lifecycle.mjs "$PWD/cases/t5l-uninstall" 58701 uninstall
node scripts/t5-human.mjs "$PWD/cases/t5h" 58671 --wait-seconds 2400   # 需真人点击（本轮未取得，见报告第 5 节）
```

每个驱动自建隔离环境并自行关闭宿主。`t2.mjs` 会打印 `overlap` 与完整 trace，可直接核对是否真的重叠。
