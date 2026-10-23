# 审查上下文与证据

描述审查前如何构造事实、授权证据、历史与先前裁决，以及变量处理和输入预算。

状态（2026-10-21）：首轮完整功能版本已实现并可在隔离 DSH 0.2.1-rc.2 profile 中试用；产品语义未定项仍按本文与[决策记录](decisions-and-questions.md)保留讨论状态。实现证据、初版选择与剩余缺口见[首轮实施报告](implementation-report.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

实现状态（2026-10-21）：ReviewSnapshot、EVIDENCE／CONTEXT／PRIOR_VERDICTS、项目规则读取、token 预算与截断已实现；快照随每次调用保存，供审计和详情复用。实现与剩余验证见[首轮实施报告](implementation-report.md)。

## 本文导航

- [结构化事实的完整性闸门](#design-5-2-2)
- [审查输入的三段上下文](#design-5-2-3)
- [授权来源优先级与文本效力](#authorization-source-priority)
- [先前裁决（prior verdicts）](#design-5-2-4)
- [变量展开与 `cd` 追踪](#design-5-2-5)
- [Token 预算与估算](#design-5-2-6)

---

<a id="design-5-2-2"></a>

## 结构化事实的完整性闸门

AST 解析产物可以作为审查输入，已可靠观察到的内容与分析缺口必须一起表达；不要求先证明整个调用效果完备才能提供观察。核心约束：

> **能肯定地说"有"，不能肯定地说"没有"。**

`bash deploy.sh` 的 AST 里没有任何 `file_redirect`，但脚本可能写任意文件。若输出 `writes_outside_workspace: []`，审查者会读成"确认不越界"——**这比不提供事实更危险**。

2026-10-22 已确认：[结构解析、每个词的静态取值、效果事实提取](rules.md#matching-uncertainty)是三个独立维度，不是互斥档位。原稿的单个 `completeness` 不再控制所有规则及审查结论；若为兼容而保留，只能表示事实提取状态。下方是语义示意，不冻结最终字段名或要求既有实现已完成迁移：

```jsonc
{
  "structure": { "status": "complete", "issues": [], "statements": 3 },
  "word_values": [
    { "source": "\"$BUILD_DIR\"", "status": "dynamic" } // 原文保留，不填猜测值
  ],
  "observed": {                    // 只列解析器真正看到的东西，不含"未发现"断言
    "writes": ["/Users/yue/build"],
    "network_commands": ["curl"],
    "credential_paths": [],
    "pipeline_exec": [["curl", "sh"]],
    "substitutions": 0,
    "subshells": 0
  },
  "opaque": false,                 // 命令调用了解释器/脚本/未知二进制
  "opaque_reason": null,
  "unresolved_expansions": ["$BUILD_DIR"], // 无法静态求值的展开
  "expansion_risk": null,          // "undefined-possible"：未解析变量出现在破坏性位置
  "completeness": "partial",       // 只描述事实提取 complete | partial | none
  "parent_authorization_present": null, // true/false；非子 agent 时为 null
  "overlaps_denied_effect": false,      // 与某条被拒调用的 effect 重叠（§5.2.4）
  "history_truncated": false            // 历史/裁决段被预算截断（§5.2.4）
}
```

**独立状态及影响**：

| 情况 | 状态及缺口 | 对规则／审查的影响 |
|---|---|---|
| 结构完整且词可静态取得 | 前两项完整，事实状态另行记录 | 文本规则正常判断，不由此承诺掌握所有副作用 |
| 结构完整但含变量等动态词 | 词值未知，不等于结构解析失败 | 原文保留；可以匹配明确的文本规则，不自动取消 allow 资格 |
| 调用脚本／解释器／未知二进制 | 可以结构完整且词值明确，但效果事实有缺口 | 不能从外层 AST 推断脚本没有其他行为；不否定用户明确配置的文本规则 |
| 子 shell／命令替换／heredoc | 递归检查是否完整；不能只因存在这种语法就认定结构缺失 | 可靠解析时纳入覆盖；未支持、嵌套有错误或未遍历完成时，相关结构条件无法判断 |
| `cd` 目标不可解析 | 工作目录与后续相对目标的事实不确定 | 不把后续路径分类当作已确认安全，不直接改变文本条件结果 |
| 结构错误或未知节点 | 结构不完整；词值与事实分别保留可用部分 | 相关 AST 条件无法判断，不以恢复片段授予完整覆盖；提供原文、可靠观察及具体缺口 |

**三条硬规则**：

1. 不允许输出"未发现 X"的断言，只能输出 `observed` 里实际看到的东西；
2. 事实不完整时，不得用“没有观察到危险”或未知内容证明安全；可靠的正向观察可以提供给 reviewer，明确文本规则仍按自身匹配与覆盖求值，reviewer 可根据原文和授权正常审查；
3. 没有可靠观察时省略相应事实并标明缺失，不用空对象／空列表暗示已经确认没有效果。存在结构错误时，仅保留能可靠关联到原始输入的观察，不能把错误恢复产物当作完整结构；若全部不可信，就只提供原文及错误说明。

**正向用途（即使 partial 也有价值）**：

- `observed.writes` 命中工作区外路径 → 可用于**提高 `risk`**、触发 `force-ask`；
- `observed.network_commands` 非空 → 可确定性置 `egress = true`（用于不变式）；
- `observed.credential_paths` 命中 → 可确定性置 `secrets = true`；
- `pipeline_exec` 命中 `curl|sh` 之类 → 可确定性置 `destructive = true`。

可靠观察可用于提高严重度或说明不确定性；缺失观察不能当作减轻风险的依据。事实 partial 不构成 review-allow 或命令规则 allow 的全局否决开关。探针 override 是否及如何采用这些观察仍遵循[判定引擎](reviewer.md#design-5-6)及其评测约束，不由本节擅自改动阈值。

**token 预算**：事实段约 100–250 tok/次。只输出与判定相关的类别，不 dump 完整 AST；条目超上限（如 30 条）截断并置 `truncated: true`，同时降级 `completeness`。各段总预算与相互约束见 [O10](decisions-and-questions.md#question-o10)。

<a id="design-5-2-3"></a>

## 审查输入的三段上下文

审查输入里与"上下文"相关的部分拆成**三段互斥**的结构。互斥是刻意的：消息只在 `EVIDENCE`、tool call 与 checkpoint 只在 `CONTEXT`、裁决只在 `PRIOR_VERDICTS`，避免同一内容注入两次、也避免不同类型的语义混在一起。

| 段 | 内容 | 作用 | 预算 |
|---|---|---|---|
| `CONTEXT` | 先前 tool call（name + args）+ checkpoint 摘要 | 让 reviewer 理解"发生了什么" | 与 `PRIOR_VERDICTS` 共享 `history.maxItems` |
| `EVIDENCE` | 三类消息（本会话人类 / 父会话人类 / 父 agent 转述） | 判定 `authorized` | `evidence.maxItems`（20） |
| `PRIOR_VERDICTS` | 本会话受阻调用的完整判定链 | 识别重试与绕过 | 共享 `history.maxItems` |

**不再注入 `AGENTS.md` 链**。早期设计考虑照搬官方的 `PROJECT_INSTRUCTIONS`，但实测判断：`AGENTS.md` 的绝大部分内容与审查无关（编码规范、工具偏好、目录说明），塞进每次审查请求是纯浪费 token。改为两个**专门为审查而写**的来源（[用户规则来源](review-context.md#design-5-2-3-1)）。

<a id="design-5-2-3-1"></a>

### 自然语言审查指引的两个来源

本节的自然语言“用户规则”统一称为[审查指引](terminology.md#core-terms)。用户已确认：`CUSTOM_RULES` 与启用的 `PROJECT_RULES` 均为自由文本，可以表达项目事实、限制、风险偏好及持续授权。其语义由 reviewer 理解，通过风险／授权信号影响代码判定；不由 free text 直接修改命令规则优先级、代码判定规则或阈值。字段名沿用原稿。

| 来源 | 位置 | 作用域 | 上限 |
|---|---|---|---|
| **`CUSTOM_RULES`** | 配置页（写入 profile 的 Cordis patch） | 用户全局，所有项目 | 2,000 字符 |
| **`PROJECT_RULES`** | 工作区根目录的固定文件 | 仅该项目 | 2,000 字符 |

两者合计上限 3,000 字符（约 800–1,000 tok）。

**`PROJECT_RULES` 的文件位置**（按顺序取第一个存在的）：

```
<workspace>/.dsh/arbiter.md      ← 推荐
<workspace>/.arbiter.md          ← 备选
```

**只读工作区根目录，不 `searchUp`、不支持目录级覆盖。** 理由：

1. `searchUp` 让规则来源不可预测，"为什么这条规则生效"的排查成本高；
2. **需要按目录细分时，在 DSH 里建多个工作区**——这是既有机制，不该用插件再造一层目录继承；
3. 文件缺失即"无项目规则"，语义干净。

**为什么用 `.md` 而不是 `.yaml`**：内容是自然语言指引（如“特别关注 .env 泄露”“这个项目的生产目录是 /srv/app”），也可包含用户希望持续适用的授权；不是可执行的匹配规则配置。

**读取开关与内容责任（已确认）**：设置页提供 `projectRules.enabled`，默认开启，控制是否读取项目审查指引。开启后按约定位置读取，用户负责内容；不再区分用户手写、克隆／拉取或 agent 修改的文件版本，不增加文件逐次人工认可流程。每次构造新的审查快照时取得当前内容；关闭时不将项目指引送入后续新构造的审查请求，不因此屏蔽正常的人类消息。界面应说明项目文件可以包含指引和授权。已发出的审查请求保持原快照，不要求重启或逐次确认。

<a id="authorization-source-priority"></a>

#### 来源优先级与冲突解释（已确认）

多个来源的适用内容发生冲突时，使用以下顺序：

```
本会话人类原话（含宿主确认的真实 ask 答复）
> 直接父会话人类原话（含对应的真实 ask 答复）
> PROJECT_RULES
> CUSTOM_RULES
> agent 转述
```

优先级解决适用内容之间的冲突，不丢弃其他来源的上下文。同一来源层级内，较新的适用指令在相关冲突上优先；不冲突的旧限制继续有效。例如“继续修复”本身不撤销更早的“不要上传日志”。任务需要哪些步骤、授权是否覆盖本次操作／目标／范围，均由 reviewer 基于原始材料理解，不另建代码级任务语义推断器。

**来源优先级与授权强度分开**：直接父会话人类原话仍与本会话人类原话采用相同授权标准，可支持 explicit，冲突优先级较低不意味着其授权上限降为 implied。CUSTOM_RULES／PROJECT_RULES 可以表达明确或持续授权，但必须保留其指引来源，不改写成聊天中的人类原话或 human-allow。纯 agent 转述不能单独制造明确人类授权；摘要和普通工具／文件材料不因引用“用户已批准”而升级为原始人类来源。

**Prompt 整合职责**：固定来源优先级及处理契约写入 system；各来源文本按独立标签或结构化字段提供。CUSTOM_RULES／PROJECT_RULES 都作为待解释的指引材料，不把 CUSTOM_RULES 原文当成压过更高优先级来源的 system 命令，也不只靠拼接先后表示覆盖。来源与时间顺序应可追溯，不能将低优先级文本重新包装成高优先级消息。该契约用于解释授权与限制，不让 reviewer 越过已经生效的命令规则或改写代码策略。

**位置与缓存**：固定策略及来源契约保留稳定 system 前缀；CUSTOM_RULES／PROJECT_RULES 以独立标注的材料块提供，可以在动态历史之前组织稳定前缀，但缓存安排不能改变上述权力顺序。旧“CUSTOM_RULES 原文直接放 system”的布局被本轮契约替代，见 [O9](decisions-and-questions.md#question-o9)。

**读取实现**：

```js
// PROJECT_RULES：按顺序找第一个存在的文件，读入并截断到 2000 字符
const candidates = [".dsh/arbiter.md", ".arbiter.md"].map(p => join(workspaceRoot, p));
const projectRules = firstExisting(candidates);   // 缺失 → null
```

该片段只说明路径选择，不锁定缓存与刷新实现。**用户已确认：每次构造新 ReviewSnapshot 时取得当前项目指引，文件更新不要求重启或逐次确认。** 缓存／变更检测可按实现选择，但不能让下一次新快照无故继续使用旧内容。构造后的 ReviewSnapshot 保持不可变，已发出的审查请求不原地替换输入。

<a id="design-5-2-3-2"></a>

### `EVIDENCE` 的结构

三类消息合并成一条按时间从新到旧的流。该排序用于选择与展示，不取代[来源优先级](#authorization-source-priority)。**role 表示消息角色，evidence 表示来源所能支持的授权上限**；来源标记还需保留消息来自本会话、父会话人类还是父 agent 转述。下面的 source 字段为表达这一要求的 Schema 建议：

```jsonc
{
  "evidence": [
    { "ts": 1234567890, "source": { "kind": "session-human", "sessionId": "child" },
      "role": "human-instruction",
      "evidence": "explicit", "text": "删掉 build 目录" },
    { "ts": 1234567880, "source": { "kind": "parent-relay", "sessionId": "parent" },
      "role": "direct-parent-instruction",
      "evidence": "implied",  "text": "用户批准了删除 build" },
    { "ts": 1234567800, "source": { "kind": "parent-human", "sessionId": "parent" },
      "role": "human-instruction",
      "evidence": "explicit", "text": "同意让子任务删除 /workspace/app/build，保留其他目录" }
  ],
  "evidence_truncated": false,
  "parent_authorization_present": true
}
```

**两个字段职责不同**：

| 字段 | 语义 | 取值 |
|---|---|---|
| `role` | 这条消息在**上下文**里是什么 | `human-instruction` / `direct-parent-instruction` / `checkpoint` / `fact` |
| `evidence` | 该来源最多能支持哪一级授权；不是对当前动作已经授权的结论 | `explicit` / `implied` / `null` |

正交的原因：人类消息既可能是**授权**（"删掉 build"），也可能是**限制**（"别碰 /etc"）。只标 evidence 会丢掉"这是限制"那一面；只标 role 又表达不了授权强度。

`evidence: explicit` 表示可作为明确授权的原始来源，不表示该消息真的批准了当前动作。reviewer 仍需根据原文、所指操作、目标与范围判断 authorized 信号；只有宽泛目标可能得到 implied，明确限制则不能被当作允许。

**来源与档位**：

| 来源 | `role` | `evidence` 上限 |
|---|---|---|
| 本会话的人类消息 | `human-instruction` | **explicit** |
| 父会话的人类原始消息 | `human-instruction` | **explicit**；与本会话原话使用相同标准，需覆盖当前操作、目标与范围，不因会话位置自动降级 |
| 父 agent 的转述（`agent-message`） | `direct-parent-instruction` | **implied**；单独不能制造明确人类授权；同时有原话时结合原话核对，不拖低原话的授权效力 |
| checkpoint 摘要 | `checkpoint` | `null`（有损摘要，永不作指令角色） |

**子任务授权沟通**按[执行 agent 行为指引](architecture.md#subagent-recovery)处理：先寻找允许的替代方案，受阻后报告父 agent，尝试父级询问并转述，必要时引导用户直接在子会话授权。插件负责提供证据及来源，不把转述自动变成 human-allow。

**本轮修正**：已有上下文设计会同时提供父会话人类原话和父 agent 转述，因此取消“父会话人类消息封顶 implied”的限制。明确授权来自人类原话，转述帮助关联子任务和待执行动作，不能扩大原话的范围；发生冲突时以适用的人类原话为准。原话与转述描述的是同一次授权，不当成两次独立批准。无法读到原话时，仍按现有证据判断，不能把“理论上可读取”当成“本次已经取得”。

**短答复的上下文**：人类只说“同意”“可以”时，应保留它回答的具体问题或待执行操作，避免脱离范围解释。若授权来自 ask 工具，需关联宿主保存的真实答复与对应提问；普通工具结果仍不作为授权。本机源码已确认：前台答复进入 ask 的工具结果，timed 的迟到答复是 source.kind 为 `user-question-reply` 的用户消息，并自带 callId、questions 与 answers，详见[源码核对](../evidence.md#ask-timing)。实际采集与截断效果仍需验证。

**排序与截断**：按 `ts` 从新到旧，受 `evidence.maxItems`（20）与 token 预算约束，超出置 `evidence_truncated: true`。

**父证据保底**：`parent-human` 至少保留 1 条（最近的），不参与竞争——否则子会话说话多时，父的授权证据会被完全挤掉。

**`parent_authorization_present`**：布尔，表示父会话里**是否存在**人类消息。若存在但因截断未进入 `evidence`，reviewer 仍知道"有证据但没看到"，从而倾向 ask。非子 agent 时为 `null`。

**读取实现**：

```js
// 原始人类消息来源示意，不是完整的 ask 答复采集器
const parentId = childSession.header.parentSession;
const parent = parentId ? ctx.sessions.get(parentId) : undefined;
const parentHuman = parent?.deriveMessages()
  .filter(m => m.source?.kind === "user" || m.source?.kind === "user-question-reply")
  .slice(-N)                                  // 最近 N 条，默认 5
  .map(m => ({ ts, source: { kind: "parent-human", sessionId: parentId },
    role: "human-instruction", evidence: "explicit", text }));
```

上例展示来源映射，ts / text 沿用消息提取器取得的原始时间与正文；不在采集阶段按会话位置预先判定当前动作的 authorized 等级。还需从已验证的 ask 调用与工具结果配对提取前台人类答复；不能把过滤普通 user 消息当作完整实现。pending、跳过的空答案和 agent 自己的转述不产生用户批准。

**三个已知边界**：

1. **父可能不在 live** → `parent` 为 `undefined`，不注入父证据，`parent_authorization_present` 置 `null`；
2. **父历史可能被压缩**：`deriveMessages()` 是派生历史，父 compaction 后人类消息原文可能已变摘要。若实测损失严重，改为扫父会话的**事件日志**；
3. **人类消息来源只采纳可识别的原始输入**——父会话的普通工具结果、文件内容不改写成人类原话；ask 工具若通过专用事件保存真实人类答复，应在验证事件来源后按上述规则提取，不把整个工具结果视为用户授权。启用的项目审查指引按单独的指引来源提供，不受这条人类消息提取规则排除。

<a id="design-5-2-3-3"></a>

### `CONTEXT` 的结构

```jsonc
{
  "context": {
    "tool_calls": [
      { "ts": ..., "tool": "bash", "arguments": "rm -rf build",
        "result": { "ok": false, "exitCode": 1 } },
      { "ts": ..., "tool": "bash", "arguments": "bash -c \"set -e; cd build && …\"",
        "arguments_truncated": true }
    ],
    "checkpoints": [
      { "ts": ..., "text": "用户要求清理构建产物并部署到 staging" }
    ],
    "context_truncated": false
  }
}
```

**tool call**：只记 `name` + `arguments`，**不记输出内容**。`result` 只保留结构化状态（`ok` / `exitCode`），不保留 stdout。

理由：工具输出是"待判数据"（可能含注入内容），体量也大。结构化状态已能回答"刚才失败了"这类关键问题。

**`arguments` 截断**：默认 `toolCallArgumentMaxChars = 200`，超出部分截断并追加 `…`，同时置 `arguments_truncated: true`。

理由：heredoc 和长脚本可能几百上千字符，而审查需要的通常是"命令是什么"，不是逐字细节。截断后的 200 字符足够表达命令形态（`bash -c "..."` 的开头部分）。

**注意**：上面的 200 字符限制只适用于历史 tool call。当前待审动作优先保留完整内容，不套用历史条目限额；长程序仍可能受总输入预算限制而截断，按[下方已确认契约](#pending-action-truncation)标记与反馈。

**checkpoint**：会话被 compaction 后的摘要。独立上限 **3 条**（最近 3 次压缩的摘要），不占 tool call 的额度。`role: "checkpoint"` 提示 reviewer 这是有损摘要。

**为什么保留 checkpoint**：不保留的话，长会话后期 reviewer 会完全失去早期上下文（"这个任务怎么来的"）。

**为什么不照搬官方的 `FILTERED_HISTORY`**：官方那段是"过滤后的完整事件上下文"，含 tool call 与按角色标签的消息。我们的方案把消息移到了 `EVIDENCE`（因为需要授权强度标签），只留 tool call 与 checkpoint，职责更窄也更清晰。

<a id="design-5-2-4"></a>

## 先前裁决（prior verdicts）

审查者需要知道"这个动作之前被怎么判过"——这是识别**重试**与**换写法绕过**的唯一来源。

**来源**：正常运行由本会话内存状态提供，不等待持久化成功；冷恢复优先读取 `plugin:arbiter/decision` 会话裁决记录，目标窗口缺段、不可读或完整性不明时再由 SQLite 补充。按共同事件标识去重与阶段顺序补齐后，保留最近 N 条逻辑裁决，N 与 `history.maxItems` 一致。会话与 SQLite 分别接收同一次裁决的数据，不串行依赖写入。审计清理不清空内存或会话裁决记录；两个来源均不足时标明缺失或完整性未知，不能作为“从未有先前裁决”处理。宿主恢复保证待验证，具体见[分层恢复](configuration-and-audit.md#decision-history-recovery)。

**结构**：保留完整判定链与各阶段原因，字段形态为建议稿，实际审计结构见[记录内容](configuration-and-audit.md#design-9-2)。例如：

```jsonc
{ "kind": "prior-verdict", "role": "fact",
  "ts": 1234567890, "callId": "c1", "configRevision": "cfg-12",
  "tool": "bash", "fingerprint": "bash:deploy --target prod",
  "trace": ["force-review", "review-escalate", "fallback-deny"],
  "result": "fallback-deny", "reason": "automatic_mode_no_human",
  "ruleId": "deploy-review", "decisionRules": ["R5"],
  "effect": { "writes": ["production"] } }
```

**优先取受阻及升级人工的调用，不重复保存成功调用的完整审查信号**；成功调用的执行信息仍在 CONTEXT 中。不能只按最终 deny 分类，必须读实际阶段链。

**范围：只取本会话。** 不跨父／兄弟会话复制裁决；父会话的授权证据仍走 EVIDENCE，不与裁决历史混用。

| 来源 | 对当前请求的含义 |
|---|---|
| 命令 deny | 按当前规则匹配；换写法不能绕过仍生效的禁止规则 |
| review-deny | 保留实际判定条件与当时上下文；当前请求仍按当前策略判断，不能由兜底层覆盖 |
| human-deny | 人对当时具体操作作出的拒绝，不能解释成“没人回答” |
| human-abort | 人工审批已经结束但没有取得决定；不证明用户反对或操作危险，不能等同 human-deny |
| review-escalate → fallback-deny | 当时需要人工而无法询问，不证明操作危险，也不证明用户反对 |
| error-escalate → fallback-deny | 审查故障且无法转人工；没有有效风险结论 |
| force-ask → fallback-deny | 规则要求实际人工审批，不能用重复调用替代批准 |

**prompt 约定**：要求模型识别完整阶段链及原因，输出风险、授权等信号；不让模型直接执行“见 deny 就拒绝”的旧模板。尤其不得从 fallback-deny 或 human-abort 推断 human-deny，不得从 error-escalate 推断高风险。仍在等待答案的审批不是 human-abort。

相同指纹或 effect 重叠仍可作为重试线索，但要区分当时是规则禁止、风险拒绝、人工拒绝还是通道／服务受阻。配置、授权、操作范围或故障状态改变后，新请求重新判定；不能仅凭“相同效果曾被 deny”永久禁止。没有相关变化时，agent 不应靠换写法反复尝试同一受阻操作。

**effect 字段**：facts 计算本次动作的 writes／network_commands，与先前受阻操作比较；overlaps_denied_effect 等旧字段名可暂保留，解释时必须结合阶段链，不能把 effect 重叠自动等同于绕过安全拒绝。

**预算（与历史段共享一个总上限）**：不是"当前轮全取 + 更早取 N 条"两笔独立预算，而是**合并后统一截断**：

内存候选和冷恢复上限可以共用这个 N，但两者均按逻辑裁决计数，每条保留完整已知阶段链，不按原始事件行或模型请求次数计数。最终送审仍与工具历史合并取 N 条并受 token 预算限制；持久化恢复缺失与正常预算裁剪分别标记。

```
候选池（四类，合并后统一排序）：
  A. 当前轮次的 prior verdicts（受阻调用的阶段链）
  B. 更早轮次的 prior verdicts（受阻调用的阶段链）
  C. 当前轮次的 tool call 历史（name + arguments）
  D. 更早轮次的 tool call 历史

按 ts 从新到旧排序 A ∪ B ∪ C ∪ D，
累计取到 maxHistoryItems（默认 40）为止
（同时受 token 预算约束，先到先限）
```

**为什么合并而不是分账**：一个长 turn 可能积累几十个 tool call，如果历史段另算一笔预算，"当前轮全取"会让单 turn 的输入膨胀到不可控。合并后是**硬上限**，不管 turn 多长。

**没有绝对保底**：所有条目一视同仁地按 `ts` 竞争，先到先得。唯一的例外是 `parent-human` 证据保底 1 条（[授权证据](review-context.md#design-5-2-3-2)，因为它不在历史预算里，是独立的一笔）。

**为什么要"无保底"**：如果给当前轮 prior verdicts 绝对保底，长 turn 里几十条拒绝会把整个预算吃光，tool call 上下文一条都进不来——反而更糟。按时间竞争的效果是：最近的拒绝和最近的调用都在，远处的自然淘汰。

**截断时置 `history_truncated: true`**，让 reviewer 知道"可能还有更早的记录没看到"，从而倾向 ask 而非直接 allow。

<a id="design-5-2-5"></a>

## 变量展开与 `cd` 追踪

**原则：不做开关，不做白名单/黑名单，只做"词法解析 + 符号分类"。**

本节描述提供给 reviewer 的事实提取，不改写[命令规范文本](rules.md#command-matching)。规范化不读取环境值或展开动态词；事实提取记录观察、符号分类与缺口，不能把它们混成一个全局 partial 来取消文本规则资格。

### 可静态求值的部分（永远做）

```
① 词法解析
   · 同一 command list 内的 variable_assignment（常量）
     例：DIR=build && rm -rf $DIR → 目标 build
   · 字面量默认值：${DIR:-/tmp}、${DIR-/tmp}
   · 结果写入 facts（安全：值本来就在命令文本里）

② 符号分类（只产出布尔，不 emissions）
   · $HOME / $PWD / $DSH_HOME / $DSH_PROFILE_DIR 等已知变量
     展开后只用于判定"是否在工作区内"，断言后丢弃值
   · facts 里写原始形式 "$HOME/build" + writes_outside_workspace: ["$HOME/build"]

③ cd 追踪（必须做）
   · 同一 command list 内追踪 cd 的效果，影响后续相对路径
   · cd 目标可词法解析 → 更新当前目录；不可解析 → 记录目录事实缺口
```

**`cd` 追踪不是精度问题，是安全 bug**：`cd /tmp && rm -rf build` 若不追踪，会把目标误判成 `<workspace>/build`（在工作区内）→ 可能 allow，而实际目标是 `/tmp/build`。

### 始终标为 unresolved 的部分

| 情形 | 原因 |
|---|---|
| 会话外部赋值的变量（`$BUILD_DIR` 来自之前命令或环境） | `bash -c` 每次是新进程，插件无法知道 |
| 脚本内部定义/修改的变量 | 需读脚本并求值 |
| 命令替换 `$(...)` / 反引号 | 需执行才知道 |
| 复杂参数展开（`%`、`#`、`//`、数组、`@`） | 需实现 shell 语义，不值得 |
| 命令词本身是展开（`$CMD ...`） | 直接判 `opaque` |

### 隐私：环境值永不写入 facts

区分"把值写进 facts"与"用值算分类"：

| 用法 | 隐私风险 | 处理 |
|---|---|---|
| 环境变量的**值**写进事实段 | 有（`$TOKEN` 会真送进审查请求） | **禁止** |
| 只用环境变量**算一个布尔** | 无 | 允许 |

因此：`curl -H "Authorization: $TOKEN"` 的 facts 里出现的是 `"$TOKEN"` 字面量，不是真 token。这条规则让白名单/黑名单/开关全部变得不必要。

### 未解析变量在破坏性位置 → 按"更危险"处理

```bash
rm -rf $BUILD_DIR          # 正常情况下
rm -rf $BUILD_DIR/         # 若 BUILD_DIR 为空 → rm -rf /  ← 灾难
```

未定义变量在非 `set -u` 下展开成空串。因此当 `unresolved_expansions` 出现在破坏性参数、重定向目标或命令词上时，置 `expansion_risk: "undefined-possible"`，并且：

- 不把目标推断为已经确认的安全路径；文本规则按自身条件及覆盖正常判断，不由该标记全局取消 allow；
- 审查者看到该标记，知道"可能比字面更危险"。

### 代价

`rm -rf $BUILD_DIR`（变量来自会话外部）可以结构完整，但词值及目标效果未知。若明确文本规则已匹配、覆盖完整且不被相关更高优先级规则阻挡，可按规则裁定；否则带着原文和缺口进入正常审查。未知变量本身不预先决定 review-allow、review-deny 或 review-escalate，也不直接产生 error-escalate。


<a id="design-5-2-6"></a>

## Token 预算与估算

所有段的上限最终要落到 **token**，因为模型按 token 计费、按 token 决定速度（Clef 超过 20k 会明显变慢）。

### 估算工具：`tokenx`

```js
import { estimateTokenCount } from "tokenx";
const tokens = estimateTokenCount(text);
```

| 属性 | 值 |
|---|---|
| 体积 | **2 kB**，零依赖 |
| 准确率 | 95%+ 平均，单样本 ≥90% |
| 校准基准 | OpenAI `o200k_base` |
| 内置规则 | CJK、西里尔、希腊、带重音拉丁、emoji |
| 许可 | MIT |

**为什么不用完整 tokenizer**：`gpt-tokenizer` 28 MB、`js-tiktoken` 22 MB，且它们只对 GPT 系准确——Clef 基于 Qwen、Jev 自研，装了也是**错的方向**。`tokenx` 是启发式但对 CJK 实测偏差仅 -1.15%，量级足够。

**为什么不用手写系数**（ascii×0.25 + 非 ascii×1.1）：不区分语言，中文按 1.1 token/字符会**高估 60%**，浪费预算。

### 预算模型

```
maxInputTokens = 10000     # 宣告值 = 实际截断值，无隐藏边际
```

**不做隐藏安全边际**。理由：

1. tokenx 的偏差是个位数百分比（中文 -1.15%，英文 ±3%），10k 估算对应真实约 10–11k，距离 20k 慢路径仍有大余量；
2. **透明度优先**——用户看到 10000 就知道能塞多少；代码里偷偷按 9k 截断会让调 prompt 的人困惑；
3. 误差可通过配置调整（用户可按自己的模型调 `maxInputTokens`）。

### 各段预算分配

**固定段**（先占，不参与竞争）：

| 段 | 预算 |
|---|---|
| system（策略 + 锚点 + 探针 + 证据分级 + 裁决规则） | ~1500 |
| `CUSTOM_RULES` | ~500（2,000 字符上限） |
| `PROJECT_RULES` | ~500（2,000 字符上限） |
| `PENDING_ACTION` | ~500 |
| `DERIVED_FACTS` | ~300 |
| **小计** | **~3300** |

**动态段**（分享剩余约 6700）：

| 段 | 配额 |
|---|---|
| `EVIDENCE` | 40%（~2700） |
| `CONTEXT` + `PRIOR_VERDICTS` | 剩余（~4000，其中 `history.maxItems = 40` 仍生效） |

`EVIDENCE` 拿 40% 的理由：它直接决定 `authorized`，是 allow 判定的关键输入；另外两段更多是防误判。

### 截断算法

**逐条累加，超限即停**——不需要先算总账再重分配：

```js
const used = fixedTokens;   // 已渲染的固定段
for (const item of candidates) {          // 已按 ts 降序
  const t = estimateTokenCount(render(item));
  if (used + t > maxInputTokens) break;
  kept.push(item);
  used += t;
}
```

这与"从新到旧"的语义天然一致，实现也简单。

**预算分配原则**：先裁剪历史及可选辅助上下文，优先保留当前动作、相关授权证据和判定所需说明；不机械地把所有授权证据都删除来腾出程序空间。具体分段上限与保留头尾或片段的算法留给实现和评测。固定策略说明不作为普通文本任意切断；可配置材料无法合法组装时，按实际配置或请求错误处理。

<a id="pending-action-truncation"></a>

**当前动作截断契约（本轮确认）**：替代旧稿“PENDING_ACTION 永不截断，超限直接 ask”的方案。完整原始请求先参与规则匹配；必须进入模型审查而输入超预算时，允许对长程序等当前动作材料截断。运行时记录并向 reviewer 说明截断事实、原始长度及已省略内容的范围；原始请求与实际送审快照分别保存。具体字段名未定。

截断是输入完整性信息，不直接决定权限结论，也不单独算审查故障。模型基于已知输入提供正常信号，判定引擎应用审查策略；首版不增加 truncated／输入充分性 noul 或独立硬闸门。真正的请求失败或后端错误仍按 error-escalate 处理。此约定不取消 shell 规则对完整 AST 覆盖的要求，也不把未知程序行为标成已检查。

最终返回给执行 agent 的反馈由插件组合实际裁决原因与补充提示。运行时知道送审有截断，可以附“本次送审程序因输入预算被截断”；不能仅据此断言“因截断而拒绝”。review chain 保持阶段序列，截断元数据不成为新阶段或阶段标签后缀。相关定义见[最终反馈](reviewer.md#final-feedback-composition)。

### 硬兜底

组装完成后对最终文本再估算一次，按上述优先级调整可裁剪材料，并更新各段完整性标记：

```js
if (estimateTokenCount(finalText) > maxInputTokens) {
  // 裁剪可选上下文，必要时按预算截断当前动作材料
  // 更新实际送审快照及截断标记，再检查预算
  // 无法构造合法请求时按实际请求准备错误处理，不把单纯截断算作错误
}
```

这道兜底防的是"逐条累加的精度误差累积"：估算按条算是准的，但拼接后的整体可能略超。

### 实际 token 数的事后核对

每次审查后记录：

```jsonc
{ "estimatedInputTokens": 7834, "maxInputTokens": 10000, ... }
```

若后端（Clef / chat provider）返回 `usage`，也记录实际值，用于：

- 校准 tokenx 的偏差（[待验证项](implementation.md#design-14) 验证项）；
- 判断 `maxInputTokens` 是否需要调整。

**记住一个事实**：`tokenx` 校准的是 OpenAI tokenizer，**不是 Clef 的**。估算值不是精确值；10k 的设计意义是"远离 20k 阈值"，不是"精确控制在 10k"。
