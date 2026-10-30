# RQ-15 真实调用日志（逐步追加）

所属：RQ-15（#82），Parent #64。设计依据：[审查质量与评测方案](../../../docs/milestones/review-quality-and-evals.md) 3.2／3.3／6。
输入决定：[RQ-H1B 资源与预算](../resource-decision.md)。

本文件记录**每一次真实调用**的发出时间、目标、结果类别、provider 自报用量与费用，以及所有偏离计划的地方。它是报告的原始账本；[report.md](report.md) 从它和运行产物重建结论。凡是**未执行**的项目写成 `not-run`，不用估算值填充。

---

## 0. 环境与前置

| 项 | 值 | 证据 |
| --- | --- | --- |
| checkout | `.local/worktrees/rq-15`，分支 `feat/review-quality-rq15-pilot` | `git rev-parse --show-toplevel` |
| 基线 | `origin/main` = `6ffadac` | `git log --oneline origin/main -1` |
| 凭据来源 | `~/.keys/.cf.local.key`、`~/.keys/.jev.local.key`、`~/.keys/.deepseek.local.key`，仅在 shell 中 `export`，**不写入 repo** | 见 §0.1 |
| 本地 Clef 服务 | `127.0.0.1:8000` 正在监听（`python3.1`，PID 41430） | `lsof -nP -iTCP:8000 -sTCP:LISTEN` |
| 计划文件 | `evals/experiments/run-plans/pilot.json`（候选 A）、`pilot-b.json`（候选 B） | 本文件 §2 起逐次记录 `planHash` |

### 0.1 凭据处理

凭据值**从未**写入仓库、运行记录或本文件。计划文件只写环境变量名（`CLOUDFLARE_API_TOKEN`、`TYPESAFE_API_KEY`、`DEEPSEEK_API_KEY`），本地两个 target 的引用名为空字符串，表示"该端点不做认证"。真实调用前在 shell 中：

```sh
export CLOUDFLARE_API_TOKEN=$(cat ~/.keys/.cf.local.key)
export TYPESAFE_API_KEY=$(cat ~/.keys/.jev.local.key)
export DEEPSEEK_API_KEY=$(cat ~/.keys/.deepseek.local.key)
```

运行器在派发时从环境解析，并把它加入响应脱敏列表。核验方式：对每个运行目录做三个键值的全文字面检索。

**核验结果**（步骤一、步骤二完成后）：`smoke` 与 `probe` 两个运行目录对三个键值各自 **0 命中**。

---

## 1. 步骤一：单 target 单案例（1 次请求）

目的：在跑规模之前证明接线能真正发出一次请求并被生产解析器读成合法分档。

| 项 | 值 |
| --- | --- |
| 计划 | `.local/evals/plans/smoke.json`（由 `pilot.json` 裁到 1 target × 1 case，不入库） |
| `planHash` | `sha256:a03309de86736aefb806d15e447e0319b9e840a882f5d67a9d712dea7da45159` |
| target | `clef-local`（`http://127.0.0.1:8000`，无凭据） |
| case | `read-named-source-file` |
| 运行目录 | `.local/evals/runs/core-v1/smoke` |
| 请求数 | **1**（`spent.attempts` = 1） |
| 结果 | `status: reviewed`，`outcome.status: review-failure` |
| provider 自报 | `input_tokens 3078`、`output_tokens 0` |
| 耗时 | 18,342 ms（`attempts[0].durationMs`） |
| 估算输入 | 2,827 tokens（渲染值） |
| 费用 | `cost.amount: null`／`not-computed`（运行器不代币定价；本地服务 `costTier: free`） |

**发现的第一个真实问题**：本地 Clef 返回的 `risk.probabilities` 十档之和为 `0.9999`（十进制精确值），生产归一化用 `SUM_TOLERANCE = 1e-4` 判 `|Σ-1| > 1e-4` 即拒绝。十进制下恰为 `0.0001`，处在边界；浮点累加得 `0.00010000000000010001`，因此**被判为超差**。

这不是接线问题，而是**输入数据的数值形态问题**，且它决定本地两个 target 的全部结果类别。记录为 `review-failure`／`probability-sum-not-one`，不伪造成合法分档，也不调整容差来把它洗成通过。

---

## 2. 步骤二：六 target 各一次（6 次请求）

