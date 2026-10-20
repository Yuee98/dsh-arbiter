# dsh-arbiter

面向 DSH 的独立权限与自动审查插件，将 permission rules 与 auto review 放在同一套产品中。Codex 侧的个人工作流是最初的灵感，当前目标已扩展为完备的独立产品。

状态：产品处于需求与设计阶段，已建立 TS/Node 工程骨架，尚未接入 DSH 或实现产品功能。

## 从这里开始

| 阅读目的                               | 文档                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| 统一术语、规则分类与判定阶段           | [产品术语](docs/terminology.md)                         |
| 比较三档策略、主／子任务设置与配置生效 | [审批模式与审查策略](docs/approval-modes.md)            |
| 了解产品目标、现有范围与边界           | [产品需求](docs/requirements.md)                        |
| 了解执行链、审批模式与子 agent         | [总体架构](docs/architecture.md)                        |
| 理解命令规则、优先级和规则沉淀         | [规则引擎](docs/rules.md)                               |
| 理解授权证据、历史与输入预算           | [审查上下文](docs/review-context.md)                    |
| 理解模型接口与最终判定                 | [审查后端与判定引擎](docs/reviewer.md)                  |
| 了解配置体验、规则测试和记录           | [配置、规则测试与审计](docs/configuration-and-audit.md) |
| 查看计划和需要实测的假设               | [实施与验证](docs/implementation.md)                    |
| 继续产品讨论或追溯方案变化             | [决策与待讨论问题](docs/decisions-and-questions.md)     |
| 核对宿主约束、技术来源和生态背景       | [调研证据](evidence.md)                                 |

首次阅读建议：产品需求 → 总体架构 → 决策与待讨论问题。进入具体设计时，再阅读对应专题。

## 初版方案概览

- 一个插件统一处理确定性规则与模型审查，规则路径先于审查路径。
- 命令规则使用 AST 解析与 exact／RE2／glob 匹配，完整顺序为 `deny > force-ask > force-review > allow > review(default)`；最后一项是默认审查入口。
- reviewer 显式选择 decision 或 chat；模型提供风险、授权与四个探针信号，代码负责最终裁决，不自动切换后端。
- 审查采用无状态单次调用，快照区分授权证据、历史、先前裁决与 AST 事实。
- trusted／guarded 控制执行边界；normal／strict 共用常规审查策略，strict 不新发起插件人工审批，progress 调整部分条件扩大代批。审批模式不限制 agent 使用 ask；主会话与全部子任务分别配置，子任务只提供 strict／progress。
- chat／decision 使用统一授权标准；具体判定条件、阈值及恢复参数留待评测，日常优先通过命令规则处理特定命令，高级设置作为独立入口建议。
- 配置 UI 与文件要求功能一致；提供规则测试和审计；离线日志分析生成候选，经独立界面人工审核后作为普通规则加入列表。

以上是讨论基线，尚未经过实现验证。当前以“审批模式”替代 DND 的总称；具体策略条件、可编辑范围及部分权限边界仍有[待收敛项](docs/decisions-and-questions.md#product-discussion)。

## 文档状态与维护

- 产品定位及[已确认的规则契约](docs/decisions-and-questions.md#confirmed-rule-contract)已同步到正文；其余产品建议保留“待讨论”状态。
- 原稿 O1、O3、O4、O6 与 O10 的方案已收敛；其他问题及运行时验证见对应文档，不再统一称为“十个未解决问题”。
- 技术内容各有一份专题正文；历史决定解释理由，证据记录来源，实施清单跟踪验证，避免多处维护同一套规范。
- [design.md](design.md) 保留为设计导航与旧节号索引；[原始文档快照](docs/archive/) 只供追溯。

包名 `dsh-arbiter`，插件行 id `arbiter`，数据目录 `$DSH_HOME/arbiter/`，斜杠命令 `/arbiter`。初稿目标运行时为 DSH desktop 0.2.1-rc.2（macOS）。

## 开发与验证

当前仅有一个临时 dummy 导出及对应测试，用于验证 TypeScript、Node ESM、测试运行器和 CI。包暂设为 private；初始化阶段的 Node 版本约束只描述开发基线，产品的宿主兼容范围在后续接入时确定。

使用 mise 固定 Node 24.21.0、pnpm 11.7.0 和 actionlint 1.7.12；CI 使用同一份 `mise.toml`。

```sh
mise trust
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm verify
```

| 命令                   | 检查内容                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `pnpm typecheck`       | 严格检查源码、测试、脚本与 JS/TS 工具配置                      |
| `pnpm lint`            | 类型感知 ESLint，零警告，禁止行内禁用与 focused/disabled tests |
| `pnpm format:check`    | 检查格式；`pnpm format` 单独执行格式化                         |
| `pnpm check:unused`    | Knip 检查未使用文件、导出与依赖                                |
| `pnpm check:workflows` | actionlint 检查 GitHub Actions 工作流                          |
| `pnpm test`            | 执行 dummy 测试，禁止 only、空测试运行与自动重试               |
| `pnpm build`           | 清理旧 `lib/` 后，使用 tsc 输出 ESM JS 和声明文件              |
| `pnpm check:build`     | 构建后在临时消费者中验证 Node 导入与声明文件正／反例           |
| `pnpm verify`          | 顺序执行以上全部检查、测试和构建                               |

辅助脚本使用 Node 原生 TypeScript。`check:build` 通过临时链接消费构建产物并自动清理临时目录，不执行 npm 发布或 DSH 安装。测试尚不设置覆盖率门槛。

依赖保留至少一天的发布冷却期；安装不会自动添加冷却期例外。运行检查前若依赖与配置或 lockfile 不一致，pnpm 直接报错，需先显式安装依赖。

现有设计专题、归档与 `validation/` 宿主验证资料保留原样，不纳入本次工程的格式、Lint、类型与 Knip 检查。构建只包含 `src/`；`lib/`、依赖目录与测试产物不提交。

CI 在所有 PR、main 推送和手动触发时运行单个 `Verify` job。Dependabot 每周检查 npm 开发依赖和 Actions 更新，通过 PR 验证，不自动合并。GitHub 仓库建立后，可将 `Verify` 设为分支必需检查；分支保护与密钥保护属于仓库设置，不会由工作流文件自动启用。
