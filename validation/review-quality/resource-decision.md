# RQ-H1B 窗口一：评测资源与预算决定

决定日期：2026-10-30。所属：RQ-H1B（#80），Parent #64，Milestone #2。
设计依据：[审查质量与评测方案](../../docs/milestones/review-quality-and-evals.md) 3.2／3.3；[评分量表](../../docs/milestones/review-quality-rubrics.md)。

本文件固定窗口一的资源决定：**用哪些模型、走哪些协议、各发多少次、总预算多少、超了怎么办**。它是 RQ-15（#82）真实运行的输入，本身不发起任何调用。

冻结计划是同目录之外的 [`evals/experiments/run-plans/`](../../evals/experiments/run-plans/)：

| 文件 | 阶段 | 案例 | 协议 × target | repeats | 可发送格子 | 实测输入 tokens |
| --- | --- | --- | --- | --- | --- | --- |
| `pilot.json` | S1 试点 | dev 内 10 条 | 7 targets × 各自协议 | 1 | 70 | 204,148 |
| `full.json` | S2 全量（单候选） | dev 全部 13 条 | 7 targets × 各自协议 | 2 | 182 | 535,220 |

两份计划都通过 `pnpm evals:plan <文件>`（RQ-10 的 dry run）：`pilot` 140 格 70 supported／70 unsupported，`full` 364 格 182 supported／182 unsupported，退出码 0。

---

## 1. 结论摘要

1. **7 个 target 里 7 个都不可派发**，但原因分三档，不能混成一句：
   - **本地 `clef`、`clef-flash`（2 个）**：端点已实测在监听，但 live 预检拒绝空凭据引用名（§4.1）。
   - **Cloudflare × 2、TypeSafe × 1（3 个）**：配置完备、引用名可解析，只差「运行器能落地」以外的最后一环 —— 真实调用（§6）。它们是最接近可用的一组。
   - **chat × 2（2 个）**：运行器没有宿主 LLM 服务入口，这是 RQ-10 的边界，不是配置问题（§4.2）。

   所以严格说：**今天没有任何 target 能经 `pnpm evals run` 发出请求**。区别在于 3 个 decision target 只等窗口二的授权执行，另外 4 个还等工程修复。
2. **全量不能按「6 候选」直接相乘**：run plan 没有候选轴，运行器只调用生产 package（= RQ-14 的候选 A）。6 候选 × 52 格的比较需要 RQ-14 的实验入口（§4.3）。
3. **预算必须按累计口径冻结**，不是逐次运行上限：`maxAttempts` 只在单 run 内生效，`--resume` 不会重派已记录的失败 cell，新 `--dir` 又会拿到一份全新的 `maxAttempts`（§3.3.1）。**但「超了自动停」只有 attempts 这一维成立**：tokens 的累计数少计 repair，货币则完全不受运行器约束 —— 配额失败甚至不会停止派发。所以付费派发的前置是 provider 侧的硬上限，而不是本文件的一个数字（§3.3.2、§3.3.4）。
4. 在以上前提下，**S1 试点可发送 70 格、204,148 估算输入 tokens**；S2 全量（单候选、dev、2 repeats）**可发送 182 格、535,220 估算输入 tokens**。**六个候选的累计上限见 §3.3。**

---

## 2. 可用端点、模型与协议

协议由**端点形态**决定，不由模型决定。`src/reviewer/envelope.ts` 已实现：路径以 `/ai/run` 结尾 → `wrapped`（`{model,input:{state,questions}}`），否则 `flat`（`{model,state,questions}`）。下表是这一规则在本批 target 上的实际取值。

### 2.1 decision（5 个）

| # | targetId | model | endpoint | 信封 | 凭据引用 | costTier |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `clef-local` | `clef` | `http://127.0.0.1:8000/client/v4/accounts/local/ai/run` | wrapped | **无**（本地服务） | free |
| 2 | `clef-flash-local` | `clef-flash` | 同上 | wrapped | **无**（本地服务） | free |
| 3 | `clef-cloudflare` | `clef` | `https://api.cloudflare.com/client/v4/accounts/b3a7fb1e6d341247192c0fbcedb41cdd/ai/run/@cf/cloudflare/clef` | flat | `CLOUDFLARE_API_TOKEN` | paid |
| 4 | `clef-flash-cloudflare` | `clef-flash` | 同上换 model 段 | flat | `CLOUDFLARE_API_TOKEN` | paid |
| 5 | `jev-1-13-0` | `jev-1.13.0` | `https://api.typesafe.ai/v1/systemone` | flat | `TYPESAFE_API_KEY` | paid |

