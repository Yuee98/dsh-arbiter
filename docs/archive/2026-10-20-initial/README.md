# dsh-arbiter

> 确定性命令规则 + 校准型决策模型审查，用于 DSH 的审批与权限判定。

本目录是设计阶段的临时工作区，最终会迁移到独立工作区。

**命名**：包 `dsh-arbiter`，插件行 id `arbiter`，数据目录 `$DSH_HOME/arbiter/`，斜杠命令 `/arbiter`。理由见 [design.md](design.md) 开头的"命名理由"。

## 文件

| 文件 | 内容 |
|---|---|
| [design.md](design.md) | 完整需求与设计：规则引擎、判定引擎、reviewer 类型、双模式、勿扰、子 agent、配置、审计、实施阶段、风险、开放问题 |
| [evidence.md](evidence.md) | 所有实测事实的来源清单（源码行号、文档章节、二进制字符串、竞品调研），实现时复核用 |

## 一句话概括

把 Codex 的「命令白名单 + auto-review 授权策略」迁移为 DSH 插件：一个包、两层门禁（tree-sitter 规则短路 → 决策模型审查），通过 `registerAuto` 挂进权限菜单，规则、reviewer 类型与阈值都在插件页配置。

Reviewer 是**二选一的类型**：`decision`（决策模型，`state`+`questions` 协议，Clef/Jev 兼容，给 0–10 概率分布）或 `chat`（任意 `ctx.llm` provider，或 `provider: "session"` 用当前对话模型，给 0–10 点值 + 四个探针）。不做自动回退——所选类型不可用即 fail-closed，用户自己改配置。

判定是**五层确定性引擎**：检查点 → 不变式 → 类别导出 → 推导表 → 概率门。模型只报事实，allow/ask/deny 全部由代码算。

审查只用**无状态单次调用**（不做 reviewer subagent）——审查在工具调用的阻塞路径上，延迟是首要约束。超时 8s、按 turn 熔断、同轮次去重；审查次数默认不设上限。

授权延续分三层（§5.10）：同轮次去重 → 用户提名写规则 → **离线**日志分析生成候选（人不审不进配置）。不做会话 grant、不做在线学习——"被批准"不等于"安全"。

## 状态

设计稿完成，尚未开始实现。§16 有 10 个开放问题待定：

- **影响架构**：O1（子 agent 授权冒泡）
- **影响实现方式**：O8（配置 UI vs 文件一致性）、O3（规则表 vs 项目级规则文件）
- **影响成本与质量**：O9（prompt 前缀缓存）、O10（prompt 结构与长度预算）、O7（i18n）
- **影响细节默认值**：O2、O4、O5、O6

待评审后按 `design.md` §12 的 P0–P9 推进。

## 生态定位

三个主流竞品（`dsh-perm-gate` 12.4k/月、`dsh-auto-review` 7.6k、`dsh-permission-rules` 7.4k）覆盖了"规则 + 审查"的骨架。**`dsh-perm-gate` 是架构最接近的一个**（同样 pre-execute 门禁 + 分级判定 + 权限档），但它的分级是规则/关键词/二值分类，不是概率判定；且在 `pre-execute` 队首、权限档注册、升权应答三处与本设计冲突，**不能共存**（§2.2）。

本项目差异化：短路 allow、决策模型概率门、DND 双档、子 agent 完整处理、离线候选学习、AST 事实完整性闸门——六项均无竞品实现（evidence §14）。

## 阅读顺序

1. `design.md` §1–§3：为什么做、结论、总体架构
2. `design.md` §5.2–§5.6：审查者形态、事实闸门、三种后端契约、五层判定引擎（核心）
2b. `design.md` §5.10：授权延续与学习的三层设计（含为什么不做 grant/在线学习）
3. `design.md` §5.6.1：子 agent（智能体团队）的 never 场景处理
4. `design.md` §6：勿扰的两档态度（strict / progress）
5. `design.md` §10–§11：取舍与风险，尤其 §11.1 的第 5 条（凭证外泄铁律被放宽）
6. `design.md` §15–§16：被推翻的决策与开放问题（O1 子 agent 授权冒泡）
7. `evidence.md` §12–§14：Codex Guardian 实现、子 agent never 证据、竞品调研
8. `evidence.md` 其余章节：其他结论的出处
