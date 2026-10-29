# evals：审查质量数据契约与标注工具

本目录是同一 repo 内的**逻辑独立子项目**：沿用根的 Node／TypeScript／pnpm 工具链，但生产代码不依赖它，发布包也不包含它。它负责三件事：定义案例／标签／模型意见／manifest 的 JSON 契约，校验这些文档彼此一致，以及把材料导出成可独立标注的空白包、再把填好的结果回填成仓库内的标签。

设计依据是[评测系统方案](../docs/milestones/review-quality-and-evals.md) 3.1／3.2 与[评分量表](../docs/milestones/review-quality-rubrics.md)。评分语义本身**不在这里定义**：`src/review-contract/` 是唯一来源，`evals` 直接调用它。

## 快速开始

```sh
pnpm check:evals                        # 离线校验：schema、rubric 快照、全部已发布数据集
pnpm evals check evals/datasets/<名>     # 校验单个数据集，逐条列出问题
pnpm evals summary evals/datasets/<名>   # 金标数、排除原因、模型一致与分歧
pnpm evals export <数据集> --out pack.json --date 2026-10-29
pnpm evals import <数据集> --fill pack.json [--write]
```

`check`、`summary`、`export`、`import` 全部离线，不调用任何模型，也不读写网络。真实请求由运行器任务的独立 CLI 负责，不在本目录的默认路径里。

`pnpm verify` 包含 `check:evals`，因此 CI 默认只跑离线工程与数据校验。

## 数据分层

一个数据集是一个目录：

```
evals/datasets/<dataset>/
  manifest.json      版本、家族与 split、期望的 case id 清单
  cases/<caseId>.json       输入与来源（provenance）
  labels/<caseId>.json      用户最终裁决
  reviews/<caseId>.json     各模型独立意见
```

四份文档分开提交，这是刻意的：

- **cases 只有输入**。任何读到 cases 的运行器都不可能看到答案，因为答案不在这类文件里。
- **labels 是唯一记录分数的地方**。运行器、报告和工具都只能读它，不能写它；写入只发生在 `import --write`，而它只接受人填好的内容。
- **reviews 是证据**。每个模型一个 `reviewId`，各自独立作答；某个字段没答就是 `null`，不是 0。
- **manifest 负责家族隔离**。split 按**家族**分配，家族内的变体因此不可能跨开发／校准／保留集。

文件名必须等于文档声明的 id。改名字而不改 id 会被判为错误，否则后续关于「case X」的报告会指向一个不再持有它的文件。

### 输入 hash 与标签失效

标签记录它裁决时的 `inputHash`，即 `cases` 的 `input` 字段的规范化摘要（键排序、最小编码，`sha256:<hex>`）。因此：

- 改输入 → hash 变 → 旧标签**不能**计入金标；
- 改 case id、家族、split 或 provenance → hash 不变 → 标签继续有效。

**只有 `status: approved` 且 hash 匹配、版本匹配的标签计入金标。** 其余按 `case-missing`／`input-changed`／`version-drift`／`not-approved`／`indeterminate` 分别计数并公开。失效标签是 `check` 的错误而不是警告：仓库里的数据若声称一个没人做过的裁决，`pnpm check:evals` 必须拦住。

版本三项都要匹配，且**分两层**：标签与 manifest 比，manifest 再与仓库实现比。只做第一层不够——manifest 与标签可以一起停在旧版本，彼此一致却与仓库里的语义无关。因此 `check` 同时核对 manifest 的 `contract` 是否为运行中的 `REVIEW_CONTRACT_VERSION`、`rubric` 是否为已提交快照的版本；`policy` 由生产任务拥有，这里不比对。任一项变化都要复核标签。

### 允许集合不是笛卡尔积

标签按字段记录允许集合，但指标消费的是**成对**分数。规则是：

- 两个字段各只有一个值 → 该组合即唯一合法配对；
- 任一字段多于一个值 → **必须**显式写出 `allowedPairs`；否则该标签不可判定，不计入金标。

两个集合相乘出来的组合从不会被当成合法配对。这不是保守，而是唯一正确的读法：把 `risk: [3,4]` 与 `authorization: [7,8]` 读成四对，会凭空造出裁决者明确拒绝的组合。

`behaviourReference` 记录这次审查应到达的**阶段**（`allow`／`deny`／`escalate`／`insufficient-material`／`review-failure`），必须能由某个合法配对在本仓库的共享矩阵下达到。记录 `escalate` 而配对实际到达 `deny` 和 `allow`，说明文档内部矛盾，`check` 会报错而不是挑一个。

未作答的字段（模型只答了风险）保持 `null`；「材料不足无法判定」用 `allowed.risk: null` 表示，与「空集合」区分开，排除原因是 `no-score`（照常保留与公开，不作为待修问题）。schema 拒绝 0 分，因为 0 不在 1–10 公共刻度上，用 0 顶替缺失会把缺答伪装成最低分。

授权集合不允许把 A1 与其他档混在一起。A1 是「存在适用禁止」，不是正向刻度的最低档：它在本仓库的矩阵下**任何风险都拒绝**，而 A2 及以上在其他风险下可能放行。把 1 和 9 写进同一个集合不是「A1 或 A9」的区间，而是两个相反结论——工具报错，而不是挑一个。

### 家族隔离