返回体形态差异（决定解析走哪条分支，`src/reviewer/envelope.ts` 的 `decisionAnswers` 两条都读）：

- Cloudflare（含本地模拟）：`{"result":{"model","answers":{"risk","authorization"},"usage"},"success":true}`
- TypeSafe：`{"model","answers":{...},"usage":{...}}` —— **根级 `answers`，无 `result` 包裹，无 `success`**

这两个形状都必须真实跑过，不能只跑一个然后假定另一个同构。S1 试点正是为此：Cloudflare 形态与 TypeSafe 形态各至少一次。

### 2.2 chat（2 个）

| # | targetId | provider | model | 凭据 |
| --- | --- | --- | --- | --- |
| 6 | `deepseek-v4-1-flash` | `deepseek-account` | `deepseek-flash` | 宿主 provider，无 ref |
| 7 | `workbuddy-glm-5-3-flash` | `workbuddy` | `glm-5.3-flash` | 宿主 provider，无 ref |

**⚠ 这两行的 provider／model 是宿主实际路由 id，不是用户口述的显示名。** 用户给的是产品名 `DeepSeek-V4.1-Flash` 与 `workbuddy-GLM-5.3-Flash`；本机宿主 session 记录里的实际配对是 `deepseek-account`／`deepseek-flash` 与 `workbuddy`／`glm-5.3-flash`（另有 `workbuddy`／`deepseek-v4.1-flash`，那是 workbuddy 渠道下的同名模型，与 DeepSeek 官方账号不是同一路由）。**派发前必须用 `listProviders()`／`listModels()` 复核**，不能凭此表直接发。

### 2.3 不支持的组合

每个 target 只支持一个协议，另一侧的格子**标记 unsupported 而非发明请求**。S1 的 70 个 unsupported 全部来自这里：

- 5 个 decision target 不支持 `chat`（`target X does not offer protocol chat`）
- 2 个 chat target 不支持 `decision`（`target X does not offer protocol decision`）

不存在「双协议 target」：本批没有任何模型同时提供 chat 与 decision 入口。因此设计文档 3.2 里「同模型双协议对比」在这个候选集上**不可执行**，只能比较系统组合差异。

---

## 3. 预算：把「余额有限、超了自动停」变成数字

用户原话是**「先用着，余额有限，超了自动停」**。这句话不是一条可执行的上限，需要落到运行器真正执行的四个字段上。运行器（RQ-10）实际强制的是 `concurrency`／`timeoutMs`／`maxAttempts`／`maxInputTokens`（见 `evals/schemas/run-common.schema.json#/definitions/bounds`），其中只有 `maxAttempts` 是**能止住花费**的那个：它在每次派发前按 cell 的最坏 attempt 数预留，不够就停，记 `budget-exhausted`。

### 3.1 取值与依据

| 字段 | S1 试点 | S2 全量 | 依据 |
| --- | --- | --- | --- |
| `concurrency` | 4 | 4 | 7 个 target 里 5 个是远端；4 路足以让一次试点在几分钟内结束，又不会同时打出几十个请求把一次配置错误放大成整批失败 |
| `timeoutMs` | 30,000 | 30,000 | 生产 chat 默认 20,000（`src/config/defaults.ts`），其中注明首次请求实测 1.9–5.2s、长 reasoning 加一次修复重试需要更多。远端 decision 无实测延迟，取 30,000 留一倍余量；本地服务同值 |
| `maxAttempts` | **90** | **234** | 单 run 上限，见下；跨阶段累计上限另见 §3.3 |
| `maxInputTokens` | 20,000 | 20,000 | 单条请求的输入上限。本批最大单请求实测 3,059（S1）／3,084（S2），余量充足；设 20,000 是为了让一个异常大的案例被**拒绝发送**，而不是悄悄发出去 |
| `context.maxInputTokens` | 10,000 | 10,000 | 沿用生产默认。实测无一条案例被裁剪（S1 与 S2 的 truncated segments 均为 0） |

**`maxAttempts` 的算法**（不是估的，是按运行器的预留规则算的）：

