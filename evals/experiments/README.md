# RQ-14 探针／prompt／cache 对照实验

本目录是 RQ-14 的交付物：**冻结的候选矩阵**、它的 schema，以及由它生成的记录。它不包含任何运行结果 —— 真实调用属后续评测任务。

## 文件

```
evals/experiments/
  rq14-matrix.json            冻结实验定义（候选、阶梯、缓存工作负载、上限）
  record.json                 由定义生成并提交的记录（身份、差异、实测预算）
  schema/experiment.schema.json  定义自己的 JSON Schema（不是运行器文档 schema）
  run-plans/                  RQ-H1B 的冻结运行计划（target、预算、bounds），供 RQ-15 调用
```

`run-plans/` 属于 RQ-H1B（`resource-decision.md`），不是候选矩阵：它点名真实 target 与预算上限，`pnpm evals:plan` 可以直接展开；而 `experiments` 的三个命令只认同目录下的实验定义。两者是不同的文档类型，不要混用——一个说「跑什么配置」，一个说「用哪个模型、花多少」。它们的目的、取值与阻塞项见[窗口一资源决定](../../validation/review-quality/resource-decision.md)。

`record.json` 由 `pnpm evals:experiments record evals/experiments/rq14-matrix.json` 生成，`definitionDigest` 与定义文件绑定；改定义必须重生成记录，测试会检查两者一致。

## 候选矩阵

| id  | prompt       | structure        | history   | scale    | 作用                     |
| --- | ------------ | ---------------- | --------- | -------- | ------------------------ |
| A   | 无探针       | 生产布局         | 当前 turn | 完整量表 | **首选候选**，等于生产包 |
| B   | 可恢复性问题 | 生产布局         | 当前 turn | 完整量表 | 与 A 唯一差异是多问一题  |
| C1  | 无探针       | compact          | 当前 turn | 完整量表 | 结构压缩                 |
| C2  | 无探针       | compact-no-audit | 当前 turn | 完整量表 | 冗余元数据清理           |
| C3  | 无探针       | compact-no-audit | 抽掉      | 完整量表 | 历史选择                 |
| C4  | 无探针       | compact-no-audit | 当前 turn | labels   | 量表／示例压缩           |

阶梯（`ladder`）每一步只改一个轴，并声明改的是哪一个；校验器会按实际差异核对声明，因此「结果差异」只有一个候选解释。

## 探针

候选 B 只多问一个问题，答案词表固定为：

```
withdrawn | recoverable | partially-recoverable | irreversible | unknown
```

- `withdrawn` 是**授权**事实（当前存在撤回／禁止），由授权量表读取 A1，不由实验额外设门。
- `recoverable` / `partially-recoverable` / `irreversible` 区分撤销、恢复与残余损害。
- `unknown` 是**合法答案**：材料不足以确立事实。它与「没能读出答案」（`member-absent` / `not-a-string` / `not-an-option`）是两个不同状态。

探针读数记录在两个档位**旁边**，从不参与 `evaluateReview`、矩阵或判定。因此：

- 风险定义不因是否有探针改变（恢复成本与残余损害本来就在风险档内）；
- 不存在「不可撤回即转人工」的隐含硬门；
- 任何新硬规则必须作为产品语义变化交第二窗口裁决，实现不默认加入。

探针的版本、member、词表与 `unknown` 表示在 `src/reviewer/probe.ts` 定义；本目录的定义与之逐项校验，不一致即校验失败。

两个协议共用同一 R/A 语义、同一探针问题与同一记录结构，只有包装不同：chat 用一个额外答案成员，decision 用一个独立的 `choice` 问题。**该 `choice` 形态取自 `evidence.md` 第 11 节的厂商文档记录，本仓库尚未在真实端点验证** —— 属未验证项，`notes` 里已固定声明，不得当作已通过。

## 缓存工作负载

序列为 `cold → stable-prefix × 2 → changed-action × 2`，由两部分具体材料定义：

- `cache.baseCaseId`：所有请求共享的 policy、环境、许可、历史与完整性；冷请求提交它自己的动作。
- `cache.changedActionCaseIds`：changed-action 槽位按顺序提交这些 case 的动作，前缀仍是基线 case。**列出来而不是推断**，所以调大某个槽位的 `repeats` 会变成真实请求，且必须有真实动作，否则校验失败。

合成发生在 **case 层**：每个请求是一个 case，其身份、policy、证据、session 与工作目录取自基线 case，动作取自动作 case；合成后的 case 再走 `caseMaterial`，也就是生产路径 —— 求事实、装快照、按输入预算裁剪、生成完整性报告、渲染。两条后果让工作负载诚实而不是近似：

