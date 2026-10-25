# 开发基线

首版功能实现开始前配置的工程约束。现有原型可以按职责重构；数据与权限语义仍遵守产品设计。工程基线不等于首版功能或发布验收已经完成。

## 工具与约束

继续使用 Node 24、pnpm、TypeScript、ESLint、Prettier 和 Vitest。工具与依赖版本固定在 `mise.toml`、`package.json` 和 lockfile，`pnpm verify` 检查 peer 兼容性。React 检查使用支持 ESLint 10 的 `@eslint-react/eslint-plugin`、`eslint-plugin-react-hooks` 和 `eslint-plugin-jsx-a11y-x`，不关闭类型检查来容纳 TSX。

| 范围 | 检查 |
|---|---|
| TS 与 TSX | 现有严格类型检查、类型感知 ESLint、未处理 Promise、不安全断言、未使用变量 |
| `src` 源码 | 单文件 600 行；普通函数 100 行；TSX 函数 200 行；复杂度 15；嵌套深度 4；长度不计空行与纯注释 |
| 所有 TSX | Hooks 规则与依赖、列表 key、DOM 属性、按钮类型、基础无障碍检查、禁止组件内嵌套定义组件 |
| React 组件与 `.ts` Hooks | 监听器、interval、timeout 必须清理 |
| 浏览器模块 | 禁止 Node／SQLite 和后端实现导入；通过客户端服务或 HTTP 边界通信 |
| 纯模块 | `src/types.ts`、`src/policy.ts` 以及 shared／domain／rules／shell／policy 目录不能依赖 React、DSH 或服务器模块 |
| 插件 UI 文案 | 直接 JSX 文本、面向用户的属性及直接渲染的字面量／模板／条件分支进入 locale |
| 测试、脚本、工具配置 | 使用各自适用的规则，不套用产品源码的长度限制；测试禁止 focused／disabled case |
| RTL 测试 | 独立运行 Testing Library 完整 React 推荐检查，识别 `renderClient`；三个 `await-async-*` 规则全部开启 |
| 全仓依赖图 | dependency-cruiser 禁止运行时循环，包含字面量动态 import；不把擦除的纯类型引用当成运行时依赖 |

导入边界覆盖普通 import、re-export、动态 import、require 和 TS import-equals；受保护模块的动态说明符必须静态可知。它是开发约束，不是执行沙箱。一个文件一个主要组件是代码组织约定，不强制将每个微小辅助组件拆成文件。

文案规则检查 `title`、`label`、`description`、`hint`、`placeholder`、`aria-label`、`aria-description`、`alt` 和直接渲染的字符串。用户输入、模型输出、原始证据与协议值作为表达式传入时保留原文。通过任意 helper 间接产生的文案仍需在功能测试与 review 中检查；不声称静态规则能识别所有字符串来源。

React 使用宿主提供的实例，开发／RTL 保持 React 18；不为了跟随最新大版本而单独升级插件。精选 React 规则沿用已安装插件，不开启带有 React 19／RSC 偏好的整套 preset。

ESLint 分两遍运行，均要求零警告。`pnpm lint:code` 使用 `eslint.config.mjs` 检查全仓的严格类型、React 与工程约束；`require-await` 和 `no-floating-promises` 保持开启。`pnpm lint:testing-library` 使用独立的 `eslint.testing-library.config.mjs`，对 `tests/client/**/*.{ts,tsx}` 与 `tests/helpers/render-client.tsx` 执行 Testing Library 的完整 `flat/react` 推荐规则。`await-async-events`、`await-async-queries`、`await-async-utils` 全部开启，并有 userEvent、findBy、waitFor 的正反样例验证。

`eslint-plugin-testing-library` 7.16.2 的三个异步规则在构造自动修复时会修改 AST，与类型感知的 `require-await` 共用语法树会导致崩溃。两遍 ESLint 分别解析源码，保留双方检查且不需要关闭规则或修改依赖。手动注册 RTL cleanup 的 setup 文件不在 Testing Library 配置的检查范围内。

