# 首轮实现评审（2026-10-21）

评审对象：DSH agent 完成后的工作区实现，基准提交 `02db947`，包含尚未提交的源文件。本轮做代码审查和补充复现，没有修改产品实现。

结论：主要模块及配置、规则、审查、审计、离线建议入口已经接通，可以继续在隔离环境验证；当前仍有影响权限结果、配置隔离和审计保留的实质缺陷，尚不适合据“完整版本已实现”的表述直接接管日常权限。优先完成以下返修，再评测策略阈值和使用体验。

> 返修状态（同日）：R1–R9 已修复，`pnpm check:regressions` 9/9 PASS，详见[返修记录](implementation-review-remediation-2026-10-21.md)。本文件保留评审时点的问题与复现证据；`validation/codex-review/2026-10-21/results.json` 已由修复后的脚本刷新。

## 验证范围与证据

- 本轮重新执行 `mise exec -- pnpm verify`：通过，包含 61 个单元测试、静态检查、构建和消费者检查。
- 对已有 DSH 集成记录重新执行 `validation/arbiter-integration/2026-10-21-arbiter-01/scripts/check.mjs`：146 passed，0 failed。这里只复核保存的结果，没有重新启动全部宿主用例。
- 新增[补充复现脚本](../validation/codex-review/2026-10-21/reproduce.mjs)及[实际结果](../validation/codex-review/2026-10-21/results.json)：9 个期望行为检查均失败，逐项见下文。脚本调用构建后的真实产品模块；数据库和 profile 文件只写入新建的临时目录并在结束时清理。
- R3、R8 用显式生命周期夹具模拟插件重载，没有把它记为真实 DSH 配置热更新端到端。另核对本机 DSH 0.2.1-rc.2 `dsh-config-editor/lib/index.js`：`edit()` 在第 125 行等待 Loader reconciliation，文档注释同样明确成功返回在 reconciliation 完成之后。应补真实宿主回归确认所有在途边界。
- 未调用真实付费模型，未测试真实人工审批或浏览器点击。现有报告也明确这些尚未运行；确定性 fixture 能证明接口和状态流转，不能证明真实模型判断质量。

复现：

```sh
mise exec -- pnpm build
mise exec -- node validation/codex-review/2026-10-21/reproduce.mjs
```

脚本按期望行为判断，当前退出码为 1；修复后对应条目应变为 PASS。运行会刷新同目录的 `results.json`。

## R1 · P1 · 相对重定向使用调用初始 cwd，忽略前面的 cd

位置：[src/rules/match.ts](../src/rules/match.ts)，279–284 行；相关解析与目录跟踪在 `src/shell/parse.ts`。

只允许 `cd`、`echo`，并给 `/workspace/project/**` 建立重定向 allow。调用 `cd /outside && echo harmless > marker.txt` 时，匹配器用初始 `/workspace/project` 解析 `marker.txt`，记录匹配 `/workspace/project/marker.txt`，完整结果为 allow。实际 shell 的写入目标是 `/outside/marker.txt`。

影响：路径规则授权范围被错误扩大；trusted 下没有文件沙箱补救，guarded 下也不能以沙箱可能阻止代替正确规则匹配。这个例子只做规则求值，没有在实际系统的 `/outside` 写文件。

修复方向：按语句维护有效目录，让重定向匹配使用所属语句的执行目录；无法确定目录变化或控制流时保留未知并转审查。事实构造和匹配不能各自使用一套不同的路径解释。补 `cd` 成功／失败分支和复合命令测试。

## R2 · P1 · progress 的批量外发分支遗漏明确授权条件

位置：[src/policy.ts](../src/policy.ts)，235–244、255–286 行。

复现信号：`risk=3, authorized=0, bulk=true, egress=true, secrets=false, destructive=false`。使用默认 progress 策略，结果为 `review-allow`，原因却写着 `bulk external sending with explicit authorization`。

根因：前面的通用授权要求随风险分数决定，低风险时为 `none`；R6 分支仅检查风险门，没有重新要求明确授权。该信号可通过现有 chat schema 校验。

