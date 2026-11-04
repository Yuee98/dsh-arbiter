# #134 首四根资源预演证据

2026-11-03；当前工程基线为已验收 main `f63cf7022550528e07319a62ff9775ecaebd3c60`。外部 W06 首四根来源 `1f191bae66e5dd08172d51f26afdca94abbfa712`，尚未合入 main，实际源 Git clean 且四个 workflows.json 与该提交逐字一致。只做离线构建，无被测模型派发、无模型标注答案、无人工参考。完整具体方案及原样复核命令见[资源计划](../../../../evals/plans/cw-134-first-four.md)。

正式 `workflow.points/resource` 计划使用 4 根 20 点的 primary main view、dev/workflows-v1、references:false，明确禁用项目规则且 customRules 为空。实际 runner 配置 revision `0617ca75`，由现有 `workflowExecutionOf` 取得完整配置、代码/源 Git 信息；材料经 `loadWorkflowSources/sourceMaterial` 到生产共用 builder。40 份 chat/decision 材料没有新增独立样本。所选 clef-local/decision 共 20 supported cells、0 unsupported，最多 20 attempts；初始估计输入 88,668，chat 诊断合计 86,848；单次 H=10,000、累计保守估计输入 200,000。输出、provider 计费 token 和金额未知，不填零。

| point | chat估计输入 | decision估计输入 | decision截断段 | blocking gaps |
| --- | ---: | ---: | --- | --- |
| cw135-001-p01 | 3176 | 3267 | 无 | 无 |
| cw135-001-p02 | 3436 | 3527 | 无 | 无 |
| cw135-001-p03 | 3781 | 3872 | 无 | 无 |
| cw135-001-p04 | 4073 | 4164 | 无 | 无 |
| cw135-001-p05 | 4469 | 4560 | 无 | 无 |
| cw135-007-p01 | 3497 | 3588 | 无 | 无 |
| cw135-007-p02 | 3909 | 4000 | 无 | 无 |
| cw135-007-p03 | 4242 | 4333 | 无 | 无 |
| cw135-007-p04 | 4496 | 4587 | 无 | 无 |
| cw135-007-p05 | 4708 | 4799 | 无 | 无 |
| cw135-013-p01 | 4628 | 4719 | CONTEXT | 无 |
| cw135-013-p02 | 5380 | 5471 | CONTEXT | 无 |
| cw135-013-p03 | 5561 | 5652 | CONTEXT | 无 |
| cw135-013-p04 | 5864 | 5955 | CONTEXT | 无 |
| cw135-013-p05 | 5892 | 5983 | CONTEXT | 无 |
| cw135-017-p01 | 3316 | 3407 | 无 | 无 |
| cw135-017-p02 | 3697 | 3788 | 无 | 无 |
| cw135-017-p03 | 3960 | 4051 | 无 | 无 |
| cw135-017-p04 | 4243 | 4334 | 无 | 无 |
| cw135-017-p05 | 4520 | 4611 | 无 | 无 |

`pnpm evals:plan evals/plans/cw-134-first-four.json` 与 `pnpm evals run evals/plans/cw-134-first-four.json --dry-run` 实际 exit 0，逐格报告正式 workflow 身份、预算、截断、缺口及 conservative ceiling。未执行 live run，预留 `resource.runDirectory` 不存在。JSON 的 live transport 与旧路由 `costTier:free` 不证明实际可用、免费或已授权。缺目标、缺数据、未知 point 和相对 resource 目录由真实 schema/semantic/source checker 拒绝。

## 与原证据的关系

原 5a7fca1 基线/4cfc 源/旧复核日志保留历史，原 CLI 的 legacy loader 拒绝不再作为当前能力结论。W06 1f191bae 窄修了旧配置 hash 误用，其 enabled/no-file 材料 revision 为 ed0fff70、预算 chat87,309/decision89,129；四份源文档相对4cfc没有变化。本次正式 runner 显式 disabled 的配置与有效输入不同，使用新重算数 86,848/88,668，不把源相同解释为 request/fingerprint 相同，不把旧 revision 倒灌新材料。

CW134-P01/P02 原真实缺口已由 #176 的已合并代码提供：正式 workflow 点/视图/材料接线，以及固定单绝对目录范围下的 claim、records/abandonment 重读、未知在途保守扣额、别名与换目录拒绝。资源文档不再称这两项“待接线”，也不声称新增全局多目录额度平台。当前只接纳已验收主线，不在 #134 修改 runner/schema/CLI。

## 验证与剩余门

独立运行文档原样复核命令，40 份材料、四份源字节、20 格/20 attempts/200,000 上限、实际 sourceGit 与配置、缺目标/数据/point/相对目录负向拒绝均通过。7 文件144项现有 runner/资源/输入/并发/续跑 unit 回归通过；完整 `pnpm verify` 在新临时 DSH_HOME、允许 loopback 测试的执行环境中 exit 0，unit2215/integration800/UI380，以及静态检查、check:evals、构建消费者和当前回归均通过。原 2文件114tests、2050 unit/638 integration/366 UI 是旧基线结果，未作当前通过证据。

本机原始证据仅在 `.local/cw-134/current-plan.log`、`current-dry-run.log`、`current-audit.json/log`、`current-focused.log`、`verify-current.log` 及原始历史记录，未作为远端附件发布。所有生产 import 与验证前使用外层临时 DSH_HOME；未访问日常 DSH，未探测端点、读取/创建凭据，未调用模型或实际标注服务。没有宿主加载/UI/生命周期改动。

另行复核 CW134-B03：纯构建 API 逐点比较现行标注 `buildAnnotationView` 与正式 runner 的实际 binding，结果为 0/20 匹配。现标注 context 不能表达 runner 的显式 disabled 规则状态；不能把同 pointId 当同一有效材料或将意见误计入 S2 参考。Root 已交独立 #185 修复接口；实际转交/参考评价前须接纳修复并重跑20点匹配，未满足前保留工程前置门，不在本三文档分支修改生产者或宣称 B03 已关闭。原始本机证据 `annotation-alignment.mjs/json/log`，未调用导出/导入服务、登记意见或生成标签。

仍待：四个参与模型的人类渠道/实际身份、真实题本转交许可、S2 clef-local 当前可用性/版本/费用、输出及总计费 token 硬限制能力或明确可接受范围、具体真实运行授权。#127 导出/导入、#128 网页和 #129 报告能力已合入 main，工具存在不等于已经取得人工意见或正式参考。20点只是首阶段外部源，不冒充正式全量数据已就绪；#137 后续端到端验收未在此宣告。issue #134 的取得适用运行授权门仍未完成，保持 OPEN。
