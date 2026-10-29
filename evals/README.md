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

`check`、`summary`、`export`、`import` 全部离线，不调用任何模型，也不读写网络。

## 运行器

```sh
pnpm evals plan <运行计划.json>                        # 展开冻结计划，列出每个格子的支持状态
pnpm evals run <运行计划.json> --dir <运行目录>          # 实际执行（唯一会发出请求的命令）
pnpm evals run <运行计划.json> --dir <运行目录> --dry-run # 只报告，不写任何文件
pnpm evals resume <运行计划.json> --dir <运行目录>       # 报告还缺哪些格子，不执行
pnpm evals show <运行目录>                             # 离线读取一次完成的运行
```

**只有 `run` 会发出请求。** `pnpm verify`、`pnpm check:evals` 和 CI 只调用 `check-all`，都不在运行器的默认路径里；真实调用必须显式输入 `run`。离线计划只替换 socket —— 渲染、信封选择、解析、N0 与用量归一化仍走生产代码（`src/reviewer/service.ts` 的 `review()`）。

### 运行目录结构

```
<运行目录>/
  plan.json              冻结的选集与配置（写入前即固化为哈希）
  index.json             运行状态：每个格子的状态、预算余量、总消耗（可重写）
  records/<cellId>.json  单个格子的不可变记录（写一次，永不重写）
  fixture.json           离线替身的脚本化 socket（可选，由计划指定）
```

`index.json` 会被重写，`records/` 不会被重写。因此**记录集合就是实际发生过的尝试集合**：中断只留下已完成的记录，续跑只能向这个集合添加，不能改写已有证据。已消耗的总量由记录重新计算，而不是累加一个可变计数器，所以续跑不会重复计入。

### 单元格与身份

一个 cell 是「一次案例 × 一个目标 × 一个协议 × 一个重复序号」。cell id 由这四项按固定规则拼接（`case~target~protocol~rN`），因此：

- **独立重复是不同 cell**，不会被当成「同一个观测用两次」；
- **修复重试不是独立重复**：它属于同一次调用的第二个 attempt，记录里标注 `kind: 'repair'`，计入用量，但不增加稳定性样本；
- 计划里没声明支持的 model × protocol 组合记为 `unsupported`，从不发送、也不写记录 —— 因此不可能被伪造的判定填充。

### 记录内容

每条记录包含：案例身份与输入指纹（与标签审批同一摘要）、入口链说明（`direct-service` 还是宿主链）、目标（计划的 model、实际协议名、**响应体自报的 model**、配置档位）、材料指纹与 M0 报告、公共判定（共用契约的原始 `outcome`）、**每个实际 attempt 的完整响应**（适配器已完成已知凭据遮蔽）、共用映射下的用量汇总、耗时与版本四元组。

**费用是状态，不是数字。** 运行器不代币定价，`cost.amount` 恒为 `null`，`cost.status` 说明原因；填 `0` 会被读成「免费调用」。

**未知不等于 0。** usage 六桶中未报告的字段是 `null`，provider 明确报告 `output_tokens: 0` 时保留 `0`；缓存／reasoning 子项不并入父项，`inclusions` 记录 `contained`／`separate`／`unknown`。

### 有界性

计划必须声明四项上限，运行器逐项执行，不是事后检查：

| 上限             | 行为                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `concurrency`    | 最多这么多个 worker，每 worker 一次一个 cell                                                               |
| `timeoutMs`      | 每个 cell 自己的时间界，从调用外部强制，超时记为 `timeout` 而非 `cancelled`                                |
| `maxAttempts`    | 派发前预留该 cell 的最坏 attempt 数（含 transports 自身的修复次数）；不足则停止派发并记 `budget-exhausted` |
| `maxInputTokens` | 派发前比较该 cell 实际渲染出的输入估计；超出则不发                                                         |

取消通过调用方的 `AbortSignal`：停止新派发，已在途的 cell 以 `cancelled` 结束，从未开始的记为 `not-run`。运行器**不重试 cell** —— 重试会是计划没要求的第二个观测，生产传输已经拥有设计允许的那一次修复。

### 消费接口

报告（RQ-11）与实验配置（RQ-14）通过 `evals/src/run/artifact.ts` 与 `evals/schemas/run*.schema.json` 消费运行记录，不导入执行器：