`pnpm lint` 顺序运行这两遍检查。`pnpm lint:fix` 分别运行两套自动修复后，再执行完整 `pnpm lint` 复查。编辑器默认使用 `eslint.config.mjs`，不会自动执行两遍；需要检查 RTL 规则时，运行 `pnpm lint:testing-library`，或显式选择独立配置。提交前的 `pnpm verify` 包含完整的两遍 lint。

## 雏形已满足的约束

已按职责拆分宿主入口、配置、审查、shell 解析、审计存储与 React 页面，移除全部 229 处旧结构／文案违规及其豁免机制。源码统一执行上述限制，不保留按文件放宽、旧代码过渡名单或静态诊断抑制。

UI 自有文案已进入中文 locale；API 返回先作为 unknown，由真实字段校验构造页面使用的数据，测试替身也按宿主接口实现，不靠不安全类型转换。没有扩大产品范围或重写权限契约。

lint 自检包含真实 TSX 配置及结构、Hooks、可访问性、文案和模块边界正反样例，避免“配置存在但没有作用于文件”。.local、构建结果、覆盖率及历史验证工件不参与源码检查。

三个类型感知 lint 测试文件在 `beforeAll` 中初始化 TypeScript 项目，准备阶段限时 30 秒；单条行为断言仍保留默认的 5 秒时限。这样将冷启动成本与规则行为分开，避免 Linux runner 上首次构建类型项目超过单条测试时限，不关闭规则或重试失败测试。

已有 R1–R9 复现脚本保持原样，由 `scripts/check-regressions.ts` 复制到相同目录深度的 `.local/regressions/run-*` 后运行，继续导入当前构建；本轮结果写入该目录，不覆盖历史 `validation` 报告。

首版范围收敛（#20）移除离线建议的公开入口后，历史 R8 覆盖的接纳流程不再属于首版：脚本与 `results.json` 保持原样作为历史证据，不按用例名建立豁免，也不删除用例。R8 改为对其 `actual` 观测值做正面断言——候选必须仍为 `pending`、`ruleAdded` 必须为 false、且接纳尝试确实因路由不存在而失败（`acceptError` 有值，且没有 handler 的 JSON 回复）。若接纳路由被恢复并真的生效，R8 会转为通过或记录 `accepted`，该断言随即失败，因此它不可能放过一个原因不同的真实缺陷。R1–R7、R9 仍要求原样通过。当前契约另由 `validation/first-release-scope/2026-10-25/reproduce.mjs`（S1–S3）正面验证：建议端点不存在、尝试接纳不改规则与候选状态、规则测试与日志仍可用且已有审计行保留。判定规则实现于 `scripts/regression-verdict.ts` 并有单测覆盖正反例。

## 分层测试

| 层次 | 环境与入口 | 交付要求 |
|---|---|---|
| unit | Vitest Node，`pnpm test:unit` | 纯逻辑、schema／策略和工程约束的正反样例 |
| integration | Vitest Node，`pnpm test:integration` | 临时目录、真实 SQLite、文件和生命周期组合；复用现有测试 |
| ui | Vitest jsdom、RTL、user-event，`pnpm test:ui` | 真实组件交互、禁用状态、插值、宿主语言订阅与中文回退 |
| dsh-e2e | Playwright + 真实隔离 DSH，`pnpm test:e2e:dsh` | 当前构建插件、真实管理器导航、配置接口、实际 UI 交互与刷新 |

`pnpm test` 分别运行三个命名的 Vitest 项目，每一层都必须包含真实测试；不使用一次聚合运行来掩盖空项目。`pnpm verify` 还执行 lint、格式、类型、i18n、构建消费者及已有回归检查。测试禁止 focused／disabled case，不靠默认 skip、预期失败或永真断言占位；E2E 也检查缺失断言。未来场景先记录在功能任务中，实现时提交适用测试。

