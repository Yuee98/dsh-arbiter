# A. 工程结果：六项宿主流程的逐项证据

所属：[#87](https://github.com/Yuee98/dsh-arbiter/issues/87)。返回 [交付报告索引](README.md)。
本文件只记录**工程条件**（实现存在 + 行为测试存在 + 本机实际执行），不记录模型质量。

执行环境：isolated DSH profile（`tests/e2e/dsh/profile.ts` 的 `createIsolatedProfile`），临时 `DSH_HOME`、临时 workspace、系统分配端口。**不读取也不修改日常 `~/.dsh`**；全部用例使用确定性 reviewer 桩，不发送模型请求（`tests/e2e/agent-guidance.spec.ts` 通过 `requestDir` 记录实际请求体）。

日期：2026-10-31。checkout：`.local/worktrees/rq-19`，分支 `feat/review-quality-rq19-acceptance`，基线 `569f1ee`。

---

## 0. 执行摘要（先看这张表）

| 项 | 命令 | 结果 | 状态 |
| --- | --- | --- | --- |
| `pnpm verify` | `pnpm verify` | 12/14 步 passed；`check:build` 环境阻塞；`check:regressions` 由前者短路 | **passed（12 步）／blocked（环境：`check:build`）** |
| `check:build` 单独重跑 | `pnpm run check:build` | 同一 `ERR_SQLITE_ERROR`；已定位为 pnpm store 不可写（§2.2） | **blocked（环境）** |
| `check:regressions` 单独重跑 | `pnpm run check:regressions` | **退出码 0**，S1–S3 三条 PASS，R1–R9 判定为已退役 | **passed** |
| `pnpm test:e2e:dsh` | `pnpm test:e2e:dsh` | 59 用例，**47 passed / 12 failed** | **blocked（环境）**：见 §3.1 |
| E2E 按开发基线补齐固定运行时后重跑 | 见 §3.2 | 59 用例，**54 passed / 5 failed** | **blocked（环境）**：见 §3.3 |

**两条都不能省略**：§3.1 是 issue 要求的原始命令的真实记录；§3.2 是同一命令在满足 `docs/development-baseline.md` 前置条件后的结果。把它们合并成一条会掩盖「12 个失败里有 7 个是可修配置缺失」这一事实，而只报 §3.2 会掩盖「按 issue 原样执行时并不通过」。

> **未把任何一项写成 passed**：`check:build` 是 `blocked（环境）`，完整 E2E 是 `blocked（环境）`。
> **未引用 CI 通过代替本机记录**：本文件不出现「CI 通过，所以本机视为通过」的表述。

---

## 1. 六项宿主流程验收

六项对应 issue #87「范围」第一条。每项给出验证点、真实执行的用例、以及可复核的证据位置。

### 1.1 主子会话

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| 子会话的工具调用进入 `tools/pre-execute` | **passed** | `tests/e2e/session-admission.spec.ts:697` *a subagent inherits an enabled parent and an unmanaged session stays ungated* —— 真实 delegation（`ADM-DELEGATE`）产生的子会话里出现 `plugin:arbiter/decision` 记录，且第一条含 `deny-rule`（子会话的工具调用确实被 gate 判定过） |
| `parentSession` 存在 | **passed** | 同上，用例以 `candidate.header?.['parentSession'] === parent.sessionId` 为等待谓词，即断言子会话 header 携带父会话 id 且该 id 就是父会话 |
| `delegationDepth` 存在 | **passed（读取侧）／not-run（真实宿主深度值）** | 读取侧：`tests/e2e/context-sources.spec.ts:431` 以 `delegationDepth: 1` 构造真实 `Session`，`snapshot` 正确产出父会话证据链（V4、V7 两项 check 通过）。真实 delegation 的 header 中**本机未单独断言 `delegationDepth` 的数值**——`session-admission` 的谓词只看 `parentSession`；`tests/e2e/dsh/session-log.ts:117` 的注释说明三字段共同界定 subagent，但用例未逐字段断言 |
| 父会话的裁决不被子会话冒充 | **passed** | 同上，`parentDecisions.some(entry => entry.includes('subagent'))` —— delegation 这次调用记在父会话名下，按父模式审查 |
| 子会话自身的 host 决策未被插件改写 | **passed** | `childModes` 断言恰为 `[{ mode: 'workspace-write', source: 'delegation' }]` |

**实现链接**：`src/host/common.ts:15`（`origin === 'subagent' || parentSession !== undefined` 判定会话类别）、`src/host/admission-narrow.ts:26`、`:47`、`src/host/permissions.ts:104`。

> **准确边界**：`delegationDepth` 在本仓库的 `src/` 里**只有类型声明**（`src/snapshot/types.ts:6`），没有任何读取或判定逻辑使用它。它是宿主 header 的一个字段，插件的会话类别判定用的是 `parentSession`／`origin`。因此「`delegationDepth` 存在」只在「宿主写入、测试可读」的意义上成立，**不声称插件依赖它**。

### 1.2 ask / no-ask

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| 两种模式共用同一矩阵 | **passed** | `tests/integration/decision-chain.test.ts:377` *normal and strict reach the same review verdict*（在 `describe('mode equivalence on the real gate')` @ `:376` 内）—— 同一分数 `risk 5 / authorization 9` 在 `ask` 与 `no-ask` 下都得到 `allow` 且 trace 都含 `review-allow`；`tests/review-contract/matrix.test.ts:244` 的 `test.each` 覆盖 `stage × ask × channel` |
| 无 ask 时 `review-escalate` → `fallback-deny` | **passed** | `tests/review-contract/matrix.test.ts:244` 的 `test.each`（`review-escalate` × `no-ask` → `fallback-deny`）；`tests/integration/decision-chain.test.ts:794` *a subagent and a host-pinned never policy both fall back*（在 `describe('missing approval channel')` @ `:793` 内），断言子会话的拒绝理由含 `fallback-deny` 与 `automatic_mode_no_human` |
| 无 ask 时 `error-escalate` → `fallback-deny` | **passed** | 同上（`error-escalate` × `no-ask` → `fallback-deny`）；`tests/review-contract/matrix.test.ts:283` *a fallback keeps the stage and the reason too* |
| 无 ask 时 `force-ask` 走 fallback-deny | **passed** | `tests/integration/decision-chain.test.ts:457` *a fallback denial is not written when the call was cancelled* —— 该用例把 `force-ask` 规则 + `no-ask` 作为「最短的兜底拒绝路径」，断言 `storedTrace('m-force-control')` 恰为 `['force-ask', 'fallback-deny']`（`:505`） |
| 真实宿主中的模式切换 | **passed** | `tests/e2e/config-lifecycle.spec.ts:283` *an external patch replacement applies through the same validation path*（`main: 'no-ask'` 经外部 patch 生效并被读回）、`:319`，两项在 §3.2 的运行中通过 |
| 三档模式下 agent 仍可 ask，且答复不记成 human-allow | **passed** | `tests/e2e/agent-guidance.spec.ts:769` —— 在 `ask` 与 `no-ask` 各跑一次真实 ask 卡片交互，断言 `decision['result'] !== 'human-allow'`（在 §3.2 的运行中通过） |

**实现链接**：`src/review-contract/matrix.ts:60`（`AskPolicy`）、`:91`（`settle`）、`src/config.ts:121`（`askPolicyForSession`）、`src/config/defaults.ts:32`（`{ main: 'ask', subagent: 'no-ask' }`）、`src/host/gate.ts:319`。

### 1.3 规则

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| 确定性规则命中 | **passed** | `tests/e2e/rules-format.spec.ts:111` 真实宿主中 `deploy` + `environment: production` 命中 deny 规则（`path === 'deny'`，`rules === [{ id: PRODUCTION_RULE.id, outcome: 'match' }]`），`environment: staging` 不命中；**本机通过** |
| 规则测试与运行时一致 | **passed** | `tests/e2e/gate-real.spec.ts:426` *the plugin gate and the tester agree on a tool-argument rule*、`:471` 引号参数用例；**补齐固定运行时后通过**（§3.2） |
| 优先级 `deny > force-ask > force-review > allow` | **passed（UI + 单元）／blocked（真实 gate 全链）** | UI：`tests/e2e/rule-test-panel.spec.ts:87` 的 *the editor entry focuses the tester and both conclusions are shown*，断言整份草稿的最终路径是更高优先级的 `force-ask`（`data-arbiter-test-path="force-ask"`）而聚焦规则自身是 `match`——**本机通过**；`tests/e2e/rule-test-panel.spec.ts:210` 的 *a rejected selector locates the condition that owns it*（选择器错误定位）也在本机通过，但它不验证优先级。单元：`tests/rules-draft.test.ts:156` *keeps the fixed precedence in evaluator order*、`:243` *never crosses into another verdict priority* |
| 结算侧把规则裁决按同一顺序映射 | **passed** | `src/policy.ts:107-145` —— `deny` 压过一切、`force-ask` 需真人、`allow` 跳过审查、`force-review` 与未命中都进审查；`src/policy.ts:126`／`:128`／`:143`／`:145` |

**实现链接**：`src/policy.ts:120`（`settleRule`）、`:41`（`stageOf`）、`:88`（`settleOutcome`）。

> **本条的真实 gate 全链证据是 `gate-real.spec.ts`**，它需要固定运行时才能跑。补齐后通过（§3.2 第 18、19 号用例）。规则测试面板（`rule-test-panel`、`rules-editor`）只覆盖求值器，不覆盖真实 `tools/pre-execute`。

### 1.4 授权

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| 跨 turn 的人类授权保留 | **passed** | `tests/e2e/context-sources.spec.ts:359` 的 V16 check：`snapshot.evidence` 同时含 `turn === 1` 且 `evidence === 'explicit'` 的早期许可、与 `turn === 2` 的新消息——早期 turn 的许可没有被当前 turn 挤掉。**补齐固定运行时后通过**（§3.2） |
| 授权证据带来源层级 | **passed** | 同用例 V4 check：`parent-relay` 恰 1 条且不含 sibling 转述；`sourcePriority` 落库（`src/snapshot/evidence.ts:428`） |
| 转述不能提升授权层级 | **passed** | 同用例 V4 + `src/snapshot/evidence.ts:410-428`：`parent-relay` 的 `evidence` 是 `implied`，兄弟会话的转述被排除 |
| 父会话人类原话不被降级 | **passed** | 同用例 V7 check：`parentAuthorizationPresent === true`，且**不是**从 relay 推断出来的 |
| ask 答复只绑定它回答的那次调用 | **passed** | 同用例 V3 check（timed `user-question-reply` 映射 `askCallId === 'ask-late'` 与 `question`）；`tests/e2e/agent-guidance.spec.ts:769` 的 `waitForAnswer(host, sessionId, question)` 以 callId 为身份，断言早先的授权结果不能顶替本次 |
| 压缩摘要不产生授权 | **passed** | 同用例 V5 check：`checkpoints.length === 1` 且摘要文本**不**出现在 `evidence` 里 |

**实现链接**：`src/snapshot/evidence.ts`（`parent-relay` 与保底位）、`src/snapshot/window.ts`（turn 窗口）、`src/snapshot/completeness.ts`（M0 分类）。

> **`context-sources.spec.ts` 的性质**：它用宿主自己的 `Session`／`llm` 构造真实事件（`createUserMessage`、`createToolResultMessage`、真实 `turn/start`／`turn/end`），验证的是**采集器对这些真实事件形状的处理**，而不是宿主交互流程本身。这一点在 `docs/review-context.md` 里已声明，此处不改变该边界。

### 1.5 缺失 / 故障

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| `insufficient-material` 与 `review-failure` 是两个状态 | **passed** | `tests/review-contract/evaluate.test.ts:83` *escalates without inventing a verdict*（在 `describe('insufficient material')` @ `:82` 内，断言结果**没有** `verdict` 与 `requiredAuthorization` 属性）、`:140` *reports every rejected field with its reason class*（在 `describe('review failure')` @ `:139` 内）；`src/review-contract/evaluate.ts` 三种 `status` |
| 材料缺失不伪造 R10/A1/A2 | **passed** | 同上：材料缺失时保留 `diagnostic: { risk, authorization }` 供诊断，但**不产生判定**；`tests/review-contract/evaluate.test.ts:96-97` 显式断言无 `verdict` |
| 评审前的四条早退路径各有独立 stage code | **passed** | `src/host/gate-review.ts` 的 `preRequestExit`（`circuit_open`、`snapshot_error:*`、超出输入预算、材料不足），`src/host/gate.ts:580` 的 `noteStage` |
| 记录写契约版本 | **passed** | `src/host/gate.ts:99`（`contractVersion: REVIEW_CONTRACT_VERSION`） |
| 真实宿主中的缺失材料可读 | **passed** | `tests/e2e/call-detail.spec.ts:85` *opens the shared detail from the log entry and reports missing material* —— 真实 SQLite 里 seed 一条「无 review 快照、无 model attempt」的记录，详情必须点名缺口而非渲染空层；**本机通过** |
| 故障不自动放行 | **passed** | `src/review-contract/matrix.ts:100-110` 的 `settle`：`error-escalate` 无通道时 `fallback-deny`，无 `allow` 分支 |
| 审查故障与规则拒绝在真实宿主中不混淆 | **passed** | `tests/e2e/session-denial.spec.ts:560` *an allowed call that the host sandbox refused is not shown as an Arbiter denial* —— 断言记录中**不**出现 `deny`／`review-deny`／`human-deny`／`human-abort`／`fallback-deny` 任何一个，即 host 沙箱失败没有被写成 Arbiter 拒绝；**本机通过** |

**实现链接**：`src/review-contract/evaluate.ts`、`src/host/gate-review.ts`、`src/host/gate.ts`、`src/policy.ts:41`。

### 1.6 恢复

| 验证点 | 结论 | 真实执行证据 |
| --- | --- | --- |
| 冷恢复后裁决可读 | **passed** | `tests/e2e/history-recovery.spec.ts:928` *a verdict the plugin settles is persisted and cold-read by another runtime*（两个 plugin 实例用**不同 scope**，排除内存缓存命中）；`:1064` *the built plugin recovers a real host session log after a cold start*；`:1115` *real plugin records cold-read after a restart, with and without the audit store* —— 三条**补齐固定运行时后全部通过**（§3.2 第 20–22 号用例） |
| 恢复的覆盖度如实报告 | **passed** | `:1064` 断言 `status = { coverage: 'partial', reset: false }`（audit store 关闭，一个来源确实不可用，读出「部分」而不是「未知」或「已知为空」） |
| 显式重置生效且不可复活 | **passed** | `:1064` 中 `applied.host.reset?.(sessionId)` 之后 `window.items` 为空且 `status.reset === true` |
| `review-cancelled` 记录保留 | **passed（集成层）／not-run（真实宿主）** | `tests/integration/decision-chain.test.ts:831` *attempts and usage survive a cancellation that arrives after the request*：取消的调用**经 durable readers 往返后仍可读**（`readableCancellation('cancel-1', stored) === true`，`:884`），`stored.result === 'review-cancelled'`（`:885`），attempt 保留 `usage.inputTokens === 900`，且 trace 含 `review-cancelled`（`:892`）而非审查失败；`tests/audit.test.ts:968-980` 把 `review-cancelled` 行写进 store 并断言它不进入 prior-verdict 窗口。**本机没有在真实宿主里触发一次「审查在途被取消」的 E2E** |
| 取消不被写成拒绝 | **passed** | `tests/integration/decision-chain.test.ts:449`／`:451`（`decision.kind === 'cancel'` 且 `traceOrNull` 为 `null`）、`:495`／`:497`（fallback denial 不写）、`:570`／`:572`（规则裁决不写） |
| 冷恢复后 admission 恢复 | **passed** | `tests/e2e/session-admission.spec.ts:528` *a cold restart with the audit database removed restores admission*；**本机通过** |

**实现链接**：`src/host/history-record.ts:59`／`:457`（`review-cancelled` 在阶段列表中）、`src/host/settlement.ts:243`（映射为 `cancel`）、`:666-682`（取消认领路径）、`src/audit/queries.ts:473`。

> **`review-cancelled` 的准确边界**：记录格式与读取路径都有测试，但**没有真实宿主 E2E**。真实宿主的取消发生在「审查请求在途时用户取消工具调用」这一时序上，本机未构造该场景（`session-denial.spec.ts:415` 的并行用例恰好是本机 **timedOut** 的一条，但它测的是并行调用与拒绝理由，不是取消路径）。因此记为「集成层 passed、真实宿主 not-run」，不是「全链 passed」。

---

## 2. `pnpm verify`

### 2.1 逐步结果

日志：`.local/logs/verify.log`（699 行，ignored 目录）。

| 步 | 状态 | 证据 |
| --- | --- | --- |
| `check:peers` | passed | `No peer dependency issues found` |
| `typecheck` | passed | `tsc --noEmit` 无输出 |
| `lint`（code + testing-library） | passed | 两遍 ESLint 均 0 问题 |
| `format:check` | passed | `All matched files use Prettier code style!` |
| `check:unused`（knip） | passed | 无输出 |
| `check:dependencies`（depcruise） | passed | 无违规 |
| `check:workflows` | passed | actionlint + zizmor |
| `check:i18n` | passed | 无输出 |
| `check:evals` | passed | `51 cases, 49 gold labels, 2 excluded`；`2 cases, 0 gold labels`；`rq14-probe-and-cache, 6 candidates, 312 cells` |
| `test:unit` | **passed** — 71 files / **1739** tests | `.local/logs/verify.log:195-196` |
| `test:integration` | **passed** — 25 files / **467** tests | `:272-273` |
| `test:ui` | **passed** — 21 files / **353** tests | `:348-349` |
| `build` | passed | 产物含 `lib/`、`locale/{en,zh}/*.json`、`cordis.patch.yml` |
| `check:build` | **blocked（环境）** | `:664-698`；`Published package: no evals source, schema, data or import.` 已先打印，随后 `[ERR_SQLITE_ERROR]` |
| `check:regressions` | 由前一步短路；**单独重跑 passed** | §2.3 |

### 2.2 `check:build` 的环境阻塞已定位

**不是随机故障，也不是本次改动引起。** 触发条件是 **`CI=true`**：

`scripts/check-build.ts:151` 执行 `pnpm install --offline --ignore-scripts`，且把 `env` 设为 `{ ...process.env, CI: 'true' }`（`:34`、`:50`）。在 `CI` 下 pnpm 会打开共享 store 的 SQLite 索引，而本机的 store 位于 checking out 之外：

```console
$ pnpm config get store-dir
/Volumes/sandisk/.pnpm-store

$ touch /Volumes/sandisk/.pnpm-store/v11/.write-probe
touch: /Volumes/sandisk/.pnpm-store/v11/.write-probe: Operation not permitted
```

即 store **存在但不可写**。最小复现（在空目录里，只改 `CI`）：

```console
$ cd $(mktemp -d) && echo '{"name":"p","private":true,"type":"module","dependencies":{}}' > package.json
$ pnpm install --offline --ignore-scripts          # 未设 CI
Already up to date
Done in 141ms using pnpm v11.7.0

$ CI=1 pnpm install --offline --ignore-scripts      # 设 CI
[ERR_SQLITE_ERROR] unable to open database file
pnpm: unable to open database file
    at StoreIndex.openDatabase (…)
```

把 `TMPDIR` 改到 checkout 内不影响结论（同一报错），说明问题在 **store 的可写性**，不在临时目录的位置。CI 上该步通过，是因为 runner 的 store 由该 runner 自己创建并可写。

**因此本项记为 `blocked（环境）`**，且不引用 CI 通过代替本机执行记录。

### 2.3 `check:regressions` 单独重跑

`pnpm verify` 的 `&&` 链在 `check:build` 处中断，`check:regressions` 未执行。单独运行：

```console
$ pnpm run check:regressions
R1–R9: retired with the legacy engine; the frozen script imports symbols this build
       no longer exports, so it cannot run. The script and its recorded results stay
       unmodified as prototype evidence.
PASS S1: Offline suggestion routes are absent from the public surface
PASS S2: An attempted acceptance is unroutable and leaves candidates and rules unchanged
PASS S3: Rule testing and logs keep working while the seeded call row is retained
S1–S3: observations match the current contract
EXIT=0
```

日志：`.local/logs/regressions.log`。判定逻辑见 `docs/development-baseline.md` 的「退役引擎探测」段与 `scripts/retired-engine.ts`。

---

## 3. `pnpm test:e2e:dsh`

### 3.1 按 issue 原样执行

```console
$ pnpm test:e2e:dsh
Running 59 tests using 3 workers
  …
  12 failed
  47 passed (3.2m)
EXIT=1
```

日志：`.local/logs/e2e.log`。结果 JSON：`.local/e2e/results.json`。

**12 个失败**（按 spec 分组）：

| spec | 用例 | 实测原因 |
| --- | --- | --- |
| `agent-guidance` | the guidance survives a complete persona and context suppression | `DSH_E2E_CLI must point at the host entry for this test.` |
| `context-sources` | real DSH sessions expose human originals, ask answers and compaction | 同上 |
| `gate-real` | the plugin gate and the tester agree on a tool-argument rule（@smoke） | 同上 |
| `gate-real` | the real gate allows a quoted shell argument but not two arguments（@smoke） | 同上 |
| `history-recovery` | a verdict the plugin settles is persisted and cold-read by another runtime | `the DSH entry path is required for this test` |
| `history-recovery` | the built plugin recovers a real host session log after a cold start | 同上 |
| `history-recovery` | real plugin records cold-read after a restart, with and without the audit store | 同上 |
| `first-release-acceptance` | one session is configured, enabled, denied, reviewed and recovered | `ENOENT …/workspace/journey-allowed-probe.txt` |
| `first-release-acceptance` | a bare install leaves the rule table empty and starts no gate | `sandbox mode "workspace-write" … sandbox-exec: sandbox_apply: Operation not permitted` |
| `first-release-uninstall` | uninstalling through the plugin manager stops the gate and survives a restart | `ENOENT …/workspace/uninstall-allowed.txt` |
| `locale-surfaces` | every plugin surface switches between the released Chinese and English copy | `expect(typeof reviewedCallId).toBe('string')` → received `object` |
| `session-denial` | the refusal reason reaches the agent, and parallel calls keep running | `Test timeout of 120000ms exceeded` |

**与未修改的 `main` 逐条比对**（基线结果：`/Volumes/sandisk/code/dsh-arbiter/.local/e2e/results.json`，2026-10-31T07:38Z）：

```text
MINE failures: 12   MAIN failures: 12
only in mine: []
only in main: []
IDENTICAL: true
```

即**失败集与 `main` 完全一致**。这一点与 [verification.md §2](../verification.md) 的既有记录一致（当时是 47/12）。

### 3.2 按开发基线补齐固定运行时后重跑

`docs/development-baseline.md` 明确要求先安装固定版本的 DSH 运行时，并让 4 类用例通过 `DSH_E2E_CLI` 指向它。本 checkout 之前**没有**执行这一步（`tests/e2e/runtime/node_modules` 不存在），所以 7 个用例在**解析宿主入口时**就失败，而非在断言处失败。

按基线执行：

```console
$ npm ci --prefix tests/e2e/runtime --strict-allow-scripts --no-audit --no-fund
added 614 packages in 6s
EXIT=0

$ node -p 'require("./tests/e2e/runtime/package.json").dependencies["@deepseek-ai/dsh"]'
0.2.1-rc.3
$ node tests/e2e/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --version
0.2.1-rc.3
```

再按基线给出的入口重跑：

```console
$ DSH_E2E_CLI="$PWD/tests/e2e/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  DSH_E2E_VERSION=0.2.1-rc.3 \
  pnpm exec playwright test
Running 59 tests using 3 workers
  …
  5 failed
  54 passed (3.6m)
EXIT=1
```

日志：`.local/logs/e2e-cli.log`、`.local/logs/e2e-cli-json.log`；机器可读结果：`.local/e2e/results-cli.json`；逐条摘要：`.local/logs/e2e-summary.json`。

**转为通过的 7 个用例**（全部是此前在解析宿主入口时失败的）：

| spec | 用例 |
| --- | --- |
| `agent-guidance` | the guidance survives a complete persona and context suppression |
| `context-sources` | real DSH sessions expose human originals, ask answers and compaction |
| `gate-real` | the plugin gate and the tester agree on a tool-argument rule（@smoke） |
| `gate-real` | the real gate allows a quoted shell argument but not two arguments（@smoke） |
| `history-recovery` | a verdict the plugin settles is persisted and cold-read by another runtime |
| `history-recovery` | the built plugin recovers a real host session log after a cold start |
| `history-recovery` | real plugin records cold-read after a restart, with and without the audit store |

**这条记录的意义**：它把「12 个环境失败」拆成「7 个可修的基线配置缺失」与「5 个真实环境阻塞」。前 7 个不是本任务引入的缺陷，也不是无法修复的环境限制；它们是**本 checkout 未按项目基线准备**。这一点此前未被记录。

> **不把它写成「E2E 通过」**：补齐后仍有 5 个失败，见 §3.3。

### 3.3 剩余 5 个失败

| # | 用例 | 原因 | 与 `main` 的关系 |
| --- | --- | --- | --- |
| 1 | `first-release-acceptance` :: a bare install leaves the rule table empty and starts no gate | **`sandbox-exec: sandbox_apply: Operation not permitted`** —— 宿主无法启动 `workspace-write` 沙箱后端，命令未执行，测试拿不到 `bare-install-free` 输出 | 与 `main` 同 |
| 2 | `first-release-acceptance` :: one session is configured, enabled, denied, reviewed and recovered | `ENOENT …/workspace/journey-allowed-probe.txt` —— 依赖 #1 被拒的沙箱写入真正落盘 | 与 `main` 同 |
| 3 | `first-release-uninstall` :: uninstalling through the plugin manager stops the gate and survives a restart | `ENOENT …/workspace/uninstall-allowed.txt` —— 同上，写入未落地 | 与 `main` 同 |
| 4 | `locale-surfaces` :: every plugin surface switches between the released Chinese and English copy | `expect(typeof reviewedCallId).toBe('string')` → `object`：该用例在 `reviewedCallIdOf` 处拿不到 callId，因为产生它的那一轮真实工具调用依赖同一个被拒的沙箱 | 与 `main` 同（`main` 上同样失败） |
| 5 | `session-denial` :: the refusal reason reaches the agent, and parallel calls keep running | `Test timeout of 120000ms exceeded`：同一 turn 内两个并行调用，其中一个需要真实执行 | 与 `main` 同（`main` 上同样 timedOut） |

**根因是同一个**：本机 `sandbox-exec` 不可用。

```console
$ sandbox-exec -p '(version 1)(allow default)' /bin/echo probe-ok
sandbox-exec: sandbox_apply: Operation not permitted
```

`guarded` 边界下宿主请求 `workspace-write`，宿主自己拒绝启动沙箱（错误原文见 #1 的 `Received string`），因此任何「allow 之后真正写文件」的用例都无法完成。**这是执行环境限制，不是插件行为。**

**这 5 个记为 `blocked（环境）`，不写成 passed，也不以 CI 通过代替本机记录。**

---

## 4. 未执行项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `check:build` | **blocked（环境）** | §2.2：pnpm store 在本 checkout 外且不可写；`CI` 下必然触发 |
| `pnpm test:e2e:dsh` 全绿 | **blocked（环境）** | §3.3：`sandbox-exec` 不可用 |
| 真实宿主中的 `review-cancelled` | **not-run** | §1.6：集成层有测试，真实宿主「审查在途被取消」的时序本机未构造 |
| 真实 delegation 的 `delegationDepth` 数值断言 | **not-run** | §1.1：用例只看 `parentSession`；插件的会话类别判定也不读该字段 |
| 真实付费模型调用 | **不执行** | 任务明确禁止；E2E 全部使用确定性 reviewer 桩 |
| 跨平台（Linux／Windows）产品级验收 | **not-run** | 本机为 macOS / arm64；与首版验收口径一致 |
