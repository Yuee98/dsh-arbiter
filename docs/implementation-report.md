# 首轮实施报告（2026-10-21）

本报告回填[首轮完整实现交接](initial-implementation-handoff.md)的执行状态：已实现流程、可运行入口、检查命令与结果、真实／模拟验证的区别、初版实现选择，以及仍需人工或外部服务验证的项目。产品语义未定与实现未完成分开列出。

状态：**首轮完整功能版本已实现并在评审返修后可在隔离 DSH 0.2.1-rc.2 profile 中试用**。宿主接入、规则、真实 reviewer、三档模式、配置页、审计与离线建议均已接入真实服务；未用 mock 代替审查或权限结论。评审 R1–R9 的返修与剩余缺口见[返修记录](implementation-review-remediation-2026-10-21.md)。

> **本文是 2026-10-21 的历史报告，按原样保留。** 当前首版交付状态、正式验收结论与已知限制见[首版验收报告](#first-release-acceptance)（2026-10-26，head `3141b88`+本 PR）。文中 DSH 0.2.1-rc.2、离线规则建议与「英文未补齐」等描述属于当时的记录，不由后续工作改写。

## 首版验收报告（2026-10-26，issue #23）

本节回填 #23「完成首版正式插件集成验收与交付说明」。前置 21 个叶子 issue（#3–#22）已全部合并到 main，验收基于 `3141b88` 及其上的本 PR。

### A. 环境与固定 head

| 项 | 值 |
|---|---|
| 验收 head | `3141b88`（= `origin/main`）起，本 PR 分支 `feat/first-release-acceptance` |
| DSH 版本 | **0.2.1-rc.3**，取自 `tests/e2e/runtime/package.json` + `package-lock.json`（与 PR／main 同一清单，不在 release 中解析 `latest`） |
| 运行方式 | `DSH_E2E_CLI=/tmp/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js DSH_E2E_VERSION=0.2.1-rc.3` |
| 平台（本轮实际执行） | macOS 27.0.1 / arm64（基准系统） |
| 隔离度 | 每个用例独立 `DSH_HOME`、独立 profile、独立 workspace、OS 分配端口；不读写日常 `~/.dsh` |
| 模型 | 确定性 fixture adapter（`tests/e2e/dsh/fixture-llm.ts`），无凭据、无外网请求 |

### B. 逐项验收结论

| # | 验收条件 | 结论 | 证据 |
|---|---|---|---|
| 1 | 发布流程复用 PR／main 同一 DSH 版本，不临时解析 `latest` | **passed** | `tests/e2e/runtime/package.json`／`package-lock.json` 固定 rc.3；`tooling/ci/dsh-platforms.mjs` 与 `tests/tooling/dsh-platforms.test.ts`；本 PR 未改动该清单 |
| 2 | 升级 PR 三平台 smoke、候选复用同一清单、各声明系统分别验证产品行为 | **partial** — 三平台 `@smoke` 兼容：passed（历史证据）；各声明系统的产品级验证：**仅基准系统 macOS 完成，Ubuntu／Windows not-run** | 平台矩阵与逐平台结论见 **E 节第 1 条**；历史证据见 `validation/engineering/2026-10-25-dsh-hosted/REPORT.md`（macos-15／ubuntu-24.04／windows-2025 各 3 passed，同为 DSH 0.2.1-rc.3）与 `2026-10-25-dsh-updates/REPORT.md`。smoke 不证明文件边界／沙箱、冷恢复、停用／卸载；self-hosted runner 未部署 |
| 3 | 自动审批用真实宿主／插件 + 确定性 Reviewer；真实模型质量与真人点击单列 | **passed（自动路径）／真实模型与真人部分见 #8、#12 状态** | `tests/e2e/first-release-acceptance.spec.ts`、`session-admission.spec.ts`、`coexistence.spec.ts`；日常 CI 不依赖模型密钥或人工等待 |
| 4 | 首版发布前补齐 `locale/en/` 全部 UI 文案，通过共享 schema 与全语言校验 | **passed** | `pnpm check:i18n:release` 退出 0；14 模块 705 key 全覆盖；`src/client/i18n/resources.ts` 同步登记 |
| 5 | 正式宿主中验证中英文切换与长文本／换行／截断／弹窗布局 | **partial** — 权限选择器、设置／规则编辑、规则测试区、Reviewer 连接测试、日志与共用详情、会话拒绝反馈：passed；**冲突提示的英文实机布局 not-run** | `tests/e2e/locale-smoke.spec.ts`（配置框架 zh→en→zh + 刷新）、`tests/e2e/locale-surfaces.spec.ts`（上述六类界面逐项中英切换、实际裁剪检查、长规则名／备注值不变）、`tests/e2e/permission-selector.spec.ts`（插槽与英文菜单不越界、经英文菜单启用仍落到后端）。**冲突提示需要真实冲突提供者才会渲染**；中文侧由 `coexistence.spec.ts` 真实冲突覆盖，英文侧仅核对目录文案，未注入伪冲突换取渲染 —— 见 E 节限制 5 |
| 6 | 切换语言不改写用户内容、工具输入、模型返回、历史审计原文；稳定协议值不变 | **passed** | `locale-surfaces.spec.ts` 断言长规则名／备注在两种语言下值不变、日志行仍显示协议裁决值；`tests/client/denials.test.tsx` 断言 Agent 收到的拒绝原因原文不变；`src/client/i18n/catalog.ts` 只在渲染层替换，不写回存储 |
| 7 | `pnpm check:release` 通过（含 `check:i18n:release`、`verify`、完整真实 DSH 用例），逐项列出状态 | **passed** | 见 C 节逐项记录；未运行项在 D 节单列，不以探针或历史报告充当结论 |
| 8 | 默认空规则、安装不接管；模式契约确定性回归；目标 Reviewer 小样本合法输出与延迟，不声称误放率／阈值已完美校准 | **passed（有界）** | `tests/e2e/first-release-acceptance.spec.ts` 的 `installation does not take over` 用例（空规则、无 admission、无裁决、工具正常执行）+ `config-lifecycle.spec.ts` 首次安装默认值；模式契约见 `tests/policy*.test.ts`、`tests/regression`；真实 Reviewer 样本复用 [#22 评测记录](../validation/arbiter-integration/2026-10-26-policy-calibration/REPORT.md)：17 样例、72 次真实 chat 请求、0 解析失败；延迟中位数 102 ms（64 ms–1139 ms，缓存命中后的稳态；首次请求 1.9–5.2 s）。该报告同时记录三个边界样例的方差。报告曾指出 `chat.maxTokens=400` 会让会 thinking 的模型把预算耗在思考上并产出空正文；**该问题已由 #52 修复，当前发布默认是 `src/config/defaults.ts` 的 `maxTokens: 10_000`**，本报告按现行默认值记录。**不声称误放率或阈值已完美校准**，也没有 decision 侧样本 |
| 9 | 未运行项不宣布交付完成；提供准确 head／环境／证据与剩余风险；关闭 parent/milestone、发布、合并另行授权 | **passed（本报告）** | 本报告 D／E 节；关闭与合并由 coordinator 执行 |

### C. `pnpm check:release` 逐项记录

| 子命令 | 结果 |
|---|---|
| `check:i18n:release` | passed — `Locale validation passed (release).` |
| `check:peers` | passed — no peer dependency issues |
| `typecheck` | passed |
| `lint`（工程 + Testing Library 两遍，零警告） | passed |
| `format:check` | passed |
| `check:unused`（Knip） | passed |
| `check:dependencies`（运行时循环依赖） | passed |
| `check:workflows`（actionlint + zizmor） | passed |
| `check:i18n`（开发口径） | passed |
| `test`（unit + integration + ui） | passed — 721 unit、395 integration、249 ui |
| `build` | passed |
| `check:build`（publint + 离线消费者） | passed |
| `check:regressions`（R1–R9、S1–S3） | passed（R8 按契约记录为「候选保持 pending、未加规则、accept 路由不可达」） |
| `test:e2e:dsh`（完整真实 DSH 套件） | 见 D 节；本轮新增 2 个用例，全量重跑 |

### D. 新增与复用的真实宿主证据

**新增（本 PR）**

| 文件 | 覆盖 | 结果 |
|---|---|---|
| `tests/e2e/first-release-acceptance.spec.ts` | 单会话跨模块旅程：配置（经真实 UI 保存规则）→ 权限选择器启用 → 规则拒绝（独立 callId、body 未执行、裁决归属）→ 确定性 Reviewer 的 `review-allow`（工具确实执行）→ 会话拒绝 marker + 共用详情 → **进程重启**后内容快照／规则恢复、admission 恢复、同类调用仍被拒绝；另含「裸安装不接管」用例 | passed |
| `tests/e2e/locale-smoke.spec.ts`（重写） | zh → en → zh 切换 + 刷新后保持；英文页无中文残留、无裸 key／占位符 | passed（`@smoke`） |
| `tests/e2e/locale-surfaces.spec.ts` | 逐面语言切换与布局：规则编辑、规则测试区、Reviewer 入口与连接测试弹窗、日志列表、共用详情、会话拒绝反馈、实际裁剪检查 | passed |
| `tests/e2e/permission-selector.spec.ts`（语言用例重写） | 权限插槽随宿主语言切换、英文菜单项不越界、经英文菜单启用仍落到后端 | passed |

**复用（未重跑或按需重跑）**：`session-admission.spec.ts`（含停用窗口生产 trace／barrier、冷重启、trusted 收窄、subagent 继承）、`session-denial.spec.ts`（marker 放置、同 step 拒绝与成功并存、沙箱失败不误标）、`coexistence.spec.ts`（官方 Auto Review 阻断与清除、第三方仅告警）、`config-lifecycle.spec.ts`、`context-sources.spec.ts`（run_code 外层／内层）、`gate-real.spec.ts`（真实 `tools/pre-execute` 与规则测试一致）、`history-recovery.spec.ts`（冷读）、`logs-pagination.spec.ts`、`rule-test-panel.spec.ts`、`reviewer-connection-test.spec.ts`、`rules-editor.spec.ts`、`rules-v2.spec.ts`、`accessibility.spec.ts`。

### E. 已知限制与未运行项（不得记为通过）

1. **平台**：本轮产品级验证只在 macOS arm64 执行。Ubuntu 有历史三平台 smoke（同 head 各 3 passed），但 smoke 不证明文件边界／沙箱、冷恢复、停用／卸载；**Windows 的路径／启动器／进程树清理、macOS 完整 E2E 本轮 not-run**。self-hosted runner 未部署。首版支持声明按此收窄，不能以 UI smoke 宣布平台功能全部受支持。
2. **decision 后端真实网络**：自定义 JSON 协议，官方 Anthropic endpoint 不兼容，需要 serving 层。**not-run**（用户明确延后）。相关路径只有协议单元测试。
3. **#14 真实 provider 成功路径**：现有宿主证据用 MSW／本地端口失败路径覆盖；真实 provider 成功返回 **not-run**。
4. **#19 并发隔离性**：bash 非 concurrency-safe，验证止于「同 step 内拒绝与成功并存」，更广义的并发安全 **not-run**。
5. **冲突提示的双语布局**：`coexistence` 的告警卡需要真实冲突提供者才会渲染；本轮在 `coexistence.spec.ts` 已有真实冲突的中文渲染，英文侧在目录层核对文案，**英文冲突卡的实机布局 not-run**（未为此注入伪冲突）。
6. **#12 真人点击与 PTC 取消**：历史 2026-10-22 报告记录了本人点击「允许一次」与「拒绝」以及宿主因沙箱模式改变取消的真实 `run_code`（DSH 0.2.1-rc.2 head）。**本轮未重跑真人点击**；PTC 的宿主中止不等于人工 abort，仍单列。跨版本复用需说明差异。
7. **#51 两条挂起项**：边界样例探针定义模糊（`bulk`／`destructive` 对递归删除的措辞）、R5 缺「既有对象删除」操作事实。**未修**，属后续 issue。
8. **真实模型质量与阈值校准**：有 #22 的有界 chat 样本（见 B 节 #8），不构成误放率结论，decision 侧无样本。
9. **`chat.maxTokens` 的历史问题已修复**：#22 记录的 400 默认值致空正文已由 #52 修正为 `10_000`（`src/config/defaults.ts`）。本轮不重复验证真实 thinking 模型，`not-run`。

### F. 迁移与升级说明

- **本版无配置 schema 破坏性变更**：`arbiter-config-v2` 与 `arbiter-config-v1` 的读取规则未变；`format` 未声明的旧文档继续按旧前缀语义解析（页面显示「未声明，沿用旧前缀语义」）。
- 从「英文未补齐」的开发版本升级：`locale/en/` 从 2 个 key 变为完整 705 key。宿主语言为英文的部署升级后会看到英文界面，此前是中文回退；这是预期变化，不是回归。
- 会话记录 `plugin:arbiter/admission`／`plugin:arbiter/decision` 的字段与版本号未变，冷恢复读取路径未变。
- 审计库（`$DSH_HOME/arbiter/arbiter.db`）结构未变，无需迁移。


## 1. 已实现的用户流程

1. 在隔离 profile 中安装并启用插件，选择主会话／子任务审批模式与 reviewer。
2. 创建命令规则，使用同一实现在配置页或 `/arbiter test` 中测试匹配范围。
3. 让 agent 运行原生工具、MCP、`run_code` 外层或 PTC 内层调用；规则先于 reviewer，规则完整 allow 不调用模型。
4. 未命中规则时构造不可变 ReviewSnapshot，调用 chat 或 decision reviewer，代码应用版本化策略产生 `review-allow`、`review-deny` 或 `review-escalate`。
5. 需要人工时由插件直接调用宿主 `approval.request`，区分 `human-allow`、`human-deny`、`human-abort`；自动模式或子任务无通道时记录 `fallback-deny`。
6. 每次调用写入内存裁决、DSH 会话 `plugin:arbiter/decision` 最小记录和 SQLite 完整审计；写审计失败不改变权限结果。
7. 在配置页查看当前生效配置、修改并“保存并应用”；外部修改或并发草稿冲突被拒绝，无效配置回退到上一份有效配置。
8. 在日志页筛选调用、查看判定链／送审材料／模型调用；在离线建议页分析历史、修改或拒绝候选，确认后通过普通配置校验加入规则。

## 2. 可运行入口

| 入口 | 位置 |
|---|---|
| 包入口 | `lib/index.js`（`apply`、`name: "arbiter"`、`inject`） |
| 浏览器半侧 | `lib/client.js`，通过 package.json `dsh.client` 由 DSH 模块图加载 |
| bundle patch | `cordis.patch.yml`，插入行 id `arbiter` |
| 配置页 | Web **Plugins → dsh-arbiter**（`plugins.bundle.config`，key `dsh-arbiter`） |
| 斜杠命令 | `/arbiter status`、`/arbiter test <command>`、`/arbiter mode trusted|guarded` |
| 数据 | `$DSH_HOME/arbiter/arbiter.db`；备用有效配置 `last-good.json` |
| 会话记录 | `plugin:arbiter/decision` |

安装与试用步骤见 [README](../README.md#本地安装与试用)。本轮实际验证了：

- `dsh plugin --profile trial add /Volumes/sandisk/code/dsh-arbiter` 成功；
- 从 shipped Web 模板创建的隔离 profile 能启动并返回 `/api/arbiter/state`；
- 配置页的厂商模块 URL 返回 200，内容为 `window.__ModuleLoader__.load({id:"dsh-arbiter",...})`。

## 3. 检查命令与结果

### 3.1 工程检查（真实执行）

```sh
mise exec -- pnpm verify
```

结果：通过。包含 `typecheck`、类型感知 ESLint（零警告）、Prettier、Knip、actionlint、66 个 Vitest 单元测试、tsc 构建、esbuild 客户端构建、临时消费者检查，以及 `check:regressions` 的 R1–R9 复现（9/9 PASS）。

评审返修的逐项根因、修复和剩余验证见[返修记录](implementation-review-remediation-2026-10-21.md)。

单元测试覆盖：

- shell 读取器：语句、重定向、赋值、`cd` 追踪、替换／子 shell／解释器／未解析展开导致的 `partial`；
- 规则：`deny > force-ask > force-review > allow > review(default)`、遮蔽、复合命令部分覆盖、重定向覆盖、未锚定 regex 拒绝、tool selector、agent 作用域；
- 策略：normal 与 strict 共用常规策略、progress 的风险上限与批量外发扩展、R1／R2／R4／R6、decision 累积概率；
- 配置：默认值、非法 regex、非法模式、decision URL／凭据引用、allow 被 force-review 遮蔽警告、字符上限；
- reviewer：严格六字段、代码块提取、额外字段／小数拒绝、矛盾检测、decision 分布映射与请求体、HTTP 失败、一次修复重试、provider 错误不重试；
- 审计：写入、查询、详情、快照去重、执行状态、按会话恢复先前裁决、保留清理、清空、打开失败；
- 离线建议：重复 allow 生成候选、硬类别／失败组不生成、normal 与 progress 回放。

### 3.2 真实 DSH 集成（真实宿主，确定性模型）

位置：[validation/arbiter-integration/2026-10-21-arbiter-01](../validation/arbiter-integration/2026-10-21-arbiter-01/REPORT.md)。

- 环境：DSH 0.2.1-rc.2，headless CLI；每用例独立 `DSH_HOME`/profile/workspace；真实 `tools/pre-execute`、真实工具执行、真实会话持久化、真实 SQLite。
- 模型：本地确定性 fixture adapter。它不是真实模型，只回放固定 reviewer JSON 与工具调用；本轮**没有**用 mock reviewer 代替判定。
- 人工：`approval-sim` 是模拟应答器，每条记录都带 `simulated: true`；它只证明审批 seam 与插件映射，**不是**真实人工审批。
- 结果：14 个用例，`check.mjs` **146 passed, 0 failed**。关键事实：

| 用例 | 权限结果 | 执行 | 模型调用 | 说明 |
|---|---|---|---|---|
| allow-rule | allow | success | 0 | 规则完整覆盖，未调用 reviewer |
| deny-rule | deny | not-started | 0 | body 未执行 |
| review-allow | review-allow | success | 1 | 真实 reviewer 链路 |
| review-deny | review-deny | not-started | 1 | 高风险拒绝 |
| review-error-fallback | fallback-deny | not-started | 2 | 非法输出经 1 次修复后失败；strict 兜底 |
| force-ask-strict | fallback-deny | not-started | 0 | 不交模型代批 |
| force-review-shadow | review-allow | success | 1 | force-review 遮蔽 allow |
| audit-unavailable | allow | success | 0 | SQLite 不可用仍放行；会话记录写入 |
| force-ask-human-allow（模拟） | human-allow | success | 0 | 模拟 allowed-once |
| force-ask-human-deny（模拟） | human-deny | not-started | 0 | 模拟 rejected |
| review-escalate-human-allow（模拟） | human-allow | success | 1 | 审查升级后可批准 |
| review-escalate-human-abort（模拟） | human-abort | not-started | 1 | cancelled 不算 human-deny |
| subagent-allow | allow（父委派 + 子调用） | success | 0 | 父会话 main、子会话 subagent 各自经过规则 |
| probe-override | review-deny（facts 置真） | not-started | 1 | reviewer 全 false，`.env` + curl 事实使 secrets／egress 为真 |

- 会话日志实际包含 `plugin:arbiter/decision`；`audit-unavailable` 用例在 SQLite 打开失败时仍写入了该记录，证明两个写入目标独立。
- SQLite 详情包含调用、阶段、完整快照、模型调用和配置快照。

### 3.3 Web 配置与查询（真实宿主路由，无浏览器点击）

在隔离 Web profile 上启动 `--port 56110`，完成 token → cookie 认证后实际调用：

| 操作 | 结果 |
|---|---|
| `GET /api/arbiter/state` | 200，返回完整有效配置、修订、审计状态、覆盖说明 |
| `POST /api/arbiter/config/save` | 200，写入 profile patch，`effectiveRevision` 与 `fileRevision` 更新，模式与规则生效 |
| 外部修改 patch 后用旧 revision 保存 | 409 `config-conflict`，草稿未被覆盖 |
| `POST /api/arbiter/validate` | 未锚定 regex 返回 `ok: false` 与具体错误 |
| `POST /api/arbiter/test` | 返回 allow／review(default)、命中规则、遮蔽与 completeness |
| `GET /api/arbiter/logs` | 200，空记录时返回空数组与 total 0 |
| `POST /api/arbiter/analyze` | 200，返回候选与新增数（本轮数据库为空时为 0） |
| `GET /api/arbiter/replay` | 200，返回比较计数 |
| `GET /api/arbiter/credentials` | 200，返回 `configured: false` |
| 客户端模块 URL | 200，约 108 KB，`window.__ModuleLoader__.load({id:"dsh-arbiter"...})` |
| 保存后 Loader 重新加载 | `/api/arbiter/state` 继续可用，audit health 为 ok，新模式与规则生效 |

**未做浏览器点击验证**：没有在真实浏览器中打开配置页并逐项点击。React 页面代码经过类型检查、esbuild 打包和 bundle 工厂检查；路由与真实数据已验证；但渲染、表单交互、tooltip 与视觉布局仍属于未运行的 UI 验证。

## 4. 初版实现选择（可调整）

这些是实现选择，不把未决产品问题记成用户确认。集中登记见[决策记录](decisions-and-questions.md#implementation-choices-2026-10-21)。

| 编号 | 选择 | 理由 | 用户可见影响 | 验证 |
|---|---|---|---|---|
| I1 | 用自带保守 shell 读取器替代 tree-sitter-bash WASM | 同步 pre-execute 中无 WASM 加载风险；同一实现可在浏览器规则测试复用；显式 `completeness` 与 `unresolved` 保证“不完整不冒充完整” | 支持常见语句、管道、重定向、赋值、`cd`、引号与展开；复杂 shell 语法标记 partial；不防恶意构造 | 单测覆盖；未与 tree-sitter 逐例对照 |
| I2 | 重定向与赋值也是独立匹配节点；完整 allow 必须覆盖它们 | 保持“每个 AST 节点都被 allow 覆盖”的安全语义，避免 `echo x > ~/.ssh/...` 被命令 allow 顺带放行 | 带重定向的命令通常需要额外 path glob allow 规则；规则测试显示 `partial-allow` | 单测与集成 |
| I3 | tool 规则使用显式工具名 + 可选 selector；没有 selector 时匹配工具名，显式 whole-tool allow 覆盖整个调用 | 不把任意 JSON 拼成 shell 文本；MCP 同名工具按完整 `mcp__server__tool` 区分；whole-tool allow 是用户明确写下的宽规则 | 非 bash 工具需要 `node: "tool"` 规则；selector 缺失时不匹配 | 单测 |
| I4 | 外层 `run_code` 进入工具准入，按完整程序文本送审；内层调用独立判定 | 外层 deny 可阻止程序启动；内层 allow 不授权其他内层调用；不声称逐项拦截直接 Node 效果 | `run_code` 默认审查；需要规则时用 tool 规则 | 继承七组宿主证据；本轮未新增 run_code 集成用例 |
| I5 | 插件直接调用 `ctx.approval.request`，不返回 `ask` | 只有直接调用才能区分 allowed-once／rejected／cancelled／unavailable，并记录 human-abort；`ask` 的最终人工结果不回到 pre-execute | normal 模式需要人工时弹出宿主审批 UI；自动模式或通道不可用时立即 fallback-deny | 14 个集成用例中的 4 个模拟人工路径 |
| I6 | 会话记录使用 `session.append('plugin:arbiter/decision', …)` | 外部插件无法导入 `appendPluginRecord`，也不能扩展 `PluginRecordMap`；运行时 append 在真实 DSH 中接受该类型 | 会话恢复可读取最小裁决；宿主未来若收紧未知事件类型，该写入需改为受支持 API | 真实会话日志中已观察到该事件 |
| I7 | 配置页通过 exact Fetch 路由 + `configEditor.edit`，不使用 Typert Remote | 外部包无需生成 Typert 代码；exact route 仅 owner Peer 可用；`configEditor` 走与 Settings 相同的校验、应用和并发保护 | 页面自带保存按钮；文件与 UI 同一路径；冲突返回 409 | Web 路由实测；UI 渲染未点击 |
| I8 | 配置修订由 profile patch 文件内容哈希计算 | 能发现外部修改与写入中的文件；与配置内容快照、生效记录分开 | 外部编辑后旧草稿保存被拒绝；需要“重新读取”合并 | Web 实测 409 |
| I9 | 无效配置加载时使用 `last-good.json`，否则用内置默认配置 | 保持当前有效配置继续工作；避免启动失败或静默关闭门禁 | 页面显示配置错误；门禁继续按上一份有效配置运行 | 单测/解析；未做外部非法文件集成 |
| I10 | 审计用 `node:sqlite`，异步有界队列；失败只标记 degraded | 无本地编译依赖；权限结果不等待持久化；故障不改变结论 | 记录可能缺失，页面显示故障；审批继续 | `audit-unavailable` 集成用例 |
| I11 | 离线候选最少 3 次、全部放行、无失败且无硬类别；规则为 `^<前两个命令词>(?:\s|$)` | 先打通真实审核流程；候选只是建议，必须人工确认 | 候选保守、数量可能少；可修改规则文本 | 单测；真实历史为空 |
| I12 | 默认策略 `arbiter-policy-v1`：R1／R2 固定拒绝，R4／R5／R3／R8 要求人工，R6／R7 按风险与授权代批；progress 放宽 medium 上限与批量外发 | 形成自洽、可回放、normal = strict 的初版；阈值标为未校准 | 保守：中风险无明确授权会要求人工；progress 可代批更多 | 单测与集成固定信号 |
| I15 | `arbiter-policy-v2`（#22）：阈值表改为由 54 例合成标注样例区间夹逼的初值；R8 与 R5 分开报告；风险类别固定为契约常量并移除可写的 `chatLowRiskMax`；新增 `tests/policy-calibration.test.ts` 守卫默认值与记录在案的候选 | 让发布默认值可追溯到可复核样例，修正「未过概率门」被表述为「已识别风险」，并消除「可调字段改写授权类别」造成的两协议分歧 | 计算/默认值基本不变；R8 的理由与其他规则一样可区分；高级设置少一个字段；改默认值若脱离证据会失败 | 确定性回放 54/54、840 输入网格、`pnpm verify`；真实模型 chat 小样本见[评测记录](../validation/arbiter-integration/2026-10-26-policy-calibration/REPORT.md)（72 次请求、16 例中 13 例每次一致、0 解析失败；decision `not-run`） |
| I13 | 无 `exec.agent` 的程序化调用直接 `next()`，不进入插件判定 | 官方 auto review 同样跳过；这类调用没有会话、证据或审批通道；强行审查会产生无来源的人工要求 | 调试/内部程序化调用不在覆盖范围内，页面“覆盖范围”明确列出 | 仅源码/设计；未做无 agent 集成 |
| I14 | 熔断按会话计数，`turn/start` 重置；默认 preset balanced | 先提供有界保护；按 turn 精确边界仍待验证 | 连续拒绝会提前进入 error-escalate；不伪造 review-deny | 无集成用例；单测未覆盖 |

## 5. 与已确认契约的对应

- 规则优先级、`review(default)` 兜底、force-review 遮蔽 allow：实现并有单测／集成。
- normal 与 strict 共用常规策略，strict 只把需要人工的调用结算为 fallback-deny：`decideReview` 只接收 `normal` 或 `progress` 策略；集成对比了 normal 与 strict。
- progress 在形成审查结论前调整条件，不覆盖已形成的 deny／error：策略层实现；回放可比较。
- 人工、故障、兜底阶段分开：trace 记录 `review-escalate → human-*`、`error-escalate → fallback-deny`、`force-ask → fallback-deny`。
- 首版策略与阈值初值按 #22 选定并记录限制；`normal = strict ⊆ progress`、两协议统一授权标准由确定性样例与网格断言锁定，模型质量部分单独记为 `not-run`。
- 配置成功应用后才生效；已有结果不重算：配置在 `configEditor.edit` 成功后由 Loader 重新加载，运行配置发布到 profile runtime；在途请求保留原审查协议与快照，模型返回后未形成的判定读取新配置，阶段记录各自 revision。
- 规则只由用户编辑或人工确认候选产生：候选未确认不进入运行时；确认后走普通配置校验。
- 审计失败不改变权限：`audit-unavailable` 证据。
- 不自动执行历史调用：恢复只读取先前裁决，不触发工具。

## 6. 仍需人工或外部服务验证

| 项目 | 状态 | 原因 |
|---|---|---|
| 真实人工审批 UI | **未运行** | 本轮无用户点击；`approval-sim` 只证明 seam 与映射 |
| 真实 chat 模型质量／阈值 | **未运行** | 集成使用确定性 fixture；需真实 provider 与样本 |
| decision 后端真实网络 | **未运行** | 无可用 endpoint／凭据；仅有协议单元测试 |
| 浏览器点击配置页 | **未运行** | 路由、真实数据与 bundle 已测；无浏览器自动化 |
| 子 agent 基本 allow 门禁 | **已新增** | 父委派与子 bash 各自进入门禁，会话类型 main／subagent |
| 子 agent deny／progress／父证据／冷恢复 | **未运行** | 只覆盖了基本 allow 路径 |
| MCP／workflow 与插件组合 | 继承七组宿主证据；**本轮未新增** | 需本地 MCP／workflow 用例 |
| 外部后端子任务 | **未运行** | 无可用后端 |
| 真实阈值校准、误放率 | **未运行** | 需人工标注样本；运行时只能得到失败率下界 |
| 无 `exec.agent` 路径 | **未运行** | 当前选择跳过并记录为覆盖缺口 |
| 配置热更新／在途请求 | 生命周期夹具已通过；**真实 DSH 热更新未运行** | 已用显式夹具验证模型等待时切 strict；真实 Loader 在途回归仍待补 |
| 跨进程 SQLite 并发／实例级保留 | 未验证 | 单进程测试 |
| 会话记录长期保留与 compaction 后读取 | 部分 | 写入已在真实会话观察；冷恢复读取未集成 |

## 7. 产品语义未定 vs 实现未完成

**产品语义未定**（不以本轮实现选择冒充确认）：

- C1：正式规则 allow 与审查不变式的全局边界；
- C2：secrets 与正常认证的最终区分；
- C3：`completeness = partial` 对全部正式规则的统一 allow 边界；
- C4：bulk、不可逆删除与 progress“永不提升”清单的交互；
- C5：外层 `run_code` 的长期产品策略（本轮选择进入工具准入）；
- O11：与其他审查者的监听顺序（本轮不承诺优先）；
- 判定阈值、progress 扩展范围、等待／重试／熔断参数仍需评测。

**实现未完成**（工程缺口，不是产品待决）：

- 浏览器 UI 的真实点击回归与视觉检查；
- 真实人工审批与真实决策模型端到端；
- 子 agent deny／progress／父证据、MCP 与 workflow 的插件级集成用例；
- 真实 DSH Loader 的模型等待／已形成结论／已弹人工三个边界的在途配置切换；
- 冷恢复读取会话记录与 SQLite 补缺的联合用例；
- 无 agent 调用、外部后端子任务的适配；
- 更完整的 shell 结构与 tree-sitter 对照；
- i18n：页面当前以中文为主，locale 文件只提供最小元信息。

## 8. 复现

```sh
mise exec -- pnpm verify

cd validation/arbiter-integration/2026-10-21-arbiter-01
node scripts/run-case.mjs
node scripts/check.mjs
```

Web 复核（隔离 profile；不会修改日常 profile）：

```sh
# 创建并启动一个隔离 Web profile，安装本包，使用 --no-open --port <free>
# 从 stdout 取带 token 的 URL，兑换 cookie 后调用 /api/arbiter/*。
```

原始结果：`validation/arbiter-integration/2026-10-21-arbiter-01/raw/results.json`；逐用例 `cases/<id>/`。宿主覆盖原始证据仍保留在 `validation/host-coverage/2026-10-20-host-coverage-01/`。