- 派生事实在**基线 case 的目录**里求值：相对路径按审查者被告知的工作目录解析，用动作 case 自己的 `cwd` 会提交一条命令行与一组效果指向两个不同目录的请求。
- 合成请求重新走生产的裁剪步骤，所以更大的动作会按生产同样的方式被裁剪并标记；`OVER_BUDGET` 描述的是这一条请求，而不是它替换掉的基线 case。

`plan` / `check-all` / `record` 调用**同一个** `experimentProblemsOf`，所以干跑判为可用的定义不会被写记录的命令拒绝。`record.json` 的 `cache.expanded` 记录每条请求的 case、角色、输入估计、稳定前缀指纹，以及与矩阵格逐字节相同的项。三条性质是**被测出来的**，不是写死的：

- 全部请求的 `stablePrefixFingerprint` 相同（provider 前缀缓存唯一能依赖的东西）；
- changed-action 的 `actionFingerprint` 与冷请求不同，且彼此不同；
- 非 changed 槽位的 `actionFingerprint` 与冷请求完全相同。

校验拒绝的状态包括：没有 changed-action 槽位；声明了数据集未发布的动作 case；展开后的请求数/变化动作数与声明不符；两个 changed 槽位提交同一个动作；动作区超过单请求上限（含 `OVER_BUDGET`）；稳定前缀不唯一。changed-action 游标在槽位之间**累积**，所以把一个 `× 2` 拆成两个 `× 1` 会提交两个不同动作，而不是重复第一个。

`byteIdenticalToMatrix` 只记录哪些请求与某个矩阵格逐字节相同，**不抵扣预算**：那一次派发是否真的发生过属于执行事实，规划不能预先声称省下一条。

**命中是测量结果，不是假设。** 只读 provider 自己报告的缓存读写计数（`review-usage-v1` 映射）；未报告保持 `null`，不按 0 计入，也不据「应当命中」推断。缓存布局同样不提升任何材料的指令层级，也不为命中保留过时授权。

`MATERIAL_COMPLETENESS` 仍取自基线 case（见 `notes`）：它属于前缀的一部分，只有动作区随槽位变化。

## 预算与运行上界

两个上限是**实验**的，一个上限是**单次运行**的（沿用 RQ-10 的 `RunBounds`），三者都要满足：

| 字段                         | 值      | 覆盖范围                 | 实测                 |
| ---------------------------- | ------- | ------------------------ | -------------------- |
| `budget.maxRequests`         | 640     | 矩阵 + 缓存 + 修复重试   | 629                  |
| `budget.maxInputTokensTotal` | 1700000 | 全部请求输入估计之和     | 833114 + 14305       |
| `budget.maxRepairRetries`    | 1       | 每格一次                 | —                    |
| `bounds.maxAttempts`         | 640     | **单次有界运行**的尝试数 | 629                  |
| `bounds.maxInputTokens`      | 20000   | **单条请求**的输入       | 最大候选单格远低于此 |

629 = 312 个矩阵格 + 5 条缓存请求 + 312 次允许的修复重试。`maxAttempts` 是单次运行的尝试上限，不是整个实验的上限：比它更大的实验需要切成多次运行，而本实验实测恰好能放进一次运行，所以声明的是覆盖它的数字，不是「已经切分」。

`plan` 还会逐格核对 `bounds.maxInputTokens`：一条渲染后超过单请求上限（或被生产预算标为 `OVER_BUDGET`）的格会被点名拒绝，因为运行器会拒发它而不是发出去。变体渲染也一起测量 —— B 多出的问题与答案格式在 system 消息里，可能撑大生产本身放得下的请求。

token／reasoning 预算与「实际缓存支持」都按**测量**确定：本任务不做真实调用，因此这些上限是给后续运行用的天花板，而不是对模型能力的断言；`reasoningEffort` 保持 `null` 是因为选用哪些模型属 RQ-H1B 的资源决定，这里不预设。

## 校验与干跑

```sh
pnpm evals:experiments check-all                 # 定义 + 测量 + 预算（也包含在 verify 里）
pnpm evals:experiments plan evals/experiments/rq14-matrix.json
```

`plan` 逐格渲染（生产渲染器 + 该候选的变体）**并逐条渲染缓存工作负载**，报告每候选的 `distinct requests` 与 `estimated input tokens`、每格 / 每条缓存请求的实测值，以及它们与三个上限的比较。它不写任何文件，也不调用模型。实测超限时以非零退出，拒绝原因是实测值而非声明值。

`check-all` 对每个已提交定义做同样的事，并额外校验缓存工作负载的字节性质（前缀一致、changed-action 确实改变了动作）。它也在 `pnpm verify` 里，所以这些性质是 CI 检查而非文档承诺。
