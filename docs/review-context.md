# 审查上下文与证据

描述审查前如何构造事实、授权证据、历史与先前裁决，以及变量处理和输入预算。

状态：需求与设计讨论中，尚未实现。已确认结论同步到正文，其余冲突与建议见[决策与待讨论问题](decisions-and-questions.md)。

入口：[README](../README.md) · [设计导航](../design.md) · [证据](../evidence.md) · [决策与待讨论问题](decisions-and-questions.md)

## 本文导航

- [结构化事实的完整性闸门](#design-5-2-2)
- [审查输入的三段上下文](#design-5-2-3)
- [先前裁决（prior verdicts）](#design-5-2-4)
- [变量展开与 `cd` 追踪](#design-5-2-5)
- [Token 预算与估算](#design-5-2-6)

---

<a id="design-5-2-2"></a>

## 结构化事实的完整性闸门

AST 解析产物可以作为审查输入，**但只在能被判定为完备时**。核心约束：

> **能肯定地说"有"，不能肯定地说"没有"。**

`bash deploy.sh` 的 AST 里没有任何 `file_redirect`，但脚本可能写任意文件。若输出 `writes_outside_workspace: []`，审查者会读成"确认不越界"——**这比不提供事实更危险**。

因此事实段的结构与闸门是：

```jsonc
{
  "parse": { "status": "ok" | "error", "statements": 3 },
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
  "unresolved_expansions": [],     // 无法静态求值的展开，如 ["$BUILD_DIR"]
  "expansion_risk": null,          // "undefined-possible"：未解析变量出现在破坏性位置
  "completeness": "complete",      // complete | partial | none
  "parent_authorization_present": null, // true/false；非子 agent 时为 null
  "overlaps_denied_effect": false,      // 与某条被拒调用的 effect 重叠（§5.2.4）
  "history_truncated": false            // 历史/裁决段被预算截断（§5.2.4）
}
```

**完整性判定**：

| 情况 | `completeness` | 是否可作为 allow 依据 |
|---|---|---|
| `parse.status = ok` ∧ `opaque = false` ∧ 无子 shell/替换/复合语句 | `complete` | 是 |
| `parse.status = ok` 但含 `opaque`（调脚本/解释器/未知二进制） | `partial` | **否** |
| 含 `subshells > 0` / `substitutions > 0` / heredoc | `partial` | **否** |
| `unresolved_expansions` 非空 | `partial` | **否** |
| `cd` 到不可解析路径 | `partial` | **否** |
| `parse.status = error` | `none` | **否**（事实段整体缺失，不是空对象） |

**三条硬规则**：

1. 不允许输出"未发现 X"的断言，只能输出 `observed` 里实际看到的东西；
2. `completeness != "complete"` 时，事实段**不得用于任何 allow 判定**，只能用于提高严重度或增加不确定性；
3. `parse.status = error` 时事实段整个不出现，审查者只看到原始命令。

**正向用途（即使 partial 也有价值）**：

- `observed.writes` 命中工作区外路径 → 可用于**提高 `risk`**、触发 `force-ask`；
- `observed.network_commands` 非空 → 可确定性置 `egress = true`（用于不变式）；
- `observed.credential_paths` 命中 → 可确定性置 `secrets = true`；
- `pipeline_exec` 命中 `curl|sh` 之类 → 可确定性置 `destructive = true`。

即：**事实只能往"更危险"的方向用，不能往"更安全"的方向用**。这条原则同时覆盖 `completeness` 判定与探针的 `override` 模式（[判定引擎](reviewer.md#design-5-6) ① 层）。

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

### 用户规则的两个来源

本节的自然语言“用户规则”统一称为[审查指引](terminology.md#core-terms)，供模型理解风险与授权上下文；它们不直接修改判定引擎中的审查判定规则和阈值。`CUSTOM_RULES`、`PROJECT_RULES` 暂保留原稿字段名。

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

**为什么用 `.md` 而不是 `.yaml`**：内容是自然语言规则（"特别关注 .env 泄露"、"这个项目的生产目录是 /srv/app"），不是结构化配置。

**冲突处理**：两者同时注入，不做覆盖。prompt 里写明：

```
When CUSTOM_RULES and PROJECT_RULES disagree, PROJECT_RULES wins: it is scoped
to this workspace and is the more specific instruction.
```

**位置与缓存**：`CUSTOM_RULES` 是全局且很少变，放进 **system 段**（稳定前缀，利于 KV cache）；`PROJECT_RULES` 随工作区变，放进 **user 段**（[O9](decisions-and-questions.md#question-o9)）。

**读取实现**：

```js
// PROJECT_RULES：按顺序找第一个存在的文件，读入并截断到 2000 字符
const candidates = [".dsh/arbiter.md", ".arbiter.md"].map(p => join(workspaceRoot, p));
const projectRules = firstExisting(candidates);   // 缺失 → null
```

`firstExisting` 只读文件，不监视变更；工作区切换时重新读。

<a id="design-5-2-3-2"></a>

### `EVIDENCE` 的结构

三类消息合并成一条按时间从新到旧的流。**role 表示消息角色，evidence 表示来源所能支持的授权上限**；来源标记还需保留消息来自本会话、父会话人类还是父 agent 转述。下面的 source 字段为表达这一要求的 Schema 建议：

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
3. **只采纳可识别的人类原始输入**——父会话的普通工具结果、文件内容不作为授权注入；ask 工具若通过专用事件保存真实人类答复，应在验证事件来源后按上述规则提取，不把整个工具结果视为用户授权。

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

**注意**：截断的是历史的 tool call，**当前待审动作的命令不截断**（它是判定对象本身）。

**checkpoint**：会话被 compaction 后的摘要。独立上限 **3 条**（最近 3 次压缩的摘要），不占 tool call 的额度。`role: "checkpoint"` 提示 reviewer 这是有损摘要。

**为什么保留 checkpoint**：不保留的话，长会话后期 reviewer 会完全失去早期上下文（"这个任务怎么来的"）。

**为什么不照搬官方的 `FILTERED_HISTORY`**：官方那段是"过滤后的完整事件上下文"，含 tool call 与按角色标签的消息。我们的方案把消息移到了 `EVIDENCE`（因为需要授权强度标签），只留 tool call 与 checkpoint，职责更窄也更清晰。

<a id="design-5-2-4"></a>

## 先前裁决（prior verdicts）

审查者需要知道"这个动作之前被怎么判过"——这是识别**重试**与**换写法绕过**的唯一来源。

**来源**：本插件自己写的会话记录 `plugin:arbiter/decision`（[两个写入点](configuration-and-audit.md#design-9-1)），用 `pluginRecordOf(event)` 扫当前会话读回。

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
   · cd 目标可词法解析 → 更新当前目录；不可解析 → partial
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

- 不进入 allow（已由 `completeness = partial` 覆盖）；
- 审查者看到该标记，知道"可能比字面更危险"。

### 代价

`rm -rf $BUILD_DIR`（变量来自会话外部）会一直是 `partial` → 不自动 allow → 交给 reviewer 判 → 大概率 ask。这个代价可接受：

1. 高频场景已进规则表短路，到不了这里；
2. `partial` 只是取消"自动 allow 资格"，不是取消审查；
3. "我不知道这个变量是什么"本身就是合理的询问理由。


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

**截断的优先级**（固定段超预算时，按此顺序牺牲）：

```
1. DERIVED_FACTS         （可降级为 completeness: partial）
2. PROJECT_RULES         （项目规则，可缺）
3. PENDING_ACTION        ← 永不截断（判定对象本身）
4. system / CUSTOM_RULES ← 永不截断（模型的固定策略说明与用户审查指引）
```

**`PENDING_ACTION` 永不截断**：如果连命令本身都放不下（超长 heredoc 之类），应该**直接 ask** 而不是硬塞——审查者看不到完整命令就无法负责。

### 硬兜底

组装完成后对最终文本再估算一次：

```js
if (estimateTokenCount(finalText) > maxInputTokens) {
  // 从尾部（动态段）逐条丢弃直到 under budget
  // 若只剩固定段仍超限 → 直接 ask（不审查）
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