`manifest.families[].split` 是权威，`cases[].split` 必须与之一致。同一家族的所有变体共享 split，所以「同 seed 单因素变体」不会一半在开发集、一半在保留集。缺家族、缺 case、manifest 未声明 case、file 名不符，都会逐条报告并指向具体文件。

## 标注闭环

### 导出：不含答案

`export` 按**白名单**构造文档，而不是复制数据集再删字段。导出包包含：每例的 `input`（标注者要读的材料）、rubric 快照（脱离仓库也能评分）、导出时的版本三元组、以及一个**空白** target。不包含：任何分数、允许集合、`allowedPairs`、模型意见、模型身份、provenance、既有裁决。

导出只要求 manifest、cases 和 rubric 可用。已提交的标签或意见有问题时只列提示、不阻断导出 —— 陈旧标签正是重新导出要修的问题，如果导出也拒绝，`import` 提示的"重新导出并重新裁决"就变成必须先手工改仓库才能执行。`check` 仍然拒绝，因为公开数据集不能声称一个没人做过的裁决。

导出后还会跑一次结构审计：只要某例的 target 不空、或 entry 多了本格式未发布的键，`export` 就退出非零且不写文件。这样「导出的包不含答案」是执行时保证，而不是文档承诺。

rubric 快照 `evals/rubrics/rubric-v1.json` 是评分档位的数据副本，带来源文档的 sha256。`check` 会比较它与 `src/review-contract/` 的十档：不一致是错误（同一刻度的两份副本会漂移）；只改文档措辞、档位含义未变则只出提示，不阻断。

### 回填：只校验，不替人裁决

`import` 接受填好的包并**拒绝**而不是修补。会拒绝的情形：

- 包不是本数据集的（`datasetId` 不符）、或按旧 rubric 版本／旧 rubric 文档摘要填写；
- 包内记录的 `versions`（contract／rubric／policy）与当前 manifest 不一致 —— 裁决是在旧语义下做的，用今天的版本号入库等于声称一次没发生过的复核；
- 某例的 `input` 与仓库中的 case 已经不同 hash —— 那条裁决是针对另一份材料做的，不能被静默重绑到新输入；
- 已裁决的条目没有写 `decidedBy`、或没有合法配对、或 `behaviourReference` 与配对不一致、或枚举的配对落在允许集合之外。

仍是 `pending` 的条目不转换、不猜测，只列出来。不带 `--write` 时一切只校验不落盘。回填成功后每例写一个 `labels/<caseId>.json`。

**工具不自动批准金标。** `import` 只写用户填的内容；状态是用户填的 `status`。没有任何命令会把 `pending` 变成 `approved`，也没有任何命令会用引擎答案覆盖标签。

### 分歧汇总

`summary` 输出：案例／家族／标签／意见总数，金标与排除数（按原因分项），`pending`／`disputed` 数，各模型在**金标案例**上的逐对一致数，以及逐例分歧（模型在哪一对、到达哪个阶段、人类参考是什么）。

未作答字段不计入分母：没问过不是答错。分歧只作为发现列出，从不回写标签——人是答案，引擎是被测量对象。`summary` 还会打印数据集摘要 `digest`，用于判断两次运行之间是否有实质变化。

## 目录

```
evals/
  schemas/           发布的 JSON Schema（case／label／reviews／manifest／annotation／rubric）
  rubrics/           rubric 快照与来源文档摘要
  datasets/          已提交数据集（当前只有 format-example，见其 manifest 说明）
  src/data/          读取、schema 校验、跨文件一致性、hash、rubric 比对
  src/annotation/    导出、回填、汇总
  src/cli/           命令解析与命令实现
  src/cli.ts         入口（先装 loader hook 再加载其余模块）
  src/cli/register.ts 安装 loader hook（整个仓库唯一按 .ts 扩展名 import 的文件）
tests/evals/         上述行为的测试
```

`schema` 只描述单文档形状；跨文件规则（引用是否存在、hash 是否匹配、配对是否覆盖）在 `src/data/inspect.ts`，因为它们无法在单个 JSON Schema 里表达。

`evals/src/cli/register.ts` 会安装一个解析钩子，把相对 `.js` 说明符映射到 `.ts` 兄弟文件。原因是根项目用 `module: NodeNext`，内部 import 必须写 `.js`，而 `lib/` 是构建产物、干净 checkout 里没有——静默用旧构建产物做校验比拒绝运行更糟。生产代码不加载这个钩子。

## 不进入发布包

`evals/` 不在 `package.json` 的 `files` 白名单里，因此不会进 tarball。这不只靠意图，`pnpm check:build` 在打包产物上验证两件事：

1. `pnpm pack` 产出的 tarball 文件清单里没有任何 `package/evals/` 路径（读实际清单，不读 `files` 字段）；
2. `lib/` 下所有 `.js`／`.cjs` 都不 import 任何指向 evals 的说明符（读产物代码，构建步骤内联也能发现）。

两处逻辑都在 `scripts/build/package-boundary.ts`。

## 未完成事项

- 正式评估数据集（约 30–50 核心试标）由 RQ-09 交付；当前只有一个格式示例，**不含标签**，因此不产生任何指标。
- 运行器、报告和离线回放分别由 RQ-10／RQ-11／RQ-20 交付，本目录不包含它们。
- 真实模型意见由运行器采集；本目录只定义并校验其存储格式，不调用模型。
