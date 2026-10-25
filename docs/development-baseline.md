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

已有 R1–R9 复现脚本保持原样，由 `scripts/check-regressions.ts` 复制到相同目录深度的 `.local/regressions/run-*` 后运行，继续导入当前构建；本轮结果写入该目录，不覆盖历史 `validation` 报告。

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

客户端通过真实 DSH `locale.register/bind/getSnapshot/subscribe` 接入宿主偏好，插件卸载时释放资源。中文 key 集中在 `locale/zh.json`；缺失英文在运行时明确回退中文。开发检查 `pnpm check:i18n` 验证 key、已有英文与插值一致性，允许尚未翻译的英文项。

`pnpm check:i18n:release` 要求英文完整，`pnpm check:release` 先执行这一门禁，再执行完整检查和真实 DSH smoke。目前英文尚未补齐是已确认的开发阶段状态，发布门禁应当失败，不能用中文回退冒充英文完成。现有原型的自有文案已接入中文 locale，新版 UI 继续沿用该边界。设计稿和 issues 继续中文。

## 真实 DSH E2E

先安装浏览器：`pnpm exec playwright install chromium`。测试默认从 PATH 查找公开 `dsh` 命令，也可用 `DSH_E2E_BIN` 指定可执行文件。`pnpm test:e2e:dsh` 会先构建当前代码，再以临时 `DSH_HOME`、profile、工作区和系统分配端口启动宿主；不会复用日常会话或发送模型请求。

fixture 给当前原型显式配置空对象以加载有效默认值。未提供配置时原型会报告 `configuration must be an object`，因此本 smoke 证明的是“已配置插件”的加载与接线，不宣称裸安装默认流程已通过首版验收。相关默认值行为仍由首版配置任务处理。

测试通过真实宿主按钮处理首次预览／登录提示并进入插件页，不伪造页面或响应。运行结束清理进程和临时 profile；`.local/e2e/` 保存宿主版本、构建指纹、脱敏日志及失败 trace／截图。缺失宿主或浏览器会失败；权限、沙箱及环境问题如实记录，不能将未运行标成通过。

本机 smoke 不替代后续审批、工具执行、重连／冷恢复、停用／卸载和并发用例。后续场景复用同一 fixture；并发窗口用 callId、生产 trace 和可控屏障证明，避免通过固定 sleep 猜时序。明确要求真人或真实模型的验收单独记录其证据级别。

axe 已对真实插件初始配置页的 `[data-arbiter-root]` 区域运行默认规则，宿主管理器外框不属于该扫描范围；未关闭或排除规则。报告附完整 JSON、页面截图及 `axe-incomplete` 注解。初次运行 0 violations、24 项规则通过，35 个节点的对比度无法自动判定，不能视为对比度通过。隐藏页签、展开区、弹窗、主题、键盘与阅读体验随对应功能分别验收。

## CI

普通 PR／main CI 运行 `pnpm verify`，再生成并上传 coverage 报告，保留 7 天。验证包括运行时依赖循环、actionlint 和 zizmor 离线静态检查；zizmor 由 mise 固定版本，使用标准 regular persona，无需凭据或远端服务。其 auditor 模式另提示已明确采用的 self-hosted runner，这不意味着需要更换已验证的宿主测试环境。Dependabot 的普通更新设置 7 天 cooldown。

独立的 `DSH E2E` 工作流使用带 `dsh-e2e` 标签、已安装 DSH 的 self-hosted runner，手动触发并保留失败工件；不会把 GitHub 托管环境中未执行的宿主测试记为通过。需要预先准备操作系统的浏览器依赖。

仓库内已配好该工作流，不代表远端 runner 已部署或远端任务已运行。首版宿主相关 PR 应提交适用的真实运行证据；最终版本执行完整宿主回归。随着 runner 可用，再将相关 PR 的触发与门禁接入，不能仅因一个静态工作流文件存在就宣布持续 E2E 已生效。

## 建立基线时的验证

2026-10-25 本机通过 `pnpm verify`：123 项 unit、24 项 integration、18 项 UI，以及 R1–R9 全部通过；包括 59 项工程约束正反样例。实际 tarball 的 publint／离线消费、运行时依赖图、actionlint／zizmor 均通过。另在 macOS arm64、DSH 0.2.1-rc.3、Chromium 上完成三项真实浏览器测试，覆盖全部七个设置页签的实际接口读取、规则测试与策略回放，并含初始配置页 axe 扫描，无跳过。可查看 `.local/e2e/report/index.html` 与 `.local/e2e/baseline-verification.json`，其中记录全部 61 个运行产物／locale／清单文件的构建指纹和三个临时 profile 的清理情况；Linux 与远端 runner 尚未运行。

反向验证也按预期失败：排除全部 UI 测试后单独运行该项目退出 1；缺失英文的 `pnpm check:i18n:release` 退出 1。它们证明空项目和未完成翻译不会被当成发布就绪。
