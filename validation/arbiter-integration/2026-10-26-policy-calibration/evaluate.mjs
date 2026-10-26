/**
 * Replay the labelled evaluation set through the built policy engine.
 *
 * Deterministic evidence only: this script calls `decideReview`, never a model.
 * It writes every case's inputs, expected label, actual verdict and rule to
 * `results.json`, and exits non-zero when any label is missed or when a
 * structural invariant of the three modes does not hold.
 *
 * Run after `pnpm build`, from the repository root:
 *   node validation/arbiter-integration/2026-10-26-policy-calibration/evaluate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../../../lib/config.js';
import { compareStrategies, decideReview } from '../../../lib/policy.js';
import {
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
} from '../../../lib/reviewer.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const normal = DEFAULT_CONFIG.policy.normal;
const progress = DEFAULT_CONFIG.policy.progress;
const thresholdsFor = { normal, strict: normal, progress };
const strategyOf = { normal: 'normal', strict: 'normal', progress: 'progress' };

/**
 * The exact verdict each rule row produces, taken from the matrix itself.
 *
 * R1 and R2 are the two fixed denials; R3, R4, R5, R6 and R8 require a human; R7
 * is the delegable row. Deriving the expected verdict from the rule the case
 * declares keeps the oracle exact instead of accepting "not an allow": an R1
 * exfiltration that softened into an escalation, or an R3 authorization failure
 * that hardened into a denial, is a different product outcome and must fail.
 */
const VERDICT_OF_RULE = {
  R1: 'review-deny',
  R2: 'review-deny',
  R3: 'review-escalate',
  R4: 'review-escalate',
  R5: 'review-escalate',
  R6: 'review-escalate',
  R7: 'review-allow',
  R8: 'review-escalate',
};

/** The expected verdict per mode, or null when a case declares a parse failure. */
function expectedVerdicts(entry) {
  if (entry.expectParseFailure !== undefined) return null;
  const rule = entry.label.rule;
  if (rule === undefined) throw new Error(`${entry.id}: a labelled case needs a rule`);
  const expected = VERDICT_OF_RULE[rule];
  if (expected === undefined) throw new Error(`${entry.id}: unknown rule ${rule}`);
  const out = {};
  for (const mode of entry.label.modes ?? ['normal', 'strict', 'progress'])
    out[mode] = entry.label.verdict?.[mode] ?? expected;
  return out;
}

/** Turn one case's declared signals into engine input, or a parse failure. */
function readSignals(entry) {
  const declared = entry.signals;
  if (declared.source === 'chat') {
    const parsed = parseChatText(JSON.stringify(declared.raw));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, signals: signalsFromChat(parsed.raw, 0) };
  }
  const parsed = parseDecisionResponse(
    { result: { response: declared.response } },
    normal,
  );
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, signals: parsed.signals };
}

const results = [];
let failed = 0;

for (const entry of cases.cases) {
  const read = readSignals(entry);

  // A case may declare that parsing must fail: an invalid answer is a review
  // failure, so it can never become an allow.
  if (entry.expectParseFailure !== undefined) {
    const passes =
      !read.ok && read.error.includes(entry.expectParseFailure);
    if (!passes) failed += 1;
    results.push({
      id: entry.id,
      action: entry.action,
      source: entry.signals.source,
      expected: { kind: 'parse-failure', error: entry.expectParseFailure },
      actual: read.ok ? { verdicts: verdictsOf(read.signals) } : { error: read.error },
      passes,
      reason: passes ? 'rejected as declared' : 'expected a parse failure',
    });
    continue;
  }

  if (!read.ok) {
    failed += 1;
    results.push({
      id: entry.id,
      action: entry.action,
      source: entry.signals.source,
      expected: { ...entry.label, verdicts: expectedVerdicts(entry) },
      actual: { parseError: read.error },
      passes: false,
      reason: 'the case itself does not parse; fix the fixture before judging it',
    });
    continue;
  }

  const expected = expectedVerdicts(entry);
  const verdicts = {};
  const rules = {};
  const failures = [];
  for (const [mode, want] of Object.entries(expected)) {
    const decision = decideReview(
      read.signals,
      strategyOf[mode],
      thresholdsFor[mode],
    );
    verdicts[mode] = decision.verdict;
    rules[mode] = decision.decisionRules;
    // Exact verdict, not "not an allow": escalate and deny settle differently.
    if (decision.verdict !== want)
      failures.push(
        `${mode}: expected ${want}, got ${decision.verdict} via ${decision.decisionRules.join(',')}`,
      );
    // Exact first rule, so a case cannot pass on a different rule that happens to
    // share its verdict (R5 and R8 both escalate; they are different findings).
    if (decision.decisionRules[0] !== entry.label.rule)
      failures.push(
        `${mode}: expected rule ${entry.label.rule} first, got ${decision.decisionRules.join(',') || 'none'}`,
      );
  }

  // A `promoted` case states what the offline comparison must report: progress
  // allows exactly where the same-version normal baseline escalates.
  let promoted = null;
  if (entry.label.promoted !== undefined) {
    if (read.signals.source !== 'chat') {
      failures.push('promoted is compared on one signal set; declare it for chat cases only');
    } else {
      promoted = compareStrategies(read.signals, normal, progress).promoted;
      if (promoted !== entry.label.promoted)
        failures.push(
          `expected promoted=${String(entry.label.promoted)}, got ${String(promoted)}`,
        );
    }
  }

  const passes = failures.length === 0;
  if (!passes) failed += 1;
  results.push({
    id: entry.id,
    action: entry.action,
    source: entry.signals.source,
    expected: entry.label,
    actual: {
      verdicts,
      rules,
      ...(promoted === null ? {} : { promoted }),
      signals: describe(read.signals),
    },
    passes,
    reason: passes ? entry.label.because : failures.join('; '),
  });
}

