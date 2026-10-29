# 项目索引与交接（HANDOVER）

给接手这个仓库的 agent：先读本文，再决定读哪份文档。**本文只做导航和「改哪里、注意什么」，不重复设计论证**；设计理由在 `docs/` 里，链接都指到具体章节。

最后更新：2026-10-26，对应 main `1ebf55e`（首版 milestone 已关闭）。

---

## 1. 一句话说明这是什么

DeepSeek Harness（DSH）的一个插件 `dsh-arbiter`：**在工具调用执行前**做确定性规则匹配 + 模型审查，产出 allow / deny / 转人工。它替代官方 Auto Review 占据同一个「自动审批」槽位。

- 宿主构建目标：**DSH 0.2.1-rc.3**（固定在 `tests/e2e/runtime/package.json`）
- 单包双半侧：宿主半侧 `lib/index.js`（Node）+ 浏览器半侧 `lib/client.cjs`
- 命名约定与模块职责：[docs/architecture.md#design-3-2](architecture.md#design-3-2)

**重要**：`docs/architecture.md` 里的「模块划分」表是**早期设计意图**，与当前文件布局不同（例如它写 `rules/parse`、`reviewer/engine`，实际是 `src/shell/`、`src/policy.ts`）。以本文第 3 节的文件表为准。

---

## 2. 五分钟上手

```sh
pnpm install --offline --frozen-lockfile   # 依赖已缓存
pnpm verify                                # 全量检查，必须 0
pnpm test:e2e:dsh                          # 真实隔离宿主，约 2 分钟
```

单独跑某一层：

```sh
pnpm test:unit          # tests/**/*.test.ts 中纯逻辑与工程约束
pnpm test:integration   # tests/audit、suggestions、unload、tests/integration
pnpm test:ui            # tests/client，RTL
pnpm exec vitest run tests/rules.test.ts     # 单文件
```

E2E 需要一个 `dsh`：

```sh
# 方式一：用本机 App 的 CLI（PATH 上有 dsh 时直接跑）
pnpm test:e2e:dsh

# 方式二：用与 CI 相同的锁定版本
# 从仓库根执行；安装放子 shell，避免把当前目录留在 runtime 包里
mkdir -p /tmp/dsh-runtime
cp tests/e2e/runtime/package*.json /tmp/dsh-runtime/
( cd /tmp/dsh-runtime && npm ci )
DSH_E2E_CLI=/tmp/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
DSH_E2E_VERSION=0.2.1-rc.3 pnpm test:e2e:dsh
```

**注意**：`tests/e2e/dsh/profile.ts` 的 `isolatedEnv()` 会剥离所有 `*API_KEY` 环境变量，且每个用例用临时 `DSH_HOME`。这是刻意的——不要让真实凭据进入测试。

规矩（提交前必读）：[AGENTS.md](../AGENTS.md) + [开发基线](development-baseline.md)。

---

## 3. 代码地图（按「改什么」组织）

### 3.1 一个工具调用的完整链路

改任何与判定相关的东西，先看这条链：

```
宿主 tools/pre-execute
  └─ src/host/gate.ts        CallGate.handle()   ← 唯一监听器，prepend
       ├─ refuseUnconfirmed()          卸载收窄未确认 → 直接拒
       ├─ 开关/accepting 检查            未启用 → next()（不接管）
       ├─ agent 缺失                    无 exec.agent → next()（已声明边界）
       ├─ scopeFor(session)             准入判定，见 3.2
       ├─ prepare()                     → src/host/stage.ts 取阶段快照
       ├─ applyRule()                   → src/rules/match.ts evaluateCall()
       └─ review()                      → src/snapshot.ts 构造送审
                                          → src/reviewer.ts 调后端
                                          → src/policy.ts decideReview()
                                          → src/host/settlement.ts 结算
```

### 3.2 会话准入（最容易被误解的部分）

**插件不会接管所有会话**。只有用户显式启用的会话才受管，记录存在会话日志里。

| 文件 | 职责 |
|---|---|
| `src/host/admission.ts` | 折叠 `plugin:arbiter/admission` 记录，判定 scope 与 revision |
| `src/host/session-admission.ts` | 启停 API：先写记录再放宽 / 先收窄再写停用 |
| `src/host/admission-*.ts` | 拆分出的窄职责：narrow / release / resume / teardown / veto / summary / view / adapters |
| `src/host/permissions.ts` | 原生 `/permission` 命令关联、回退顺序、drain |
| `src/host/descendants.ts` | 继承受管子会话的范围解析 |
| `src/host/narrow-retry.ts` | 收窄失败后的有界重试 |

**硬不变量**：
- 收窄失败必须 **fail-closed**，不能让会话带着旧宽权限离开门禁
- 卸载顺序是 **先回退、后 drain**（`permissions.ts::unload()`）；反序会让 drain 窗口内的新调用在旧 `danger-full-access` 下免审执行
- 继承的子任务**只收窄沙箱**，不改写宿主固定的 `never`
- 缺少 `sandbox/mode` 事件**不当作安全**

契约：[docs/architecture.md#permission-selector-contract](architecture.md#permission-selector-contract)、[#design-3-3](architecture.md#design-3-3)

### 3.3 规则与匹配

| 文件 | 职责 |
|---|---|
| `src/config/rules.ts` | 规则 schema 校验（`RuleTarget` / `RuleCondition` / `RuleScope`） |
| `src/config/format.ts` | 唯一的 `arbiter-config-v3` 声明；退役与未知格式报错 |
| `src/config/document.ts` | 整份文档解析：各 section 与规则 |
| `src/rules/compile.ts` | 编译规则 → 求值器；条件级 match / no-match / **unknown** |
| `src/rules/match.ts` | `evaluateCall()`：规则求值、优先级、覆盖判定 |
| `src/rules/selector.ts` | RFC 9535 JSONPath，保留 JSON 类型 |
| `src/shell/*` | `unbash` 适配：结构 / 词值 / 事实三档独立 |

**已确认的行为**（不要回退）：
- exact / RE2 / glob 全部**整值匹配**，不强制 `^`
- 空结果不匹配；`null` ≠ 缺失；对象/数组不 stringify
- 高优先级 `unknown` **阻止**低优先级 allow
- 结构不完整时结构条件一律 `unknown`
- 授权覆盖要求：tool 备选必须**自身命中**；已解析与未解析混存时保留 `unknown`；命中的全部文本都要参与覆盖判定

设计：[docs/rules.md#parameter-matching](rules.md#parameter-matching)、[#matcher-semantics](rules.md#matcher-semantics)

### 3.4 审查（Reviewer）与判定引擎

| 文件 | 职责 |
|---|---|
| `src/snapshot.ts` | 送审结构构造、预算、截断 |
| `src/snapshot/evidence.ts` | 授权证据分层（本会话人类 / 父会话人类 / relay / 转述 / checkpoint） |
| `src/snapshot/budget.ts` | token 估算与裁剪顺序 |
| `src/reviewer.ts` | 两个后端的公共出口 |
| `src/reviewer/chat.ts` | `ctx.llm.stream()` 点值协议 + 修复式重试 |
| `src/reviewer/decision.ts` | `state` + `questions` JSON 协议 |
| `src/reviewer/prompt.ts` | `REVIEW_POLICY`（chat）与 `buildQuestions()`（decision） |
| `src/reviewer/signals.ts` | 响应解析、六探针校验、格式修复 |
| `src/policy.ts` | **判定引擎**：R1–R8 + 阈值 + 三档策略 |

**关键区间**：改阈值或规则语义时，`src/policy.ts` 与 `docs/approval-modes.md#thresholds` 必须同步；`tests/policy-calibration.test.ts` 会守卫默认值是否落在记录区间内。

**两个容易踩的坑**：
- `chat.maxTokens` 是**输出**预算，thinking 与正文共享。实测 400 会让思考吃满、正文为空 → 默认已提到 10000，`timeoutMs` 20000
- `REVIEW_POLICY` 与 `buildQuestions()` 是**两份独立文本**，改探针措辞必须同时改，否则两个协议漂移

**已知缺口**（见第 6 节）：R5 只表示「风险超上限」，矩阵里的操作类别事实未实现；decision 协议下 R5 不可达。

设计：[docs/reviewer.md](reviewer.md)、[docs/approval-modes.md](approval-modes.md)、[docs/review-context.md](review-context.md)

### 3.5 审计、历史与恢复

| 文件 | 职责 |
|---|---|
| `src/audit.ts` | `AuditStore` 门面 |
| `src/audit/{schema,writer,queries,rows,retention,metadata,types}.ts` | 建表（无迁移链）、写入、查询、行映射、30 天/1 GiB 清理 |
| `src/audit/call-list.ts` | **keyset 分页**（`ts DESC, call_id DESC`）+ 精简投影 |
| `src/audit/verdict-sources.ts` | 恢复专用只读查询 |
| `src/host/history.ts` | 三源裁决历史：内存 / 会话记录 / SQLite |
| `src/host/history-record.ts` | `plugin:arbiter/history*` 记录 codec |
| `src/host/history-sources.ts` | 三源读取与去重 |
| `src/records.ts` | 会话记录读写（`appendPluginRecord`） |

**已确认的行为**：
- 三源共用同一选择器：谓词、`callId` 身份、`(ts, callId)` 排序、链合并
- 格式过滤必须在 **SQL `WHERE`** 里、`LIMIT` 之前（否则不可读行占用窗口名额）
- `priorVerdictsForSession` 返回 `{ verdicts, unreadableCount }`；`unreadableCount > 0` 且会话日志为空时必须是 `partial`，**不能**报 `known-empty`
- 审计失败只降级提示，不改变裁决

### 3.6 路由与客户端

宿主路由全在 `src/host/*-routes.ts`，在 `src/host/routes.ts` 汇总注册：

```
/api/arbiter/state          src/host/state.ts
/api/arbiter/sessions       admission-routes.ts
/api/arbiter/validate|save|credentials|test   config-routes.ts
/api/arbiter/models         model-catalog-routes.ts
/api/arbiter/reviewer-test  reviewer-test-routes.ts
/api/arbiter/logs|log|clear audit-routes.ts
/api/arbiter/coexistence    coexistence-routes.ts
```

客户端是 React，走宿主 `slots`。**注册点全在 `src/client/index.tsx`**：

| slot | 用途 | 注意 |
|---|---|---|
| `plugins.bundle.config` | 设置页（key `dsh-arbiter`） | — |
| `shell.overlay` | 共存冲突提示 | 必须全框可见，不能放面板内 |
| `conversation.chat.node` | #19 会话拒绝行 | 需 `ctx.inject(['uiConversation'])` 可选注入 |
| `conversation.input.permission` | 权限选择器 | **单值 slot，priority 升序取第一个，宿主在 0 → 必须用负值**；且先探测宿主半侧是否存在再占位 |

组件目录：`src/client/components/`（含 `call-detail*`、`denial-*`、`permission-selector*`、`rules/`）、`src/client/panels/`（六个页签）。

**UI 硬性要求**：文案必须走 `locale/zh/<module>.json` + `src/client/i18n/resources.ts` 登记；英文已补齐 705 key，`pnpm check:i18n:release` 必须过。

---

## 4. 测试怎么分层

| 层 | 位置 | 什么时候用 |
|---|---|---|
| unit | `tests/*.test.ts`、`tests/unit/` | 纯逻辑、schema、策略、工程约束正反样例 |
| integration | `tests/audit.test.ts`、`tests/unload.test.ts`、`tests/integration/` | 真实 SQLite、文件、生命周期组合 |
| UI | `tests/client/` | RTL + user-event + MSW |
| dsh-e2e | `tests/e2e/` | 真实隔离 DSH 进程 + Playwright |

**写测试的硬要求**（本仓库对此非常严格，评审会逐条查）：
- 空断言、占位通过、`skip`/`only` **不构成完成证据**
- 断言要**有区分力**：改掉被测行为时测试必须变红。**交付前自己验一次**
- 不要比较两个可能同时为空的值（空串 == 空串、`null == null`、两个空数组）
- 分页/排序类断言不要依赖「块的数量」这类视图状态，要按内容或稳定标识

E2E 常用夹具：`tests/e2e/dsh/case-host.ts`（隔离宿主）、`fixture-llm.ts`（确定性模型，固定返回低风险允许）、`session-log.ts`（读宿主自己的 zstd 日志）。

---

## 5. 常见改动怎么做

### 加一个设置项
1. `src/types.ts` 加字段 → 2. `src/config/<area>.ts` 校验（带 path + errors + 稳定 code）→ 3. `src/config/defaults.ts` 默认值 → 4. `src/client/panels/*.tsx` 控件 → 5. `locale/zh/*.json` + `resources.ts` → 6. `tests/config.test.ts` + RTL 用例

**注意**：默认值改动要同时看 `src/config/<area>.ts` 的**校验上限**和 UI 的 `min`/`max`——同一个范围在三处声明，漏一处会「拒绝自己的默认值」。

### 加一条路由
`src/host/<name>-routes.ts` 导出 handler → 在 `src/host/routes.ts` 注册 → `src/client/api.ts` 加调用 → `src/client/decoders/*` 严格解码（**不要把 unknown 强转**）→ 集成测试用真实 `apply()`。

### 改判定规则或阈值
`src/policy.ts` + `docs/approval-modes.md#thresholds` + `tests/policy*.ts` 三处同步。**不要为了让测试通过而改阈值**——那是用测试集拟合。

### 改宿主接入
所有 `ctx` 交互的窄接口在 `src/host/types.ts`。**不要新增对宿主内部实现的依赖**；接口不存在时如实报告限制，不要伪造。

---

## 6. 现状与已知缺口（不要当成 bug 重新发现）

首版 milestone 已关闭。以下是**已确认接受**的未验证项，别把它们当新问题报：

| 缺口 | 原因 |
|---|---|
| `decision` 后端真实网络 | 自定义 JSON 协议，官方 Anthropic endpoint 不兼容，需 serving 层 |
| `#14` 真实 provider 成功路径 | 只有 MSW / 本地端口失败路径 |
| `#19` 更广义并发隔离 | bash 非 concurrency-safe，只验证到「同 step 内拒绝与成功并存」 |
| `#12` 真人点击与 PTC 取消 | 2026-10-22 有 rc.2 记录，rc.3 未重跑 |
| 卸载后工具调用 / `removeBundle` 期间时序 | 卸载后插件页面消失，夹具无法驱动模型回合 |
| Ubuntu/Windows 产品级验收 | 仅 macOS 完成；其余只过基础兼容 smoke |
| R5 操作类别事实 | 需扩展送审信号结构，属独立设计 |
| 探针措辞（`bulk`/`destructive`） | 已转入后续「测试集 + prompt/policy 调整」milestone |

当前 `main` 是干净的、`pnpm check:release` 通过的。

---

## 7. 历史文档怎么读

`docs/` 里有大量过程记录，**按需读，不要通读**：

| 文档 | 什么时候读 |
|---|---|
| [requirements.md](requirements.md) | 想确认产品范围 / 首版边界 |
| [architecture.md](architecture.md) | 宿主接入、slot 契约、共存、执行覆盖 |
| [rules.md](rules.md) | 规则语义、匹配、JSONPath |
| [reviewer.md](reviewer.md) | 送审结构、两后端协议、信号 |
| [approval-modes.md](approval-modes.md) | 三档模式、R1–R8 矩阵、阈值 |
| [review-context.md](review-context.md) | 授权证据分层、截断 |
| [configuration-and-audit.md](configuration-and-audit.md) | 配置、凭据、审计、日志、详情 |
| [implementation-report.md](implementation-report.md) | **首版验收报告**：逐项 passed/not-run |
| [development-baseline.md](development-baseline.md) | 工程约束、CI、i18n 检查 |
| `decisions-and-questions.md` | 决策台账（含已解决与仍开放的） |
| `archive/`、`implementation-review-*.md`、`validation/` | **历史证据，不要改**，只读 |

---

## 8. 协作与提交规矩（本仓库特有）

- **PR 标题与 squash 消息**用英文 Conventional Commits（`type(scope): summary`），PR 正文中文
- **代码与文档分开提交**，commit message 英文
- 合并走 `pnpm pr:merge NUMBER`（校验标题、锁 head、空 body），**不要**直接 `gh pr merge`
- 不要新增 lint 豁免、过渡名单、coverage 门槛
- 修改后跑 `pnpm verify`；涉及宿主加载/UI/生命周期要跑 `pnpm test:e2e:dsh`

---

## 9. 调试入口

| 想知道 | 看哪里 |
|---|---|
| 一次调用为什么被拒/放行 | 日志页 → 点行 → 调用详情；或 `GET /api/arbiter/log?callId=` |
| 实际送审了什么 | 详情的「原始材料」→ `snapshot` / `modelAttempts` |
| 为什么没被审查 | 详情里的 chain；`gate/skipped` 的 reason（`no-agent` / `not-enabled` / `plugin-disabled` / `boundary-unconfirmed`） |
| 配置为什么没生效 | `state` 的 `invalidConfigError` / `configApplications` / `historyIncomplete` |
| 宿主事件序列 | 审计库 `$DSH_HOME/arbiter/arbiter.db` 的 `stages` / `calls` 表；或 E2E 的 session log（zstd） |
| E2E 为什么失败 | `.local/e2e/results/` 下的 screenshot / trace / `host.stderr.log` |

**排错顺序建议**：先看 chain 是否走到 review，再看快照是否完整送达，最后看 policy 应用了哪条规则。多数「判定不对」其实是规则匹配或证据分层的问题，不是模型。