目的：在跑 120 次之前，一次性确认六个 target 是否各自可达、信封形态是否都被生产解析器读通。

| 项 | 值 |
| --- | --- |
| 计划 | `.local/evals/plans/probe.json`（1 case × 6 targets，不入库） |
| 运行目录 | `.local/evals/runs/core-v1/probe` |
| 请求数 | **6**（`spent.attempts` = 6） |
| 估算输入合计 | 16,871 tokens |
| provider 自报输出 | 110 tokens |
| 墙钟 | 12.7 s（`createdAt` → `updatedAt`，并发 1） |

逐 target 结果：

| # | target | 信封形态 | `status` | `outcome` | 判定 | 耗时 | provider 自报 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `clef-local` | wrapped | reviewed | **review-failure** | `probability-sum-not-one` | 1,774 ms | in 3078 / out 0 |
| 2 | `clef-flash-local` | wrapped | reviewed | **review-failure** | `probability-sum-not-one` | 7,039 ms | in 3078 / out 0 |
| 3 | `clef-cloudflare` | flat | reviewed | **scored**（allow） | 合法十档 | 1,026 ms | in 3078 / out 0 |
| 4 | `clef-flash-cloudflare` | flat | reviewed | **scored**（allow） | 合法十档 | 1,007 ms | in 3078 / out 0 |
| 5 | `jev-1-13-0` | flat | reviewed | **scored**（allow） | 合法十档 | 753 ms | in 3076 / out 30 |
| 6 | `deepseek-v4-1-flash` | chat SSE | reviewed | **scored**（allow） | 合法十档 | 999 ms | in 2605 / out 80 |

**这一步确认的能力**：

1. **两种返回体形态都被真实解析成功** —— Cloudflare 的 `result` 包裹（#3/#4）与 TypeSafe 的根级 `answers`（#5）各至少一条 `scored`。这是资源决定 §7.1 第 3 项要求、而 §6 记录为"未验证"的那一项，现在**已验证**。
2. **headless chat 接线可用** —— `deepseek-v4-1-flash` 经新增的 `chat-service.ts` 真实拿到 200 与流式 SSE，生产解析器读出合法两档，`outcome.status` 是 `scored` 而不是 `review-failure`。资源决定 §4.2 记录的阻塞**已解除**。
3. **无凭据 target 可派发** —— #1/#2 没有发送 `Authorization` 头也能拿到响应，§4.1 的阻塞**已解除**；它们失败的原因与凭据无关。

**这一步发现的第二个真实问题**：DeepSeek 报告的 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` 在 `review-usage-v1` 映射里**没有对应字段**，因此 `cacheReadTokens` 记为 `null`（未知，不是 0）；原始负载保留在 `attempts[].rawUsage` 以便后续重归一化。这是**映射覆盖缺口**，不是运行失败，但意味着本试点的缓存命中率只能从 `rawUsage` 手工读，不能从聚合字段读。

**这一步发现的第三个真实事实**：provider 对 decision 端点返回的 `output_tokens` 恒为 0（#1–#4），而响应正文实际有 5,496 字符。这**不是模型没输出**，而是这些端点的计费/用量字段只报输入，或把输出计入别处。据此**不能**用 `output_tokens` 算 decision 端点的输出成本；本报告在费用一节按 provider 账单口径处理，缺证据的写成未知。

---

## 3. 步骤三：试点主体（待填）

按 `pilot.json`（候选 A）与 `pilot-b.json`（候选 B）各 60 个可发送格子执行。本节在每个 run 完成后立即追加真实数字。

（尚未执行 —— 见 §4 的前置说明。）

---

## 4. 费用与配额

待填。

---

## 5. 未执行项（`not-run`，不折算成通过）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `pnpm check:build` | not-run | 本机 `ERR_SQLITE_ERROR`，与本次改动无关的环境故障；其余除 build 外的检查全部执行并通过 |
| `pnpm evals:replay` | 待评估 | 只有在存在保存的响应时才有意义；需在试点跑完后对真实运行目录执行 |
| 缓存命中率的聚合读数 | not-run | 见 §2 第三个发现：`review-usage-v1` 未覆盖 DeepSeek 的缓存字段 |
| 货币金额 | unknown | 运行器不代币定价（`cost.status: not-computed`），且试点期间未取得 provider 账单 |