- decision cell 永远只发 1 次（`attemptCeilingOf` 对 decision 固定返回 1，`runDecisionTransport` 只做一次 fetch）；
- chat cell 的最坏开销是 `1 + maxRepairRetries` = `1 + 1` = 2。

| 阶段 | decision cells | chat cells | 最坏 attempts | 单 run 取值 | 允许的重跑 |
| --- | --- | --- | --- | --- | --- |
| S1 | 10 × 5 × 1 = 50 | 10 × 2 × 1 = 20 | 50 + 20×2 = **90** | **90** | **一次**，独立新的 `--dir` |
| S2（每候选） | 13 × 5 × 2 = 130 | 13 × 2 × 2 = 52 | 130 + 52×2 = **234** | **234** | 无 |

**为什么 S1 的单 run 上限是 90 而不是 180**（这一条推翻了我最初的取值，原因在运行器行为里，不在偏好里）：

`evals/src/run/lifecycle.ts` 的续跑只挑出**没有记录**的格子：

```ts
const completed = new Set(options.existing.records.map((record) => record.cellId));
const pending = grid.cells.filter((cell) => !completed.has(cell.cellId));
```

`completed` 这个名字有误导性 —— 它的判据是「有没有 record」，而失败、超时、取消的 cell **也写 record**（`execute.ts` 的 `recordOf` 对 dispatched 失败照写）。因此：

- `--resume` **不会**重派一个已经记录的失败 cell；
- 把 `maxAttempts` 设成 180 只是让**同一个 run 有能力**多花 90 次，而那个 run 里已经没有可派的 cell 了 —— 余量悬空；
- 真正能重跑的做法是**新的 `--dir` 起一个新 run**，而新 run 拿到的是自己那份额度。

所以「180 = 2 倍余量」在语义上是错的。正确的表述是：**S1 允许多跑一轮，每轮上限 90，累计不超过 180**。这需要操作者在第二轮的 `--dir` 上显式声明，并在起跑前核对第一轮实际消耗（`index.json` 的 `spent.attempts`）。本轮**不把这两轮压成一次**，因为运行器做不到。

S2 每候选 234 **无重跑额度**：全量阶段已经由试点确认流程，任何需要重跑的情况都说明出现了系统性问题，应该停下来交人判断，而不是自动再烧一份全额。

**「超了自动停」的单 run 部分**：超过 `maxAttempts` 时运行器停止派发并把剩余格子记为 `budget-exhausted`，退出码非 0，已完成的记录保留。这是**运行器行为**，不需要外部监控。**但它是单 run 行为，不跨 run 累计** —— 跨阶段的累计上限见 §3.3。

### 3.3 累计预算（授权范围与可执行上限）

这一节冻结本次窗口的**授权范围**，并说明其中哪些数字是运行器真正强制的、哪些只是估算基线。这个区分很关键：把估算当成硬上限，会让读者以为花费受控，实际却不受控。

#### 3.3.1 已确认的评测范围

| 阶段 | 内容 | 可发送格子 | 最坏 attempts | 估算输入 tokens |
| --- | --- | --- | --- | --- |
| S1 试点 | dev 内 10 条 × 7 targets × 1 repeat | 70 | 90 | 204,148 |
| S1 重跑额度 | 至多一轮同形 | 70 | 90 | 204,148 |
| S2 主对照 | dev 13 条 × 7 targets × 2 repeats × **6 候选** | 1,092 | 1,404 | 3,211,320 |
| 缓存工作负载 | RQ-14 的 5 条 cold/stable/changed 请求 | 5 | 5 | 14,307 |
| 最终保留集 | holdout 16 条 × 7 targets × 2 repeats × 1 候选 | 224 | 288 | 669,634 |
| **合计** | | **1,461** | **1,877** | **4,303,557** |

S2 的六个候选各是一份同形 run（各 182 格／234 attempts／535,220 tokens），因为 run plan 没有候选轴（§4.3）。**候选 B、C1–C4 与本窗口的授权范围在同一批内**，不再逐次询问。

**S2 的 3,211,320 是规划投影，不是六个候选的实测渲染值。** 它按候选 A 的逐案例估算 × 6 得出；RQ-14 的 `record.json` 明确记录六个候选的实际估算不同（A 151,906、B 160,876、C1 145,038、C2 135,706、C3 137,526、C4 102,062，各为 52 格 2 repeats 的量级）。B 比 A 大约 5.9%，所以六候选的真实合计会高于此表。用它做授权量级判断是可以的，用它做精确账单预测不可以。