```ts
import {
  readRun,
  cellSucceeded,
  scoredOutcome,
  usageAttemptsOf,
} from './evals/src/run/artifact.js';
import { compileRunCheckers } from './evals/src/run/schemas.js';

const checkers = await compileRunCheckers();
const read = await readRun(directory, checkers); // 按已发布 schema 收窄，不调用模型
if (read.ok) {
  for (const record of read.artifact.records) {
    /* … */
  }
  read.artifact.missing; // 声称跑过却没有记录的 cell（真正的缺口）
}
```

`readRun` 不联网、不调用模型，因此「同一记录可离线消费」是可执行保证。`usageAttemptsOf(record)` 返回生产 `aggregateUsage` 接受的形状，重算时与记录里的汇总同口径。

`pnpm verify` 包含 `check:evals`，因此 CI 默认只跑离线工程与数据校验。

## 报告

```sh
pnpm evals report <运行目录>                                  # 用运行记录自带的数据集重建三层报告
pnpm evals report <运行目录> --out validation/review-quality/run-a
pnpm evals report <运行目录> --mode no-ask --channel unavailable
```

`report` 只读：它通过 `evals/src/run/artifact.ts` 读保存的记录，不派发、不解析凭据、不调用模型。同一份运行记录的两次重建产出**逐字节相同**的文档，因此它可以被 CI 或回归检查调用，而 `run` 不行。

三个文件一起写出：`<prefix>.json`（报告本身）、`<prefix>.md`（人读）、`<prefix>.html`（自包含，无脚本、无外链）。默认 prefix 在运行目录内；已存在的报告不会被覆盖，除非加 `--force`——报告是证据。

### 三层分开

| 层             | 内容                                                  | 分母                               |
| -------------- | ----------------------------------------------------- | ---------------------------------- |
| 一：自动行为   | 误放／误拒／不必要人工／升级而非拒绝／一致            | 有判定且案例有金标标签的格子       |
| 二：R/A 诊断   | 评分误差、相邻档、合法配对命中、单调性、分布形态      | 裁决者把该字段钉成唯一值的案例     |
| 三：模式与结算 | allow／deny／询问人工／归一拒绝，以及询问人工是否必要 | 全部格子，但技术故障的结算单独一行 |

**技术失败不属于任何一层。** 超时、取消、传输失败与审查失败都是「没有对本次调用作出陈述」，因此不进比较分母、不算拒绝，只在覆盖表里单独计数。记录缺失（索引声称跑过却没有记录）与派发前已决定（不支持／预算耗尽／未开始）也各占一行。

### 分母与未知

- `labels/` 为空时金标指标没有分母，报告显示 `n/a (0/0)` 并说明这是等待用户裁决的正常状态，**不显示 0% 通过率**。
- 按格子与**按案例加权**的比率同时给出：相关变体与重复共享 seed，不是独立样本。
- 无效／未复核／争议标签按 `case-missing`／`input-changed`／`version-drift`／`not-approved`／`no-score`／`indeterminate` 计数并公开，全部带案例 id 与裁决理由原文。
- 行为参考与实际结果冲突时列入「差异」，从不用引擎输出覆盖人类答案。

### 可比性

同模型双协议只在**一个目标同时支持两种协议**时配对，且只对两侧都确有回答的案例配对；重复按案例 id 取一个值，不放大配对数。模型与协议同时变化时只输出「系统组合」并写明不能归因于单一协议。

### 用量扩展段

逐 attempt、逐次审查、按 model／protocol／target／run 汇总，全部复用 `src/reviewer/usage.ts` 的 `aggregateUsage`，不复制字段映射。每格重算值与记录自带汇总比对，不一致时报告按重算值输出并在自检里标出。

- 六个桶（input／output／total／cache 读／cache 写／reasoning）各自给出合计、报告数、缺失数与 `complete`；未知保持 `null`，明确报告的 0 保持 0。
- 缓存与 reasoning 子项按 `inclusions` 标注 `contained`／`separate`／`unknown`，**永不并入父项**。
- 适配器估算的 input token 与 provider 报告分开两栏，不加在一起。
- 费用是状态：`cost.amount` 恒为 `null`，报告**不输出费用合计**。
- 超时／取消时未报告的预留 attempt 单列，不编造 token 数。

