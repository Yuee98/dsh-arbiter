# The sum-tolerance repair on saved responses (RQ-16, #84)

Scope: the normalization boundary fix required by [#84](https://github.com/Yuee98/dsh-arbiter/issues/84),
prompted by the S1 pilot finding in [RQ-15 report §3.1](../review-quality/calibration/report.md).
Runs: offline. **No model was called for this record.**

## 1. The defect

`src/review-contract/normalize.ts` accumulated a decision answer's ten probabilities as
doubles — `let total = 0; … total += checked` — and compared
`Math.abs(total - 1) > SUM_TOLERANCE`. **Both halves were float operations.** The exact
decimal helper `addDecimals` existed in the same file but was used only for the cumulative
N0 median (`cumulativeDecimal`), not for the validation total. So an answer whose decimal
total sat exactly on `1e-4` from one was pushed outside by one binary ulp:

```
decimal total     0.9999
float sum         0.9998999999999999
|float sum − 1|   0.00010000000000010001   > 1e-4   → rejected
```

`SUM_TOLERANCE` is **unchanged at `1e-4`**. The fix changes only how the comparison is
made, so the product's bound and its inclusive reading are the same as before.

## 2. The fix

`withinSumTolerance(sum: string)` compares the exact decimal total against the exact
decimal tolerance in integer arithmetic (`BigInt` scaling, no float step). "Exactly on the
bound" is inside it, in both directions:

| total | distance from 1 | verdict |
| --- | --- | --- |
| `0.9999` | `0.0001` | accepted (on the bound) |
| `1.0001` | `0.0001` | accepted (on the bound) |
| `1.0002` | `0.0002` | rejected |
| `0.9998` | `0.0002` | rejected |

The failure detail now prints the exact decimal total (`total is 1.0002, …`) instead of a
`toFixed(6)` float rendering, so a person re-checking the boundary reads the number the
answer carried.

Concretely, `checkProbabilities` no longer keeps a running `total` double at all: it
collects each non-zero level's exact decimal, sums them with `addDecimals`, and hands the
resulting **string** to `withinSumTolerance`. No float step remains on that path.

## 3. Saved responses: original result vs repaired result

The inputs below are **captured provider output**, copied verbatim from the Clef capture
files named in [`tests/fixtures/saved-clef-distributions.json`](../../../tests/fixtures/saved-clef-distributions.json)
(`/Volumes/sandisk/code/clef-apc/artifacts/unified-models/live/<model>/requests.json`,
pointer `/10/response/answers/q/probabilities`). They are not reconstructed.

| capture | float sum | `\|float−1\|` | exact total | old rule | after fix | N0 risk band |
| --- | --- | --- | --- | --- | --- | --- |
| `clef-flash-4bit` | `0.99989999999999990` | `0.00010000000000010001` | `0.9999` | **rejected** | **accepted** | 5 |
| `clef-4bit` | `0.99999999999999989` | `1.11e-16` | `1.0000` | accepted | accepted | 4 |
| `mammoth-q4` | `0.99990000000000001` | `0.000099999999999988987` | `0.9999` | accepted | accepted | 8 |
| `d3-ultra-q4` | `0.99990000000000001` | `0.000099999999999988987` | `0.9999` | accepted | accepted | 5 |
| `flash-q8` | `0.99990000000000023` | `0.000099999999999766942` | `0.9999` | accepted | accepted | 5 |

**One capture changes verdict**, and it changes from rejected to accepted — the answer
that sat exactly on the tolerance. Nothing the old rule accepted is now refused, so the
repair does not loosen the bound. This is asserted as a test rather than left to the
reader: `tests/review-contract/saved-response-boundary.test.ts` recomputes both verdicts
from the fixture and fails if a second capture starts changing verdict.

The `clef-flash-4bit` total is the same shape the pilot reported: `0.9999` accumulating to
`0.9998999999999999`, `|Σ−1| = 0.00010000000000010001`. It is a different case, which is
the point — the boundary, not one answer, was broken.

## 4. The pilot's own six failures

The RQ-15 pilot recorded six `probability-sum-not-one` failures; five were on the boundary
(4 × `0.9999`, 1 × `1.0001`) and one was genuinely outside (`1.0002`). **The pilot's run
records were not available to re-read**: they lived under the `rq-15` worktree's ignored
`.local/evals/runs/core-v1/pilot-a` directory, and that worktree has been removed. Rerunning
the pilot was not authorized for this task and would be a new set of paid calls, so it is
recorded as `not-run` instead of being estimated.

What *is* verified:

| claim | evidence |
| --- | --- |
| the four `0.9999` cases would now be accepted | §3 row 1 reproduces the exact arithmetic; `tests/review-contract/saved-response-boundary.test.ts` pins it |
| the `1.0001` case would now be accepted | the table test in `normalize.test.ts` pins `withinSumTolerance('1.0001') === true`, and both sides of the bound are asserted together |
| the `1.0002` case still fails | `tests/review-contract/saved-response-boundary.test.ts` constructs `1.0002` from the saved capture's own numbers and asserts rejection with the same reason |
| the repair reaches a score, not only the validator | the saved capture is read through `readProtocolScores` and N0 returns band 5 |

Re-reading the pilot's stored records to substitute measured counts for these derived ones
is left to the task that owns the run directory (RQ-17, #85, which re-runs the candidate on
a holdout), rather than claimed here.

## 5. Verification

```
pnpm test:unit            # includes tests/review-contract/{normalize,saved-response-boundary}.test.ts
```

Boundary tests added (`tests/review-contract/normalize.test.ts`, block
*the sum tolerance boundary is decimal, not float*): 18 cases across inside / exactly on /
outside, both signs, longer decimals, and the failure detail. Running the same tests against
the pre-fix `normalize.ts` fails 17 of them, so they discriminate rather than merely pass.