最终验证用 holdout、且只跑**一个**候选 —— 按设计文档 3.3，保留集不得用于调参，也只在候选冻结后跑一次。

#### 3.3.2 哪些数字真的强制，哪些只是估算

| 字段 | 值 | 是否被运行器强制 | 说明 |
| --- | --- | --- | --- |
| `maxCumulativeAttempts` | **2,300** | **是（可核对）** | 见下 |
| `maxCumulativeInputTokens` | **5,200,000** | **否 —— 这是估算基线，不是硬上限** | 见下 |
| `maxCurrency` | **unknown** | **否** | 见 §3.3.4 |

**attempts 这一维是可靠的。** `lifecycle.ts` 的 `attemptsOfCell` 统计 record 里 `sent !== false` 的 attempt 数，**包含 repair**（`kind: 'repair'` 也是 attempt）。因此把一个 run 的 `index.json` 里 `spent.attempts` 累加，得到的确实是「已发出过多少次请求」。放气的失败 cell 也留着 record，所以它花的次数不会丢。2,300 这个上限因此**可以靠核对 `index.json` 执行**。

**tokens 这一维不可靠，必须如实说。** `spendOf` 里只有一行：

```ts
estimatedInputTokens += record.material?.estimatedInputTokens ?? 0;
```

它按 **cell** 计一次，取的是 `material` 上**初次渲染**的估算。如果一次 chat cell 先发初次请求、拿到不可读答案、再发一次 repair，**两次请求都真实发出、都计费，但累计 token 只记了一次**。所以累加 `index.json` 得到的数字**低于**实际发送量，差量大致等于 repair 次数 × 该 case 的单次估算。

因此：**5,200,000 是「初次请求输入」的估算基线，不是「全部已发送输入」的上限。** 表里的 4,303,557 与它同口径，比较是自洽的，但它们都不覆盖 repair 重复发送的部分。本文件不再把 5,200,000 说成硬性停止条件。

要精确核对实际发送量，`evals/src/metrics/usage.ts` 的按 attempt 汇总（`estimated` 段与 `attempts` 计数）能给出逐 attempt 的估算，且已排除 `sent === false` 的拒绝请求。**这是 #82 执行后核算的路径，不是本窗口的派发前检查。**

#### 3.3.3 停止条件

任一阶段起跑前，**三个都要满足**：

1. **累计 attempts < 2,300**：从各 run 的 `index.json` 汇总 `spent.attempts`。这一项是硬检查。
2. **前一阶段已通过其放行标准**（§7.1 的六项，或 S2 的完成）。
3. **本轮 attempts 加已消耗 ≤ 2,300**（按该 run 的 `bounds.maxAttempts` 预留）。

**token 检查的性质是软的**：核对累加估算是否接近 5,200,000，只作为量级接近的信号，不作为放行判据 —— 因为它少计 repair。真正防止多花的，是 §3.3.4 的货币约束，不是这个 token 数。

**为什么第 7 个候选不被本表排除、而是不被授权**：2,300 / 1,877 的余量在数学上足够再放一份 S2 同形 run（234 attempts）。排除它的**不是容量，而是授权范围** —— 窗口一只授权 §3.3.1 那张表。这是纪律边界，不是算术边界，写成算术边界会让人误以为「还有余量所以可以跑」。

#### 3.3.4 货币上限：为什么未验证的余额不能算作限制

运行器不代币定价：`cost.amount` 恒为 `null`，`cost.status` 说明原因（`not-computed`），因为「未计算」和「真的免费」是两个不同事实。本文件不把它填成 0，也不假装能算出准确总额。`maxCurrency: unknown` 在这一点上是正确的。

**但 `unknown` 不等于「余额会自动兜住」。** 本文件最初写成「账户余额即上限，超了自动停」，这是错的，有两条代码依据：

**Failure A —— provider 配额失败不会停止派发。** 一个返回的 `review-failure`（含配额／余额耗尽错误）在 `execute.ts` 里被判为 `status: 'reviewed'`，只要不是 cancelled 或 timeout。而 `scheduler.ts` 的 `state.stopped` 只有三个取值：

```
255:  state.stopped = 'cancelled';
319:  state.stopped = 'budget-exhausted';
346:  state.stopped = 'in-flight-timeout';
```

