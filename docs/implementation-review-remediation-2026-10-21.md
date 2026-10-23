# 首轮实现评审返修（2026-10-21）

对应评审：[首轮实现评审](implementation-review-2026-10-21.md)。本轮只返修已实现流程，不扩大产品范围。原始评审的失败结论保留在评审文档中；本文件记录返修结果与剩余验证。

## 结论

评审列出的 R1–R9 均已修复。`pnpm verify` 现在包含评审提供的复现脚本作为 `check:regressions`，**9 项全部 PASS**；产品单元测试从 61 增至 66。已再次运行真实 DSH headless 集成 14 个用例、146 项断言，全部通过。

生命周期相关修复（R3、R8、R4）已用评审的显式生命周期夹具验证；**尚未在真实 DSH 配置热更新过程中做在途模型／人工等待回归**，该缺口保留在文末。

## 逐项返修

| 编号 | 根因 | 修复 | 回归 |
|---|---|---|---|
| R1 | 匹配器对所有重定向使用调用初始 cwd，忽略语句间的 `cd`；事实构造与匹配各自解释路径 | shell 读取器为每条命令和重定向记录有效 `cwd`；`cd` 成功按 `&&`／`;` 传播；`||` 的 RHS、后台 `&`、含 `cd` 的管道和不可解析 `cd` 标记为未知，未知 cwd 的相对路径不参与 allow 覆盖；事实构造复用同一 cwd | 规则测试新增 `cd /outside`、`cd -- /outside`、`cd … \|\|`、workspace 内对照；`reproduce.mjs` R1 PASS |
| R2 | R6 只检查风险门，未重新要求明确授权；低风险时通用授权要求为 none | R6 在风险门之前独立执行 `authGate(..., 'explicit')`；失败进入 `review-escalate`，不再以“明确授权”解释 | 策略测试新增 risk=3/auth=0/bulk+egress；R2 PASS |
| R3 | 每个 Loader 实例新建 runtime；旧请求在模型返回后继续使用旧 mode／strategy／thresholds，且持有已关闭 audit | 引入按 profile 隔离的进程内 runtime；插件实例只更新 runtime 配置，不替换在途请求的协议和快照；模型返回后重新读取当前 mode／strategy／thresholds，并用当前阈值重分类 decision 分布；audit 由 runtime 持有，活跃请求期间不关闭；请求计数与实例引用计数分离 | 生命周期夹具：normal 下模型挂起 → 应用 strict → 旧响应结算为 fallback-deny 且不弹人工；R3 PASS |
| R4 | `last-good.json` 仅按 DSH_HOME 存放，跨 profile 共享审批配置 | `last-good` 改为 `$DSH_HOME/arbiter/last-good/<profile>-<hash>.json`，hash 绑定 profile dir；回退只读取本 profile 文件，否则使用内置默认，不再读取共享文件 | 生命周期夹具：A deny、B allow，A 非法配置恢复 A 的 deny；R4 PASS |
| R5 | 容量清理按物理文件大小循环 DELETE，DELETE 不缩文件，最终删光；且只在 apply 时清理 | 先按时间清理；容量判断使用“已用页 − 空闲页”，按行均大小批量删除最旧调用并保留至少一条；删除后 `wal_checkpoint(TRUNCATE)` + `VACUUM` 回收空间；增加每小时后台保留任务（`unref`，随实例清理），关闭时清理 | 审计测试新增 10 条、目标仅低 16 KiB 的容量用例：仍有记录且物理体积下降；R5 PASS |
| R6 | decision 只把 `request.user` 放进 `state`，`customRules` 只在 chat 的 system 中；授权说明也未进入 decision 输入 | 新增 `renderDecisionState()`，把 `CUSTOM_RULES`、`PROJECT_RULES`、规则优先级、授权证据说明、先前裁决说明和 `MISSING_INPUT` 显式写入 decision `state`；chat 与 decision 共用同一快照来源 | reviewer 测试检查 decision 请求体包含 sentinel 用户规则；R6 PASS |
| R7 | 人类原话被逐条截到 4,000 字符但未标记；预算器看不到原始长度 | `EvidenceItem` 新增 `truncated`／`originalLength`；截断时同时设置 `evidenceTruncated` 和 `missing`；`MISSING_INPUT` 进入 chat 与 decision 输入；逐条来源与截断元数据保留在快照/审计中 | 快照测试使用 4,073 字符且末尾含限制的父/本会话证据；R7 PASS |
| R8 | 候选接受先 `await configEditor.edit()`，后写闭包中的旧 audit；重载后旧库已关闭，规则已生效却返回失败 | 候选接受改为读取运行时当前 audit；配置应用后状态写入失败不再把成功应用报成失败，返回 warning；增加幂等路径：规则已存在时直接结算候选为 accepted；候选状态更新使用重载后重开的 store | 生命周期夹具 R8 PASS；另在真实 DSH Web profile 中经 `/api/arbiter/suggestions/act` 接受候选：响应 `accepted`，配置出现新规则，SQLite 候选状态变为 accepted |
| R9 | 候选分析先过滤所有非 allow 结果，拒绝样本不进入分组；全放行条件成为过滤后的恒真 | 按同一命令族先纳入所有结果：允许计入 approved，非允许计入 rejected 并保留 denied call ids；只有 rejected=0、failed=0、无硬类别且 approved=occurrences 才生成候选；统计展示 rejected | 建议测试新增 3 次 allow + 1 次 human-deny；R9 PASS |

