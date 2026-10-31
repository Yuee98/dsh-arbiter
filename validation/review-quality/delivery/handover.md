# D. 后续移交项

所属：[#87](https://github.com/Yuee98/dsh-arbiter/issues/87)。返回 [交付报告索引](README.md)。

**本文件引用 [acceptance-scope.md §C](../acceptance-scope.md) 的 6 项，全部保持原编号与内容。**
本阶段**没有执行任何一项**；每一项的状态一律是 `not-run` 或 `未开`，不因 Milestone #2 收口而改变。

---

## 0. 移交总表

| # | 移交项 | 状态 | 对应 issue | 为什么不在本阶段 |
| --- | --- | --- | --- | --- |
| C1 | **保留集验证** | `未开` | [#85](https://github.com/Yuee98/dsh-arbiter/issues/85)（RQ-17）— **已移出 Milestone #2，保持 OPEN** | 需要事前冻结的验收数值线，本阶段按 2026-10-31 范围调整**不冻结质量数值线** |
| C2 | **C1–C4 消融对照** | `未开` | 无 issue | 每轴需要新的 run plan 与新一轮真实调用；S1 只覆盖 prompt 一轴 |
| C3 | **S2 全量** | `未开` | 无 issue | S1 的 10 案例 × 1 repeat 不足以分离模型方差与系统差异（[C 类 B4](limitations.md)） |
| C4 | **cold／warm 缓存对照** | `未开` | 无 issue | S1 没有该工作负载；属 RQ-14 的 cache 序列 |
| C5 | **阈值回放实验** | `未开` | 无 issue | 需要可读的保存运行目录——**当前本机不存在**（[C 类 B6](limitations.md)） |
| C6 | **费用证据**（provider 账单） | `未开` | 无 issue（B02） | 运行器不代币定价，需 provider 账户账单或可信 rate card |

---

## 1. C1：保留集验证（#85）— 本 milestone 的关键移交

**这是本 stage 唯一有独立 issue 的移交项，也是 issue #87 明确要求单列的一项。**

| 项 | 内容 |
| --- | --- |
| 目标 | 在未参与逐例调参的家族上给出**通过／未通过**结论，含真实 SHA／数据／prompt hash 与成本证据 |
| 为什么移出 | 2026-10-31 的范围调整移除了「最终候选有按预定标准验证的真实结果」这一依赖；#87 的验收条件改为**工程条件**（注意：工程条件本身仍有本机环境阻断项，见 [A 类未执行项](engineering.md#4-未执行项)，那属 #87 而非本移交项） |
| issue 状态 | [#85](https://github.com/Yuee98/dsh-arbiter/issues/85) **保持 OPEN**，已移出 Milestone #2 |
| 本阶段是否提供部分证据 | 提供**基线**（[decision-record.md](../decision-record.md)）与**工具**（回放、三层报告、run plan），**不提供结论** |

**接管条件（5 条，全部满足才能开）**：

1. dev 全 13 条跑完（S1 只用了 10 条）；
2. 高风险禁止类（`prohibited-billing-wipe` R9、`injection-in-project-rules` R8）进运行范围；
3. **至少 2 repeats**；
4. `full.json` 对齐六 target：移除 `workbuddy-glm-5-3-flash`、两个本地 target 的 `credentialRef` 改为空字符串；
5. 派发前按 [resource-decision.md §3.3.4](../resource-decision.md) 记录「硬上限 + 自动关闭充值」或「逐次余额核对授权」。

> 条件 4 的具体依据是 [report §10.1.3](../calibration/report.md)：`full.json` 与本次实际范围**不一致**，当前**不是可直接运行的后继计划**。

---

## 2. C2：C1–C4 消融对照

prompt／结构／历史／量表四轴各自单独移动。S1 只覆盖 A/B 一轴（prompt）。

**接管条件**：先有独立预算与冻结计划。其余三轴已在 `src/reviewer/variant.ts` 有取值——结构 `full`／`compact`／`compact-no-audit`、历史 `current-turn`／`none`、量表 `complete`／`labels`——但**从未派发**；三轴的取值与身份由 `tests/reviewer-variant.test.ts`（40 tests）固定。

**状态**：`未开`（无 issue）。

---

## 3. C3：S2 全量

更大的数据集、多 repeat。

**接管条件**：

1. 冻结 S2 计划并重算 `planHash`；
2. dev 13 条 + 至少 2 repeats；
3. 预算与货币前置（同 C1 条件 5）；
4. B3 的具名配对清单若要复核，需先决定是否重建已丢失的运行记录（[C 类 B6](limitations.md)）。

**状态**：`未开`。输入文件 `evals/experiments/run-plans/full.json` 存在但**不一致**（[report §10.1.3](../calibration/report.md)），当前**不可直接运行**。

---

## 4. C4：cold／warm 缓存对照

S1 没有该工作负载；属 RQ-14 的 cache 序列。

**接管条件**：需要能表达缓存工作负载的计划与一次真实对照；`review-usage-v1` 需先覆盖全部缓存字段（当前 `cacheWriteTokens` 未报，[report §5.4](../calibration/report.md)）。

**状态**：`未开`。`evals/experiments/rq14-matrix.json` 已含 6 candidates／312 cells／5 cache requests，但**未派发**。

---

## 5. C5：阈值回放实验

同一份保存响应换 `strict`／`at-least` 重算（N0 边界）。

**接管条件**：

1. 需要可读的保存运行目录——**当前本机不存在**（[C 类 B6](limitations.md)），因此该实验必须先重建或重新生成运行产物；
2. 输出是阈值建议，属产品语义变更，需新窗口裁决。

**状态**：`未开`。工具有该轴（`evals/src/replay/variants.ts`），但 S1 只跑过生产默认值（risk `strict`／auth `at-least`）。

**一个必须同时说明的边界**：**矩阵门槛实验**（改 `requiredAuthorizationFor` 分段）是**现有工具刻意不支持**的——`evals/README.md:162` 写明「共同矩阵不是轴」。这与「C5 没跑」是两件不同的事：前者是**能力不支持**，后者是**未执行**。

---

## 6. C6：费用证据

provider 账户账单。

| 项 | 值 |
| --- | --- |
| 现状 | 运行器不代币定价，S1 的 120/120 格 `cost.status` 全为 `not-computed`，货币金额 `unknown`（[report §5.3](../calibration/report.md)） |
| 接管条件 | 需 provider 账户账单或可信 rate card；接管方读完账单后按实测 token 计价，**不得用估算替代**（§5.3 已明确拒绝该做法） |
| 状态 | `未开`（B02） |
| 意义 | 该项是 [RQ-15 报告 §9](../calibration/report.md) 的 AC1 **唯一剩余未满足项** |

---

## 7. 依赖关系与顺序

`acceptance-scope.md §C.x` 给出的顺序仍然有效：

```text
本阶段基线（已确认，acceptance-scope §A）
   └─ C1（#85 保留集验证）  ← 接管条件 ①–⑤ 全部满足才能开
         ├─ C3（S2 全量）     ← 与 C1 共享「dev 13 条 + 2 repeats + 预算前置」
         ├─ C4（cold/warm）   ← 依赖 C3 的运行产物
         └─ C5（阈值回放）    ← 依赖可读的保存运行目录（B6）
   └─ C2（C1–C4 消融）      ← 独立预算，可与 C1 并行但不得用保留集调参
   └─ C6（费用证据）        ← 独立于运行；任何时候都可补，且补完才能说 AC1 完整
```

**本阶段新增的一条约束**：C5 与 C3 都依赖「可读的保存运行目录」。B6 使这个前提**当前不成立**，因此这两项的接管条件里都隐含「先解决运行产物的可获得性」。这不改变它们各自的验收口径，只是接管方需要先读 B6。

---

## 8. 移交不改变的事项

逐条沿用 [acceptance-scope.md §C.y](../acceptance-scope.md)：

- 移交**不**把未执行项改写成已通过。C1–C6 的状态一律是 `not-run` 或 `未开`。
- 移交**不**解除本阶段基线：候选 A、现行矩阵、现行 N0、`review-rubric-v1` 仍是默认，直到有新的窗口决定。
- 移交**不**授权新的付费调用；任何真实运行仍需按 C1 条件 5 的货币前置单独授权。
- 移交**不**改变父任务与 milestone 的关闭状态。

---

## 9. 本阶段的另外两项：不是移交，是已完成的工程任务

`acceptance-scope.md §C.x` 末尾写明「#86 与 #87 不属移交」。到本报告写作时：

| issue | 状态 | 说明 |
| --- | --- | --- |
| [#86](https://github.com/Yuee98/dsh-arbiter/issues/86)（RQ-18，数据重置） | **CLOSED（completed，2026-10-31T09:42Z）** | 执行记录见 issue comment；残留项见 [C 类 §1.3](limitations.md) |
| [#87](https://github.com/Yuee98/dsh-arbiter/issues/87)（RQ-19，本报告） | 由本 PR 交付 | 工程验收见 [A 类](engineering.md) |

这两项的完成**不吸收** C1–C6 任何一项，也不把 C 类的 8 项标记为已解决。