**没有 quota-exhausted 这一类。** 所以 provider 说「你没钱了」之后，运行器会继续派发后面的格子 —— 每个都失败，每个都花一次尝试。

**Failure B —— 余额是否是硬上限，本文件无从确认。** provider 侧的预付费硬上限、是否自动充值、是否转后付，我都没有证据。把它当成已被验证的事，就是用未知证据声明通过。

**所以货币约束的正确表述是：未经验证。** 在派出第一笔付费请求前，必须由**用户或 provider 账户设置**提供下列之一，并把结果记录到本文件（不是靠推算）：

| 方案 | 判定 |
| --- | --- |
| provider 账户已设置硬性预付费上限，且自动充值关闭 | 满足；记录设置证据与上限金额 |
| 每次派发前人工核对余额并授权 | 满足；但属逐次授权，与本窗口「不逐轮重问」的取向不同 |
| 两者皆无 | **付费 target 的派发为 blocked**，只跑本地与已确认免费的 target |

**结论**：本文件能冻结的、且运行器真正支持的，是 **attempts 这一维的 2,300**。token 与货币两维达不到「硬上限」的强度，已如实降级为估算基线与待验证项。**在 §3.3.4 的表格得到「满足」之前，Cloudflare 与 TypeSafe 的派发不开始** —— 这是 #82 的前置，不是本文件能自行宣称完成的事。

需要精确金额时，由 #82 在执行后从 provider 账单读取并回填；那属于执行证据，不属于本窗口的预算决定。

### 3.4 余量用途（按优先级）

1. **试点失败重跑**：**至多一轮**，新的 `--dir`，需先核对第一轮实际消耗（§3.1 已说明 `--resume` 不能重派失败 cell）；
2. **修复重试**：chat 每个 cell 自带一次，已计入 2×，不额外占用；
3. **配额用尽后的续跑**：余额到顶后运行**不会自动停**（见 §3.3.4），需要人工中断；已完成的记录保留，补足后 `--resume` 只跑**从未记录**的格子。注意它补不了已记录的失败格子；
4. **不用于新增实验候选**：第 7 个候选或第二轮全量属于新的资源决定。


---

## 4. 阻塞项（如实记录，不在配置侧绕过）

这三项是在写计划过程中**实测**出来的，不是推测。任何一项都足以让 S1 的 live run 在预检阶段被拒。

### 4.1 本地服务：无法表达「不需要凭据」

**现象**：`liveProblems()` 对每个 decision target 都执行 `credentialRefOf(target)`，然后 `(env(resolved.ref) ?? '').length === 0` 判为不可路由。本地服务的正确配置是**没有凭据**，其 `credentialRef` 与 `decision.apiKeyRef` 都为空字符串 —— 此时报出的是：

```
a live run needs ; refusing to start without it
```

注意分号前是空字符串，说明拒绝针对的就是「没有引用名」这件事本身。

**实测方式**（`pnpm evals:plan` 对 `pilot.json` 通过，但 `liveProblems` 直接调用返回 3 条问题，其中 2 条是这个空引用，另 1 条见 §4.2）：

```
pilot: 3 preflight problem(s) with both credentials set
   - a live chat cell needs the host LLM service, ...
   - a live run needs ; refusing to start without it
   - a live run needs ; refusing to start without it
```

**为什么不能在配置里绕过**：填任意占位字符串能让预检通过，但随后 `liveDecision` 会把它当真实凭据发成 `Authorization: Bearer`，请求失败，且让记录里出现一个假的凭据引用名。这违反「不把凭据写入 repo」和「不以未知／未执行证据声明通过」两条。

**归属**：`evals/src/run/commands.ts` 与 `evals/src/run/backends.ts`，属 RQ-10 的实现边界，本任务写入范围不含 `evals/src/run/`。**建议**：把「未命名凭据」与「命名了但未设置」区分开 —— 前者是 endpoint 不需要凭据（合法），后者才是拒绝理由。

### 4.2 chat target：运行器拿不到宿主 LLM 服务

**现象**：`liveProblems()` 在 `plan.protocols` 含 `chat` 且 `llm === null` 时直接拒绝整次运行：

```
a live chat cell needs the host LLM service, which this command does not have;
run a chat plan offline, or reach a chat model through a decision endpoint
```

