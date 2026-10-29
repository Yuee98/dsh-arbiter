# 决策记录与待讨论问题

区分原稿的方案演变、已收敛问题、仍待验证的问题，以及本次产品讨论中已确认的契约与尚未采纳的建议。

状态（2026-10-21）：首轮完整功能版本已实现并可在隔离 DSH 0.2.1-rc.2 profile 中试用；产品语义未定项仍按本文保留讨论状态。实现证据、初版选择与剩余缺口见[首轮实施报告](implementation-report.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md)

**阅读约定**：历史取舍表用于解释方案演变，不单独作为当前规范；具体行为以专题正文为讨论基线，存在冲突时先在问题登记中收敛。原稿中的“已核实”仍需按目标版本复核。

## 本文导航

- [早期取舍汇总（历史记录）](#design-10)
- [方案演变记录（历史记录）](#design-15)
- [原稿问题登记与当前状态](#design-16)
- [本轮已确认的规则契约](#confirmed-rule-contract)
- [规则条件连接词](#rule-combine-v3)
- [术语与 DND 讨论进展](#review-policy-terms)
- [本轮产品讨论登记](#product-discussion)
- [执行覆盖与准入契约](#execution-admission-contract)
- [授权来源与信任边界：已确认](#authorization-trust-boundary)
- [权限选择器与生命周期：已选方案](#permission-ui-decision)
- [DND 待细化项](#dnd-refinements)

---

<a id="design-10"></a>

## 早期取舍汇总（历史记录）

| 决策 | 取舍 | 理由 |
|---|---|---|
| 合并为一个插件 | 包更大、职责更多 | 消除顺序依赖、状态共享、预设槽位互斥（[一个插件，两层门禁](architecture.md#design-3-1)） |
| `allow` 默认含沙箱豁免 | 失去沙箱兜底 | 对齐 Codex 语义；拆分会产生自噬场景（[五层裁决与优先级](rules.md#design-4-4)） |
| 用 danger-full-access 预设 | 沙箱不再是第二道防线 | 与 auto review 同档；规则层先筛（[审查后端与判定](reviewer.md#design-5)、[风险与限制](requirements.md#design-11)） |
| 不自动应答升权 | guard 模式下外部写入需人工 | approval 请求不携带机器可读目标，自动应答等于用不可信输入批准整次无围栏调用 |
| AST 而非纯 regex | 依赖 WASM、启动开销 | 字符串匹配无法表达重定向/拼接结构（[解析](rules.md#design-4-1)） |
| regex 用 re2js 而非自建安全子集 | 不支持 lookahead/lookbehind，否定式需改写 | 引擎级拒绝危险语法 + O(n) 保证，比自建审计更可靠；纯 JS 零依赖（[regex 用 re2js，不自建安全子集](rules.md#design-4-2-1)） |
| 做 reviewer subagent | **砍掉，只做无状态单次调用** | 审查在阻塞路径上，延迟是首要约束；子 agent 秒级到数十秒，且引入递归风险（[审查者形态：只做无状态单次调用](reviewer.md#design-5-2-1)） |
| 首选后端不可用时自动降级到 chat | **不自动回退，用户显式选类型** | 悄悄降级会改变判定质量而不被察觉（[Reviewer 类型选择](reviewer.md#design-5-2)） |
| 变量展开做白名单/黑名单/开关 | **不做**；改为「值永不写入 facts + 符号分类」 | 只把环境值用于算布尔、不外发，隐私风险消失，配置面归零（[变量展开与目录追踪](review-context.md#design-5-2-5)） |
| 审查次数设硬上限 | **默认无限**，可选 `reviewBudget` 仅提示 | 后端成本差异巨大（免费/付费/本地部署零边际成本），硬上限让长任务停摆（[超时、熔断与去重](reviewer.md#design-5-11)） |
| 熔断阈值随模式组合变化 | 预设 + `earlyInDnd` 单开关 | 12 种组合的文档与测试成本过高；行为差异已由「触发后 ask vs deny」体现（[超时、熔断与去重](reviewer.md#design-5-11)） |
| 勿扰用插件状态而非 `never` | 多一个状态位 | `never` 会切断升权通道且文案误导（[为什么不用原生 never](architecture.md#design-6-1)） |
| reason 由代码合成 | 解释略显机械 | 可审计、可统计、可本地化、无注入面（[拒绝理由（reason）](reviewer.md#design-5-7)） |
| 类型二选一，不做自动回退 | 切换需改配置 | 判定质量不可比（分布 vs 点值）；悄悄降级会改变判定语义而不被察觉（[Reviewer 类型选择](reviewer.md#design-5-2)） |
| chat 后端加修复式重试 | 阻塞路径多一次调用 | 无 `response_format`，格式失败只能靠反馈修复；上限 1 次控制延迟（[校验与重试分级](reviewer.md#design-5-4-3)） |
| 不做 tool-call 适配器 | 少一个可选模式 | 无 `tool_choice` 时约束力等同 JSON；保留为 chat 的 `output` 选项（[Chat 后端与重试](reviewer.md#design-5-4)） |
| chat 用 0–10 点值而非 "标签 + decision" | 决策权从模型移到代码 | 决策权威单一是可审计前提；官方"模型直接决策"不可离线调参（[输出契约：policy-aware 信号](reviewer.md#design-5-4-1)、[方案演变记录](decisions-and-questions.md#design-15)） |
| 不采信自报 `confidence` | 少一个可用信号 | 未校准且在误解动作时最自信；`risk` 点值承担可校准的序数职责（[统一中间表示](reviewer.md#design-5-5)） |
| 把判定规则写进 prompt | 有边界锚定风险 | 模型需要知道规则才能产出贴合语义的分级；靠探针矛盾检测与直方图监控缓解（[Prompt 结构](reviewer.md#design-5-4-2)） |
| `risk`/`authorized` 用 0–10 而非 3–4 档 choice | 需要更多锚点写作 | 分布可导出类别标签（不失分类信息），且与 chat 后端点值同形（[Decision model 后端（Clef / Jev）](reviewer.md#design-5-3)） |
| `secrets ∧ egress` 加 `auth=none` 门槛 | 放弃"授权不能解锁凭证外泄"的铁律 | `git push` 等正常工作流本就读凭证+发网络；代价是外泄依赖 critical 判定，记入 [安全边界（必须明确）](requirements.md#design-11-1) |
| 模型不再输出 `driver` | 少一个自报字段 | 归因可由不变式/推导表/概率门确定性算出，避免"理由与判定不符"（[拒绝理由（reason）](reviewer.md#design-5-7)） |
| DND 分 strict/progress 两档 | 配置面变大 | 一刀切 ask→deny 会浪费"接近放行"的部分；两档对应不同无人值守场景（[勿扰态度（attitude）](architecture.md#design-6-3)） |
| 事实段只给无状态审查者 | 两种形态两套输入 | 可检索审查者能自己查证（Codex Guardian 即如此），送事实是冗余甚至污染；无状态审查者缺信息源（[Reviewer 类型选择](reviewer.md#design-5-2)、[证据 §12](../evidence.md#evidence-12)） |
| 事实只允许往"更危险"方向用 | 失去"确认安全"的能力 | "没看到写入"不等于"没有写入"；假保证比不给事实更危险（[事实完整性闸门](review-context.md#design-5-2-2)） |

---

<a id="design-15"></a>

## 方案演变记录（历史记录）

讨论过程中被推翻或修正的决策，记录理由以免重蹈：

| 原方案 | 修正为 | 理由 |
|---|---|---|
| `allow` 与 `allow-unconstrained` 两个裁决 | 合并为 `allow`（默认含 bypass） | 拆分产生"规则放行却被沙箱拒"的自噬场景；Codex 语义本就是一体 |
| 勿扰模式用原生 `never` | 插件会话状态 | `never` 在 waterfall 前拒绝，切断升权通道；文案误导 |
| approval seam 自动应答升权（callId 对表） | 放弃 | 审批请求不携带机器可读目标；自动应答等于用不可信输入批准整次无围栏调用 |
| 两个独立插件（规则 + 审查） | 单包 | 顺序依赖、状态共享、预设槽位互斥 |
| reason 用 `noul` 类型 | 代码合成 | Clef 无自由文本输出类型 |
| 用 workspace-write + 自动升权实现多根 | 放弃，改 trusted 模式 | 沙箱是唯一防线时，闸门只能批准整次无围栏调用，设计残废 |
| 单一 reviewer（Clef only） | 类型二选一（decision / chat） | 没有 Clef key 的人也需要能用；`chat.provider: session` 让零配置可用 |
| 独立 tool-call 适配器 | 降级为 chat 的可选 `output` 模式 | `ctx.llm` 无 `tool_choice`，tool-call 约束力等同 JSON，调试成本更高 |
| 审查失败即终局 | chat 后端允许 1 次修复式重试 | 无 `response_format` 时格式失败是常态；反馈校验错误比重采样更有效 |
| `confidence: null` → 一律 ask | chat 改产 `risk` 点值（0–10）参与决策 | `confidence` 是元认知、未校准、且误解动作时最自信；`risk` 点值是对世界的判断，可离线按级别统计误放率，是可证伪的赌注 |
| chat 输出 `risk` + `decision`，代码只做收紧 | 模型只产信号，决策权完全归代码 | 双决策者会出现"模型说 allow、代码改 ask"的模糊状态；单一决策权威才可审计、可调参 |
| 折中方案里代码二次收紧 | 把判定规则一并写进 prompt 供参考 | 官方 `REVIEW_POLICY` 本就把 medium/high 规则写进 prompt；模型需要知道规则才能产出贴合语义的分级，而不是靠代码事后修正 |
| 要求 chat 自报 `confidence` 并采信 | 不要求、不采信 | 未校准的数字只会制造"假分布"；序数信号已足够，且可验证 |
| `risk`/`authorized` 用 `choice`（3–4 档） | 改用 `score`（0–10） | 分布可导出类别标签、不丢尾部概率、与 chat 点值同形；`authorized` 用 score 还获得单调性 |
| `secrets ∧ egress → deny`（无授权门槛） | 加 `authClass = none` | `git push`/`gh` 本就读凭证发网络，会误伤日常工作流；代价记入 [安全边界（必须明确）](requirements.md#design-11-1) |
| 模型输出 `driver` 归因 | 代码确定性计算 | 有了探针与分层判定，归因是机器事实；模型自报会与判定不符 |
| DND 下 ask 一律转 deny | 分 strict/progress 两档 | 一刀切浪费"接近放行"的部分；两档对应不同无人值守场景 |
| DND strict 只做 ask→deny | 旧方案曾同时收紧 allow 门槛（τ 0.8→0.9）；**当前已改为 normal / strict 共用常规策略** | 早期按无人值守考虑更强证据；当前只在插件人工审批处理上区分两档 |
| 所有审查者都注入 AST 事实 | 仅 `stateless` 审查者注入 | Codex Guardian 是可检索形态并**不注入**解析结果（[证据 §12](../evidence.md#evidence-12)）；能自己查证的审查者不需要，也受不了污染 |
| 事实段可表达"未发现写入" | 只输出 `observed` + `completeness` | "没看到"不等于"没有"；假保证比没有事实更危险 |
| 探针可用事实置真或置假 | 只能置真 | `bash deploy.sh` 看不到写入，不能因此判定 egress=false |
| 子 agent 走原生审批链 | 旧方案：插件内结算并继承父态度；当前改为独立的统一子任务设置 | 原生 `never` 在 waterfall 前拒绝且文案误导；插件在 pre-execute 就结算完，不触发 it（[子 agent 场景](architecture.md#design-5-6-1)） |
| fork `dsh-subagent` 改掉 `never` | 放弃 | 破坏官方"子 agent 权限固定"的安全模型，需重验所有依赖路径 |
| 复刻竞品的会话 grant | 不做；早期 L1/L2/L3 划分已由后续决定替代 | 精确操作本就不重复；上下文无关的免票是隐患；当前保留同轮去重，规则建议统一走离线审核（[当前规则契约](#confirmed-rule-contract)） |
| 复刻竞品的在线学习 | 改离线分析 + 人工确认 | "被批准"≠"安全"；离线有 hindsight、可评审、可回滚（[规则沉淀](rules.md#design-5-10)） |
| 学习规则也短路 | 旧方案：`source: learned` 仍跑 AST 不变式复检；**已被后续决定取代** | 当时将学习结果视为统计推断；当前要求人工审核具体规则，确认后与手工规则同义，取消按来源复检（[当前规则契约](#confirmed-rule-contract)） |
| 运行时回填 outcome | 不做，改纯离线读会话日志 | `toolOk` 信息量低；有价值信号本就在日志里；回填成本高收益低（[不做 outcome 回填](configuration-and-audit.md#design-9-3)） |
| `bulk` 一刀切 deny | 改为组合条件（`destructive ∧ bulk → 不自动 allow`） | 批量操作是正常场景；progress 档的存在意义就是让夜间批处理推进（[bulk 探针](reviewer.md#design-5-6-2)） |
| DND 下所有 ask 一视同仁 | 按来源区分：用户 force-ask → deny；机器推断 → 用 base 判定重算 | "我判不了"不该直接等于拒绝；探针在 DND 下退化为 risk 输入而非独立闸门（[勿扰态度（attitude）](architecture.md#design-6-3)） |
| 规则不做 agents 维度 | 采纳竞品的 `main`/`subagent`/`preset:<name>` | 子 agent 无法弹审批，规则层是它唯一的自主空间；未知身份 fail-closed（[规则 Schema](rules.md#design-4-3)） |
| 冒泡需要新跨 agent 协议 | **不需要**，三条已有通道组合即可 | `approval` 与 `userQuestions` 对子 agent 都封死，但 `agent-message` 开放；父获取授权后转述（[子 agent 场景](architecture.md#design-5-6-1)、[O1](decisions-and-questions.md#question-o1)） |
| 子 agent 只读自己的历史 | **默认读父会话的人类消息** | 多数情况下 implied 就够，省掉"让人进子会话"一轮交互（[授权证据](review-context.md#design-5-2-3-2)） |
| 三种授权来源分别注入 | **合并成按时间排序的 `EVIDENCE`** | reviewer 看到一条时间线，不需要自己分辨三段碎片（[授权证据](review-context.md#design-5-2-3-2)） |
| 照搬官方 `FILTERED_HISTORY` / `PROJECT_INSTRUCTIONS` | 改为三段互斥：`CONTEXT` / `EVIDENCE` / `PRIOR_VERDICTS` | 官方术语把消息混在历史里，无法承载授权强度；分段后职责清晰且不重复注入（[上下文分段](review-context.md#design-5-2-3)） |
| 消息只标来源 | 加 `role` + `evidence` 双字段 | 授权强度与上下文语义正交，缺一不可（[授权证据](review-context.md#design-5-2-3-2)） |
| 父证据与其余来源同等竞争预算 | **父证据保底 1 条** | 子会话话多时，父的授权证据可能被完全挤掉（[授权证据](review-context.md#design-5-2-3-2)） |
| 审查者不知道先前裁决 | **注入 `prior_verdicts`（仅本会话）** | 识别重试与"换写法绕过"的唯一来源；只取 deny/ask，不取 allow（[先前裁决](review-context.md#design-5-2-4)） |
| 注入 AGENTS.md 整条指令链 | **不注入**，改用 CUSTOM_RULES + PROJECT_RULES | AGENTS.md 绝大部分与审查无关，每调用一次是纯浪费（[用户规则来源](review-context.md#design-5-2-3-1)） |
| PROJECT_RULES 支持目录级 `searchUp` | **只读工作区根目录** | 需要按目录细分就在 DSH 建多个工作区，不该用插件再造一层继承（[用户规则来源](review-context.md#design-5-2-3-1)） |
| 消息只用 `source` 单字段 | **`role` + `evidence` 双字段正交** | 人类消息既可能是授权也可能是限制；单字段表达不了两面（[授权证据](review-context.md#design-5-2-3-2)） |
| prior verdicts 跨会话读父/兄弟 | **只取本会话** | 子 agent 不是常见路径；跨会话裁决语义易冲突；[授权证据](review-context.md#design-5-2-3-2) 的父证据是授权语义，不混用（[先前裁决](review-context.md#design-5-2-4)） |
| reviewer subagent（`form: agent`） | 砍掉，只做无状态单次调用 | 审查在阻塞路径上，延迟优先；且引入审查者递归调用自身的风险（[审查者形态：只做无状态单次调用](reviewer.md#design-5-2-1)） |
| 审查者"无法主动验证"列为限制 | 改为"决策模型的工作方式" | 对比基准错了——Clef 本就不探索；责任在插件把快照做好（[审查者形态：只做无状态单次调用](reviewer.md#design-5-2-1)） |
| 变量展开做名单/开关 | 值不外发 + 符号分类，零配置项 | 只需区分"写值"与"算布尔"，隐私面消失（[变量展开与目录追踪](review-context.md#design-5-2-5)） |
| 未解析变量只是"不确定" | 破坏性位置标 `undefined-possible` | 未定义变量展开为空串，`rm -rf $X/` 可能变成 `rm -rf /`（[变量展开与目录追踪](review-context.md#design-5-2-5)） |
| 审查次数上限 | 默认无限 + 可选预算仅提示 | 限制是家长式的；真实风险由去重与熔断覆盖（[超时、熔断与去重](reviewer.md#design-5-11)） |
| 熔断阈值按模式矩阵 | 预设 + `earlyInDnd` 单开关 | 避免 12 种组合的文档/测试成本（[超时、熔断与去重](reviewer.md#design-5-11)） |
| 预算按字符而非 token | **改 token 预算（tokenx）** | 模型按 token 计费限速；Clef 超 20k 明显变慢；字符对 CJK 严重低估（[输入预算](review-context.md#design-5-2-6)） |
| 打包完整 tokenizer | **用 tokenx（2 kB）** | gpt-tokenizer 28 MB 且只对 GPT 系准，Clef/Jev 用不上（[输入预算](review-context.md#design-5-2-6)） |
| 设隐藏安全边际（宣告 10k、截断 9k） | **不设，宣告即截断值** | tokenx 偏差个位数百分比，10k 距 20k 有大余量；隐藏边际会让调 prompt 的人困惑（[输入预算](review-context.md#design-5-2-6)） |
| 手写 token 系数（ascii 0.25 / 非 ascii 1.1） | **用 tokenx** | 不区分语言，中文按 1.1 会高估 60%；tokenx 对 zh 实测 -1.15%（[输入预算](review-context.md#design-5-2-6)） |
| `sandboxed: true` 字段 | **删除** | 语义完全由模式决定：trusted 无沙箱可保留，guarded 下 allow 本来就要过沙箱（[规则 Schema](rules.md#design-4-3)） |
| review-hint 与 allow 同级或更低 | 旧名称顺序为 deny > force-ask > review-hint > allow > implicit；**名称已更新** | 保留显式审查高于 allow 的顺序，现统一为 force-review，并明确 review(default) 兜底（[五层裁决与优先级](rules.md#design-4-4)） |
| 子 agent 强制 strict | 旧方案曾继承父会话 DND 态度；**已被设置页统一子任务模式替代** | 态度是对整个过程的选择，不因委派而改变；仍受 dndMaxRisk 与硬类别约束（[子 agent 场景](architecture.md#design-5-6-1)） |

---

<a id="design-16"></a>

## 原稿问题登记与当前状态

以下保留原稿的 O1–O10 编号。O1、O3、O4、O6 的方案已在原稿中收敛；O10 的结构与预算也已有决定。O2、O5、O7、O8、O9 仍有待定内容，已定方案的运行时表现仍需验证。这里的“已定”表示原稿设计状态，不表示已实现或已验证。

| 编号 | 主题 | 影响 |
|---|---|---|
| O1 | ~~子 agent 授权冒泡~~ | **已定**：三通道组合，无需新协议 |
| O2 | 事实段在 `partial` 时的用途 | 影响 [事实完整性闸门](review-context.md#design-5-2-2) |
| O3 | ~~规则表 vs 项目级配置~~ | **已定**：CUSTOM_RULES + PROJECT_RULES 分层 |
| O4 | （已解决）reviewer 类型选择 | — |
| O5 | `opaque` 白名单 | 影响事实段可用性 |
| O6 | 子 agent 审批模式 | **旧决定已替代**：设置页为全部子任务统一选择 strict / progress，不继承父模式 |
| O7 | i18n | 影响 UI 与 reason 文案 |
| O8 | 配置 UI 与文件一致性 | 影响 [配置与凭据](configuration-and-audit.md#design-8) 实现方式 |
| O9 | prompt 前缀缓存策略 | 影响成本 |
| O10 | prompt 结构与长度预算 | **方案已定**：见上下文预算；效果仍待验证 |

<a id="question-o1"></a>

### O1. （机制已定）子 agent 授权冒泡

**原问题**：子 agent 的审批策略硬编码 `never`，需要人类授权的操作必然失败，如何冒泡？

**结论：不需要新协议，靠三条已有通道组合**（详见 [子 agent 场景](architecture.md#design-5-6-1)）：

| 通道 | 状态 |
|---|---|
| `approval` seam | 子 agent 封死（`never`） |
| `userQuestions`（ask 工具） | 子 agent 封死（`DELEGATED_CALLER`，同样因为"owned child has no human answerer"） |
| `agent-message` 消息 | **开放**——父 ↔ 子双向 |

子 agent 可向父 agent 报告受阻，由父获取用户授权并转述；必要时引导用户进入子会话直接授权。最后由子 agent 的 reviewer 根据证据重新判定，不保证放行。当前按[模型行为指引](architecture.md#subagent-recovery)组织这段流程，不新增自动授权协议。

**两条路径**：

1. **父会话的人类原话 + 父 agent 转述** → 原话明确覆盖操作、目标与范围时可支持 explicit，转述帮助关联任务；不因来自父会话降级。只有转述时不能制造明确授权；
2. **人类直接进子会话说话** → `session-human` → 可支持 explicit；在父级原话不可取得、缺少范围或仍不足时使用，不因需要 explicit 就必经这条路径。

**剩余待验证**（不是设计问题，是实现细节）：

- 父会话的 `deriveMessages()` 在 compaction 后损失多少人类消息原文？若严重，改用事件日志扫描（[授权证据](review-context.md#design-5-2-3-2)）；
- 父不在 live（已销毁 / 子 agent resume）时的降级行为是否符合预期；
- reviewer 能否对语义相同的 parent-human / session-human 授权使用相同标准，同时区分仅有 relay、范围不符和原文被截断的情况；
- ask 工具的真实人类答复保存为哪类宿主事件，如何与具体提问及操作范围一并提取。

<a id="question-o2"></a>

### O2. 事实段在 `completeness = partial` 时的用途边界

**原稿背景**：曾用单个 partial 同时约束事实与 allow。2026-10-22 已由[独立状态与三态求值](rules.md#matching-uncertainty)替代：可靠观察可以提供给 reviewer，缺失事实不能证明安全，词值或事实未知本身不否定明确文本规则。仍需评测可靠观察如何影响风险等级及探针 override，避免误报导致过度 deny。

**待定**：`probeMode: override` 在 `partial` 下是否生效。当前设计倾向于"生效"（因为只往危险方向），但需要实测误报率（[待验证项](implementation.md#design-14) 第 19 项）。

<a id="question-o3"></a>

### O3. （已定）规则表与项目级配置的关系

**决定**：分两层，职责不同，不冲突（[用户规则来源](review-context.md#design-5-2-3-1)）。

| 来源 | 内容 | 维护方式 |
|---|---|---|
| `CUSTOM_RULES` | 自由文本审查指引，可含事实、限制、偏好和持续授权；当前插件配置作用域内跨项目 | 插件配置页／配置文件，不依赖个人 `deploy.ts` |
| `PROJECT_RULES` | 同类自由文本指引，仅本项目；projectRules.enabled 控制读取，内容由用户负责 | 仓库内 `.dsh/arbiter.md`，随项目走，不逐次人工认可 |

**与竞品 `dsh-permission-rules` 的职责区别**：它的 `.dsh/rules.yaml` 是可执行的匹配规则；我们的 PROJECT_RULES 是供 reviewer 解释的自由文本，能表达持续授权，但不直接改写代码策略。插件共存按[已确认契约](architecture.md#approval-provider-coexistence)处理，不由二者字段不同就推断运行时绝无交互。

**不支持** `searchUp` 与目录级覆盖（[用户规则来源](review-context.md#design-5-2-3-1)）。

<a id="question-o4"></a>

### O4. （已解决）reviewer 类型选择

原问题：`current-agent` 后端能否作主后端。**已解决**——改为 `type: decision | chat` 二选一，`chat.provider: "session"` 承担"用当前对话模型"的需求，且仍产出四探针与点值（[Reviewer 类型选择](reviewer.md#design-5-2)、[判定引擎](reviewer.md#design-5-6)）。

<a id="question-o5"></a>

### O5. AST 解析失败与 `opaque` 的判定顺序

**背景**：[已知限制清单](requirements.md#design-11-2) 指出 `opaque` 识别依赖"对解释器列白名单而非黑名单"。但白名单本身有维护成本，且新解释器会不断出现。

**待定**：白名单的初始内容（bash/sh/zsh/python/node/ruby/perl/php 等）、更新机制，以及"遇到未知二进制时默认 `opaque = true`"是否会让事实段几乎永远不可用（从而导致该功能形同虚设）。

<a id="question-o6"></a>

### O6. （旧决定已替代）子 agent 的审批模式

**当前决定**：用户在插件设置页为全部子任务统一选择 strict / progress，不提供 normal 和单个子任务覆盖，也不继承父会话模式。见[模式选择](approval-modes.md#mode-selection)。

以下为被替代的旧理由，仅供追溯：

理由：`progress`/`strict` 是对**整个过程**的态度，不是对单个 agent 的命令限制。用户选 progress 就意味着接受"模型可以代答"，这个接受不因子任务被委派给子 agent 而改变。

继承后仍生效的两道闸：`dndMaxRisk`（风险上限）与硬类别清单（永不提升）。

<a id="question-o7"></a>

### O7. 国际化（i18n）

**背景**：至少需要英文与中文。涉及面比想象广：

1. **UI 文案**：配置页、审批对话框、通知条；
2. **reason 文案**：[拒绝理由（reason）](reviewer.md#design-5-7) 的模型可见 reason 目前是英文（与官方 `REVIEW_POLICY` 一致），displayReason 是中英双语；
3. **reviewer prompt**：`REVIEW_POLICY` 与锚点定义是英文，是否需要本地化？**建议不本地化**——英文 prompt 对模型最稳定，且便于与官方对齐；只有面向人的部分做 i18n；
4. **插件元信息**：`package.json` 的 `displayName` / `description`、插件页卡片文案（走 `locale/*.json` + 导出的 `meta`）。

**待定**：

- 模型可见的 reason 是否也要出中文版？若出，需要在 reason 模板里做两套并选择（会让模板数量翻倍）；
- 错误信息（如"审查不可用"）进模型上下文的 vs 进 UI 的，是否分开；
- locale 文件的组织方式（官方惯例是 `locale/{zh,en}.json` + 导出 `meta`）。

<a id="question-o8"></a>

### O8. 配置 UI 与配置文件的一致性

**需求**（用户明确提出）：配置 UI 要做完善（可能较复杂），同时也要能直接编辑配置文件，且**二者功能必须完全一致**。

**这个约束的实质**：UI 是配置文件的**投影**，不是另一份真相。实现上要保证：

1. **单一真相源**：配置文件（profile 的 Cordis patch）是当前配置唯一可编辑的持久化来源，UI 只读写它；SQLite 历史快照不构成第二套可编辑配置；
2. **schema 驱动**：用同一个 schema 同时生成表单与校验配置文件的合法性——不能出现"UI 允许但文件里非法"或反之；
3. **双向同步**：文件在外部被编辑后，UI 应感知并更新生效状态；若已有未保存草稿，保留草稿并提示冲突，不能直接覆盖（`config-editor` 有 HMR 支持，具体能力待核实）；
4. **冲突处理**：UI 保存时若文件已被外部修改（基于 revision 的乐观并发），应拒绝并提示，而不是覆盖。

**已统一的版本方向**：UI 使用“保存并应用”，外部文件变更走同一校验与应用路径；分别记录文件修订、不可变内容快照和配置生效事件，恢复旧内容复用快照但新增生效记录。无效外部内容不替换已有有效配置；具体约定见[配置保存、生效与版本历史](configuration-and-audit.md#config-history)。

**待评估的复杂度**：

| 配置分组 | UI 复杂度 |
|---|---|
| 规则表（增删改排序 + 校验） | 高（列表编辑、reorder、实时校验 regex/glob、错误定位） |
| Reviewer 类型与配置（单选 + 条件字段） | 中（单选切换后显示对应字段组） |
| 阈值（数值 + 联动约束） | 低 |
| 探针锚点（11 项文本编辑） | 中（表格） |
| 凭据（状态展示 + 写入） | 低但涉及安全 |
| 模式/DND 默认值 | 低 |

**待定**：

- 是否值得自建完整 UI，还是先提供"配置文件 + 只读状态页"作为 MVP？
- 规则表的编辑器是否可以用纯文本 YAML 编辑（带 schema 校验）代替结构化表单——工作量小十倍，且与"可直接编辑配置文件"的需求天然一致；
- 若两者都做，如何保证不漂移（建议：UI 生成的文件格式与手写格式完全一致，且 UI 保存后立刻重新解析校验）。

<a id="question-o9"></a>

### O9. Reviewer prompt 的前缀策略

**背景**：KV cache 复用依赖稳定前缀。当前 prompt 结构是：

```
system: 固定策略 + 锚点 + 探针定义 + 来源优先级与证据分级 + 先前裁决规则
user:   CUSTOM_RULES + PROJECT_RULES（分别标注来源的材料块）
        + ENVIRONMENT + CONTEXT + EVIDENCE + PRIOR_VERDICTS
        + PENDING_ACTION + DERIVED_FACTS
```

**稳定性分层**（决定缓存收益）：

| 层 | 内容 | 变化频率 |
|---|---|---|
| 稳定 | system 固定契约与策略说明 | 模板／策略配置改变时 |
| 半稳定 | CUSTOM_RULES、PROJECT_RULES 材料块 | 用户配置或项目文件内容改变时 |
| 动态 | `ENVIRONMENT` 之后全部 | 每次调用都变 |

**可缓存的部分**：system 固定说明及输入前部的稳定材料有助于前缀复用。旧稿将 CUSTOM_RULES 原文当成 system 指令的布局已被[来源契约](review-context.md#authorization-source-priority)替代；缓存布局不能改变用户消息优先于项目／全局指引的语义。

**问题**：

1. **探针锚点是否应该放进 system**？如果用户在配置页改了锚点文案，system 变化 → 整个 cache 失效。选项：(a) 锚点固定为内置常量，配置只改阈值不改文案；(b) 锚点进 system 并接受改配置时的 cache 失效；(c) 锚点做成 few-shot 示例放在 user 段。
2. **多会话共享前缀**：Clef 是单次无状态调用，没有会话概念，cache 由服务端决定（Workers AI 是否支持 prefix cache 待核实）。
3. **chat 后端**：走 `ctx.llm.stream()`，KV cache 由 provider 决定；稳定前缀仍有价值（DeepSeek 等内容缓存按前缀命中）。

**待定**：

- system 段是否拆成"固定策略"+"可配置锚点"两段，让前者可缓存；
- 历史段的顺序（最新在前 vs 最新在后）对缓存的影响——若历史是变量部分，应放在**最后**；
- 本设计只做无状态单次调用（[审查者形态：只做无状态单次调用](reviewer.md#design-5-2-1)），没有「审查者自己的 agent system prompt」这一层，缓存分析只需覆盖单次请求的前缀。

<a id="question-o10"></a>

### O10. （方案已定）Reviewer prompt 的结构与长度预算

**当前结构**（来源优先级按本轮确认同步；预算数值仍见对应专题）：

```
system:
  固定策略（REVIEW_POLICY）
  锚点定义（risk / authorized 各 11 级）
  探针定义（secrets / destructive / egress / bulk）
  授权来源优先级与证据分级规则
  先前裁决处理规则

user:
  CUSTOM_RULES         （用户配置指引，2000 字符上限，保留来源标签）
  PROJECT_RULES        （工作区根目录 .dsh/arbiter.md，2000 字符上限，可选）
  ENVIRONMENT          （cwd）
  CONTEXT              （tool call + checkpoint，共享 history.maxItems）
  EVIDENCE             （三类消息，role + evidence）
  PRIOR_VERDICTS       （deny/ask + layer，共享 history.maxItems）
  PENDING_ACTION       （当前动作；优先完整，超预算可明确标记截断）
  DERIVED_FACTS        （AST 事实，独立上限 100–250 tok）
```

**待细化的点**：

1. ~~各段的长度预算~~ —— **已定**：[输入预算](review-context.md#design-5-2-6)（固定段先占，动态段按 40/60 分）；
2. ~~"max N 但按 token 截断"的语义~~ —— **已定**：逐条累加、超限即停（[输入预算](review-context.md#design-5-2-6) 截断算法）；
3. ~~AST 段的独立上限~~ —— **已定**：[事实完整性闸门](review-context.md#design-5-2-2) 的 100–250 tok，超出降级 `completeness`；
4. ~~**历史段的信息取舍**~~ —— **已定**：`CONTEXT`（tool call + checkpoint）、`EVIDENCE`（三类消息，role + evidence）、`PRIOR_VERDICTS`（deny/ask + layer）三段互斥，详见 [上下文分段](review-context.md#design-5-2-3)；
5. ~~顺序对缓存的影响~~ —— **已定**：稳定段在前、动态段在后（[输入预算](review-context.md#design-5-2-6)、O9 稳定性分层）；
6. **指引的材料角色已确认**：固定来源契约放 system，CUSTOM_RULES／PROJECT_RULES 按独立来源标签提供；替代旧“CUSTOM_RULES 原文放 system”的方案，具体缓存布局不能改变来源优先级；

**预算模型**：见 [输入预算](review-context.md#design-5-2-6)（`maxInputTokens = 10000`、tokenx 估算、逐条累加截断）。本节不再重复，只保留待定项。

---

<a id="question-o11"></a>

### O11. （产品契约已定，接入待验证）审批提供者互斥与监听顺序

**当前确认**：arbiter 替代官方 Auto Review，两者互斥，其他宿主 guard 照常生效。不维护第三方互斥插件名单；官方实际运行时阻止新接管，其他插件按接口行为告警。运行中发现冲突保留当前门禁、模式及审查流程，不统一 force-ask；官方冲突一次弹窗、其他潜在冲突轻量通知，同次去重并保留未解决状态。配置、规则测试、历史和诊断继续可用；Auto 注册失败如实显示。冲突解除后核对 arbiter 与宿主实际状态。统一正文见[共存与冲突契约](architecture.md#approval-provider-coexistence)，下列候选只保留为此前背景。

**背景**：第一轮宿主实测（`g1-a`／`g1-g`／`g1-h`）显示，`ctx.on("tools/pre-execute", …, { prepend: true })` 只能把监听器插到**同一 prepend 组的最前**；headless 组合下已有一个非探针 `prepend` 监听（源码对应 `dsh-tool-jobs`），加入官方 auto-review bundle 后有两个，它们都更早注册，因此插件仍在它们之后。见[覆盖范围](architecture.md#execution-coverage)与[报告](../validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)第 8.1 节。

**为何重要**：“规则 allow 短路、零 token”是省 token 的前提；如果其他审查者先运行，短路就失去意义，甚至可能先被别处拒绝。

**此前候选方向（历史背景）**：

| 方向 | 代价 |
|---|---|
| 接受顺序不确定，产品表达限定为“不保证优先于其他审查者” | 最省事，但削弱核心卖点 |
| 与官方 auto-review 互斥（安装本插件时移除该 bundle，沿用 P0 的迁移要求） | 只解决官方竞品，第三方同类插件仍在 |
| 插件在 `admit` 阶段检测同类监听器并拒绝启用／告警 | 需要宿主提供可枚举监听器的接口，本轮未验证 |
| 改用宿主提供的更高优先级 seam（若存在） | 源码中未发现等价入口，待确认 |

**后续为工程设计与验证**：插件作用域映射、生命周期状态检测、Auto 注册失败及清理时序、告警去重、前端通知／重连，以及解除冲突后的恢复核对。源码可读取插件运行清单、检测 Auto 槽占用，前端具备覆盖层与 Modal／Toast 组件；通用功能识别尚无已确认的能力声明接口，见[冲突检测证据](../evidence.md#conflict-detection-source)。同一事件监听器可能属于任务调度或 guard，不能一律判冲突；这些验证不重新变成第三方名单或全调用强制人工方案。

<a id="confirmed-rule-contract"></a>

## 本轮已确认的规则契约

以下结论已由用户确认，并同步到专题正文。历史记录中的旧名称与旧流程只供追溯。

| 项目 | 当前约定 | 正文 |
|---|---|---|
| 显式审查规则 | `review-hint` 更名为 `force-review`；无 hint 也必须审查，hint 只提供关注点 | [规则优先级](rules.md#design-4-4) |
| 完整顺序 | `deny > force-ask > force-review > allow > review(default)`；默认审查是兜底路径，不是第五种配置 verdict；复合命令的 allow 覆盖不足也进入默认审查 | [规则优先级](rules.md#design-4-4) |
| 规则建议 | 2026-10-23 已确认移出首版，先积累真实日志再设计生成与验证机制；保留“离线候选须人工审核后成为普通规则”的原则，实时审批只处理当前操作 | [首版范围](requirements.md#first-release-scope)、[后续规则建议](rules.md#design-5-10) |
| 正式规则语义 | 人工确认的候选与手工创建的规则同义；取消 `source: learned` 运行时分支及额外复检，可选来源提示仅作说明 | [独立审核界面](configuration-and-audit.md#offline-rule-review) |
| 列表与编辑 | 列表行固定显示开关、摘要、行为下拉和操作，行内展开适用范围、条件、备注及折叠测试；展开区不重复行为控件，统一保存应用 | [规则管理](configuration-and-audit.md#rule-management) |
| 新建与复制默认值 | 新建默认必须审查、开关打开，命令默认 RE2、工具参数默认精确；复制保留范围／条件／行为／备注并生成新 ID，副本默认关闭。无条件规则可留草稿，不能保存应用 | [规则管理](configuration-and-audit.md#rule-management) |
| 名称、摘要与标识 | 自动摘要作为默认名称，可自定义覆盖并恢复；只保存可选自定义名称，允许重名。ID 自动生成并持久化，编辑／改名不变，复制用新 ID；历史显示当时名称与快照 | [命名契约](configuration-and-audit.md#rule-naming) |
| 保存校验与告警 | 语法、必填项、类型及重复 ID 错误阻止保存；重复内容、可识别遮蔽、宽范围 allow 告警不阻断；工具／参数定义暂不可用只提示，不强制二次确认或测试，禁用规则也须语法有效 | [保存校验](configuration-and-audit.md#rule-validation) |
| 参数与条件 | 参数选择器读取本次结构化参数；多个条件由规则级 `combine`（`all`／`any`）连接，见[规则连接词](#rule-combine-v3)；字段缺失或类型不支持时该条件不匹配；路径作为普通参数，不做 cp／mv／rm 路径适配 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 参数选择与多值 | 使用 JSONPath（RFC 9535），`$` 为工具参数对象；多值支持任一／全部、默认任一，空结果均不匹配；保留 JSON 类型，不将对象／数组自动转成文本，“全部”只约束选中值 | [匹配对象与参数条件](rules.md#parameter-matching) |
| 命令匹配文本 | AST 拆出独立命令，规范化可静态确定的字面量并保留参数边界；动态或无法可靠转换的词保留原文；精确样例采用相同转换，RE2／glob 表达式不改写，原文可通过参数条件匹配 | [命令匹配文本与规范化](rules.md#command-matching) |
| 静态词解码选型 | 优先复用现成能力，`unbash` 为优先候选；解码值不等于静态性证明，接入、正式版本及兼容性由实现侧验证，不因候选探针通过宣称产品已满足 | [解析与候选边界](rules.md#design-4-1) |
| 匹配方式与大小写 | 精确、RE2、glob 均完整匹配，默认大小写敏感、逐条件可忽略；取消强制 `^`。glob 固定 `/` 分段、包含点号内容，不启用前导 `!` 取反或隐式路径转换 | [匹配方式契约](rules.md#matcher-semantics) |
| 解析与求值 | 结构解析、每词取值、事实提取独立记录；匹配／不匹配／无法判断按规则级 `combine` 传播（`all` 下同一目标须由同一节点同时满足）。相关高优先级规则未知或覆盖不足时 allow 不短路，词值或事实未知不构成全局否决，进入审查不等于强制人工或故障 | [状态与三态求值](rules.md#matching-uncertainty) |
| 规则审查提示 | hint 保留为可选高级项，常规表单不自动展开；备注不自动送给 reviewer，force-review 无 hint 仍须审查 | [规则管理](configuration-and-audit.md#rule-management) |
| 测试区 | 默认折叠，上方填写命令或参数 JSON，也可从调用记录带入；基于整份当前草稿，分别显示本规则匹配与最终规则路径，展开具体取值和遮蔽解释；旧结果在编辑后标为需重测 | [测试区契约](configuration-and-audit.md#rule-test-ui) |

<a id="rule-combine-v3"></a>

### 规则条件连接词（2026-10-27 已确认）

用户提出：条件固定为“或”是否合适？直觉上“与”更合适，因为“或”可以用多条规则代替；是否改成只允许单层“与”，并加一个高级模式直接写 JSON。

讨论与实现后确认：

| 项目 | 决定 | 理由 |
|---|---|---|
| 连接词 | 规则级 `combine: "all" \| "any"`，四条行为语义一致 | 按行为区分会让同一个“添加条件”控件含义随行为变化，正是用户最初指出的理解成本 |
| 默认值 | 新建规则 `all`；由旧格式读入的多条件规则为 `any` | 前者符合“加条件就是加限制”；后者不能让既有规则被静默收窄 |
| 嵌套 | 不做 | 不含取反的布尔式都能化为 DNF，每个子句就是一条扁平规则；嵌套唯一多买到“一个规则 ID”。否定能力明确排除，且 `deny` + 规则顺序**不等价于**一般布尔否定 |
| 高级 JSON 编辑模式 | 不做 | 它的前提是“表单渲染不了某些形状”，扁平方案下该前提消失；引入后校验、错误定位、测试解释、摘要、i18n 都要处理通用树 |
| 同一目标的合取 | 必须由同一个节点同时满足 | 否则 `[命令 glob "git *", 命令 regex ".*--force"]` 会命中 `git status && rm --force`，覆盖再把两个节点都算作已覆盖，整条命令被误放 |
| 工具条件的整调用覆盖 | `all` 规则含结构条件时，工具条件只作匹配前提 | 否则 `all(tool=bash, command="echo hi")` 会放行 `echo hi; rm -rf /tmp/victim`，结构条件形同虚设 |
| 调用级与语句级 | 采用调用级合取，限制写入契约与界面提示 | 语句关联需要 `Subject` 的父子关系，属于另一项能力，另行立项 |
| 格式 | 只保留 `arbiter-config-v3` | 旧解析器会静默忽略不认识的字段，在 v2 里加字段会让“用户以为收窄、实际未变”变成无声事故；v1／v2 与 `match` 写法已由 RQ-05（#69）删除，不做迁移 |
| 未知键 | 一律报错 | 本版不再接受“写入时曾经合法”的旧文档，故没有需要靠告警保持可加载的对象 |

**实现证据**：`tests/rules.test.ts` 的“condition combining”组覆盖同节点合取、缺节点、三态与工具覆盖；`tests/integration/rule-agreement.test.ts` 覆盖真实 gate、测试区一致性与历史合取证据；`tests/client/rules-editor.test.tsx` 覆盖连接词控件、保留与跨目标提示。

审查、人工与兜底阶段的命名见[术语与 DND 讨论进展](#review-policy-terms)；具体判定条件、人工可覆盖的范围及 DND 的完整处理流程尚未全部定稿。

---

<a id="review-policy-terms"></a>

## 术语与 DND 讨论进展

用户已确认 **审查策略 = 审查判定规则 + 判定阈值**，并要求记录术语以避免概念漂移。统一定义维护在[产品术语](terminology.md)，各专题引用该文档，不在各章节另写口径不同的定义。

- 命令规则与审查判定规则分开；推导表属于判定规则，概率门槛属于判定阈值。
- 审查结论由代码应用审查策略产生；记录 `review-*`、`human-*` 和 `fallback-deny` 的阶段差异，保留用户提出的 `review-escalate → fallback-deny` 路径。
- progress 对规则和阈值的影响在审查结论形成之前表达；normal / strict 共用常规审查策略，progress 的具体调整留待评测。
- 用户同意先解释产品语义，宿主限制和实现细节后置；现已建立[审批模式与审查策略](approval-modes.md)专题。旧稿相互冲突的规则集中保留为评测候选，不再要求当前逐条确认具体效果或阈值。

“不变式”旧称混合了硬拒与要求人工的效果，需逐条按当前术语重述。术语定名不代表 `destructive ∧ bulk` 的行为或用户自定义判定规则的能力已经确定。

**本轮新增约定与建议**：

- 用户指定在插件设置页控制主会话和全部子任务的模式；子任务只有 strict / progress，暂无每个子任务覆盖。旧“继承父模式”决定被替代。
- 配置成功应用后生效，已经弹出的审批维持人工处理，尚未作出的后续判定使用新配置，不追溯；不采用每次执行前额外检查模式的建议。用户补充：后端或输入协议改变后，已有结果仍推进到最终处理，无论是 escalate 还是 allow / deny；旧响应按原协议解释，保留各阶段实际配置。
- fallback-deny 只结束当前 tool call；审计及历史保留完整链，至少明确末态与来源，不能把所有结果压成 deny。
- 采用用户提出的 error-escalate，与 review-escalate 共用人工及兜底流程，但保留故障来源。取消和执行失败的分类与具体故障边界见专题。
- 采用用户提出的 human-abort，与 human-allow / human-deny 并列；人工审批已结束但未取得决定时不放行，审计不记作用户明确反对。仍在等待回答的审批保持 pending。
- 子任务先找允许的替代方案，受阻再报告父 agent；父可询问用户并转述，仍不足则引导用户进入子会话直接授权。这主要作为执行 agent 行为指引；插件负责原因、证据来源及指引接入。
- 用户指出现有输入已包含父会话人类原话和父 agent 转述；据此修正原稿：父会话原话与本会话原话按同一标准评估，明确覆盖当前操作、目标与范围时可支持 explicit，取消父会话来源的 implied 上限。仅有转述仍不能制造明确人类授权；原文与转述同时出现时不重复计算批准。
- 用户已同意执行指引采用简短 system 上下文配合当次拒绝结果提示，父／子 agent 各有对应说明；具体替代方案和求助时机由模型判断。reviewer 的证据判定规则已同步修正，宿主注入能力另行验证。
- 总称沿用当前讨论中的“审批模式”；用户要求每档都有 tooltip。当前名称草案为“交互审批／自动审批／自动审批·推进”，不再将 strict 描述为使用更保守的审查阈值。
- 用户要求明确 normal 也启用 Auto Review；tooltip 已写明需要审查的调用会自动审查并按策略批准或拒绝，需要人工时才发起审批。“交互审批”不表示所有调用都需要人确认。
- 用户指定 normal / strict 基本共用常规判定规则和阈值；strict 的 force-ask、review-escalate 以及 error-escalate 进入 fallback-deny。progress 通过调整部分规则和阈值扩大代批，具体条件留待评测；不是兜底覆盖已形成的 escalate。
- chat / decision 统一授权标准；信号形式仍分别为点值与分布，不再按后端区分某类操作需要 implied 还是 explicit。
- 默认提供三档，优先让用户通过命令规则放行或拒绝特定命令。独立高级设置、标记自定义与恢复默认为本轮建议，具体可编辑字段待设计与评测。
- 用户明确不限制 ask 工具；撤回此前按提问目的禁止自动档补授权的建议。审批模式只控制插件是否新发起人工审批，agent 在所有档位仍可使用宿主可用的 ask 或聊天。ask 超时不产生批准，不复活已结束调用。
- 判定阈值及等待、重试、熔断和恢复参数留到后续评测精调；本机 DSH 已核对 legacy / timed 两种 ask 机制，结果见[源码证据](../evidence.md#ask-timing)，不据此假定用户当前启用 timed。

---

<a id="product-discussion"></a>

## 本轮产品讨论登记

以下条目来自本次对产品整体的讨论。独立产品定位、[已确认的规则契约](#confirmed-rule-contract)和[术语定义](#review-policy-terms)已写入正文；本节其余条目仍为待讨论建议或待收敛冲突。

### 原稿中需要收敛的语义

| 编号 | 状态 | 需要统一的内容 | 相关正文 |
|---|---|---|---|
| C1 | 待收敛 | 正式规则的 allow 跳过审查不变式，与“不变式不可覆盖”的适用范围；策略硬拒、reviewer 拒绝、人工覆盖各自的权限 | [五层裁决与优先级](rules.md#design-4-4)、[判定引擎](reviewer.md#design-5-6)、[规则沉淀](rules.md#design-5-10) |
| C2 | 待收敛 | secrets 定义已排除正常认证，后文仍以避免误伤正常认证为由放宽凭证外发条件 | [Decision model 后端（Clef / Jev）](reviewer.md#design-5-3)、[bulk 探针](reviewer.md#design-5-6-2)、[安全边界（必须明确）](requirements.md#design-11-1) |
| C3 | 本轮产品契约已确认，接入待验证 | 三个独立维度替代全局 partial：词值或事实未知不直接禁止文本规则 allow；结构缺失使相关条件无法判断，未知高优先级规则或覆盖不足阻止 allow 短路；完整原文进入正常审查，不由缺口直接 deny／强制人工／error-escalate | [独立状态与三态求值](rules.md#matching-uncertainty)、[事实完整性闸门](review-context.md#design-5-2-2) |
| C4 | 待收敛 | bulk、不可逆删除、DND progress 提升与“永不提升”清单的交互 | [bulk 探针](reviewer.md#design-5-6-2)、[规则沉淀](rules.md#design-5-10)、[勿扰态度（attitude）](architecture.md#design-6-3) |
| C5 | 本轮产品契约已确认 | 外层 run_code 先对完整原始请求匹配规则，需审查时按程序文本送审；内层实际调用独立处理。允许明确标记的预算截断，不由截断直接产生错误／拒绝，不新增模型 truncated 字段；最终反馈由插件组合实际原因与运行时提示 | [PTC（run_code）与内层调用](rules.md#design-4-7)、[覆盖矩阵](architecture.md#execution-coverage) |

这些条目记录尚未解决的分歧；已确认部分以[当前规则契约](#confirmed-rule-contract)及其链接的正文为准。

### 产品建议

| 编号 | 状态 | 讨论方向 |
|---|---|---|
| D1 | 待讨论 | 产品对外承诺、首批目标用户及可观察的收益：任务推进、打断次数、成本和可追溯性 |
| D2 | 覆盖及授权来源契约已定，展示与接入待验证 | [覆盖矩阵](architecture.md#execution-coverage)区分宿主能力与验证状态；自由文本授权、内容责任和来源优先级见[来源契约](#authorization-trust-boundary)。项目读取默认开启，每次新快照取得当前内容；覆盖状态与证据展示待界面细化 |
| D3 | 入口、日志详情、规则管理与测试区契约已定，接入待验证 | [审批拒绝提示](architecture.md#approval-rejection-feedback)及[日志分页](configuration-and-audit.md#log-list)保持已定契约；会话与日志共用[调用详情](configuration-and-audit.md#call-detail)。[规则管理](configuration-and-audit.md#rule-management)的列表、展开、新建／复制默认值、[名称与 ID](configuration-and-audit.md#rule-naming)、[保存校验及告警](configuration-and-audit.md#rule-validation)均已确认；参数选择使用 JSONPath，支持任一／全部、默认任一。[命令规范化](rules.md#command-matching)、[完整匹配与大小写](rules.md#matcher-semantics)、[三态求值](rules.md#matching-uncertainty)及优先验证 unbash 的方向已确认。[测试区](configuration-and-audit.md#rule-test-ui)输入、两类结果与展开解释已确认。离线候选生成、验证与专用流程移到后续版本，见 D9；初始默认值见 D11，高级选项可后续设计，需求确认不等于初版实现已经满足 |
| D4 | 待讨论 | 早期建立人工标注案例集，同时评估误放、误拦、人工打断、延迟与成本；用目标场景验证概率输出的实际价值 |
| D5 | 启停与卸载目标已整理，接入待验证 | 会话启停由权限选择器控制；插件停用／卸载回退仍接管的会话至工作区写入，不主动取消在途审批，保留宿主取消语义。命令同步、重连、卸载清理及冷恢复待验证，安装升级与 reviewer 故障恢复仍需细化 |
| D6 | 待讨论 | 产品自身的安装、配置、排错和升级如何独立于个人 agent-home、deploy.ts 与个人白名单 |
| D7 | 沟通流程、授权原则与指引放置已定，接入待验证 | 父会话原始人类授权可以支持 explicit；简短 system 指引配合具体工具结果提示；证据完整性与宿主接入待验证 |
| D8 | 日志产品契约已收敛，进入实现与宿主验证 | 内存／会话记录／SQLite 分层恢复，写入失败不影响权限结果；本地完整保存约定的审查材料，Reviewer 连接凭据除外。按 DSH 数据实例归属，默认 30 天 / 1 GiB，可在高级设置调整；首版不做专门导出。旧数据采用版本化迁移、保留原文、按能力读取；脱敏留到需要外发时再细化。见[日志存储讨论状态](configuration-and-audit.md#audit-open-questions) |
| D9 | 后续版本，暂缓设计（2026-10-23 已确认） | 离线规则建议的入口、候选生成、批量验证与审核 journey 不纳入首版开发或验收；先完成核心功能并按现有日志契约积累真实样本，再设计机制与流程。原型及早期方案仅供参考，不据此扩大首版范围；见[首版范围](requirements.md#first-release-scope) |
| D10 | Reviewer 配置与一次性测试已确认，接入待验证（2026-10-24） | decision 手填，chat 在一个 select 中选择 DSH 具体模型或跟随会话；跟随会话禁用测试。测试用草稿与固定合成样例，只请求 Reviewer 并校验输出，采用一次性弹窗，不持久化测试状态／历史或写入正式审批记录，不影响真实审批统计与熔断。测试与保存独立；默认值按 D11，见[配置](configuration-and-audit.md#reviewer-configuration)及[测试契约](configuration-and-audit.md#reviewer-test-ui) |
| D11 | 首版初始默认值已确认（2026-10-24） | chat + 跟随会话模型、guarded、主 normal／子 strict、空命令规则表；安装不自动接管会话。首版不附带预设规则，实际使用一段时间后再评估是否增加预设，不自动扩大首版范围；见[默认配置](configuration-and-audit.md#initial-defaults) |

<a id="permission-ui-decision"></a>

### 权限选择器与生命周期（2026-10-21）

用户已选择第二种方案：**不依赖上游修改，在原权限控件位置提供 arbiter 自有选择器**，保留宿主其他权限选项，并以单一自动审查入口控制当前会话启停。trusted / guarded 在插件配置页选择，不在权限菜单拆成两个入口。完整契约唯一正文见[权限选择器](architecture.md#permission-selector-contract)及[生命周期](architecture.md#permission-lifecycle)。

此前“切出原生 auto 就停用，因此取消 guarded”的判断已撤回。guarded 与 trusted 都保留；会话启用、执行边界和审批模式是三个概念。原生 auto 的固定捆绑属于宿主预设服务限制，自有控件不声称改变该原生定义。

不能只看 `current === auto` 或 `{auto, workspace-write}`；后端须能区分普通工作区模式与 arbiter 已启用的 guarded。启用状态必须可独立于审计 SQLite 恢复，前端重连只读取后端真相。原生 `/permission` 同值切换的意图可观测性是本轮关键验证点。

用户提出的卸载回退目标为工作区写入，已切到其他权限模式的会话不覆盖；在途审查与人工请求不因插件操作主动取消，但宿主沙箱切换可能取消 PTC／run_code，须按真实原因记录。优雅收尾、卸载等待与已关闭会话恢复能力尚未实测，不能记作已完成。

本轮只验证菜单覆盖、原生命令同步、重连、停用／卸载恢复四组，不据此重开全部 1–47 清单或自动启动完整实现。任务与回填要求见[验证任务](permission-ui-validation.md)，源码补核见[证据](../evidence.md#permission-ui-source)。

#### 四组验证后的缺口与最小替代（2026-10-21，运行 id `2026-10-21-permission-ui-01`）

四组均已运行（报告 [REPORT.md](../validation/permission-ui/2026-10-21-permission-ui-01/REPORT.md)，断言 63/63）。以下只登记**契约尚未被公开接口满足**的部分，不擅自改成另一套交互。

| 编号 | 缺口 | 性质 | 后续处理（以最新确认契约为准） |
|---|---|---|---|
| PU-1 | **原生 auto 一旦被准入就固定展开 full-access，不能保持 guarded**；首轮未验证拒绝准入路径 | 拒绝契约已确认，实施与补测待完成 | 用户于 2026-10-22 确认拒绝原生 `/permission auto`；拒绝在权限变更前发生，保持原有启用／沙箱／审批状态，自有菜单仍支持 trusted／guarded。准入回调拒绝或不注册的方案由实施选择并验证，不接受只隐藏菜单或事后纠偏。见[契约](architecture.md#native-auto-rejection)及[本轮任务 F2](permission-recovery-followup.md) |
| PU-2 | **同值 `/permission` 的退出记录不能在观察回调内持久化**：`session/event` 观察者处于宿主 commit 内，`append` 会重入报错 | 记录写入顺序限制 | 用 microtask／显式队列延后持久化；内存门禁状态、命令成功／失败、并发新调用与写入顺序需一起验证，不能将观察到意图等同于已完成退出 |
| PU-3 | **`session.append('plugin:…')` 不写 `ignorable`**，冷读会拒绝整份日志；现有 `plugin:arbiter/decision` 正属此类 | 现有实现缺陷（本轮实测确认） | 改用 `appendPluginRecord(session, type, data)`。这是纯实现修正，不改契约；需要确认历史会话里的既有事件如何兼容（宿主目前会拒绝加载，不是静默跳过） |
| PU-4 | **审批挂起时 composer 被宿主禁用**，用户无法用斜杠命令切出 | 宿主 UI 行为 | 自有菜单与原生控件走 `session.command()`；不依赖 composer。无需上游改动 |
| PU-5 | **`run_code`／PTC 在沙箱切换下的宿主取消未验证**（本机 `sandbox-exec` 不可用） | 环境限制 | 在可用的沙箱主机上重跑该用例；源码依据保留，不据此判定通过或失败 |
| PU-6 | **真实人类审批路径未验证**（应答者为探针的挂起实现） | 验证限制 | 需一次真实人工点击；当前只证明切换不会代批／代拒 |

**结论**：公开 API 已支持菜单覆盖、双执行边界、同值命令退出、重连、冷恢复与探针卸载收尾。PU-1 已确认拒绝原生入口，PU-3 已授权修复；真实插件管理器停用／卸载、新调用、真实人工答复与 PTC 取消按[本轮交接](permission-recovery-followup.md)补测，尚不标为完成。

**2026-10-22 补测后的更新**（运行 id `2026-10-22-permission-recovery-01`）：

| 编号 | 现状 |
|---|---|
| PU-1 | **已关闭**。按用户决定改为**直接拒绝**原生 `/permission auto`，不再是"先退出再展开"。`registerAuto` 的 admit 在权限写入前抛错，guarded／trusted／未启用三档均运行确认零副作用。见[架构](architecture.md#native-auto-rejection) |
| PU-2 | **观察者重入已规避，并发收尾仍待补测**。延后持久化可避免重入；F4 现有产物没有证明新调用与真实 drain 窗口重叠，不能据此关闭时序问题。见[复核](../evidence.md#permission-recovery-review) |
| PU-3 | **已修复**。`src/records.ts` 只走 `appendPluginRecord`，失败不回退；真实冷恢复与旧日志修复均已验证 |
| PU-4 | **已补测，不是宿主边界**。改为不同预设（workspace-write → read-only），并经 `sessions.binding(id).session.command(...)` 真实调用：`/permission read-only` 与 `/permission workspace-write` 在审批挂起时**均成功**（`{ok:true,value:{matched:true}}`，有 `command/run`/`command/done`），审批**保持挂起**。composer 仍被禁用，但选择器通道可用；上一轮"无公开入口"的结论来自点击已选中的值 |
| PU-5 | **不再受限**。本机 `sandbox-exec` 已可用；F6 真实运行，宿主以 `abort: sandbox mode changed` 取消 PTC |
| PU-6 | **已关闭**。操作者用真人点击完成两条路径：允许一次 → `human-allow` 并执行落盘；拒绝 → `human-deny` 且工具未执行 |

新增缺口：

| 编号 | 缺口 | 最小替代 |
|---|---|---|
| PU-7 | `registerAuto` 的 admit **没有参数**，无法区分"用户切换"与"恢复已存 auto 身份的旧会话"；完全拒绝会让这类旧会话无法加载 | 用公开的 `command/run`/`command/done` 生命周期区分：有进行中的 `/permission` 命令即拒绝，否则按恢复放行并计数。属推断，不是接口保证 |
| PU-8 | **已关闭**。停用与卸载分别验证：卸载走 `removeBundle`，删除依赖并取消 bundle 选择，重启后不复活 | — |
| PU-9 | 正式客户端选择器尚未接入会话启用状态（后端 auto 拒绝与卸载回退已就绪） | 后续接入 `conversation.input.permission` 时按[接入约束](architecture.md#design-7)实现 |
| PU-10 | 审计目录被移走时插件在加载阶段重建，因此该对照实际验证的是**记录恢复不依赖审计**，不是审计不可用 | 若要验证审计失败，应让路径不可写而非移走目录 |

#### 结果复核（2026-10-22；同日后续确认见下）

- **原生 auto 的建议已获确认**：拒绝该原生入口，由自有菜单提供自动审查。官方 Auto Review 与 arbiter 互斥，退出 arbiter 后只留下原生 auto 身份，不能保证还有 reviewer 接管。准入回调抛错或不注册的路径仍需补测，旧 auto 会话的恢复／迁移也需核对。
- **时序不可外推**：保留的 U2 事件是 seq 57 写 auto、seq 58 改 full-access、seq 59 写 disabled；前两条观察中的 enabled 仍为 true。因此 `command/run` 已被观察到，不等于退出已经完成。PU-2 的实现要区分意图、内存状态与延后持久化，补测命令失败保持原状态及并发新调用；尤其拒绝 auto 时不能因为收到 command/run 就先停用 arbiter。
- **冷恢复修复**：`src/index.ts` 仍直接 append `plugin:arbiter/decision`。修复须覆盖所有插件会话记录，并验证真实写入→关闭→重启→重开；已写入的不兼容记录需要保留原文的兼容／修复路径，不以删除整个会话解决。本文旧 I6 的写入选择已被运行证据否定。
- **卸载证据边界**：已验证探针调用 fiber.dispose 的收尾，未触发真实 plugin_manager 运行时重组合。还需验证收尾等待时新调用、转人工后的依赖可用性和真实管理器停用／卸载，不将 63 项产物断言当作这些场景已运行。

#### 用户确认与修复授权（2026-10-22）

用户明确确认拒绝原生 `/permission auto`，并要求交给 DSH agent 修复冷恢复写入问题，补测拒绝入口、真实插件停用／卸载、收尾期间新调用、人工审批和 PTC 取消。本轮从机制验证进入**正式修复 + 针对性补测**；具体范围、旧记录处理和验收标准以[交接任务 F1–F6](permission-recovery-followup.md)为准。这里记录授权与产品结论，不表示修复或补测已经执行。

<a id="dnd-refinements"></a>

### 审批模式细化状态（旧称 DND）

三档关系与评测候选已整理为[专题对照表](approval-modes.md)。下表区分已定契约、后续评测与宿主验证；原“执行前额外检查策略版本”和“自动档限制 ask 补授权”建议均已撤回。

| 编号 | 状态 | 当前约定或剩余问题 |
|---|---|---|
| N1 | 三档关系已定，具体规则与阈值留待评测 | normal / strict 共用常规策略；strict 不新发人工审批；progress 调整部分条件扩大代批。[R1–R8](approval-modes.md#rule-matrix)为评测素材，不是当前逐条确认前提 |
| N2 | 设置方式与初始值已定 | 插件设置页分别选择主会话三档、全部子任务两档；用户控制，无单子任务覆盖，不继承父模式。2026-10-24 已确认主 normal／子 strict 为初始值 |
| N3 | 生效原则与已有结果处理已定 | 成功应用后用于尚未作出的后续判定；已有结果继续推进，不因后端／输入协议变更丢弃或重审；旧响应按原协议解释；已弹出审批保留，不加执行前二次检查 |
| N4 | 总称沿用审批模式，显示名与宿主覆盖待定 | 三档显示名称仍为建议；只承诺权限审批语义，不承诺关闭全部通知；原生升权入口的控制能力需实测 |
| N5 | 已定 | fallback-deny 仅结束当前调用；审计与历史保留完整链；既不当成人工拒绝，也不当成危险证据，不影响其他独立调用 |
| N6 | 阶段与流程已定，运行参数留待评测 | error-escalate 与 review-escalate 共用人工／兜底流程；故障不自动放行，等待、重试、熔断及恢复参数通过运行评测精调 |
| N7 | 判定链已定，字段与指标待细化 | 记录规则入口、各阶段及原因；具体 Schema 未定。promoted 的 normal 比较基线与评估建议见专题 |
| N8 | 原始授权分级已修正，读取效果待验证 | 父会话人类原话与本会话原话同标准，可支持 explicit；纯转述不制造明确授权。核对具体操作及范围，验证原话与答复上下文的采集、压缩和截断，承接 D7 |
| N9 | 终态语义已定，宿主事件待验证 | human-abort 表示已进入人工审批但未取得决定就结束，执行上不放行；pending 不提前记 abort，审计不混作 human-deny；具体超时、关闭、断连映射待验证 |
| N10 | 方案已确认，接入待验证 | reviewer system 保持授权语义；执行 agent 使用简短常驻说明和当次结果提示，父／子 agent 各有对应内容，避免把恢复流程固定成必须依次执行的脚本 |
| N11 | 已定：ask 不受审批模式限制 | 包括补充授权的提问，父为 strict / progress 也可使用宿主可用的 ask；子 agent 仍受宿主限制。timed pending 与 human-abort 分开，不把未回答当作许可 |
| N12 | 已定：后端统一授权标准 | chat / decision 对同类操作使用相同授权条件；点值与分布分别校准，差异不能变成隐含的产品权限差异 |
| N13 | 日常配置已定，高级入口为建议 | 默认三档，优先命令规则；高级设置可细调阈值和内置规则参数，具体字段范围、自定义标记与恢复默认见配置专题建议 |

N1 承接 C1、C2、C3、C4 的相关边界；具体条件移入评测阶段不表示已经解决，最终实现需选定明确且可回放的策略版本。

审批模式的产品框架本轮已收敛；后续评测具体策略与运行参数，界面设计细化高级设置及 tooltip，宿主验证单独跟踪，见[当前状态与后续工作](approval-modes.md#open-choices)。

<a id="execution-admission-contract"></a>

## 执行覆盖与准入契约（2026-10-21）

本节记录本轮需求讨论的确认项，具体规范维护在对应专题。实现及宿主验证继续在独立会话推进，需求确认不表示这些新要求已经实现或实测。

| 项目 | 已确认契约 | 正文 |
|---|---|---|
| 外层与内层 | 外层先规则、需审查时看程序文本；内层每次实际调用独立准入。直接 Node API 只能从外层程序准入控制，用户可以用规则提前裁定 | [PTC](rules.md#design-4-7) |
| 长程序 | 允许按预算截断送审材料；运行时标记截断，告知 reviewer，并在最终反馈附加提示。截断不直接触发 error-escalate、强制人工或拒绝，不新增 truncated／输入充分性 noul | [输入预算与截断](review-context.md#pending-action-truncation) |
| 判定链与反馈 | chain 保留阶段序列，不附加截断标签。最终 reason 由插件结合实际规则／审查／人工／兜底结果和运行时信息组装；区分裁决原因与补充提示，不从截断事实推断拒绝因果 | [最终反馈](reviewer.md#final-feedback-composition) |
| MCP | 审查工具请求入口及参数；服务端内部效果不逐项接管 | [覆盖矩阵](architecture.md#execution-coverage) |
| 子任务 | 委派与消息入口由发起方审查；内部调用由子任务所在环境审查，父端不重复逐项审查。消息入口独立运行验证待补，外部后端不宣称自动接入 | [覆盖矩阵](architecture.md#execution-coverage) |
| 官方互斥与宿主约束 | 共存契约已定：官方实际运行时阻止新接管；其他插件按接口行为告警，不维护名单；运行中保留门禁和原模式，通知去重并持续显示未解决状态，不统一 force-ask。其他宿主 guard 照常生效，注册失败与恢复状态如实显示 | [共存契约](architecture.md#approval-provider-coexistence) |
| 无 agent 工具调用 | 首版暂不接管没有 exec.agent 的程序化工具调用，明确列为覆盖边界；交还宿主流程，不记作插件审查批准。API 能力已有源码支持，现成业务实例及运行实验仍未确认 | [覆盖边界](architecture.md#execution-coverage)、[源码澄清](../evidence.md#agentless-tool-api) |

无 agent 调用不纳入首版接管范围，共存及冲突处理的产品契约已确认。覆盖状态在设置页与单次调用详情中的具体表达待界面细化；检测与生命周期、消息入口及其他运行环境待验证。截断算法和输入预算数值留给实现／评测，不重新变成默认强制拒绝语义。接下来讨论[授权来源与信任边界](#authorization-trust-boundary)。

<a id="authorization-trust-boundary"></a>

## 授权来源与信任边界（契约已确认）

用户已确认以下方案。统一定义和完整优先级维护在[来源契约](review-context.md#authorization-source-priority)；本节记录决定，不另建文件认可、任务语义推断或持久 grant 系统。产品确认不表示当前实现和模型效果已经验证。

| 项目 | 已确认约定 |
|---|---|
| Free text 的效力 | CUSTOM_RULES／启用的 PROJECT_RULES 可以表达事实、限制、偏好和持续授权，语义交给 reviewer；通过模型信号影响判定，不直接改写命令规则优先级、代码判定规则或阈值 |
| 项目内容责任 | projectRules.enabled 默认开启，用户控制读取并负责内容；不区分手写、克隆／拉取或 agent 修改，不增加逐次人工认可流程 |
| 更新生效 | 每次构造新审查快照时取得当前项目指引；不要求重启，已发出的请求保持原快照，缓存实现不改变此行为 |
| 来源顺序 | 本会话人类原话 > 直接父会话人类原话 > PROJECT_RULES > CUSTOM_RULES > agent 转述；真实 ask 答复归入对应人类来源层 |
| 覆盖与时间 | 优先级只解决适用内容冲突，不删除其他上下文；同层较新适用指令在相关冲突上优先，不冲突的旧限制继续有效 |
| 优先级与授权强度 | 两者分开；父会话原话仍可支持 explicit。纯转述不能单独制造明确人类授权，原话与转述不是两次独立批准 |
| 模型与产品职责 | 任务的合理步骤、授权是否覆盖本次操作及其范围由模型理解；插件负责来源、优先级、输入和协议，不穷举任务授权语义 |
| Prompt 组织 | 固定来源契约写入 system，指引与证据保留独立标签；不依靠拼接顺序覆盖，不将 CUSTOM_RULES 原文作为高于用户消息的 system 命令 |
| 既有边界 | 人工审批结果、ask 授权证据和消息指引继续区分；历史结果不自动创建新请求许可，日志保留时间不决定授权有效期 |

默认开启和每次新快照取得当前内容已由用户确认，本专题的产品契约暂告收敛。缓存／变更检测方式属于实现设计，不增加重启或逐次确认要求。

其他工作是 prompt 与数据接入验证：本会话／父会话原话冲突、较新消息是否真正撤回旧限制、项目／全局指引持续授权、纯转述、真实 ask 答复、截断与摘要来源等。这里验证已定契约的效果，不重新增加独立的信任确认流程。

<a id="implementation-choices-2026-10-21"></a>

## 首轮实现选择（2026-10-21）

首轮完整实现已落地。以下行为是执行者依据宿主证据作出的**初版实现选择**，不是新的用户确认，也不改变已确认契约；完整理由、影响与验证见[首轮实施报告](implementation-report.md#4-初版实现选择可调整)。

| 编号 | 实现选择 | 保留边界 |
|---|---|---|
| I1 | 自带保守 shell 读取器替代 tree-sitter-bash WASM | 初版用 `completeness`／`unresolved` 限制 allow、复杂语法标 partial；此为历史实现选择。2026-10-22 已确认优先验证 unbash，并按[独立状态与三态求值](rules.md#matching-uncertainty)调整，不能继续用词值／事实 partial 全局否定文本规则 |
| I2 | 重定向、赋值与命令一样是独立匹配节点 | 初版按全部节点计算 allow 覆盖；此选择不构成通用路径识别承诺，需按[当前参数契约](rules.md#parameter-matching)核对及调整 |
| I3 | 非 bash 工具用 `node: "tool"` + 显式工具名 + 可选参数 selector | 不把任意 JSON 拼成 shell 文本；MCP 使用完整 `mcp__server__tool`；多个“或”条件及选择器能力须按新需求设计，不以初版字段限制产品 |
| I4 | 外层 `run_code` 进入工具准入，按程序文本送审；内层独立判定 | 不解析 JS／TS，不声称拦截直接 Node 效果；内层 allow 不授权其他内层 |
| I5 | 插件直接调用 `ctx.approval.request` 结算人工 | 可区分 human-allow／human-deny／human-abort；normal 之外不发起，通道不可用 fallback-deny |
| I6 | 初版会话裁决直接 `session.append("plugin:arbiter/decision", …)`，**已由 PU-3 证实有缺陷，待修复** | 该写法缺少 ignorable 会导致冷恢复拒绝日志；当前安装包公开导出 appendPluginRecord。包解析／类型接入问题应在实现中解决，不能继续使用不兼容写法 |
| I7 | 配置页使用 exact Fetch 路由 + `configEditor.edit` | owner-only；配置文件仍是唯一可编辑来源；冲突返回 409 |
| I8 | 文件内容哈希作为保存并发修订 | 与内容快照、生效记录分开；外部修改后旧草稿被拒绝 |
| I9 | 无效配置回退到 `last-good.json`，否则内置默认 | 页面显示错误；不静默关闭门禁；当前有效配置继续工作 |
| I10 | `node:sqlite` + 异步有界队列；失败只降级提示 | 审计不是权限前置；队列满可丢弃并标记 |
| I11 | 离线候选最少 3 次、全部放行、无失败、无硬类别 | 历史原型选择；2026-10-23 已确认本功能移出首版，生成与验证机制待真实样本积累后重新设计，不将这些阈值或条件视为已确认需求 |
| I12 | 默认策略 `arbiter-policy-v1`，normal = strict；progress 放宽 medium 上限与 R6 | R1／R2 固定拒绝；阈值未校准 |
| I13 | 无 `exec.agent` 的调用直接 `next()` | 初版选择与本轮“首版暂不接管”的需求确认一致；明确覆盖边界，不声称已审查，运行验证仍未完成 |
| I14 | 熔断按会话、`turn/start` 重置，默认 balanced | 不伪造 review-deny；turn 边界仍待验证 |

这些选择可以在后续评测中调整；调整时修正实现并更新本表与报告，不把旧选择保留成第二套互相冲突的规范。

### 后续维护方式

- 讨论结论被确认后，先更新相应专题正文，再在这里记录状态与理由。
- 被取代的方案留在历史记录中，并链接到当前正文；不在多份文件中各维护一套规则。
- 新的实现证据写入[证据清单](../evidence.md)；验证是否完成记录在[实施与验证清单](implementation.md)中。
- 原稿快照只用于追溯，不再修改。
- 新增或调整产品术语先维护[统一术语表](terminology.md)，并检查代码示例、日志和界面文案是否仍使用旧含义。
