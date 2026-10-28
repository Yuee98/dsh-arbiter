# 审查质量与评测：任务图发布记录

状态：ISSUE_GRAPH_PUBLISHED。这里只记录规划和任务图发布；产品实现、用户标注及真实评测尚未执行。

- [Milestone #2](https://github.com/Yuee98/dsh-arbiter/milestone/2)：审查质量与评测：统一评分、策略与规则体验
- Parent：[#64](https://github.com/Yuee98/dsh-arbiter/issues/64)，兼任整体交付 tracker。
- [正式方案](review-quality-and-evals.md)与[评分量表](review-quality-rubrics.md)。
- 发布权威版本：[42b48c4d8514d727e8c1d77a8a0826d759f1b21e](https://github.com/Yuee98/dsh-arbiter/blob/42b48c4d8514d727e8c1d77a8a0826d759f1b21e/docs/milestones/review-quality-and-evals.md)。
- 本文为发布后的索引与回执，不改变已审查的方案或 issue 语义。

## 结构与执行顺序

采用 compact：一个 parent 协调共同契约、两个集中人工窗口和整体接受条件，所有叶子直接归属它。没有另设 tracker。准备阶段新建 milestone 和 parent，图发布阶段复用该 parent 并新建 23 个叶子；全图共 24 个 issue、23 条原生父子关系、32 条原生阻塞关系。

基础契约先行，数据、生产接线和规则体验按接口就绪并行；真实评测等待标签与运行资源，最终默认与保留集验收等待第二窗口。依赖由 GitHub blocked-by 表达，编号不表示全局串行。

| 稳定 ID | GitHub issue | 交付结果 | 直接前置 |
| --- | --- | --- | --- |
| RQ-01 | [#65](https://github.com/Yuee98/dsh-arbiter/issues/65) | 建立共用十档评分、N0 归一化与判定核心 | 无 |
| RQ-02 | [#66](https://github.com/Yuee98/dsh-arbiter/issues/66) | 重构当前 turn 材料、跨 turn 授权与 M0 完整性处理 | [#65](https://github.com/Yuee98/dsh-arbiter/issues/65) |
| RQ-03 | [#67](https://github.com/Yuee98/dsh-arbiter/issues/67) | 实现共用语义的新版 prompt 与 chat/decision 适配 | [#65](https://github.com/Yuee98/dsh-arbiter/issues/65)、[#66](https://github.com/Yuee98/dsh-arbiter/issues/66) |
| RQ-04 | [#68](https://github.com/Yuee98/dsh-arbiter/issues/68) | 将运行链切换到新版评分和 ask/无 ask 模式 | [#67](https://github.com/Yuee98/dsh-arbiter/issues/67) |
| RQ-05 | [#69](https://github.com/Yuee98/dsh-arbiter/issues/69) | 删除旧配置版本与模式兼容路径 | [#68](https://github.com/Yuee98/dsh-arbiter/issues/68) |
| RQ-06 | [#70](https://github.com/Yuee98/dsh-arbiter/issues/70) | 删除旧审计迁移、兼容读取与日志修复工具 | [#68](https://github.com/Yuee98/dsh-arbiter/issues/68) |
| RQ-07 | [#71](https://github.com/Yuee98/dsh-arbiter/issues/71) | 提供限定范围的旧测试数据重置工具 | [#70](https://github.com/Yuee98/dsh-arbiter/issues/70) |
| RQ-08 | [#72](https://github.com/Yuee98/dsh-arbiter/issues/72) | 建立 evals 数据契约与标注导出回填工具 | [#65](https://github.com/Yuee98/dsh-arbiter/issues/65) |
| RQ-09 | [#73](https://github.com/Yuee98/dsh-arbiter/issues/73) | 构建覆盖评分、授权及上下文边界的待标注数据集 | [#72](https://github.com/Yuee98/dsh-arbiter/issues/72) |
| RQ-10 | [#74](https://github.com/Yuee98/dsh-arbiter/issues/74) | 实现复用生产 reviewer 的有界评测运行器 | [#67](https://github.com/Yuee98/dsh-arbiter/issues/67)、[#72](https://github.com/Yuee98/dsh-arbiter/issues/72) |
| RQ-11 | [#75](https://github.com/Yuee98/dsh-arbiter/issues/75) | 实现三层评测报告与逐例对比 | [#74](https://github.com/Yuee98/dsh-arbiter/issues/74) |
| RQ-20 | [#76](https://github.com/Yuee98/dsh-arbiter/issues/76) | 实现原始响应归一化与策略的离线回放 | [#75](https://github.com/Yuee98/dsh-arbiter/issues/75) |
| RQ-12 | [#77](https://github.com/Yuee98/dsh-arbiter/issues/77) | 简化规则编辑并显示匹配范围和最终路径 | 无 |
| RQ-13 | [#78](https://github.com/Yuee98/dsh-arbiter/issues/78) | 支持从真实调用创建可测试的规则草稿 | [#77](https://github.com/Yuee98/dsh-arbiter/issues/77) |
| RQ-H1A | [#79](https://github.com/Yuee98/dsh-arbiter/issues/79) | 窗口一：用户组织多模型标注并提交最终参考答案 | [#73](https://github.com/Yuee98/dsh-arbiter/issues/73) |
| RQ-H1B | [#80](https://github.com/Yuee98/dsh-arbiter/issues/80) | 窗口一：确定评测模型、可用服务与整体运行预算 | [#74](https://github.com/Yuee98/dsh-arbiter/issues/74) |
| RQ-14 | [#81](https://github.com/Yuee98/dsh-arbiter/issues/81) | 准备无探针/可撤回性与 prompt/cache 对照实验 | [#74](https://github.com/Yuee98/dsh-arbiter/issues/74) |
| RQ-15 | [#82](https://github.com/Yuee98/dsh-arbiter/issues/82) | 运行真实试点与校准对照并形成推荐报告 | [#76](https://github.com/Yuee98/dsh-arbiter/issues/76)、[#81](https://github.com/Yuee98/dsh-arbiter/issues/81)、[#79](https://github.com/Yuee98/dsh-arbiter/issues/79)、[#80](https://github.com/Yuee98/dsh-arbiter/issues/80) |
| RQ-H2 | [#83](https://github.com/Yuee98/dsh-arbiter/issues/83) | 窗口二：集中裁决候选方案与最终验收条件 | [#82](https://github.com/Yuee98/dsh-arbiter/issues/82) |
| RQ-16 | [#84](https://github.com/Yuee98/dsh-arbiter/issues/84) | 接入已选默认 prompt、策略与候选设置 | [#68](https://github.com/Yuee98/dsh-arbiter/issues/68)、[#83](https://github.com/Yuee98/dsh-arbiter/issues/83) |
| RQ-17 | [#85](https://github.com/Yuee98/dsh-arbiter/issues/85) | 在独立保留集验证最终候选并归档真实证据 | [#84](https://github.com/Yuee98/dsh-arbiter/issues/84) |
| RQ-18 | [#86](https://github.com/Yuee98/dsh-arbiter/issues/86) | 按限定清单执行旧 Arbiter 测试数据重置 | [#71](https://github.com/Yuee98/dsh-arbiter/issues/71)、[#84](https://github.com/Yuee98/dsh-arbiter/issues/84) |
| RQ-19 | [#87](https://github.com/Yuee98/dsh-arbiter/issues/87) | 完成新版宿主集成验收与 milestone 交付报告 | [#69](https://github.com/Yuee98/dsh-arbiter/issues/69)、[#70](https://github.com/Yuee98/dsh-arbiter/issues/70)、[#78](https://github.com/Yuee98/dsh-arbiter/issues/78)、[#85](https://github.com/Yuee98/dsh-arbiter/issues/85)、[#86](https://github.com/Yuee98/dsh-arbiter/issues/86) |

## 两段集中人工窗口

1. 数据与运行准备：[#79](https://github.com/Yuee98/dsh-arbiter/issues/79) 由用户组织独立模型标注、作最终裁决并记录进 repo；[#80](https://github.com/Yuee98/dsh-arbiter/issues/80) 同期确定被测模型、服务与整体预算。已就绪的规则体验一并试用，agent 在此期间继续独立工程。
2. 结果与验收收口：[#83](https://github.com/Yuee98/dsh-arbiter/issues/83) 集中决定默认候选、真实取舍及验收线，处理剩余争议和体验反馈；随后按冻结标准完成保留集和工程验收。

第一窗口的试标与后续批次临近安排。预算内迭代无需逐轮确认；正常交付不再安排第三次方案确认。

## Relay 审查与发布证据

- Workflow：milestone-to-issue-graph；mode：auto；workflowId：`dsh-arbiter-review-quality-20261028`。
- Relay 指令源版本：`d8c1f22dc26f8c5dd2b19c0a0bf8b7a5ae82684e`。
- 固定 session：`sr_ed05bad0-065a-4b64-9d10-99e7a0f36e39`；conversation：`6ae1b06d-9fac-83ea-a04e-7860712c5772`。
- compact-graph 共使用 2/3 轮内容审查，未重置预算。

| 轮次 | Relay task | Verdict | 处理 |
| --- | --- | --- | --- |
| 1 | `4f537a92-3405-4f4a-9e35-cb2328c2cd1a` | NOT_READY | 接受 CMP-001，拆分报告与回放并修订依赖；同时处理三项非阻塞意见。 |
| 2 | `21c5b496-7805-4ab1-9498-32dcdef75ab7` | COMPACT_GRAPH_READY | agent Decision：CONTINUE；无未解决的已核实阻塞项，冻结内容并发布。 |

- 首轮 reviewDigest：`257dc6340a8b3c51079be87ab80dca249f6dde1db8f8003e02c2a2f902413c7f`。
- 最终 reviewDigest：`75647952817d911354f2a9465efbf345eb4f6a309f16bfa527680c8d9b383bb3`。
- materializationDigest：`580117adccfecf340a1dd1661118af380fa7e0cbc5286274b5f9f2b8d43e056c`。
- issue 编号代入仅使用冻结清单中已声明的替换，所有最终正文均与审查来源建立哈希关联。
- final-remote-graph：not-required。compact 已完成全内容审查和确定性远端回读，没有另行要求独立发布审查；无虚构的第三个 Relay task。
- 两轮均请求并选中 pro，无 fallback。回复后的 effort 核验返回 HTTP 404，状态 unknown；按普通工作流记录非阻塞警告，不能声称实际回复 effort 已核实。

## 远端回读与关闭状态

- 核验完成时间：2026-10-28T08:58:47.827Z（UTC）。状态：PASS。
- 定向回读：2026-10-28T08:59:25.625Z，milestone 方案链接已机械更新到最终审查版本，描述及完整 24 项成员集合再次核对通过。
- 精确核对 24 个 issue 的标题、正文、marker 唯一性、milestone、open 状态及原生 type；个人仓库不提供 issue type，保持未设置。
- 完整分页读取父子、blocked-by、反向 blocking 和 milestone 成员；23 条父子边与 32 条阻塞边完全匹配，无额外关系，DAG 本地检查通过。
- 每次创建先记录唯一 intent 与正文哈希，已确认身份后直接回读；所有 23 个叶子创建及完成评论都有确定身份，未遗留结果不明的创建。
- 原生关系逐次写入并验证增量，既有对象写入前检查漂移；正文与 milestone 成员集合未发现冲突。
- [完成评论](https://github.com/Yuee98/dsh-arbiter/issues/64#issuecomment-6464854546)已发布并按 ID、全文哈希回读；parent 仍为 open。
- compact parent 是交付 tracker，发布时关闭不适用。所有叶子与 milestone 均保持 open，后续关闭需要实际验收和相应授权。

## 工程验证与后续边界

- 正式文档初版 e81a406 执行 pnpm verify，通过 735 项单元、412 项集成、294 项 UI 测试及其余必需检查。后续 42b48c4 仅拆分任务说明，git diff --check 通过。
- 此次为文档／任务图变更，无宿主、UI 或生命周期实现变化，因此未运行 DSH E2E。后续相关实现任务仍须执行隔离 DSH E2E。
- 当前 UI 开发工作区未改动；方案位于 codex/review-quality-milestone 分支，发布任务图没有创建或合并 PR。
- 无未解决的发布权限问题。模型服务、标注结果、预算与验收数值按两段窗口确定，尚未执行真实模型调用或实际旧数据删除。
- 完整 manifest、冻结正文／哈希、两轮回复、finding ledger、receipt、分页回读和验证记录保存在本任务本地 .local/planning/review-quality-issue-graph/，不加入产品发布包。