CLI 的 `RunIo` 构造（`evals/src/cli/run.ts` 的 `runCommand`）**不传 `llm`**，因为 CLI 进程里没有宿主会话。`RunIo.llm` 是存在且被完整使用的（`backends.ts` 的 `liveChat` 会用它包一层 `boundedStream`），但唯一能提供它的路径是**在宿主进程内调用 `executeRun`**，而当前没有任何宿主侧入口这么做。

**核实结论**：#74 实现了 `llm` 通道的**接缝**，没有实现**接线**。「chat 走宿主 `ctx.llm.stream()`，复用宿主 provider 凭据」这个设计成立，但当前只有离线路径可用。

**归属**：需要宿主侧的运行入口（新代码），或在 RQ-15 明确改为「chat 走离线」或「chat 改为通过 decision 端点」。本任务不新增该入口。

### 4.3 全量：6 候选不能乘进一份 run plan

**现象**：`run-plan.schema.json` 没有候选／变体字段，`planProblems` 也不接受；运行器 `execute.ts` 直接 `import { review }`，而 `review()` 固定使用 `PRODUCTION_PACKAGE` = RQ-14 的候选 A。用户给的「6 候选 × 52 格 × 2 协议 × 2 repeats」中的 52 格本身是对的（13 dev 案例 × 2 协议 × 2 repeats），但**候选维度不在这个文档里**。

**因此**：`full.json` 描述**一个候选**。6 个候选是 6 次同形计划的 6 次运行，其中只有候选 A 能通过当前运行器发出；B/C1/C2/C3/C4 需要 `reviewWith(package)` 的实验入口。

这是**能力边界**，不是通过调大上限能解决的问题。已写进 `full.json` 的 notes。

---

## 5. 凭据如何表达

**repo 里只有引用名，没有一个字节的值。**

| 位置 | 内容 | 例子 |
| --- | --- | --- |
| `targets[].credentialRef` | 环境变量名 | `"CLOUDFLARE_API_TOKEN"` |
| `targets[].decision.apiKeyRef` | 同一个名字（两处必须一致，`credentialRefOf` 会核对） | `"CLOUDFLARE_API_TOKEN"` |
| 本地服务 | 两者皆空字符串 | `""` |
| chat target | 两者皆 `null` | `null` |

解析发生在**派发时**：`evals/src/run/backends.ts` 的 `liveDecision` 用 `read(ref)` 从环境取，然后作为 `preResolvedCredential` 交给传输层；传输层用它发请求并把它加入脱敏列表，所以记录里的完整响应已遮蔽该值。repo 里既没有读取 `~/.keys` 的代码，也没有任何键值。

**操作方式**（由 RQ-15 执行，本任务不执行）：

```sh
export CLOUDFLARE_API_TOKEN="$(cat ~/.keys/.cf.local.key)"
export TYPESAFE_API_KEY="$(cat ~/.keys/.jev.local.key)"
```

两个源文件在本机实测存在（53 与 107 字节），但本任务**没有读取其内容**、没有验证其有效期内与否。「凭据可用」这件事需要在 S1 里被真实证明，不能由文件存在推断。

---

## 6. 连通性状态：区分「用户实测」与「本任务实测」

这一节的目的是不让读者把不同来源的证据混成一个。

| 项 | 状态 | 证据来源 |
| --- | --- | --- |
| 5 个 decision 端点 HTTP 200 | **用户实测** | 用户于 2026-10-30 逐一验证并告知；本任务未复现（真实调用属 #82） |
| 本地服务在 127.0.0.1:8000 监听 | **本任务实测** | `nc -z 127.0.0.1 8000` 成功；监听进程为 `python3`（PID 41430） |
| `api.cloudflare.com:443` / `api.typesafe.ai:443` TCP 可达 | **本任务实测** | `nc -z` 均成功 |
| 两个凭据文件存在 | **本任务实测** | 文件存在性已确认；**未读内容、未验证有效性** |
| 经生产适配器拿到合法公共评分 | **未验证** | 这是 #82 的验收项，本任务不做调用 |
| Cloudflare 与 TypeSafe 两种返回体都能解析 | **未验证** | 代码路径已就绪（`decisionAnswers` 同时读 `result.answers` 与根级 `answers`），但没有真实样本 |
| 2 个 chat target 可用 | **未验证且当前不可执行** | 见 §4.2 |

**TCP 可达不等于协议可用。** 上面的网络探测只能证明「不是 DNS 或防火墙问题」，不能证明信封正确、凭据有效、返回体可解析。真正的连通性证明只在 S1 里产生。

