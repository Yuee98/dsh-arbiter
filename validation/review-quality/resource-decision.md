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

1. **7 个 target 里 5 个可用**：3 个 decision target 具备今天就能跑的条件（本地 `clef`、`clef-flash`，以及 TypeSafe `jev-1.13.0`），Cloudflare 两个只差一次凭据端到端实测。**2 个 chat target 今天跑不了** —— 运行器没有宿主 LLM 服务入口，这是 RQ-10 的边界，不是配置问题（§4.2）。
2. **本地服务今天也跑不了**：运行器的 live 预检不接受空凭据引用名，而本地服务恰恰不需要凭据（§4.1）。这是必须由工程任务修掉的缺陷，不能在配置侧绕过。
3. **全量不能按「6 候选」直接相乘**：run plan 没有候选轴，运行器只调用生产 package（= RQ-14 的候选 A）。6 候选 × 52 格的比较需要 RQ-14 的实验入口（§4.3）。
4. 在以上前提下，**S1 试点可发送 70 格、204,148 估算输入 tokens**；S2 全量（单候选、dev、2 repeats）**可发送 182 格、535,220 估算输入 tokens**。这两组数字是今天真实可能的规模，不是理想规模。

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
| `maxAttempts` | **180** | **234** | 见下 |
| `maxInputTokens` | 20,000 | 20,000 | 单条请求的输入上限。本批最大单请求实测 3,059（S1）／3,084（S2），余量充足；设 20,000 是为了让一个异常大的案例被**拒绝发送**，而不是悄悄发出去 |
| `context.maxInputTokens` | 10,000 | 10,000 | 沿用生产默认。实测无一条案例被裁剪（S1 与 S2 的 truncated segments 均为 0） |

**`maxAttempts` 的算法**（不是估的，是按运行器的预留规则算的）：

- decision cell 永远只发 1 次（`attemptCeilingOf` 对 decision 固定返回 1，`runDecisionTransport` 只做一次 fetch）；
- chat cell 的最坏开销是 `1 + maxRepairRetries` = `1 + 1` = 2。

| 阶段 | decision cells | chat cells | 最坏 attempts | 取值 | 余量 |
| --- | --- | --- | --- | --- | --- |
| S1 | 10 × 5 × 1 = 50 | 10 × 2 × 1 = 20 | 50 + 20×2 = **90** | **180** | 90（100%） |
| S2 | 13 × 5 × 2 = 130 | 13 × 2 × 2 = 52 | 130 + 52×2 = **234** | **234** | 0 |

S1 的 180 是**刻意的 2 倍余量**：试点第一次跑通 7 个 target，失败多半来自连通性／凭据／信封判断错误，需要重跑。余量给到这个程度，一次配置修正不必重新授权。

S2 的 234 **没有余量**，这是有意的：全量阶段已经由试点确认流程，任何需要重跑的情况都说明出现了系统性问题，应该停下来交人判断，而不是自动再烧一份全额。

**「超了自动停」的落地**：超过 `maxAttempts` 时运行器停止派发并把剩余格子记为 `budget-exhausted`，退出码非 0，已完成的记录保留、可续跑（`--resume`）。所以「自动停」是**运行器行为**，不需要外部监控来拔插头。

### 3.2 总额与余量用途

| 阶段 | 可发送格子 | 估算输入 tokens | 备注 |
| --- | --- | --- | --- |
| S1 试点 | 70 | **204,148** | 2×28,514（chat）+ 5×29,424（decision），repeats 1 |
| S2 全量（单候选） | 182 | **535,220** | 2×2×37,385 + 5×2×38,568，repeats 2 |

两份计划的 token 数是**用生产渲染器量出来的**（`evals/src/run/material.ts` 的 `caseMaterial` → `request.estimatedInputTokens`），不是按字符数估的。运行器只记录实际 usage，不代币定价（`cost.amount` 恒为 `null`，`cost.status` 说明原因），所以本文件**不给货币金额**：给了就是编的。

余量用途，按优先级：

1. **试点失败重跑**（S1 的 90 attempt 余量）；
2. **修复重试**：chat 每个 cell 自带一次，已计入 2×；
3. **配额用尽后的续跑**：余额到顶时运行中断，已完成的记录保留；补足后 `--resume` 只跑缺的格子，不重复计费；
4. **不用于新增实验候选**。要跑第 2–6 个候选，属于新的一次资源决定。

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

`dev-deletion-backup` 与 `dev-credential-egress` 各少取一条（`delete-uncommitted-drafts`、`authenticated-internal-api-call`），是因为试点只验证流程，不需要家族内全覆盖；这两条在 S2 补上。

**通过标准**（写清楚才能判失败）：

1. 5 个 decision target **各自**至少一个 cell 产出 `reviewed` 且 `outcome.status === 'scored'`；
2. 两种返回体形态（Cloudflare `result` 包裹、TypeSafe 根级）都实际被解析成功；
3. 2 个 chat target 连通（**前置 §4.2 修复**）；
4. 70 个 unsupported 格子全部如实记录 `unsupported`，没有一条变成失败或伪造判定；
5. 无 `budget-exhausted`（若出现，说明预留算错，应先修再跑全量）。

任一项不满足 → 停下，交窗口判断，不进入 S2。

### 7.2 S2：全量（单候选）

**前置**：S1 五项全部通过。**规模**：dev 全部 13 条，repeats 2，**182 个可发送格子，535,220 估算输入 tokens**。

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
6. **货币金额未估算** —— 运行器不代币定价，本文件不编造价格。S1／S2 的实际花费只能事后从 provider 账单读取。
7. **§2.3 无同模型双协议 target** —— 设计文档 3.2 的该项对比在本候选集上不可执行，只能记录系统组合差异。
