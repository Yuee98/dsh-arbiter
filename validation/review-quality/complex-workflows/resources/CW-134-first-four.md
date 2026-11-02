# #134 首四根资源预演证据

2026-11-02；工程基线 `5a7fca11ae91a5d6912512bd7d44c09d599f3cbc`，W06 来源 `4cfc13a1bdac29176c6170273c20782c6813f6fa`，未合入 main。仅离线构建，无被测模型派发、无模型标注答案、无人工参考。完整计划及可复现命令见 [资源计划](../../../../evals/plans/cw-134-first-four.md)。

实际核对四份源文件与 W06 固定提交逐字一致，再通过 `readGroupedDataset`（显式 dev/workflows-v1/references:false）、`workflowMaterial` 和既有 `cellGrid/attemptCeilingOf` 重建。4 根 20 点、40 份 chat/decision 诊断材料；所选 clef-local/decision 共20 supported cells、0 unsupported，最多20个attempt。所选 decision 估计输入89,129，chat诊断合计87,309；保守累计估计输入200,000。provider计费tokens、输出及金额未知，不填0。

| point | chat估计输入 | decision估计输入 | decision截断段 | blocking gaps |
| --- | ---: | ---: | --- | --- |
| cw135-001-p01 | 3200 | 3291 | 无 | 无 |
| cw135-001-p02 | 3460 | 3551 | 无 | 无 |
| cw135-001-p03 | 3805 | 3896 | 无 | 无 |
| cw135-001-p04 | 4097 | 4188 | 无 | 无 |
| cw135-001-p05 | 4493 | 4584 | 无 | 无 |
| cw135-007-p01 | 3521 | 3612 | 无 | 无 |
| cw135-007-p02 | 3933 | 4024 | 无 | 无 |
| cw135-007-p03 | 4266 | 4357 | 无 | 无 |
| cw135-007-p04 | 4520 | 4611 | 无 | 无 |
| cw135-007-p05 | 4732 | 4823 | 无 | 无 |
| cw135-013-p01 | 4649 | 4740 | CONTEXT | 无 |
| cw135-013-p02 | 5401 | 5492 | CONTEXT | 无 |
| cw135-013-p03 | 5582 | 5673 | CONTEXT | 无 |
| cw135-013-p04 | 5885 | 5976 | CONTEXT | 无 |
| cw135-013-p05 | 5909 | 6000 | CONTEXT | 无 |
| cw135-017-p01 | 3340 | 3431 | 无 | 无 |
| cw135-017-p02 | 3721 | 3812 | 无 | 无 |
| cw135-017-p03 | 3984 | 4075 | 无 | 无 |
| cw135-017-p04 | 4267 | 4358 | 无 | 无 |
| cw135-017-p05 | 4544 | 4635 | 无 | 无 |

现有 `pnpm evals:plan evals/plans/cw-134-first-four.json` 的真实结果为 exit 1，逐点 `unknown legacy caseId`。这证明当前 workflow point/view runner 尚未接线，不能将资源JSON当作已可派发实验。root 已将正式 runner 接线拆为独立工程 [#176](https://github.com/Yuee98/dsh-arbiter/issues/176)，本分支不修改 runner/schema/CLI。资源文档中的只读重建命令已逐字执行成功，其 `dispatchAllowed=false` 仅描述本计划未授权状态，不是通用运行授权系统。

缺目标配置、缺数据目录和不存在的 point 已分别由真实 schema/semantic checker、group reader 和 workflowMaterial 负向校验拒绝，未构造 backend，未派发请求；原始结果见 `negative-dry-run.json`。

现有行为回归：`pnpm exec vitest run --project unit tests/evals/run-bounded.test.ts tests/evals/run-cli.test.ts`，2文件/114测试通过；覆盖预算不足停止、并发预留、补答计数、续跑扣已耗、超时/未知在途保守占额、逐请求输入超限、缺配置及只读CLI。未新增生产行为，不添加镜像或占位测试。首次误选 integration 项目得到 no test files/exit1，纠正后真实运行上述unit项目，不将空项目计通过。

`pnpm check:evals` 通过。完整 `pnpm verify` 在新临时 DSH_HOME、本机正常权限下 exit 0 通过；包括 unit 2,050、integration 638、UI 366，以及静态、构建消费者和当前范围回归。首次 sandbox 运行在 localhost 集成连接连续超时后终止（exit 130），其失败日志保留，不计通过；未影响宿主加载/UI/生命周期，因此无新宿主 E2E 要求。所有验证入口外层使用 mkdtemp DSH_HOME；未访问日常 DSH 日志/配置，未探测目标端点，未读取/创建凭据。

本机原始证据位于 `/private/tmp/dsh-arbiter-cw-134/.local/cw-134/`：`dry-run.json`/`dry-run.log`、`doc-dry-run.log`、`legacy-loader-refusal.log`、`runner-regressions-unit.log`、`check-evals.log`、`negative-dry-run.json`、`verify-sandbox.log`、`verify.log`。这些 ignored 工件只在本机可读，尚未上传为远端附件；本文提交可供远端复核结论，原始文件不冒充 GitHub 链接。Relay原始提交/结果及正式绑定也保留同目录。

Relay Plan R1 返回 CORRECT：CW134-P01 正式接线由 root 拆至 #176；CW134-P02 指出现有 runner 只扣同 run 消耗，跨 run 对账尚非不可绕过的入口检查，阻止真实多 run 就绪但不阻离线准备。当前资源候选限定唯一预留 run 目录且不允许拆 run，不把人工对账写成机器强制。root 已将 P02 的入口累计检查及不确定在途保守预留归入 #176，实际派发前必须闭合；当前不标成代码已修。

待确认：实际标注人类渠道与模型身份；#128人工盲标/复核就绪；S2目标当前可用性/模型版本/费用；输出及总计费token硬限制能力或可接受范围；完成 #176 的正式 workflow runner 接线；取得适用真实调用授权。issue #134 尚未全部完成，不关闭。