---

## 7. 试点与全量

### 7.1 S1：试点

**目的**：确认 7 个 target 全部连通、流程无系统性问题，再用同一批可比数据扩展。
**规模**：dev 内 10 条案例，7 targets，repeats 1，**70 个可发送格子，204,148 估算输入 tokens**。

**案例选择依据**：全部取自 `dev` 家族，因为 dev 材料最简、不含 hint，最适合验证「流程通不通」而不是「判断准不准」。具体 10 条按家族分摊，覆盖 5 个 dev 家族的边界：

| 家族 | 案例 | 为什么选 |
| --- | --- | --- |
| `dev-ordinary-read` | `read-named-source-file`、`read-repo-index-with-cache` | 常规只读，最低风险的对照组 |
| `dev-routine-cleanup` | `cleanup-stale-cache-dir`、`cleanup-rebuildable-cache` | 数据删除／恢复，同命令只改是否需重建 |
| `dev-deletion-backup` | `delete-generated-output-no-permission`、`delete-generated-output-authorized` | 授权有无的一对，验证 A 档能分开 |
| `dev-credential-egress` | `private-key-upload`、`sample-log-upload-authorized` | 高风险外发与低敏感外发，验证 R 档能分开 |
| `dev-low-risk-prohibition` | `prohibited-config-reformat`、`unrequested-config-reformat` | 低风险但有／无禁止，验证「低风险不自动放行」 |

这个 10 条的选择**遗漏了 3 条** dev 案例：`delete-generated-output-restorable`、`delete-uncommitted-drafts`（同属 `dev-deletion-backup`）、`authenticated-internal-api-call`（`dev-credential-egress`）。试点只验证流程，不需要家族内全覆盖；这三条在 S2 全部补上。上表删除了其中一条的备注以免读者以为只漏了一条。

**通过标准**（写清楚才能判失败）。六项都用**运行记录里的字段**判定，不用「HTTP 200」「路由存在」这类替代品：

1. 5 个 decision target **各自**至少一个 cell 满足 `status === 'reviewed'` 且 `outcome.status === 'scored'`；
2. 2 个 chat target **各自**至少一个 cell 同样满足 `status === 'reviewed'` 且 `outcome.status === 'scored'`。

   「连通」不是判据。`reviewed` 只说明派发过并拿到响应；如果模型文本没能被生产解析器读成两个合法分档，记录仍是 `reviewed`，`outcome.status` 却是 `review-failure`。能用 HTTP 200 或「宿主路由存在」通过的检查证明不了这件事，也证明不了这些 chat 记录能进 S2 的三层比较。transport／provider／parse 失败一律不算这一项通过。
3. 两种返回体形态（Cloudflare `result` 包裹、TypeSafe 根级 `answers`）都实际被解析成功 —— 判据同上，各至少一条 `scored`；
4. 70 个 unsupported 格子全部如实记录 `unsupported`，没有一条变成 `failed` 或伪造判定；
5. 无 `budget-exhausted`（若出现，说明预留算错，应先修再跑全量）；
6. 全部 70 个可发送格子里，**没有** `status` 为 `failed`／`timeout`／`cancelled` 的格子。有则不通过 —— 试点就是用来暴露这类问题的，带着它进 S2 只会让 182 格的对照被同样的故障污染。

任一项不满足 → 停下，交窗口判断，不进入 S2。第一轮不通过的项允许在 §3.3 的重跑额度内再试一轮。

### 7.2 S2：全量（单候选）

**前置**：S1 六项全部通过。**规模**：dev 全部 13 条，repeats 2，**182 个可发送格子，535,220 估算输入 tokens**。

选 `dev` 而不是 `dev + calibration`：`dev` 是 RQ-14 冻结矩阵使用的 split（`rq14-matrix.json` 的 `dataset.split` = `dev`，52 格 = 13 × 2 × 2）。跟随它，才能让 S2 的运行结果与已冻结的实验定义**逐格可比**。`calibration` 留给 #82 按需扩展，`holdout` 保留给最终候选验证（设计文档 3.3 的家族隔离要求）。

**repeats 2 的理由**：设计文档 3.2 要求「分开重复试验、修复重试和缓存复用」。1 次重复无法区分模型方差与系统差异；2 次是最小可行值，能在 182 格上给出「同格两次是否一致」的证据。#82 若要 3 次以上，应作为新的一次预算决定。