现有页面按职责拆分，`ConfigActions`、模式设置和规则测试已覆盖真实组件交互。RTL 使用真实子组件和用户操作，在外部服务边界提供替身；没有必要给纯包装组件增加只重复实现的测试。状态转换可以抽为 Node 逻辑测试，复杂界面仍可在同一个 UI 测试项目里做组件集成。

需要 HTTP 的测试按文件调用 `tests/helpers/api-mock.ts`，使用 MSW 3 的真实 fetch 拦截；未匹配请求按 `onUnhandledFrame: 'error'` 拒绝，每例重置 handler，文件结束关闭。现有 API 测试验证成功 POST、结构化错误、文本故障、损坏 JSON 和网络错误，不依赖真实网络或 mock 掉被测 API。

fast-check 已接入现有规则优先级测试，每项 100 轮，失败输出 seed／path 供复现。性质测试根据行为契约验证 deny 优先级、输入次序变化及禁用规则，不复制判定实现作为期望结果。它曾发现规则测试区没有过滤禁用规则的问题；匹配器现已与运行时保持一致，配置校验仍检查禁用规则的格式。

## Coverage 只生成报告

运行 `pnpm test:coverage`，一次运行 unit／integration／UI 三个项目并汇总。报告明确包含 `src/**/*.{ts,tsx}`，排除无可执行代码的 `.d.ts`；完全没有被测试导入的实现文件也进入报告。输出 `coverage/index.html`、`lcov.info` 和 `coverage-summary.json`。

**不设置覆盖率硬门槛，不维护 coverage 过渡名单，也不因百分比低而让 CI 失败。** 普通测试失败或采集工具故障仍正常报错。验收依据是行为契约及有区分力的断言，报告帮助发现遗漏；不为提高数字添加无意义调用、实现镜像或大快照。

## 打包产物检查

`pnpm check:build` 先 `pnpm pack`，对实际 tarball 执行 publint，再在临时消费者中离线安装，验证后端导入、声明文件正反例、DSH 客户端模块工厂以及 locale／patch 文件。消费者不能通过整个仓库软链接获得未打包的文件；依赖来自前面的冻结安装，不联网、不执行安装脚本，结束后清理。

`./client` 继续导出 DSH 的 `window.__ModuleLoader__` 工厂，产物以 `.cjs` 明确其格式，宿主从 package exports 读取实际文件路径。publint 不过滤任何格式诊断；warning／error 均失败。消费者检查仍使用真实 React 验证工厂注册与导出，真实 DSH smoke 再验证宿主加载。

## i18n 的开发与发布检查

客户端通过真实 DSH `locale.register/bind/getSnapshot/subscribe` 接入宿主偏好，插件卸载时释放资源。资源按 `locale/<语言>/<模块>.json` 维护，例如 `locale/zh/config.json`、`locale/zh/rules.json` 和 `locale/en/common.json`。按稳定功能模块拆文件，文件内部用嵌套对象表达分组，属性名不再包含点号；组件仍用 `t('config.actions.label')` 这样的完整点号 key。文件名提供模块命名空间，文件内容不重复套模块名。`common.json` 保留既有根级 `title`／`summary` 等公共 key，不增加 common 前缀；命名空间碰撞和字符串／对象冲突会报错。

`src/client/i18n/resources.ts` 显式导入各语言与模块，供 TypeScript 从中文叶子节点推导合法 key，并把资源编入浏览器包；新增文件或语言时同步登记。运行时先展平成点号 key，再逐条合并中文回退，因此部分译文不会覆盖整个中文分组。缺文件、缺分组或缺叶子都能按条回退，用户内容和插值参数不被重复解释。

`locale/schema.json` 是所有语言共用的 JSON Schema，只规定嵌套对象、合法属性名和非空白字符串，禁止数组、数字、布尔与 null；不手工枚举全部文案 key。`.vscode/settings.json` 为资源文件关联该 schema，字典自身不混入 `$schema`。校验使用仅开发环境依赖的 Ajv，浏览器不加载 schema 校验器。

