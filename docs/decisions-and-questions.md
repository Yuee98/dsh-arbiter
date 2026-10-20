# 决策记录与待讨论问题

区分原稿的方案演变、已收敛问题、仍待验证的问题，以及本次产品讨论中已确认的契约与尚未采纳的建议。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md)

**阅读约定**：历史取舍表用于解释方案演变，不单独作为当前规范；具体行为以专题正文为讨论基线，存在冲突时先在问题登记中收敛。原稿中的“已核实”仍需按目标版本复核。

## 本文导航

- [早期取舍汇总（历史记录）](#design-10)
- [方案演变记录（历史记录）](#design-15)
- [原稿问题登记与当前状态](#design-16)
- [本轮已确认的规则契约](#confirmed-rule-contract)
- [术语与 DND 讨论进展](#review-policy-terms)
- [本轮产品讨论登记](#product-discussion)
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

**背景**：[事实完整性闸门](review-context.md#design-5-2-2) 规定事实段不得用于 allow 判定（只能往更危险方向）。但实际实现时，`partial` 的事实（如"看到了 `rm -rf /`，但也看到了 `| sh`"）是否应作为**提高风险等级**的依据？如果作为依据，会不会因为 AST 的误报导致过度 deny？

**待定**：`probeMode: override` 在 `partial` 下是否生效。当前设计倾向于"生效"（因为只往危险方向），但需要实测误报率（[待验证项](implementation.md#design-14) 第 19 项）。

<a id="question-o3"></a>

### O3. （已定）规则表与项目级配置的关系

**决定**：分两层，职责不同，不冲突（[用户规则来源](review-context.md#design-5-2-3-1)）。

| 来源 | 内容 | 维护方式 |
|---|---|---|
| `CUSTOM_RULES` | 审查偏好（自然语言），用户全局 | 配置页 → `deploy.ts` 分发 |
| `PROJECT_RULES` | 审查偏好（自然语言），仅本项目 | 仓库内 `.dsh/arbiter.md`，随项目走 |

**与竞品 `dsh-permission-rules` 的关系**：并存但用途不同——它的 `.dsh/rules.yaml` 是**可执行的匹配规则**（拦不拦），我们的 `PROJECT_RULES` 是**自然语言审查偏好**（怎么审）。同装时不冲突。

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

1. **单一真相源**：配置文件（profile 的 Cordis patch）是唯一的持久化位置，UI 只读写它；
2. **schema 驱动**：用同一个 schema 同时生成表单与校验配置文件的合法性——不能出现"UI 允许但文件里非法"或反之；
3. **双向同步**：文件在外部被编辑后，UI 应感知并刷新（`config-editor` 有 HMR 支持，具体能力待核实）；
4. **冲突处理**：UI 保存时若文件已被外部修改（基于 revision 的乐观并发），应拒绝并提示，而不是覆盖。

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
system: 固定策略 + 锚点 + 探针定义 + 证据分级 + 先前裁决规则 + CUSTOM_RULES
user:   PROJECT_RULES + ENVIRONMENT + CONTEXT + EVIDENCE + PRIOR_VERDICTS
        + PENDING_ACTION + DERIVED_FACTS
```

**稳定性分层**（决定缓存收益）：

| 层 | 内容 | 变化频率 |
|---|---|---|
| 稳定 | system 全部（含 `CUSTOM_RULES`） | 用户改配置时才变 |
| 半稳定 | `PROJECT_RULES` | 切工作区时变 |
| 动态 | `ENVIRONMENT` 之后全部 | 每次调用都变 |

**可缓存的部分**：`system` 段固定 → 天然可复用前缀。

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

**最终结构**（经多轮收敛后）：

```
system:
  固定策略（REVIEW_POLICY）
  锚点定义（risk / authorized 各 11 级）
  探针定义（secrets / destructive / egress / bulk）
  授权证据分级规则
  先前裁决处理规则
  CUSTOM_RULES（用户全局，2000 字符上限）

user:
  PROJECT_RULES        （工作区根目录 .dsh/arbiter.md，2000 字符上限，可选）
  ENVIRONMENT          （cwd）
  CONTEXT              （tool call + checkpoint，共享 history.maxItems）
  EVIDENCE             （三类消息，role + evidence）
  PRIOR_VERDICTS       （deny/ask + layer，共享 history.maxItems）
  PENDING_ACTION       （完整命令）
  DERIVED_FACTS        （AST 事实，独立上限 100–250 tok）
```

**待细化的点**：

1. ~~各段的长度预算~~ —— **已定**：[输入预算](review-context.md#design-5-2-6)（固定段先占，动态段按 40/60 分）；
2. ~~"max N 但按 token 截断"的语义~~ —— **已定**：逐条累加、超限即停（[输入预算](review-context.md#design-5-2-6) 截断算法）；
3. ~~AST 段的独立上限~~ —— **已定**：[事实完整性闸门](review-context.md#design-5-2-2) 的 100–250 tok，超出降级 `completeness`；
4. ~~**历史段的信息取舍**~~ —— **已定**：`CONTEXT`（tool call + checkpoint）、`EVIDENCE`（三类消息，role + evidence）、`PRIOR_VERDICTS`（deny/ask + layer）三段互斥，详见 [上下文分段](review-context.md#design-5-2-3)；
5. ~~顺序对缓存的影响~~ —— **已定**：稳定段在前、动态段在后（[输入预算](review-context.md#design-5-2-6)、O9 稳定性分层）；
6. ~~**custom rules 的位置**~~ —— **已定**：`CUSTOM_RULES` 放 system（稳定前缀，利于缓存）；`PROJECT_RULES` 放 user 段首位（随工作区变）；

**预算模型**：见 [输入预算](review-context.md#design-5-2-6)（`maxInputTokens = 10000`、tokenx 估算、逐条累加截断）。本节不再重复，只保留待定项。

---

<a id="question-o11"></a>

### O11. 监听顺序：插件如何保证“规则短路先于其他审查”

**背景**：第一轮宿主实测（`g1-a`／`g1-g`／`g1-h`）显示，`ctx.on("tools/pre-execute", …, { prepend: true })` 只能把监听器插到**同一 prepend 组的最前**；headless 组合下已有一个非探针 `prepend` 监听（源码对应 `dsh-tool-jobs`），加入官方 auto-review bundle 后有两个，它们都更早注册，因此插件仍在它们之后。见[覆盖范围](architecture.md#execution-coverage)与[报告](../validation/host-coverage/2026-10-20-host-coverage-01/REPORT.md)第 8.1 节。

**为何重要**：“规则 allow 短路、零 token”是省 token 的前提；如果其他审查者先运行，短路就失去意义，甚至可能先被别处拒绝。

**候选方向（均未定案）**：

| 方向 | 代价 |
|---|---|
| 接受顺序不确定，产品表达限定为“不保证优先于其他审查者” | 最省事，但削弱核心卖点 |
| 与官方 auto-review 互斥（安装本插件时移除该 bundle，沿用 P0 的迁移要求） | 只解决官方竞品，第三方同类插件仍在 |
| 插件在 `admit` 阶段检测同类监听器并拒绝启用／告警 | 需要宿主提供可枚举监听器的接口，本轮未验证 |
| 改用宿主提供的更高优先级 seam（若存在） | 源码中未发现等价入口，待确认 |

**待定**：选哪条、是否需要向宿主提上游需求。本轮不以探针的测试配置替产品定案。

<a id="confirmed-rule-contract"></a>

## 本轮已确认的规则契约

以下结论已由用户确认，并同步到专题正文。历史记录中的旧名称与旧流程只供追溯。

| 项目 | 当前约定 | 正文 |
|---|---|---|
| 显式审查规则 | `review-hint` 更名为 `force-review`；无 hint 也必须审查，hint 只提供关注点 | [规则优先级](rules.md#design-4-4) |
| 完整顺序 | `deny > force-ask > force-review > allow > review(default)`；默认审查是兜底路径，不是第五种配置 verdict；复合命令的 allow 覆盖不足也进入默认审查 | [规则优先级](rules.md#design-4-4) |
| 规则建议 | 日志 → 离线分析 → 候选 → 独立界面人工审核 → 正式规则；实时审批只处理当前操作 | [离线规则建议与人工审核](rules.md#design-5-10) |
| 正式规则语义 | 人工确认的候选与手工创建的规则同义；取消 `source: learned` 运行时分支及额外复检，可选来源提示仅作说明 | [独立审核界面](configuration-and-audit.md#offline-rule-review) |

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
| C3 | 待收敛 | partial 是禁止使用不完整事实证明安全，还是禁止整个调用自动 allow；按规则来源区分限制的方案已取消，剩余问题需对全部正式规则统一定义 | [事实完整性闸门](review-context.md#design-5-2-2)、[变量展开与目录追踪](review-context.md#design-5-2-5)、[规则沉淀](rules.md#design-5-10) |
| C4 | 待收敛 | bulk、不可逆删除、DND progress 提升与“永不提升”清单的交互 | [bulk 探针](reviewer.md#design-5-6-2)、[规则沉淀](rules.md#design-5-10)、[勿扰态度（attitude）](architecture.md#design-6-3) |
| C5 | 机制已确认，产品策略待定 | 外层 run_code 可进入 pre-execute；官方主动跳过。需决定本产品是否审查外层，以及外层规则与内层逐调用审查如何协作，不能一边提前跳过一边承诺 force-ask 生效 | [PTC（run_code）与内层调用](rules.md#design-4-7)、[覆盖矩阵](architecture.md#execution-coverage) |

这些条目记录尚未解决的分歧；已确认部分以[当前规则契约](#confirmed-rule-contract)及其链接的正文为准。

### 产品建议

| 编号 | 状态 | 讨论方向 |
|---|---|---|
| D1 | 待讨论 | 产品对外承诺、首批目标用户及可观察的收益：任务推进、打断次数、成本和可追溯性 |
| D2 | 宿主覆盖机制已核对，产品表达待讨论 | [覆盖矩阵](architecture.md#execution-coverage)区分源码能力、不可逐项拦截的路径和运行待验证项；覆盖状态、判定依据与授权证据的展示仍为建议。仓库内项目规则的信任来源、覆盖权限与修改生效方式待讨论 |
| D3 | 部分已定 | 离线建议的独立审核入口与确认后普通规则管理已定；首次使用、运行状态、完整决策解释与高级选项展开仍待讨论 |
| D4 | 待讨论 | 早期建立人工标注案例集，同时评估误放、误拦、人工打断、延迟与成本；用目标场景验证概率输出的实际价值 |
| D5 | 待讨论 | 安装、升级、停用、卸载及 reviewer 故障的行为；区分服务不可用与策略拒绝，明确恢复路径 |
| D6 | 待讨论 | 产品自身的安装、配置、排错和升级如何独立于个人 agent-home、deploy.ts 与个人白名单 |
| D7 | 沟通流程、授权原则与指引放置已定，接入待验证 | 父会话原始人类授权可以支持 explicit；简短 system 指引配合具体工具结果提示；证据完整性与宿主接入待验证 |

<a id="dnd-refinements"></a>

### 审批模式细化状态（旧称 DND）

三档关系与评测候选已整理为[专题对照表](approval-modes.md)。下表区分已定契约、后续评测与宿主验证；原“执行前额外检查策略版本”和“自动档限制 ask 补授权”建议均已撤回。

| 编号 | 状态 | 当前约定或剩余问题 |
|---|---|---|
| N1 | 三档关系已定，具体规则与阈值留待评测 | normal / strict 共用常规策略；strict 不新发人工审批；progress 调整部分条件扩大代批。[R1–R8](approval-modes.md#rule-matrix)为评测素材，不是当前逐条确认前提 |
| N2 | 设置方式已定 | 插件设置页分别选择主会话三档、全部子任务两档；用户控制，无单子任务覆盖，不继承父模式。主 normal／子 strict 为建议初始值 |
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

### 后续维护方式

- 讨论结论被确认后，先更新相应专题正文，再在这里记录状态与理由。
- 被取代的方案留在历史记录中，并链接到当前正文；不在多份文件中各维护一套规则。
- 新的实现证据写入[证据清单](../evidence.md)；验证是否完成记录在[实施与验证清单](implementation.md)中。
- 原稿快照只用于追溯，不再修改。
- 新增或调整产品术语先维护[统一术语表](terminology.md)，并检查代码示例、日志和界面文案是否仍使用旧含义。