## 离线回放

```sh
pnpm evals replay <运行目录> --out <派生父目录>                 # 用生产同一套阈值重算（应与原结果一致）
pnpm evals replay <运行目录> --out <派生父目录> --threshold-risk at-least
pnpm evals replay <运行目录> --out <派生父目录> --mode no-ask --channel unavailable
pnpm evals replay <运行目录> --variants <变体.json> --out <派生父目录>
```

`replay` 只读源运行目录，把每个变体写成一个**独立的派生运行目录**（`plan.json`／`index.json`／`records/`／`fixture.json`／`lineage.json`）并在其中用既有报告接口重建三层报告。它不派发、不解析凭据、不调用模型：**保存的响应是它唯一能读的东西**。

### 三个轴，且只有三个

| 轴                         | 取值                                                           | 默认（= 生产）                    |
| -------------------------- | -------------------------------------------------------------- | --------------------------------- |
| `answer`                   | `response-text`／`recorded-parse`                              | `response-text`                   |
| `thresholds.risk`          | `strict`／`at-least`                                           | `strict`（累计质量 **>** 一半）   |
| `thresholds.authorization` | `strict`／`at-least`                                           | `at-least`（累计质量 **≥** 一半） |
| `settlement`               | `mode`：`ask`／`no-ask`；`channel`：`available`／`unavailable` | `ask`／`available`                |

轴值就是变体身份：目录名是三条轴的可读拼接（`text-strict-at-least-ask-available`），`digest` 是三条轴的摘要，`description` 不参与身份。**共同矩阵不是轴**：`requiredAuthorizationFor` 只有一张表，生产没有第二张，所以回放不把它当旋钮——那会是「与被测引擎并列的第二个引擎」，而新的放行规则属于窗口二的产品裁决。

### 为什么不是复制判定逻辑

| 步骤       | 复用的是                                                                       |
| ---------- | ------------------------------------------------------------------------------ |
| 读答案     | `src/reviewer/signals.ts` 的 `readChatAnswer`／`readDecisionAnswer`            |
| 选档       | `src/review-contract/normalize.ts` 的 `bandFrom`（含精确十进制累加与一半判定） |
| 判定位     | `src/review-contract/matrix.ts` 的 `scoreReview`                               |
| 材料可用性 | `evaluateReview`／`materialAvailability`（M0 的缺口语义）                      |
| 重建报告   | `evals/src/metrics` 与 `evals/src/report`，读派生目录本身                      |

同一变体命中生产阈值时，回放直接调用 `evaluateReview`，所以「同版本重现原结果」是**构造上成立**而不是两次实现互相比对的结果；`tests/evals/replay-thresholds.test.ts` 同时验证三层报告逐段相等。

### 故障优先级

- HTTP 失败、`success:false`（即便同时带完整 answers）、传输失败、解析失败：**在任何阈值／模式下都保持故障**。派生报告照旧把技术结果单列、保留已报告 usage，未知用量仍是 `null`。
- 原文被遮蔽到无法解析（见下节「已知上游限制」）：该格标 `not-replayable` 并写明原因，**保留原判定**、不修补、不参与派生比较；换 `--answer recorded-parse` 可读适配器自己的解析结果。
- 材料有阻塞缺口（`insufficient-material`）：阈值不适用，结果不变。

### 不变量

- 源运行目录与数据集**逐字节不变**；派生目录不得位于源内、不得等于源、不得包含源。该判定比较**真实位置**（跟随符号链接、用平台分隔符），`--force` 不能绕过：force 只决定能否替换已有派生，不决定能否动证据。
- 派生**先写进一个刚由 `mkdtemp` 建出的暂存目录，再整体 rename 就位**。这一条才是「任何写入都到不了证据」的来源：顶层目录合法不代表其下的 `records/`、单个 record、`fixture.json` 或报告文件合法，而这些路径都可能事先是一个指向源运行的链接；新建目录里不可能存在这样的链接。
- prompt 与输入变化不会被回放"补偿"：prompt 不是回放的轴；某例的输入 hash 与保存时不同时，保存的答案就不再是关于当前材料的证据。两者都会在 CLI（stderr warning）**与 `lineage.json` 的 `inputs` 段**里点名，并说明**要测量变化必须重新发起请求**。`inputs` 有三种状态：`compared`（含 `drifted` 与 `unverified` 两个列表）、`undetermined`；未验证既不算变化也不算一致。数据集整体不可读、某例文件读不出来、或一个案例都对不上，都会落到 `undetermined`／`unverified` 而不是沉默地当作未变化——安静只代表「比过且一致」。
- 派生索引复刻源的 `spent`、attempt 与时间戳：回放没有新增请求，也就没有新增消耗。
- `labels/` 只读。派生报告按**同一份**人类参考比较引擎答案；标签不因回放而改变。
- 同一变体的两次回放产出逐字节相同的派生文档（除 `lineage.json` 里记录的目标目录名）。
- 每个格子恰好出现一次：能重算的带新结果，不能的带原判定与原因。