`pnpm check:i18n` 扫描所有语言目录及其每个 JSON 文件，先应用共享 schema，再以中文为基准检查未知模块／key、对象与字符串冲突及插值一致性；检查对象不限英文。磁盘资源还必须与客户端登记完全一致，防止新增资源未实际打包或注册。开发阶段允许译文缺文件／key，不能容忍已有译文格式错误。模块文件使用小写开头的字母数字名称；语言目录使用如 zh、en、fr、pt-BR 的语言标签。

`pnpm check:i18n:release` 对所有已声明语言要求完整覆盖中文叶子，`pnpm check:release` 先执行这一门禁，再执行完整检查和真实 DSH smoke。目前英文尚未补齐是已确认的开发阶段状态，发布门禁应当失败，不能用中文回退冒充英文完成。新增／修改 UI 继续复用此入口，设计稿和 issues 继续中文。打包消费者递归核对全部语言资源及 schema；真实 DSH 的构建指纹也包含整个 locale 目录。

2026-10-25 资源重组验证：214 个中文 key 与文案、2 个已有英文 key 与文案均与拆分前一致。`pnpm verify` 通过 139 项 unit、39 项 integration、18 项 UI 和 R1–R9；包含第三语言的共享 schema、结构／插值、发布完整性、资源登记及逐条回退验证。macOS arm64、DSH 0.2.1-rc.3 下三个真实 smoke 均通过，覆盖语言切换和刷新。发布检查按预期拒绝仍缺失的 212 个英文 key，不表示英文已完成。

## 真实 DSH E2E

先安装浏览器：本机使用 `pnpm exec playwright install chromium`，Linux runner 使用 `pnpm exec playwright install --with-deps chromium` 安装系统依赖。测试默认从 PATH 查找公开 `dsh` 命令，也可用 `DSH_E2E_BIN` 指定安装版可执行文件。npm CLI 使用 `DSH_E2E_CLI` 指定绝对 JavaScript 入口，由当前 Node 直接执行，不经过 shell 或 Windows `.cmd`；两种覆盖值不能同时设置。

`pnpm test:e2e:dsh:smoke` 只运行带 `@smoke` 标签的轻量用例；`pnpm test:e2e:dsh` 运行全部真实宿主场景，目前两者均为三个已实现用例，后续功能交付时加入适用场景，不添加占位或跳过。两个入口都会先构建当前代码，再以临时 `DSH_HOME`、profile、工作区和系统分配端口启动宿主；不会复用日常会话或发送模型请求。现有 smoke 最多使用三个 worker 并行，每例独立启动并清理宿主；后续需要共享生命周期的场景应在对应测试内明确组织。

GitHub-hosted runner 从独立的 `tests/e2e/runtime/package.json` 和 `package-lock.json` 安装精确锁定的 DSH，本轮实测版本为 **0.2.1-rc.3**。PR、main 与后续 release 共用该版本来源，不依赖机器预装或发布当天的 `latest`。`npm ci` 锁定完整依赖树，安装脚本只允许清单中的五个依赖，新增脚本需明确审查；该运行时不进入插件依赖或发布包。工作流自动读取期望版本，fixture 在启动前核对 `--version`，不接受实际版本漂移。

DSH 通过升级 PR 维护：Dependabot 为 `/tests/e2e/runtime` 单独每周检查，沿用 7 天 cooldown，最多保留一个常规更新 PR，不与根目录开发依赖分组；也允许维护者手动更新清单和 lockfile。升级 PR 自动跑三平台 smoke，由人工检查候选版本、预发布通道、兼容结果及必要的完整宿主回归后合并，不自动合并。当前使用 RC，候选 RC／正式版本及跨通道变化仍需明确审核；不把机器人提出更新当作版本已获接受。

本地复现 npm 运行时（以下为 POSIX shell；Windows 可设置同名环境变量并使用绝对入口路径）：

