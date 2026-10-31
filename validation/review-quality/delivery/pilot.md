# B. 核心试点结果

所属：[#87](https://github.com/Yuee98/dsh-arbiter/issues/87)。返回 [交付报告索引](README.md)。

**本文件不重复 [RQ-15 试点报告](../calibration/report.md) 的数字。** 它只回答一个问题：S1 试点让本阶段**知道了什么**，以及这些结论如何被本阶段的工程基线吸收。

> 原始证据（逐格 R/A、混淆表、分母、用量、复现命令）一律以 [calibration/report.md](../calibration/report.md) 与 [call-log.md](../calibration/call-log.md) 为准。任何本文件与报告的不一致，以报告为准。

---

## 1. 试点是什么（范围，不重复数字）

| 项 | 内容 | 出处 |
| --- | --- | --- |
| 交付物 | **S1 试点**：六个已决定 target × `core-v1` dev 案例 × A/B 两臂 | [report §0](../calibration/report.md) |
| 性质 | **不是** RQ-15 的完整交付，**不是** 保留集验证，**不是** milestone 的质量验收 | [report §0](../calibration/report.md)、§9 |
| 原始记录状态 | `call-log.md` 摘要存留；**运行产物已丢失**（详见 [C 类](limitations.md) 的 B6） | [normalization-boundary.md §4](../normalization-boundary.md) |
| 费用 | 全部 `not-computed`／`unknown`；未取 provider 账单 | [report §5.3](../calibration/report.md) |

---

## 2. 试点让本阶段确认的四条结论

这四条是**本阶段可据以行动**的结论，不是准确率数字：

### 2.1 「候选 B 不采用」已裁决，依据是「对照无法建立」而非「B 质量更差」

decision 端点以 422 拒绝了候选 B 的探针问题类型（缺 `criteria`），因此 B 侧在 decision 协议上根本没有可比较的读数。用户的裁决是 decision 与 chat **统一采用无探针（候选 A）**。

- 裁决记录：[report §7.4](../calibration/report.md)
- 基线固化：[decision-record.md §1](../decision-record.md)
- **措辞边界**：这是「经评估后不采用」，**不是**「B 失败」；报告 §7.4 与 §9 都在这一点上做了显式区分。

### 2.2 本阶段默认基线已固定，且该固定没有改动任何评分语义

默认基线 = 无探针候选 A + 现行 100 格共同矩阵 + 现行 N0 + `review-rubric-v1` + `core-v1` 的 51 条用户标签，代码版本 `366f73d`。

- 完整记录（含每个维度的版本标识与出处）：[decision-record.md](../decision-record.md)
- **关键限定**：这是一次**确认现状**的决定，不是「该基线质量达标」。`decision-record.md` 开头即写明「它不是质量结论」。
- 矩阵本身在试点后**未被调整**：没有任何概率阈值、风险上限或后端分支被重新引入，`policy` 配置段仍只有 `version`（`src/config/policy.ts:58`）。

### 2.3 唯一被试点直接推动的**代码**改动是归一化边界，且它只放宽了一侧

试点发现本地 Clef 的十档之和落在容差边界，判决受浮点累加影响。RQ-16 已修复：比较改为精确十进制整数运算，容差数值 `1e-4` **未变**，「恰好等于容差」判为在内。

- 修复记录与 5 份真实捕获的逐份对照：[normalization-boundary.md](../normalization-boundary.md)
- 实现：`src/review-contract/normalize.ts:87`（`withinSumTolerance`）
- 回归：`tests/review-contract/saved-response-boundary.test.ts`（5 tests）
- **边界**：5 份捕获里只有 1 份改判，方向是「拒绝 → 接受」；试点第 6 个未评分格的十进制度和本身超差（`1.0002`），该修复**不覆盖它**（[limitations.md](limitations.md) 的 B8）。

### 2.4 生产与 evals 走同一条管线，这一点由试点暴露、由 parity 核对固定

试点的三处接线阻塞（空凭据引用、headless 无 LLM 服务、plan 无法表达候选）修复后，生产与 evals 才第一次共用 `reviewWith(pkg)` 与**同一个** `PRODUCTION_PACKAGE` 对象（同一性断言，不是相等）。

- 核对记录：[parity.md](../parity.md)
- 回归：`tests/evals/production-evals-parity.test.ts`

---

## 3. 试点**没有**得出的结论

这一节与 §2 同等重要，且不得省略：

| 未得出的结论 | 为什么 |
| --- | --- |
| 任何候选「获胜」 | 报告的结论先行段落明确拒绝；只有 DeepSeek chat 一个 target 在 A/B 两臂都完整可评 |
| 模型质量达标 | S1 是 10 案例 × 1 repeat，且含已知不可作质量证据的本地网格 |
| 零风险 | `误放 = 0` 只在 49 格上成立，高风险禁止类案例不在 dev 试点范围 |
| 保留集通过 | 保留集验证属移交 C1（#85），本阶段未执行 |
| B 比 A 更贵 | B 的 50 次 422 没有产生已报告用量；把「未报告」读成「零成本」是错的 |
| 阈值／矩阵应调整 | 本阶段不据小样本调整 prompt、量表或矩阵 |

完整清单见 [report §7.2](../calibration/report.md) 与 [report §11](../calibration/report.md)。

---

## 4. 试点结果与工程结果的关系（本报告最重要的一句）

**A 类的工程条件满足，不使 B 类的试点结果变成质量达标。**

具体地：

- A 类证明的是「六项宿主流程在隔离 profile 中按契约运行」；
- B 类证明的是「本阶段有了一份可追溯、可离线重建、结论被如实限定的试点证据」；
- 两者都不证明「模型在新数据上判定准确」。

因此本阶段建议 Milestone #2 按**工程条件**收口，并在完成说明里保留「复杂场景质量与最终模型／阈值选择待后续验证」——这一措辞已写入 Milestone #2 的描述，本报告与其一致。

---

## 5. 复核入口

| 想核对什么 | 去哪 |
| --- | --- |
| 试点的逐格读数、分母、混淆表 | [calibration/report.md §6](../calibration/report.md) |
| 试点的用量与费用口径 | [calibration/report.md §5](../calibration/report.md) |
| 每次调用的上下文 | [calibration/call-log.md](../calibration/call-log.md) |
| 基线为什么是这一套 | [decision-record.md](../decision-record.md) |
| 归一化修复的逐份对照 | [normalization-boundary.md](../normalization-boundary.md) |
| 生产／evals 同逻辑 | [parity.md](../parity.md) |
| 工程验收 23 项 | [acceptance-scope.md §A](../acceptance-scope.md) |