### lineage

`lineage.json` 记录：变体三轴与 `variantId`／`digest`、生产契约版本（重算实际运行的那份）、源 run id／plan 哈希／数据集摘要／版本四项、**读到的每个源文档及其实摘的 sha256**、派生目录与报告文件、逐格 disposition（`re-derived`／`kept`／`not-replayable`／`no-record`）、该格的 attempt id 与响应原文摘要、以及「源版本与运行版本不一致」等说明。拿着 lineage 可以 `sha256sum` 复核源文件是否仍是派生时那份。

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

## 实验配置

对照实验的候选矩阵与记录在 `evals/experiments/`，代码在 `evals/src/experiments/`。三者都离线，**都不调用模型**：

```sh
pnpm evals:experiments check-all              # 校验并测量每个已提交定义
pnpm evals:experiments plan <定义.json>        # 干跑：展开矩阵并报告实测输入量，不写文件
pnpm evals:experiments record <定义.json>      # 写出冻结的 experiments/record.json
```

`check-all` 也包含在 `pnpm check:evals` 与 `pnpm verify` 里，因此 CI 会验证实验定义可编译、可测量，而不会执行它们。

### 候选与消融

候选是**四个独立轴**的组合，身份由四轴派生（`rq14/<prompt>.<scale>.<history>.<structure>`），所以两个候选不可能指向同一个包：

| 轴          | 取值                                  | 含义                                                     |
| ----------- | ------------------------------------- | -------------------------------------------------------- |
| `prompt`    | `no-probe`／`recovery-probe`          | 候选 A 无探针；候选 B 多问一个可恢复／可撤回性问题       |
| `structure` | `full`／`compact`／`compact-no-audit` | 生产布局／单 JSON 信封／再去掉长度、上限与路径等登记信息 |
| `history`   | `current-turn`／`none`                | 当前 turn 工具历史／抽掉并声明「被有意抽掉」             |
| `scale`     | `complete`／`labels`                  | 十档完整操作条件／一行档位标签＋守卫段                   |

**生产默认不受影响。** `review()` 固定用生产包（候选 A 即生产包本身）；实验入口是独立函数 `reviewWith(pkg)`，候选只能通过配置选择。压缩量表保留 `SCALE_GUARD`（A1 是禁止、3–10 累积、最弱关键效果封顶、恢复成本留在风险档内），因此量表消融不改变风险定义。

**四个轴在每种布局上都生效。** `history: none` 对 `full`、`compact` 与 `compact-no-audit` 都抽掉工具窗口并写下「被有意抽掉」的说明；两个身份不会共享一种处理。

**压缩只去掉转述，不去掉输入事实。** `compact-no-audit` 移除的是 `config_revision`、`turn`、来源字符数与上限、per-source 路径这类登记信息；每个来源是否 `present`／`enabled`／`truncated` 仍在 `guidance_sources` 里，因此「被预算截断的许可材料」在任何布局下都不会被读成完整材料。

**候选 B 的探针**定义固定在 `src/reviewer/probe.ts`，实验定义里的 `probe` 块与之逐项校验（版本、member、选项集合、`unknown`）。`unknown` 是**合法答案**，表示材料不足以确立事实，不是缺答；「读不出答案」是另一个状态（`member-absent`／`not-a-string`／`not-an-option`）。探针读数与两个档位分开记录，从不参与 outcome、矩阵或判定，所以任何候选都无法靠多答一题引入隐含门。

### 记录与预算

