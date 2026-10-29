# RQ-14 探针／prompt／cache 对照实验

本目录是 RQ-14 的交付物：**冻结的候选矩阵**、它的 schema，以及由它生成的记录。它不包含任何运行结果 —— 真实调用属后续评测任务。

## 文件

```
evals/experiments/
  rq14-matrix.json            冻结实验定义（候选、阶梯、缓存工作负载、上限）
  record.json                 由定义生成并提交的记录（身份、差异、实测预算）
  schema/experiment.schema.json  定义自己的 JSON Schema（不是运行器文档 schema）
```

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

序列为 `cold → stable-prefix × 2 → changed-action × 2`：先冷请求，再连续发稳定前缀（契约、量表、policy、许可与判断材料不变，只有动作与完整性块变化）。

**命中是测量结果，不是假设。** 只读 provider 自己报告的缓存读写计数（`review-usage-v1` 映射）；未报告保持 `null`，不按 0 计入，也不据「应当命中」推断。缓存布局同样不提升任何材料的指令层级，也不为命中保留过时授权。

## 预算

`budget` 是本次实验的上限，`plan` 的实测值必须落在其中：

- `maxRequests` 624（实测矩阵 312 格）
- `maxInputTokensTotal` 1700000（实测 818346，含重复）
- `maxRepairRetries` 1
- `reasoningEffort` 为 `null`：由 provider 默认决定，理由见下

token／reasoning 预算与「实际缓存支持」都按**测量**确定：本任务不做真实调用，因此这些上限是给后续运行用的天花板，而不是对模型能力的断言；`reasoningEffort` 保持 `null` 是因为选用哪些模型属 RQ-H1B 的资源决定，这里不预设。

## 校验与干跑

```sh
pnpm evals:experiments check-all                 # 定义 + 测量 + 预算（也包含在 verify 里）
pnpm evals:experiments plan evals/experiments/rq14-matrix.json
```

`plan` 逐格渲染（生产渲染器 + 该候选的变体）并报告每候选的 `distinct requests` 与 `estimated input tokens`，不写任何文件，也不调用模型。实测超预算时以非零退出，拒绝原因是实测值而非声明值。
