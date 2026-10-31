# C. 已知限制

所属：[#87](https://github.com/Yuee98/dsh-arbiter/issues/87)。返回 [交付报告索引](README.md)。

**本文件引用 [acceptance-scope.md §B](../acceptance-scope.md) 的 8 项，不新增、不删减、不改写其性质。**
每一项补充的是「进入交付时的现状」：到本报告写作时它是否被处理、边界是否变化、证据在哪。

> **C 类不因 A 类通过而消失。** 这些是**未解决的质量与工程债务**，本阶段的基线确认（[decision-record.md](../decision-record.md)）不撤销它们，A 类的宿主验收也不覆盖它们。

---

## 0. 状态总览

| # | 问题 | 进入交付时的状态 | 本阶段是否处理 |
| --- | --- | --- | --- |
| B1 | authorization 系统性低估 −0.98 档 | **未修复** | 否（不据小样本调 prompt／矩阵） |
| B2 | risk 在 2→3 边界高估 | **未修复，且未分离成因** | 否（分离需矩阵门槛实验，工具刻意不支持） |
| B3 | 配对命中率 24.5% | **未修复；具名清单不可得** | 否（依赖已丢失的运行产物） |
| B4 | 样本量不足（10 案例 × 1 repeat） | **未扩大** | 否（属移交 D1／D3） |
| B5 | 误放 0 不覆盖高风险禁止类 | **未覆盖** | 否（案例在 calibration/holdout） |
| B6 | 试点原始运行记录已丢失 | **未重建，且本阶段确认仍不可得** | 否（重建需新的付费调用，未授权） |
| B7 | `promptFingerprint` 无法从 masked attempt 重算 | **未修复；已由测试固定为设计边界** | 否 |
| B8 | 本地 Clef 的 1 个格子在容差修复后仍失败 | **未重放** | 否（依赖 B6） |

---

## 1. 三项特别列明（issue 要求）

### 1.1 B6：试点原始运行记录已丢失，仅存 `call-log.md` 摘要

| 项 | 内容 |
| --- | --- |
| 事实 | 运行产物原在 `rq-15` worktree 的 ignored `.local/evals/runs/core-v1/pilot-a`，该 worktree 已被移除 |
| 本阶段复核 | [acceptance-scope.md §B6](../acceptance-scope.md) 记录：本机主 checkout 与 `rq-h2` worktree 的 `.local/evals/runs/` **均不存在**，全盘搜索 `pilot-a` 目录 **0 命中** |
| **本次交付复核** | `rq-19` checkout 的 `.local/evals/` 同样不存在（本 checkout 为全新）。`validation/review-quality/calibration/` 下只有 `report.md` 与 `call-log.md`，**没有任何运行目录** |
| 后果 | 报告里的**逐格 R/A**、B3 的**具名配对清单**、**B 臂矛盾**都无法复核；B8 的那一格无法重放 |
| 为什么记为 `not-run` 而不是估算 | 重建需要重新派发真实调用；那是新的付费调用，**未授权**。用推算补出来的数字会伪装成证据 |
| 相关证据 | [normalization-boundary.md §4](../normalization-boundary.md)、[report §0](../calibration/report.md) |

**这一项在 Milestone 收口后仍然存在。** 它不阻塞工程条件，但意味着「试点报告的数字」在交付后只能作为**已记录的历史读数**被引用，不能作为可重新计算的产物。

### 1.2 B1：authorization 低估 −0.98 未修复

| 项 | 内容 |
| --- | --- |
| 事实 | authorization 系统性低估近一档（平均偏差 −0.98，平均绝对偏差 1.469，19/49 格相差两档以上）；排除本地两 target 后 36 格仍为 −0.889，方向与量级保留 |
| 为什么它是最稳的信号 | 六个 target 上都出现、方向一致；不是本地服务独有 |
| 因果链的状态 | **未经证明**。它解释了 10 次「不必要人工」里的 3 次、参与解释另外 3 次，**不是全部原因** |
| **是否修复** | **否。** 本阶段**不据此调整 prompt、量表或矩阵** |
| 客户可见影响 | 表现为「本来已经授权的操作被要求人工确认」——方向是**更保守**，不是更危险；但仍消耗用户注意力 |
| 证据 | [report §6 第二层](../calibration/report.md)、[acceptance-scope.md §B1](../acceptance-scope.md) |

**为什么本阶段不修**：能修它的手段（改授权量表的锚点、改 prompt 措辞、放宽矩阵）都属于「根据 10 个案例的小样本改评分语义」，而这正是 issue 非目标里排除的做法。修复需要更大的样本，属移交 D1／D3。

### 1.3 E2E 测试残留未清理：主库 5 行 + `backup-v2` 1 行

| 项 | 内容 |
| --- | --- |
| 事实 | `~/.dsh/arbiter/arbiter.db` 含 **5 行**当前格式数据（E2E 测试残留：`c3`/`c5`/`c7`/`gate-1`/`gate-2`，2026-10-27/28）；`arbiter.db.backup-v2` 含 **1 行**当前格式数据 |
| 为什么保留 | RQ-18 的重置工具把它判为 `REFUSE`——工具**正确区分**「旧测试数据」与「当前契约产生的数据」，不无差别清空 |
| 执行记录 | [issue #86 的执行记录](https://github.com/Yuee98/dsh-arbiter/issues/86)（2026-10-31）：`backup-v1`（768 行、纯旧结构）已删除；这两处按工具判定保留 |
| **是否清理** | **否。** 彻底清理需先删除这些行再跑整库重置，属**直接改数据库**，RQ-18 明确未执行 |
| 影响 | 主库与备份库各留少量 E2E 残留行；不影响新记录写入、冷恢复或旧历史不回灌（RQ-18 已各自验证：新库可读、`user_version = 2`、`integrity_check ok`） |
| 归属 | 未开独立 issue；属「已知残留，按进度优先未处理」 |

**这不是「数据不一致」或「迁移未完成」**：保留的行是当前格式的合法记录，只是内容来自 E2E 而非真实使用。删除它们是数据卫生问题，不是契约问题。

---

## 2. 其余五项（引用原清单，补充交付时的现状）

### B2：risk 在 2→3 边界高估

`unrequested-config-reformat` 稳定多给一档（4/4 次）。这是 10 次不必要人工里唯一完全由 risk 造成的部分。

**「是模型高估还是 A8 门槛偏严」未分离**，且分离它需要的矩阵门槛实验**现有回放工具刻意不支持**（`evals/README.md:162` 记录该轴不是回放轴）。本阶段不动矩阵。

证据：[report §6.4](../calibration/report.md)、[report §8 争议 2](../calibration/report.md)、[acceptance-scope.md §B2](../acceptance-scope.md)。

### B3：配对命中率 24.5%（12/49）

落进人类允许配对的格子只有 12 个，其余 23 格「行为对但配对错」。12 格是行为一致 35 格的子集。

**具名例证已在报告勘误中撤回**（早期版本曾用具名反例支持该结论）；具名清单只能从**已丢失**的运行产物导出（见 B6），本报告给不出。

证据：[report §6 第一层与第二层](../calibration/report.md)、[acceptance-scope.md §B3](../acceptance-scope.md)。

### B5：误放 0 不覆盖高风险禁止类

`误放 = 0/49` 仅成立于小子集。dev 10 案例里只有 2 条参考为 `deny`（都是低到中风险禁止类）；真正的高风险误放场景（`prohibited-billing-wipe` R9、`injection-in-project-rules` R8）在 calibration／holdout，**未进 dev 试点**。

**零误放是「这个小子集上没观察到」，不是能力证明。** 这一条在交付时必须与任何「零误放」引用同时出现。

证据：[report §6 第一层](../calibration/report.md)、[report §11](../calibration/report.md)、[acceptance-scope.md §B5](../acceptance-scope.md)。

### B7：`promptFingerprint` 无法从 masked attempt 重算

`CellMaterial.promptFingerprint` 是**渲染后请求**的摘要；attempt 里的 `request` 已过 `maskAttempt`，chat 提示的 `<integer 1-10>` 占位符被当成 auth header 值遮蔽。

- **不影响分数、判定或 provider 侧行为**（`stream` 收到的字节完好）
- 已被 `tests/evals/production-evals-parity.test.ts` 的 *the masked attempt is not a fingerprint source, by design* 断言**固定为设计边界**
- 可追溯性另由「从 `snapshots.content` 重算」补足（[parity.md §5.1](../parity.md)）
- **但生产不持久化 `promptFingerprint`，也不记录 `REVIEW_PROMPT_VERSION`**

证据：[parity.md §5](../parity.md)、[verification.md §3](../verification.md)、[acceptance-scope.md §B7](../acceptance-scope.md)。

### B8：本地 Clef 的 1 个格子在容差修复后仍失败

`sample-log-upload-authorized~clef-flash-local` 的风险十进制和为 **`1.0002`**，十进制本身超差。

**这一例与归一化边界修复无关**：修复只把「恰好等于 `1e-4`」判为在内，容差数值仍是 `1e-4`。它与另外 5 例（4 × `0.9999`、1 × `1.0001`）**不是同一类**，不能合并成「本地 Clef 的 6 例已修复」。

原运行记录已丢失（B6），本阶段未重放该格。

证据：[report §3.1](../calibration/report.md)、[normalization-boundary.md §4](../normalization-boundary.md)、[acceptance-scope.md §B8](../acceptance-scope.md)。

---

## 2.1 记录口径纠正：把「配置缺失」误归入「环境阻塞」

**这一条是对历史记录口径的纠正，不是对历史证据的改写。**

此前若干任务（如 [RQ-16 验证记录](../verification.md) §2）把 `pnpm test:e2e:dsh` 的失败整体归入「环境阻塞」，理由是「失败集与未修改的 `main` 逐条相同」。**该理由成立**——本报告 §A 也复核了同样的事实（12 vs 12，双向无差异）。

但收口过程中发现：那 12 个失败里**有 7 个不是本机环境不可修**，而是 **checkout 没有按 `docs/development-baseline.md:106` 安装固定 DSH 运行时**。这些用例在**解析宿主入口时**就抛出 `DSH_E2E_CLI must point at the host entry for this test.`，根本没有进入断言。

按基线执行后（同一命令、同一 checkout）：

```sh
npm ci --prefix tests/e2e/runtime --strict-allow-scripts --no-audit --no-fund
DSH_E2E_CLI="$PWD/tests/e2e/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" \
DSH_E2E_VERSION="$(node -p 'require("./tests/e2e/runtime/package.json").dependencies["@deepseek-ai/dsh"]')" \
pnpm exec playwright test
```

**7 个此类失败转为通过，真实环境阻塞为 5 个**（54 passed / 5 failed）。

| 口径 | 失败数 | 构成 |
| --- | --- | --- |
| 按 issue 原样执行（未装固定运行时） | 12 | 7 个宿主入口解析失败 + 5 个真实环境阻塞 |
| 按 `development-baseline` 前置条件执行 | 5 | 全部由 `sandbox-exec` 不可用或其派生写入缺失引起，另有 1 条与 `main` 同因失败、1 条与 `main` 同因超时 |

**处理方式**：

- **历史记录保持原样，未改写。** `verification.md` 是 #84 当时的执行记录，改写它等于篡改历史证据。
- 该纠正记录于本文件与 [engineering.md §3.2](engineering.md)，并在 [README](README.md) 的 F1 中单列。
- 后续任务引用「E2E 环境阻塞」时应使用本节的 12／5 拆分，而不是笼统的「12 个环境阻塞」。

**为什么这不改变本报告的结论**：本报告的 A 类**两个数字都记录**，且 5 个残余失败仍记为 `blocked（环境）`、不写成 passed。纠正的是**归因**，不是**状态**。

---

## 3. 本阶段新增的已知限制（工程侧，不属 B 类质量问题）

这三条来自本报告的 [A 类](engineering.md) 执行过程，是**记录方式的限制**，不是产品缺陷：

| # | 限制 | 影响 | 处理 |
| --- | --- | --- | --- |
| E1 | `check:build` 在本机 `blocked（环境）`：pnpm store 在 checkout 外且不可写 | 本机无法验证打包消费者的完整链路 | 记录为 `blocked（环境）`，不以 CI 通过代替；复现条件见 [engineering.md §2.2](engineering.md) |
| E2 | 完整 E2E 在本机 `blocked（环境）`：`sandbox-exec` 不可用导致 5 个用例无法完成 | 「allow 之后真正写文件」这一路径本机不可验 | 记录为 `blocked（环境）`；根因与逐条原因见 [engineering.md §3.3](engineering.md) |
| E3 | `review-cancelled` 只有集成层证据，**没有真实宿主 E2E** | 「审查在途被取消」的真实时序本机未构造 | 记为「集成层 passed、真实宿主 not-run」，见 [engineering.md §1.6](engineering.md) |

**E1–E3 不改变 B 类的性质，也不被 B 类吸收。** 它们是「本机没能验证」的记录，不是「产品有问题」的记录；两者在本报告里始终分开。

---

## 4. 这些限制不撤销的结论

- 本阶段基线（候选 A、现行矩阵、现行 N0、`review-rubric-v1`、`core-v1` 标签）仍是默认，直到有新的窗口决定。
- Milestone #2 可以按**工程条件**收口（[README](README.md)）；收口不表示 B 类被解决。
- 关闭 #64 与 Milestone #2 由用户确认；本报告不做该判定，也不代表质量达标。