`experiments record` 写出的 `record.json` 固定：候选 id 与其派生包 id、每轴与生产默认的差异、阶梯（每步只改一个轴）、缓存工作负载、上限与实测值。它**不含分数**：本任务只准备矩阵，真实运行属后续评测任务。

`plan` 逐格渲染并测量：`cells`、每候选的 `distinct requests` 与 `estimated input tokens` 都是实测值。实测超出三个上限中的任何一个时拒绝，不会为了塞进预算而裁掉格子：

- `budget.maxRequests`：矩阵格 + 缓存请求 + 每格允许的修复重试；
- `budget.maxInputTokensTotal`：全部请求的输入估计之和；
- `bounds.maxAttempts`／`bounds.maxInputTokens`：单次运行的尝试上限与单条请求的输入上限（沿用 RQ-10 的 `RunBounds`）。实测超过单请求上限的格会被点名拒绝，因为运行器会拒发它；变体渲染也一起核对，B 多出的问题可能撑大生产本身放得下的请求。

缓存工作负载不只是「冷请求 → 稳定前缀 → 变化动作」的标签：`cache.baseCaseId` 与 `cache.changedActionCaseIds` 指明材料，合成在 case 层完成（身份、policy、证据、session 与工作目录取基线，动作取动作 case），再走生产的 `caseMaterial`，因此派生事实在提交的工作目录里求值、合成请求也按生产预算裁剪。`plan`／`check-all`／`record` 共用同一套校验：逐条渲染并核对稳定前缀逐字一致、changed-action 确实改变动作、每个 changed 槽位提交自己的动作、没有未发布的动作 case。**命中与否只读 provider 自己报告的计数**（经 `review-usage-v1` 映射），未报告保持 `null`，不按 0 计入，也不据「应当命中」推断。

## 目录

```
evals/
  schemas/           发布的 JSON Schema（case／label／reviews／manifest／annotation／rubric）
  rubrics/           rubric 快照与来源文档摘要
  datasets/          已提交数据集（当前只有 format-example，见其 manifest 说明）
  experiments/       实验定义、schema 与冻结的 record.json
  src/data/          读取、schema 校验、跨文件一致性、hash、rubric 比对
  src/annotation/    导出、回填、汇总
  src/experiments/   实验定义校验、矩阵与缓存工作负载展开测量、记录
  src/cli/           命令解析与命令实现
  src/metrics/       报告的三层指标、分组、逐例证据与可比性规则
  src/report/        Markdown／HTML／JSON 渲染、写出与 report 命令
  src/replay/        离线回放的变体、重算、派生目录与 replay 命令
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

## 已知上游限制

`src/reviewer/redact.ts` 的 `redactAuthHeaders` 会重建 decision 的分数对象，但它只认**结构完整**的那种：`{"type":"score","probabilities":{…}}`。因此下面两种答案在遮蔽后会变成非法 JSON：

- 答案成员缺 `"type":"score"` 标记（`"authorization": {"probabilities":{…}}`）——它不满足分数对象的判定，被当成 header 改写为 `[redacted]`；
- 保留成员（如 `legend`）的字符串值里出现 `Authorization: …` 之类 header 形状的文本——脱敏后的值没有配对的引号，字符串被截断。

影响范围：**判定与分数不受影响**（解析器读未遮蔽原文，`parsed` 完好，用量按数字字段归一化照常）。受影响的是记录里的 decision 原文可解析性，以及由它派生的 `target.responseModel`（此时为 `null`，而不是回落到配置的 model 名称）。

这直接限定了离线回放的边界：读 `--answer response-text` 时，这类格子标为 `not-replayable` 并保留原判定，不修补文本；换 `--answer recorded-parse` 读适配器自己的解析结果即可重算。这是设计允许的取舍——遮蔽发生在写记录之前，回放只能基于遮蔽后的文本，不能反过来要求记录保存未遮蔽原文。

这是 `src/` 侧缺陷，不在本目录修复；运行器如实保存适配器输出，不做第二次脱敏。

## 未完成事项

- 报告、离线回放与实验配置分别见「报告」「离线回放」与「候选与消融」；`evals/experiments/` 存放冻结的候选矩阵。
- 真实模型调用需显式 `pnpm evals run`，且需要窗口一授权的预算；本目录不自动触发。
- 标签审批仍是用户终审；运行器写 records，从不写 `labels/`。