---

## 8. 重试策略

三类「再次请求」被严格区分，因为它们的含义和计费都不同：

| 类型 | 谁发起 | 是否独立观测 | 计数方式 |
| --- | --- | --- | --- |
| **修复重试**（repair） | 生产传输层，答案不可读时 | 否 | 同一 cell 的第二个 attempt，`kind: 'repair'`，计入用量与 `maxAttempts`，不计入稳定性样本 |
| **独立重复**（repeat） | 计划（`repeats`） | 是 | 不同的 cell（`~r2`），是真正的第二个观测 |
| **续跑**（resume） | 操作者 `--resume` | 否 | 只补没有记录的格子；已有记录不改写、不重发、不重复计费 |

**运行器不重试 cell。** 一个 cell 失败就留下失败记录 —— 重试会是计划没要求的第二个观测。要更多观测，就在计划里加 `repeats`。

`maxRepairRetries` 设为 1（chat target），与生产默认一致（`src/config/defaults.ts` 的 `maxRepairRetries: 1`）。decision 协议没有修复重试的机制（单次 fetch）。

---

## 9. 与其他任务的关系

| 任务 | 关系 |
| --- | --- |
| RQ-10（#74） | 提供运行器与 `pnpm evals:plan`。本文件 §4.1／§4.2 的两项阻塞在其范围内 |
| RQ-14（#81） | 提供冻结的 6 候选矩阵与 629 请求预算。本文件 §4.3 说明候选轴无法进入 run plan |
| RQ-H1A（#79） | 用户组织标注、提交最终参考答案。与本任务同窗口，互不阻塞 |
| RQ-15（#82） | 消费本文件的决定与两份计划；负责真实调用、试点验收与结果报告 |
| RQ-H2 窗口二 | 在 S2 结果之后集中裁决候选方案与验收线 |

本任务**不做任何真实模型调用**。上面的 token 数是渲染器估算，格子数是计划展开结果，连通性只有 TCP 层与文件存在性被实测。

---

## 10. 未解决项

1. **§4.1 空凭据引用被拒** —— 阻塞本地服务 2 个 target。需 RQ-10 修复，本任务写入范围不含 `evals/src/run/`。
2. **§4.2 chat 无宿主 LLM 入口** —— 阻塞 2 个 chat target。需宿主侧运行入口或在 RQ-15 改口径。
3. **§4.3 候选轴缺失** —— 6 候选比较需 `reviewWith(package)` 实验入口，当前只能跑候选 A。
4. **chat 的 provider／model id 待复核** —— §2.2 的表来自本机 session 记录推断，不是 `listProviders()`／`listModels()` 的返回值。派发前必须复核。
5. **凭据有效性未验证** —— 只确认文件存在，未读内容、未验证是否仍有效。
6. **货币上限未验证** —— 运行器不代币定价，且配额失败不会停止派发（`scheduler.ts` 无 quota 停止原因）。§3.3.4 要求派出付费请求前先确认 provider 侧硬上限；未确认前付费 target 为 blocked。`maxCurrency` 保持 `unknown`，精确花费由 #82 事后从账单回填。
7. **累计 token 估算少计 repair** —— `spendOf` 按 cell 只计一次初次渲染估算，repair 重复发送不计入。因此 5,200,000 是估算基线而非硬上限；精确核算须用 `evals/src/metrics/usage.ts` 的按 attempt 汇总（#82 执行后）。
8. **§2.3 无同模型双协议 target** —— 设计文档 3.2 的该项对比在本候选集上不可执行，只能记录系统组合差异。
9. **累计 attempts 靠操作者核对，运行器不强制** —— §3.3 的 2,300 不是 `bounds` 字段，运行器不认识它。每次起跑前必须手工汇总各 run 的 `index.json` 的 `spent.attempts`。要让它自动生效需要一个跨 run 的账本（工程任务，不在本窗口）。
10. **`concurrency: 4` 未经限流实测** —— 没有四路并发下 provider 限流行为的证据。它是运营初值，不是已验证吞吐；若试点出现 429，应降到 1–2 重跑，属 §3.3 重跑额度内。
11. **`timeoutMs: 30000` 对 decision 端点无实测依据** —— 生产默认 20,000 的实测数据只覆盖 chat（`src/config/defaults.ts` 的注释引用 #22）。decision 延迟与超时率在试点中首次测量。