```sh
npm ci --prefix tests/e2e/runtime --strict-allow-scripts --no-audit --no-fund
DSH_E2E_CLI="$PWD/tests/e2e/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" \
DSH_E2E_VERSION="$(node -p 'require("./tests/e2e/runtime/package.json").dependencies["@deepseek-ai/dsh"]')" \
pnpm test:e2e:dsh:smoke
```

fixture 给当前原型显式配置空对象以加载有效默认值。未提供配置时原型会报告 `configuration must be an object`，因此本 smoke 证明的是“已配置插件”的加载与接线，不宣称裸安装默认流程已通过首版验收。相关默认值行为仍由首版配置任务处理。

测试通过真实宿主按钮处理首次预览／登录提示并进入插件页，不伪造页面或响应。运行结束清理进程和临时 profile，逐例保存 `cleanup.json` 并检查宿主退出和临时目录删除；Windows 使用 `taskkill /t /f` 清理当前 fixture 的进程树。`.local/e2e/` 保存宿主版本、构建指纹、脱敏日志及失败 trace／截图；CI 另保存安装日志与实际 DSH lockfile。缺失宿主或浏览器会失败；权限、沙箱及环境问题如实记录，不能将未运行标成通过。

本机 smoke 不替代后续审批、工具执行、重连／冷恢复、停用／卸载和并发用例。后续场景复用同一 fixture；并发窗口用 callId、生产 trace 和可控屏障证明，避免通过固定 sleep 猜时序。明确要求真人或真实模型的验收单独记录其证据级别。

axe 已对真实插件初始配置页的 `[data-arbiter-root]` 区域运行默认规则，宿主管理器外框不属于该扫描范围；未关闭或排除规则。报告附完整 JSON、页面截图及 `axe-incomplete` 注解。初次运行 0 violations、24 项规则通过，35 个节点的对比度无法自动判定，不能视为对比度通过。隐藏页签、展开区、弹窗、主题、键盘与阅读体验随对应功能分别验收。

## PR 标题与 squash 消息

PR 标题采用英文 Conventional Commits：`type(scope)!: summary`，scope 和 `!` 可选。type 固定为 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`build`、`ci`、`chore`、`style`、`revert`；scope 使用小写字母／数字，可用 `.`、`/`、`_`、`-` 分段。冒号后一个空格，summary 非空，整行没有首尾空格。例如 `ci: validate PR titles`、`feat(rules)!: change the rule format`。不额外设置标题长度门槛。

机械检查将英文约束为可打印 ASCII、单行和上述结构，拒绝中文、弯引号、控制字符与换行；它不判断语法或措辞质量。PR 正文、issue 和设计文档继续使用中文。开发提交使用英文，代码与文档分开提交；CI 不逐个约束 PR 内部的临时提交。

`scripts/github/message-policy.ts` 是唯一的消息校验实现。`pnpm check:pr-title "ci: validate PR titles"` 可本地检查标题。独立的 `PR title` 工作流在 PR 创建、标题编辑、推送、重开和转为可评审时运行，不安装项目依赖；标题经环境变量传入 Node，不拼接到 shell。标题编辑只重跑这个独立工作流，不重跑普通 CI 或 DSH smoke。main ruleset 在原有 squash 限制与 `Verify` 之外，将 GitHub Actions 的 `PR title` 设为必需检查。

仓库 squash 默认标题设为 `PR_TITLE`，正文设为 `BLANK`：无论 PR 有几个 commit，都使用 PR 标题，不从中间 commit 或中文 PR 正文生成消息。最终 subject 带 GitHub 的 `(#编号)` 后缀。可选 commit body 必须使用英文可打印 ASCII，允许换行和 tab；合并脚本会将 CRLF 规范成 LF。Dependabot 的根目录 npm、DSH 独立运行时和 Actions 三项配置均显式使用 `prefix: chore` 与 `include: scope`，生成 `chore(deps): ...` 或 `chore(deps-dev): ...`，不豁免机器人。