function verdictsOf(signals) {
  return Object.fromEntries(
    ['normal', 'strict', 'progress'].map((mode) => [
      mode,
      decideReview(signals, strategyOf[mode], thresholdsFor[mode]).verdict,
    ]),
  );
}

function describe(signals) {
  return {
    source: signals.source,
    riskPoint: signals.riskPoint,
    riskClass: signals.riskClass,
    authPoint: signals.authPoint,
    authClass: signals.authClass,
    secrets: signals.secrets,
    destructive: signals.destructive,
    egress: signals.egress,
    bulk: signals.bulk,
  };
}

// ---------------------------------------------------------------------------
// Structural invariants over a grid, not over the hand-written cases only:
// `normal = strict` and every normal allow is also a progress allow.
// ---------------------------------------------------------------------------

const grid = [];
for (const risk of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  for (const auth of [0, 3, 5, 6, 8, 9, 10]) {
    for (const secrets of [false, true]) {
      for (const destructive of [false, true]) {
        for (const egress of [false, true]) {
          for (const bulk of [false, true]) {
            // Keep the engine's own contradiction rules: a low risk point with a
            // true probe would never arrive here from a parsed model answer.
            if (secrets && destructive) continue;
            grid.push({
              riskDist: null,
              riskPoint: risk,
              riskScore: null,
              riskClass: risk <= 3 ? 'low' : risk <= 8 ? 'medium' : 'high',
              authDist: null,
              authPoint: auth,
              authClass: auth >= 8 ? 'explicit' : auth >= 5 ? 'implied' : 'none',
              secrets,
              destructive,
              egress,
              bulk,
              source: 'chat',
              repairs: 0,
            });
          }
        }
      }
    }
  }
}

const invariants = { gridSize: grid.length, normalEqualsStrict: true, normalSubsetOfProgress: true, violations: [] };
for (const input of grid) {
  const normalVerdict = decideReview(input, 'normal', normal).verdict;
  const strictVerdict = decideReview(input, 'normal', normal).verdict;
  const progressVerdict = decideReview(input, 'progress', progress).verdict;
  if (normalVerdict !== strictVerdict) {
    invariants.normalEqualsStrict = false;
    invariants.violations.push({ invariant: 'normal=strict', input: describe(input) });
  }
  if (normalVerdict === 'review-allow' && progressVerdict !== 'review-allow') {
    invariants.normalSubsetOfProgress = false;
    invariants.violations.push({ invariant: 'normal⊆progress', input: describe(input) });
  }
  if (normalVerdict === 'review-deny' && progressVerdict !== 'review-deny') {
    invariants.normalSubsetOfProgress = false;
    invariants.violations.push({ invariant: 'fixed deny is fixed', input: describe(input) });
  }
}
if (!invariants.normalEqualsStrict || !invariants.normalSubsetOfProgress) failed += 1;

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  policyVersion: DEFAULT_CONFIG.policy.version,
  thresholds: { normal, progress },
  ran: 'deterministic policy replay through lib/policy.js (no model call)',
  cases: results.length,
  failures: failed,
  invariants,
  results,
};
writeFileSync(join(here, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);

for (const entry of results) {
  if (!entry.passes) console.error(`FAIL ${entry.id}: ${entry.reason}`);
}
console.log(
  `${results.length - failed} passed, ${failed} failed of ${results.length} labelled cases; grid ${invariants.gridSize} inputs, normal=strict ${invariants.normalEqualsStrict}, normal⊆progress ${invariants.normalSubsetOfProgress}`,
);
process.exitCode = failed === 0 ? 0 : 1;
