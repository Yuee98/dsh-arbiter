# RQ-16 验证记录（#84）

日期：2026-10-31。checkout：`.local/worktrees/rq-16`，分支 `feat/review-quality-rq16-baseline`，
基线 `97ea56c`。本文件记录实际执行的检查及其状态；未执行的写 `not-run`，不折算成通过。

## 1. `pnpm verify`

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| `check:peers` | passed | `.local/verify.log:2` |
| `typecheck` | passed | `.local/verify.log:4` |
| `lint`（code + testing-library） | passed | `.local/verify.log:5-7` |
| `format:check` | passed | `.local/verify.log:8-11` |
| `check:unused`（knip） | passed | `.local/verify.log:11` |
| `check:dependencies`（depcruise） | passed | `.local/verify.log:12` |
| `check:workflows` | passed | `.local/verify.log:16` |
| `check:i18n` | passed | `.local/verify.log:25-26` |
| `check:evals` | passed | `.local/verify.log:27` |
| `test:unit` | **passed** — 71 files / 1734 tests | `.local/verify.log:176-177` |
| `test:integration` | **passed** — 25 files / 467 tests | `.local/verify.log:253-254` |
| `test:ui` | **passed** — 21 files / 353 tests | `.local/verify.log:329-330` |
| `build` | passed | `.local/verify.log:334-335` |
| `check:build` | **not-run（环境故障）** | `.local/verify.log:646` `[ERR_SQLITE_ERROR] unable to open database file` |
| `check:regressions` | **not-run** | 因前一步失败而未执行；见 §4 |

`check:build` 的失败与本次改动无关：**同一个命令在未修改的 `main`（`97ea56c`）上以同一错误失败**
（`pnpm run check:build` → `Build consumer verification failed`，包体检查本身已先打印
`Published package: no evals source, schema, data or import.`）。原因是 pnpm 的 store index SQLite
在临时 consumer 目录里打不开，属本机环境问题。CI 覆盖该步。

## 2. `pnpm test:e2e:dsh`

**结果：47 passed / 12 failed。** 12 个失败全部是环境性的，并且**与未修改的 `main` 逐条相同**：

```
$ diff <(main 的失败用例列表) <(本分支的失败用例列表)
（无输出 —— IDENTICAL FAILURE SET）
```

| 失败类别 | 数量 | 实测原因 |
| --- | --- | --- |
| `DSH_E2E_CLI must point at the host entry` | 4 | 该用例要求 npm CLI 入口；本机只有已安装的 `dsh` 0.2.1-rc.3，未按 `docs/development-baseline.md` 安装 `tests/e2e/runtime` |
| `sandbox mode "workspace-write" ... no sandbox backend is usable` | 1 | 本机 `sandbox-exec: sandbox_apply: Operation not permitted` |
| `ENOENT .../workspace/*.txt` | 2 | 依赖上面被拒的沙箱写入 |
| `history-recovery` 定位宿主根失败 | 3 | 同上，宿主入口不可用 |
| `locale-surfaces` `reviewedCallId` 类型不符 | 1 | **main 上同样失败**（`Expected: "string"` / `Received: "object"`），非本次改动引入 |
| 其他真实宿主场景 | 1 | 同上 |

**结论**：E2E 在本机为 **blocked（环境）**，不是 passed，也不是本分支的回归。CI 的
`Build, consumer and regressions` 与 `Real DSH smoke` 覆盖该层。

## 3. 本次新增/修改的测试

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| `tests/review-contract/normalize.test.ts` | 新增 18 个边界用例（*the sum tolerance boundary is decimal, not float*） | passed |
| `tests/review-contract/saved-response-boundary.test.ts` | 5 个用例，用保存的 Clef 响应重放边界 | passed |
| `tests/evals/production-evals-parity.test.ts` | 13 个用例：同包、同渲染、同判定，另加 fingerprint 可复算（chat/decision）与 decision 端到端对等 | passed |
| `tests/config.test.ts` | 新增 1 个默认值回归 | passed |
| `tests/client/reviewer-model-picker.test.tsx`、`tests/e2e/plugin-smoke.spec.ts` | 跟随 locale 文案更新 | picker 24 passed；plugin-smoke 属上表环境失败集 |

**证伪验证**（确认测试有区分力，不是恒真）：

| 撤销的改动 | 结果 |
| --- | --- |
| **只回退比较实现**（保留 `withinSumTolerance` 导出，把 `checkProbabilities` 改回「先浮点累加再 `Math.abs`」） | `normalize.test.ts` + `saved-response-boundary.test.ts` 共 **5 个行为用例失败**，模块加载正常 —— 是行为检出，不是缺导出 |
| 把 `candidateOf` 的默认包改成 `variantPackage(PRODUCTION_VARIANT)` | parity 的 "same object" 断言失败 |
| 给 `caseMaterial` 的渲染结果加一个空格 | parity 的两条渲染断言失败 |
| 改 `caseMaterial` 里被哈希的成员（`digestOf({protocol, request, extra:1})`） | parity 的两条 fingerprint 断言失败 |
| **只回退比较实现**，跑 parity 的 decision 用例 | 「恰好落在容差」用例失败（12 passed / 1 failed）—— 证明 decision 端到端对等确实覆盖了 N0 修复 |

> 修订记录：早期版本的证伪用「整份换回旧 `normalize.ts`」完成，Relay 指出那样会因缺少
> `withinSumTolerance` 导出而在**模块加载阶段**失败，无法区分「检出原缺陷」与「导入失败」。已改为
> 上述的定向回退，并在相同改动下重跑确认 5 个用例是行为失败。

## 4. 未执行项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `check:build` | not-run | 本机 `ERR_SQLITE_ERROR`；`main` 上同样失败；CI 覆盖 |
| `check:regressions` | not-run | 由 `check:build` 短路；其判定对象（R1–R9、S1–S3）不涉及本任务改动的契约代码 |
| `pnpm test:e2e:dsh` 通过 | blocked（环境） | 见 §2；失败集与 `main` 完全一致 |
| 重跑 RQ-15 试点 | not-run | 未授权的新付费调用；试点运行目录已不在本机（见 [normalization-boundary.md](normalization-boundary.md) §4） |
