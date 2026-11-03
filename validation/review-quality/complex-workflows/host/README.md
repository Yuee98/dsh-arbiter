# CW-S09 隔离宿主连续行为验收

对应 [#126](https://github.com/Yuee98/dsh-arbiter/issues/126)，冻结设计及四份配套文档为 `f26cb073b10d597e48ed134a1ca2ed8e2f65b15f`。这是接线与行为证据，不是模型质量、人工标注或主数据评测成绩。

## 被测版本与执行环境

- 被测代码提交：`0ad0f43e502a5c7e4e116e218efa8071f53aa007`；运行前工作区无源码或测试改动。报告为后续独立文档提交，不冒充被测代码提交。
- 最初独立基线为 `9ae3a6a264ed9c536f93afa1bb3a0b081bf97214`；提交前同步到 `ef632237fe0203d53d6bfaf056fda810dcd3dc2a`。新增上游内容属于已合并的资源计划与 annotation 修复，不是本任务的额外交付。
- Node `v24.21.0`，DSH `0.2.1-rc.3`，`darwin/arm64`，Playwright Chromium，3 workers，retries=0。
- 宿主使用本工作树独立安装的锁定 npm CLI；agent 与 reviewer 均为本地受控 adapter，不访问真实模型或凭据。
- 每次命令在导入生产模块前设置独立外层 `DSH_HOME`。每例另有私有 profile、workspace、`DSH_AGENTS_HOME`；spill 保存在该 home 内，并禁用 SDK 对其他默认 spill roots 的启动清理。未使用日常 DSH。

Arbiter 配置为 `arbiter-config-v3`，boundary=guarded，main=ask / subagent=no-ask，Reviewer route=`arbiter-workflow-reviewer/workflow`。实际配置修订：问答与 timed ask `8f000845efc6`，审批四变体 `8326162d5a54`，父刷新 `bca632e47f02`，连续结果 `3725df57aa13`。各例的完整 profile、受控响应配置与对应 audit record 均保存在原始工件中；这些是既有配置修订，不是新增追踪或 hash 体系。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm verify` | PASS，exit 0 |
| unit | 110 文件 / 2231 passed |
| integration | 80 文件 / 862 passed |
| UI | 23 文件 / 382 passed |
| 完整 `pnpm test:e2e:dsh` | 76 passed / 0 failed / 0 skipped / 0 flaky，149.3 秒 |
| 原三项失败 | locale、trusted rollback、drain 均实际通过 |
| 宿主环境与清理 | 79 份 environment / 79 份 cleanup 全部成功，home 均已移除；216 项构建指纹全程一致且匹配当前构建；两个外层 home 为空；两份独占 boundary probe 均已删除 |

`verify` 包含静态检查、完整测试、构建、打包消费者和当前回归 S1–S3。现有脚本将旧原型 R1–R9 标为 retired；本报告没有将其记为运行通过。Coverage 由全量源码任务生成，不设置百分比门槛，也不将 coverage 数字作为行为验收结论。

原始完整基线为 63 passed / 3 failed / 0 skipped / 0 flaky。本次保留失败证据并修正根因，没有继承早期豁免。

## 九项工程 fixture 与验收映射

| 轨迹 / 数量 | 实际控制入口与因果证据 |
| --- | --- |
| 连续结果、迟到、失败后修复、预算、冷恢复 / 1 | 同一任务真实提交并发 slow 与 before；文件 barrier 保持 slow 未返回时捕获实际 before wire。释放后，真实 result 的 native seq 早于 after 调用，其 receipt、存储正文与实际 after wire 对应。真实工具异常返回后，agent 读取该错误并自动提交 repair。当前待审调用及其未来结果不进入自身 prefix；旧 snapshot/wire 不变。 |
| 主动询问，肯定与否定 / 2 | P1 是真实未获许可的复制调用，经过生产 review-deny 并结算失败，目标 ENOENT；随后才出现原生问题。UI 答案绑定原 callId 与 `sample-only`。肯定分支自动提交参数相同的 P2 并成功复制 sample，再真实尝试范围外 P3，独立被拒绝；否定分支不产生获准复制。没有用另一次人工 RUN 代替续行。 |
| 审查升级后批准一次 / 1 | 固定 R/A 经生产矩阵触发 review-escalate；答前无 C 执行或成功结果。原生 UI 批准后 C 只执行一次，C 不重复送审；实际结果回到后继 D，D 独立审查/审批并被 UI 拒绝。 |
| 审查升级后拒绝 / 1 | 原生 UI 拒绝，最终 human-deny，实际失败结果，无 C/D 文件效果。 |
| 无答后中止 / 1 | 真实审批保持 pending 时证明未执行；SDK 审批接管 composer，此时没有 Stop 按钮，使用同一原生 `session/cancel` RPC 取消实际 agent。最终 human-abort，区别于 human-deny。此取消入口是宿主 RPC，不冒充 UI Stop 点击。 |
| 真正无审批答复通道 / 1 | 独立 profile 不加载 `api-remotes` 答复通道，使用原生 session RPC 创建、启动并接管实际任务。真实 SDK 写出 `approval/asked` / `approval/decided(outcome=unavailable)`，生产链最终 fallback-deny，无物理执行。仅断开浏览器会保留 pending，因此没有把“没人回答”当成 unavailable。 |
| timed ask 无答、继续与迟答 / 1 | 只在此隔离 profile 中给现有 `tool-ask-user` 配置 timed/timeout=1。真实 pending result 不是 `answers=[]`，agent 自动完成独立检查；continued 卡片收到 UI 迟答后，宿主以 `user-question-reply` / `answer_to_pending_question` 在新 turn 自动续行。后继 wire 有真实问题/答案绑定，旧视图不回填。 |
| 父原始限制、局部例外、撤回 / 1 | 真实 subagent 在步骤间暂停；父会话 UI 分别输入局部例外与撤回，再释放子任务。三个 child review 的直接父 cutoff 严格递增，各自实际 wire 分别反映当时输入；同宿主无关会话不混入，旧视图不变。初始委派为 relay，父人类原文为 parent-human。 |

以上合计 **9 项新增工程 fixture**。预设 R/A 只驱动生产矩阵与状态机；它不证明模型理解了限制、例外或自然语言范围，也不计为九个独立业务质量样本。

## 热冷投影、结果可用性与截断

结果轨迹中真正停止并重启同一 CLI/profile，验证实际 receipt 与存储来源恢复。另从真实 zstd 会话文件的相同 native cutoff、同一 pending 输入和实际 SQLite receipt，分别在热模块与独立冷 Node 进程重新调用**已构建生产** `prepareReviewSnapshot`。父子轨迹还同时固定 child 与直接 parent 的 cutoff。新热 prefix 与原实际 snapshot 一致；新热/冷 bundle 的事件身份、顺序、结果状态、绑定、completeness、渲染和预算完全相等，仅将新建时间 `snapshot.createdAt` 归一化。

这部分是“真实宿主文件/receipt → 生产投影”的集成证明；独立 Node 文件适配器不冒充恢复一个可交互的 child agent。实际 CLI 重启的生命周期证明另由结果轨迹提供。它没有只比较旧 snapshot 的序列化副本。

默认 T=6000、H=10000，单条工具单元 C 为剩余容量与 T/10 的较小值，本轨迹实际为 600。长结果的实际存储正文大于 64 KiB，并保留 SDK 返回的完整结构化值；宿主自己的格式化内容可含 spill 省略与引用，报告将该格式化层与存储层区分。实际 reviewer 只收到带原 call/receipt 身份的预算片段，单元记录 truncated。既有 context-budget-effect 宿主对照与 #124 测试继续覆盖固定 H 下修改 T 的行为，没有新增组合测试平台。

在来源不变的热冷相等之后，停止宿主，再删除该私有 profile 中一份实际正文文件。新投影保持原结果身份与已发生的 success 状态，但正文明确为 unavailable/lost，collection.read=missing-file；没有将丢失当作 empty 或重新解释为未执行，旧持久 snapshot 仍保持不变。存储失败/空结果/unsupported 等其余故障组合复用 #122 已有集成与宿主测试。

## 修复的生产接缝与原基线问题

1. Rules 页拥有已消费的测试请求 nonce，RuleTest 真正处理请求时回执。重挂载不重放旧请求；非零首次未消费请求、以后新请求、recorded seed 与焦点行为均保留。两套 RTL 42 项通过，并保留改前失败回归证据。
2. 原 sandbox 负向目标位于 SDK 明确允许的 temp roots。新探针读取锁定 SDK 的实际 writableRoots，校验 canonical 路径，普通测试进程先写读其独占 0700 目录。trusted 阶段真实可写；rollback 后 temp 正向 control 仍可写，真正范围外目标 ENOENT。drain 等待本次 callId 的实际 result 与所属 turn/end，继续核物理效果、rollback 和 dispatch 位于 drain 窗口。
3. 锁定 SDK 将 subagent 初始委派记录为 source.kind=user。新适配只在原生 origin/parent 已知、完整且连续的 own 初始前缀可识别时捕获该事件身份，并在读保护前冻结为 relay。读取器入口、fallback、父来源与 redaction/rebuild 接线同义；截断或内部缺口不猜第一条可见消息，后续真实人类/原生 ask 保留。对应集成测试还验证 rebuild 不重新读取移动来源。
4. locale 泄漏检查检查可见界面文案，原样模型/审计 `<pre>/<code>` 内容单独逐值比较。原协议中合法的英文单词 `undefined` 不再被当成翻译错误；原始材料和响应的语言往返一致性断言保留。

## 证据定位与边界

本轮真实 SDK 与边界探针使用锁定 npm CLI；独立打包可执行版没有本轮运行证明。

受版本控制的主要用例：[结果](../../../../tests/e2e/workflow-results.spec.ts)、[问答](../../../../tests/e2e/workflow-questions.spec.ts)、[审批](../../../../tests/e2e/workflow-approval.spec.ts)、[父刷新](../../../../tests/e2e/workflow-parent.spec.ts)、[来源捕获回归](../../../../tests/integration/initial-delegation.test.ts)。

本任务最终运行与九项轨迹的原始证据在本次工作树本地目录 `.local/cw-126/final/`，包括 `verify.log`、`e2e.log`、`results.json`、逐例 environment/cleanup/fingerprint、native-sessions、实际 agent/reviewer request、完整审计记录、profile 配置、hot/cold/source-loss projection 与 proof.json。执行者工作树为 `/private/tmp/dsh-arbiter-cw-126`。这些大工件为 **local-only**，没有上传到仓库；GitHub 上的此报告不是原始日志附件链接，也不以本地路径冒充可下载证据。

需要复查原始数据时，应在执行者环境读取上述目录；没有该目录的评审者可以按受版本控制的测试复跑。正式 PR 的当前准确 head 还须完成线上 CI 与开发评审；本报告只记录上述被测代码和本地执行事实。没有调用业务模型、编辑主数据、收集新人工意见或测量业务质量。