## 工程证据

```sh
mise exec -- pnpm verify
mise exec -- pnpm check:regressions
```

`verify` 顺序执行：typecheck → ESLint → Prettier → Knip → actionlint → **66 个 Vitest 单元测试** → tsc 构建 → esbuild 客户端构建 → 临时消费者检查 → **R1–R9 复现**。

真实 DSH 集成（未改由本轮重跑）：

```sh
cd validation/arbiter-integration/2026-10-21-arbiter-01
node scripts/run-case.mjs
node scripts/check.mjs
```

结果：14 个用例、146 项断言全部通过。修复后的 SQLite 容量清理、审计重开和配置 runtime 在该套件中没有引入回归。

评审复现原始结果已刷新为 `validation/codex-review/2026-10-21/results.json`，9/9 PASS。

## 剩余缺口

- **R3 的真实宿主在途热更新**：R8 已有真实 Web 候选确认回归；R3 仍是显式生命周期夹具，未在真实 DSH Loader 的模型等待、已形成结论、已弹人工三个边界上端到端验证。代码已按 `dsh-config-editor` 的 reconciliation 时序设计，但仍需真实 Web／headless 回归。
- **R5**：容量目标使用有效页估算并依靠 checkpoint／VACUUM 回收；多进程共享同一数据库、极端磁盘压力和物理空间统计的精度仍未验证。后台任务每小时执行，清理本身不是执行前置条件。
- **R1**：仍是保守 shell 读取器，不是完整 shell；`builtin cd`、函数、`eval`、复杂控制流等仍标记 partial 或未知，必要时转审查。`cd` 失败分支只做保守未知处理。
- **R6**：decision 收到共享语义，但两类后端的协议仍不同；没有真实 decision 网络调用，无法验证模型实际如何使用这些字段。
- **R7**：逐条人类证据上限仍是 4,000 字符；更大的历史依赖 token 预算裁剪，超预算路径现在保留真实估算并标记 `OVER_BUDGET`，但不会自动把超长待审动作转人工。
- **R8**：真实 Web 候选确认已通过；跨进程并发接受、模型／人工在途时的候选确认，以及状态写入长期失败后的补偿仍未验证。
- **R9**：拒绝样本进入统计后，候选仍需人工审核；没有真实历史样本验证候选接受率。

真实模型质量、真实人工审批 UI、浏览器点击、decision endpoint、子任务 deny／progress／父证据，仍按[首轮实施报告](implementation-report.md#6-仍需人工或外部服务验证)保留未验证。
