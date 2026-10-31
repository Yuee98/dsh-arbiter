# RQ-19 Milestone 交付报告

所属：[RQ-19](https://github.com/Yuee98/dsh-arbiter/issues/87)（#87），Parent [#64](https://github.com/Yuee98/dsh-arbiter/issues/64)，Milestone [#2](https://github.com/Yuee98/dsh-arbiter/milestone/2)。
代码基线：`569f1ee`（`main`，PR [#114](https://github.com/Yuee98/dsh-arbiter/pull/114)）。本报告在 `feat/review-quality-rq19-acceptance` 上记录。
前序输入：[基线决定](../decision-record.md)、[工程验收范围](../acceptance-scope.md)、[RQ-15 试点报告](../calibration/report.md)、[归一化边界](../normalization-boundary.md)、[RQ-16 验证记录](../verification.md)。

**本报告是 Milestone #2 的收口记录，不是公开发布说明，也不是质量达标声明。**

---

## 四类分列（先读这一节）

Issue #87 的验收条件是「四类不得混写」。本报告因此拆成四个文件，每一类只回答自己的问题：

| 类别 | 文件 | 回答的问题 | 状态口径 |
| --- | --- | --- | --- |
| **A. 工程结果** | [engineering.md](engineering.md) | 六项宿主流程是否在隔离 profile 中真实跑通，证据在哪 | `passed`／`blocked（环境）`／`not-run`，逐项附命令与日志 |
| **B. 核心试点结果** | [pilot.md](pilot.md) | S1 试点让本阶段知道了什么，结论是什么 | 只引用 [calibration/report.md](../calibration/report.md)，不重复其数字 |
| **C. 已知限制** | [limitations.md](limitations.md) | 哪些质量问题仍未解决，边界在哪 | 引用 [acceptance-scope.md §B](../acceptance-scope.md) 的 8 项，逐项给现状 |
| **D. 后续移交项** | [handover.md](handover.md) | 哪些工作不在本阶段，接管条件是什么 | 引用 [acceptance-scope.md §C](../acceptance-scope.md) 的 6 项，含 #85 |

**四类之间的关系，一句话**：A 通过不使 B 变成质量达标；B 的试点结论不消除 C；C 的存在不阻塞 D 的移交；D 的移交不把任何未执行项改写成已通过。

> **工程条件满足 ≠ 质量达标。** 本报告的 `passed` 一律指「实现与行为测试存在、且本机实际执行过」，不指「模型判定准确」「矩阵阈值已冻结」或「保留集已验证」。后三者在 C、D 两类里，状态是 `not-run`。

---

## 一句话结论

**本阶段的工程条件满足，可以建议 Milestone #2 整体收口；质量达标不属于本阶段条件，也未被本阶段证明。**

具体到 A 类：六项宿主流程都有真实执行证据（`54 passed / 5 failed` 于 59 个真实 DSH 用例，其中 5 个失败全部为环境性且与未修改的 `main` 一致或为其子集）；`pnpm verify` 除 `check:build` 一项因本机 pnpm store 不可写而 `blocked（环境）` 外全部通过。

---

## 本阶段新增的工程发现（收口过程中产生，非试点结论）

这三条不属于 A/B/C/D 任何一类的「已通过」证据，但影响后续判断，单列于此：

| # | 发现 | 影响 |
| --- | --- | --- |
| F1 | **E2E 的 12 个失败里有 7 个不是「本机环境不可修」，而是没按 `docs/development-baseline.md` 跑固定 DSH 运行时** | 按基线执行 `npm ci --prefix tests/e2e/runtime` 后，`gate-real`、`history-recovery`、`context-sources`、`agent-guidance` 的 7 个用例立即转为通过。**这意味着此前「失败集与 main 逐条相同」的结论虽然成立，但把可修的配置缺失算进了「环境阻塞」**。详见 [engineering.md §3.2](engineering.md) |
| F2 | `check:build` 的 `ERR_SQLITE_ERROR` 已定位到具体条件：**`CI=true` 时 pnpm 需要写共享 store 的 SQLite 索引，而 store 位于 checkout 之外、本 checkout 不可写** | 不是随机故障，也不是本次改动引起。设 `CI=false` 时同一命令成功。CI 上通过是因为 runner 的 store 可写。详见 [engineering.md §2.2](engineering.md) |
| F3 | 剩余 5 个 E2E 失败中，**`locale-surfaces` 的 `reviewedCallId` 类型断言**与 `main` 上同样失败，且与本次改动无关；其余 4 个由 `sandbox-exec` 不可用或由此派生的写入缺失引起 | 记录为 `blocked（环境）`，不写成 passed，也不引用 CI 通过代替本机记录。详见 [engineering.md §3.3](engineering.md) |

---

## 范围与边界（与 issue 非目标一致）

- 不冻结模型质量数值线（属移交 D1）。
- 不根据 S1 小样本调整评分提示、量表或矩阵（属 C1、C2）。
- 不新增旧兼容、后端专属门、风险上限或模式转换。
- 不以未知／未执行证据声明通过；本机未执行的项目一律写 `blocked（环境）` 或 `not-run`。
- 不执行真实付费模型调用；本报告的 E2E 全部使用确定性 reviewer 桩，不发送模型请求。
- 不关闭 #64 与 Milestone #2 —— 由用户确认。