获得合并授权后，在仓库内使用以下入口；预览不发送合并请求：

```sh
pnpm pr:merge 30 --dry-run
pnpm pr:merge 30
pnpm pr:merge 30 --body-file /path/to/english-body.txt
```

脚本要求 PR 已打开且非 draft，检查所有已报告的 CI（包含非必需 smoke），然后重新读取最新标题与 head。检查结果读取 `gh pr checks --json name,bucket`，要求非空且每项均为 `pass`；失败、取消、未完成、跳过、未知或损坏结果都停止，不只依赖 gh 进程退出码。检查期间 head 改变则停止；合并前复用同一校验器检查最新标题、最终 subject 与正文，再显式传入 `--squash`、`--match-head-commit`、subject 和正文 stdin。不使用 admin、auto-merge 或自动删除分支。GitHub 服务端仍执行现有 ruleset。合并过程中标题再次变化不会改变已经校验并明确提交的消息；head 再变化由服务端拒绝。

GitHub 的 squash 默认值不能禁止人在页面或 API 中覆盖消息，因此统一通过上述入口合并，不能只依赖之前通过的标题检查。新增工作流随本 PR 验证；其他旧分支需要同步包含该工作流的 main，再通过 PR 更新触发必需检查。规则格式、消息来源与 Dependabot 设置分别参考 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)、[GitHub squash 配置](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)与 [Dependabot commit-message](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#commit-message)。

## CI

普通 PR／main CI 在 Ubuntu 24.04 上并行执行 `pnpm verify` 包含的检查，共 10 个独立入口：类型、源码 lint、Testing Library lint、格式、依赖边界、工作流／文案／peer 六组静态检查，unit／integration／UI 三层测试，以及构建／消费者／R1–R9 加首版范围回归。各入口自行安装固定工具和冻结依赖，复用 mise 与 pnpm store 缓存，不经过共享的前置 setup job；同一组 matrix 的失败不取消其他入口。

三层测试各执行一次，同时输出含 coverage 的 Vitest blob。后续 coverage job 只依赖测试，检查三份 blob 均存在后合并生成全量 HTML／LCOV／JSON 报告，不重复运行测试，不设覆盖率门槛；报告保留 7 天。最终常驻 `Verify` job 无论前面成功、失败或跳过都会汇总，仅全部依赖成功时通过，供分支保护使用。汇总代码有实际子进程正反测试，覆盖失败、取消、跳过、未知和缺失结果。连同 coverage 与汇总，工作流共 12 个 job 实例；新提交取消同一 PR 的旧运行。

验证包括运行时依赖循环、actionlint 和 zizmor 离线静态检查；zizmor 由 mise 固定版本，使用标准 regular persona，无需凭据或远端服务。Dependabot 的普通更新设置 7 天 cooldown。

独立的 `DSH E2E` 工作流使用 GitHub-hosted runner，不再要求预装 DSH 或部署 self-hosted runner。其 job 与普通 CI 独立，两个工作流同时运行，不把 smoke 串在 `Verify` 后面。工作流先用不安装依赖的轻量 job 选择平台，再并行启动选中的系统；三个 smoke 保持并行，跨平台 matrix 使用 `fail-fast: false`。复用 pnpm store 和 npm 下载缓存，每次仍通过冻结安装和 `npm ci` 校验依赖。失败时不重试掩盖问题，工件保留七天。

| 时机 | 运行范围 |
|---|---|
| 普通 PR | 普通并行 CI；纯文档、纯 Node 测试等未命中路径的改动不触发 DSH smoke |
| 相关 PR | `src/`、locale、E2E、构建、清单／lockfile、固定工具或宿主 patch 等路径变化，自动在 `ubuntu-24.04` 跑 smoke |
| DSH 运行时升级 PR | 改动 `tests/e2e/runtime/`，自动在 Ubuntu、macOS、Windows 三平台并行跑 smoke；Dependabot 与手动升级相同 |
| main 推送 | 自动在 `ubuntu-24.04` 跑 smoke，确认合并后的集成 |
| 手动兼容验证 | `platforms` 可选 Ubuntu、`macos-15`、`windows-2025` 或 `all`；`all` 三个平台同时运行 smoke |
| 发布前 | 使用仓库已接受的固定 DSH 版本，手动 `all` 验证基础兼容，并按实际支持的系统完成关键权限与生命周期验收；完整 UI 旅程主要在基准系统执行 |

自动平台选择读取 PR base 与 checkout 合并树之间的整份 Git diff，不依赖作者、机器人身份、分支名或最后一个提交。运行时目录内的新增、修改、删除、移出与 lockfile 单独更新均触发三平台；解析使用 NUL 分隔文件名，diff 无法读取时失败，不降级成 Ubuntu 通过。main 仍固定一个 Ubuntu 平台；手动触发仍以 `platforms` 的明确选项为准。

DSH 独立目录配置及升级 PR 自动三平台分流的运行证据见[版本维护验证报告](../validation/engineering/2026-10-25-dsh-updates/REPORT.md)。Dependabot 配置检查通过与定时服务实际产生更新分开记录；配置合并到 main 后才开始定时检查，不把分支验证写成服务已运行。

手动入口示例：`gh workflow run dsh-e2e.yml -f platforms=all`。该入口只运行 smoke，不等于完整发布验收。`pnpm check:release` 仍要求全语言完整性、`pnpm verify` 与完整 `pnpm test:e2e:dsh`，各功能的宿主场景随 issue 交付，不推迟到发布前才首次运行。涉及接管、沙箱和卸载回退的改动，在合并前还应提交适用真实宿主证据，不能只凭常规 smoke 放行。

Release Action 尚未实现，`pnpm check:release` 是当前机器上的检查命令，不会自行创建三平台矩阵。后续发布流程必须复用仓库中的 DSH 清单和 lockfile；发布前发现新版时，先提升级 PR、验证并合并，再开始发布，不在 release job 中临时解析或安装另一个 `latest`。平台与版本支持声明以实际验收证据为准。

不同系统共用 Chromium 不能证明宿主语义相同：文件边界、命令／沙箱、启动退出、冷恢复和真实停用／卸载需在每个声明支持的系统分别验收；Windows 还需关注启动器、路径及进程树清理。通用自动化使用真实宿主和插件，在 Reviewer 边界提供确定性响应；真实模型质量与真人操作另留证据，不让日常 CI 等待人工或付费模型。具体已运行平台与能力见[GitHub-hosted 验证报告](../validation/engineering/2026-10-25-dsh-hosted/REPORT.md)，不以 smoke 通过直接宣布该平台首版功能全部受支持。

## 建立基线时的验证

2026-10-25 本机通过 `pnpm verify`：133 项 unit、24 项 integration、18 项 UI，以及 R1–R9 全部通过；包括 69 项工程约束正反样例。实际 tarball 的 publint／离线消费、运行时依赖图、actionlint／zizmor 均通过。按 CI 命令分别执行三层测试并合并 coverage，确认合并不会重跑测试。另在 macOS arm64、DSH 0.2.1-rc.3、Chromium 上，以三个独立 worker 并行完成三项真实浏览器测试，覆盖全部七个设置页签的实际接口读取、规则测试与策略回放，并含初始配置页 axe 扫描，无跳过。可查看 `.local/e2e/report/index.html` 与 `.local/e2e/baseline-verification.json`，其中记录全部 61 个运行产物／locale／清单文件的构建指纹和三个临时 profile 的清理情况。这是建立基线时的本机证据；后续 GitHub-hosted 验证另见上面的独立报告，旧报告保持原样。

反向验证也按预期失败：排除全部 UI 测试后单独运行该项目退出 1；缺失英文的 `pnpm check:i18n:release` 退出 1。它们证明空项目和未完成翻译不会被当成发布就绪。
