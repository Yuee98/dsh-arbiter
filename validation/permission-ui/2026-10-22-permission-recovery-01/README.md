# 冷恢复修复与权限生命周期补测 · 2026-10-22-permission-recovery-01

对象：**正式插件** `dsh-arbiter`（`link:` 安装到隔离 profile，执行 `lib/` 构建产物），宿主 DSH 0.2.1-rc.2。

- 结论：[REPORT.md](REPORT.md)
- 环境与代码指纹：[ENVIRONMENT.md](ENVIRONMENT.md)、`raw/fingerprint.txt`
- 复现命令见 REPORT 第 10 节；驱动在 `scripts/`，确定性模型在 `probes/arbiter-llm.mjs`

## 与上一轮的区别

| | `2026-10-21-permission-ui-01` | 本轮 |
|---|---|---|
| 被测对象 | 探针 `pui-probe` | **正式插件** |
| 卸载 | 探针 `unload` 路由 | **插件页真实开关**（`setPluginEnabled`） |
| 人工审批 | 探针挂起应答器 | **真人**用自己的浏览器点「允许一次」「拒绝」 |
| PTC 取消 | 环境受限未运行 | **真实运行**（`sandbox-exec` 已可用） |

上一轮报告与 63 项断言保持不变，**不构成本轮证据**。

## 目录

```
scripts/     env.mjs / host.mjs / browser.mjs / drive.mjs / session-log.mjs
             f1.mjs f2.mjs f2-trusted.mjs f3.mjs f4.mjs f5.mjs f6.mjs
probes/      arbiter-llm.mjs（确定性 agent + reviewer，支持 reviewerDelayMs）
cases/       每组的隔离 DSH_HOME、profile、workspace、会话、截图
raw/         汇总产物副本 + fingerprint.txt
```

## 关键复现

```sh
cd validation/permission-ui/2026-10-22-permission-recovery-01
node scripts/f1.mjs "$PWD/cases/f1" 57721          # 冷恢复（含两次重启）
node scripts/f2.mjs "$PWD/cases/f2" 57671          # 三档 auto 拒绝 + 回归
node scripts/f2-trusted.mjs "$PWD/cases/f2t" 57701 # trusted 档
node scripts/f3.mjs "$PWD/cases/f3" 57791          # 真实停用 + 在途
node scripts/f3-uninstall.mjs "$PWD/cases/f3u" 57951  # 真实卸载（含重启复用 profile）
node scripts/f5-switch.mjs "$PWD/cases/f5s" 57971    # 审批挂起期间尝试切换
node scripts/f4.mjs "$PWD/cases/f4" 57811          # 收尾期新调用
node scripts/f6.mjs "$PWD/cases/f6" 57861          # PTC 取消
node scripts/f5-human.mjs "$PWD/cases/f5h" 57881 --wait-seconds 2400   # 打印 token URL，由真人用自己的浏览器点击
```

每个驱动自建隔离环境并自行关闭宿主；端口需空闲。