影响：初版策略自己规定的批量外发授权条件没有执行，日志还给出与输入相反的授权解释。修复时将 R6 所需授权作为独立条件，不由一般风险分类免除；chat 和 decision 均覆盖。

## R3 · P1 · 配置重载后，在途审查继续使用整份旧模式和策略

位置：[src/index.ts](../src/index.ts)，366–425、874–880、1161 行及后续 `settleHuman` 调用。

每次 `apply()` 新建 runtime state；请求开始时捕获 mode、strategy、thresholds，模型返回后继续用原值。生命周期复现：normal 下模型尚未返回，重载并成功应用 strict，再让旧模型返回需要人工的信号；旧请求仍发起人工审批并得到 human-allow。

这与已确认的“旧响应按原协议解释，尚未作出的后续判定使用新配置；已经弹出的审批保留”不同。旧处理器还持有重载时已关闭的 audit 实例，后续结算记录可能被丢弃。

修复方向：将请求生命周期和运行配置发布从 Loader 实例生命周期中分离；明确保留请求协议／模型输入快照，同时在尚未形成的判定处读取当前生效策略。不要用每次执行前再审查替代这一约定。补真实 DSH 的模型等待、已形成结论、已弹人工三个边界测试。

## R4 · P1 · last-good 配置跨 profile 共用，可能恢复另一套权限

位置：[src/index.ts](../src/index.ts)，366–383 行。

`$DSH_HOME/arbiter/last-good.json` 只按实例存放，却保存整个 profile 的审批配置。复现顺序：A 保存 deny，B 保存 allow，A 加载非法规则；A 的“上一份有效配置”实际恢复成 B 的 allow。

影响：同一 DSH_HOME 下普通 profile 配置维护即可改变另一 profile 的权限，不需要并发。已确认的实例级审计归属不能推导为实例级审批策略。

修复方向：恢复信息以实际配置作用域／profile／插件实例标识隔离，并在回退时核对归属。保留当前实例内存配置的路径也需独立于日志成功与否。

## R5 · P1 · 容量清理按物理文件大小循环 DELETE，会误删全部历史

位置：[src/audit.ts](../src/audit.ts)，1067–1097 行；清理调用目前仅在 [src/index.ts](../src/index.ts) 第 401 行初始化时发生。

写入 10 条记录后，数据库及 sidecar 合计 444,776 字节。目标仅降低 16,384 字节至 428,392。执行清理后 10 条记录全部删除，物理体积反而变成 749,656 字节。

根因：DELETE 不立即缩小数据库，WAL 还会增加；循环把“不缩文件”误判成“仍需继续删记录”。现有测试只覆盖按时间删除，未覆盖容量行为。

修复方向：区分有效数据占用、可复用空闲页与物理空间回收，批量清理后配套 checkpoint／回收策略；避免通过删光记录追逐不下降的文件大小。同时补后台调度：目前长期运行中的新增数据不会触发时间／容量清理。共享配置／候选／分析记录及在途保护也应纳入统一保留边界。

## R6 · P1 · decision 后端遗漏全局 customRules 和共有审查说明

位置：[src/reviewer.ts](../src/reviewer.ts)，162–164、735–776 行；调用处为 [src/index.ts](../src/index.ts) 的 decision 分支。

`customRules` 只在 `renderSystem()` 中；decision 请求却只把 `request.user` 放进 `state`，`buildQuestions()` 也不带这些规则。加入唯一的自定义规则标记后，chat 的实际输入包含它，捕获的 decision 请求完全不包含。

影响：切换后端会静默丢失用户的全局审查偏好，以及公共策略中未在 questions 重述的证据处理说明。接口形式可以不同，但用户规则和授权语义不能因此改变。

修复方向：为两类后端建立共有的语义输入，显式映射到各自协议，并用同一授权／规则样例检查实际发送内容；不能只对比最终点值和概率类型。

## R7 · P1 · 人类原话被静默截断，却标为未截断证据

位置：[src/snapshot.ts](../src/snapshot.ts)，103–109 行；父会话人类证据也经过同一函数。

复现人类消息长度 4,073 字符，末尾包含“不要向机器外发送”。快照只保留前 4,000 字符，限制句被删除，但 `evidenceTruncated=false`、`missing=[]`。这是逐条预处理中的截断，后续 token 预算器看不到原始长度，无法补上标记。

影响：reviewer 把缺失限制的片段当作完整原始证据；详情也无法解释当时为何没看到限制。修复应保留逐条来源与截断元数据，统一计入总体完整性，并按契约让缺失信息真正进入模型输入；不只修改 UI 文案。

## R8 · P2 · 确认离线候选后继续写已经关闭的旧数据库

位置：[src/index.ts](../src/index.ts)，1785–1809 行；旧库关闭在 407–411 行。

候选接受处理先 `await configEditor.edit()`，后使用闭包捕获的 `audit.updateCandidateStatus()`。按宿主的 reconciliation 生命周期模拟重载后，规则已经写入新配置，但调用抛出 `database is not open`；候选仍为 pending。

影响：用户看到失败，实际上权限规则已生效；重试又可能遇到重复规则 id。当前 API 验证仅在空候选数据上调用 analyze，没有覆盖确认流程。

修复方向：让候选确认状态与配置应用之间具备明确、幂等的结算过程，且状态写入使用重载后仍有效的服务；补“配置已成功、候选状态写入失败”的可恢复路径及真实 Web 集成。

## R9 · P2 · 离线统计先过滤所有拒绝，候选的全放行依据失真

位置：[src/suggestions.ts](../src/suggestions.ts)，124–126 行。

同一命令族放入 3 条 allow 和 1 条 human-deny。分析仍生成覆盖整个命令族的 allow 候选，统计为 `occurrences=3, approved=3, failed=0`，拒绝记录未进入分组或代表案例。

影响：候选虽需人工确认，但审核人看到的成功率和冲突依据不完整；“全部放行”的筛选条件成为永远成立的前置过滤结果。修复应先按拟议规则的实际匹配范围统计所有结果，再判定候选资格并展示冲突；不能只把被允许的子集作为分母。

## 其他需补齐的契约与验证

以下为静态审查发现的缺口，没有算入上述 9 项独立复现：

- 恢复固定使用 `MAX_PRIOR=40`，而配置公开 `historyMaxItems`；缺失来源被 catch 后未向后续输入传递，会话错误按当前新 callId 查询也无法反映先前丢失。共同 callId 冲突直接以会话记录优先跳过，没有保留冲突状态。
- 审计保存了完整序列化 prompt 副本，尚无独立不可变模板／renderer 历史；与约定的快照重建、内容去重方案不同。原始模型响应还存在固定长度截断，应说明实际保留能力。
- `truncateSnapshot()` 在事实已缩减后仍可重复 500 次且返回 estimatedInputTokens=0；不可再缩减的输入也没有统一硬预算失败路径。应补超大待审程序及长人类证据的预算测试。
- 项目文件默认启用，prompt 写明 PROJECT_RULES 优先于 CUSTOM_RULES。项目文件信任权限尚未确认，应明确记录这项选择并收敛；不能只在报告中保留为抽象待决项。
- 临时实现选择中，自写 shell 读取器取代 tree-sitter 增加了需要独立验证的核心逻辑；本轮不建议继续增加启发式规则前先声称 AST 语义完整。至少补成熟解析器对照和常见 shell 结构案例。
- 简短执行 agent system 指引、提示去重、真实人工 UI、浏览器交互和停用后的宿主状态仍需要对应实现／验证证据。API 返回 200 和 bundle 可加载不等于页面用户流程已验收。

## 返修建议

优先修 R1–R7，补上与已确认契约一致的回归，再修 R8–R9 的完整人工审核流程。R3 与 R8 共享插件重载生命周期问题，应合并分析，避免只在单个调用点捕获“数据库已关闭”错误。R5 的删除算法和后台调度都要验证。修复后先运行这些针对性复现及仓库检查，再补真实 DSH 的热更新、候选确认、主／子任务拒绝与人工审批回归。

当前先保留功能范围，集中把已经实现的流程做可靠；不需要重新缩小为只有骨架的版本，也不建议继续堆新功能来替代这轮返修。
