/**
 * Derive each threshold's admissible interval from the labelled cases.
 *
 * For one threshold at a time, every candidate value on the shipped UI grid is
 * tried with all other thresholds held at the shipped default, and the labelled
 * cases are replayed. The admissible set is the set of candidate values under
 * which every label still holds. The interval is reported as the open bounds
 * implied by the nearest failing candidate on each side, and the recommendation
 * is the grid midpoint of that interval.
 *
 * This is interval arithmetic over a fixed sample set, not a statistical
 * estimate: it says which values the labels permit, and says nothing about how
 * a real model would score unseen calls.
 *
 * Run after `pnpm build`, from the repository root:
 *   node validation/arbiter-integration/2026-10-26-policy-calibration/calibrate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../../../lib/config.js';
import { decideReview } from '../../../lib/policy.js';
import {
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
} from '../../../lib/reviewer.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).cases;
const base = DEFAULT_CONFIG.policy.normal;

/** The shipped UI grid per field, mirroring `src/client/panels/advanced.tsx`. */
const FIELDS = [
  { key: 'tauAuth', min: 0, max: 1, step: 0.05, tables: ['normal', 'progress'] },
  { key: 'tauRisk', min: 0, max: 1, step: 0.05, tables: ['normal', 'progress'] },
  { key: 'tauCritical', min: 0, max: 1, step: 0.05, tables: ['normal', 'progress'] },
  { key: 'tauLow', min: 0, max: 1, step: 0.05, tables: ['normal', 'progress'] },
  { key: 'chatLowRiskMax', min: 0, max: 8, step: 1, tables: ['normal', 'progress'] },
  // These two are the fields the two strategies deliberately differ on, so each
  // table is scanned on its own: a single sweep across both would ask one value
  // to satisfy the normal must-blocks and the progress must-passes at once, which
  // is precisely the widening the design intends to keep separate.
  { key: 'chatMediumRiskMax', min: 0, max: 8, step: 1, tables: ['normal'], table: 'normal' },
  { key: 'chatMediumRiskMax', min: 0, max: 8, step: 1, tables: ['progress'], table: 'progress' },
  { key: 'mediumRiskCeiling', min: 0, max: 8, step: 1, tables: ['normal'], table: 'normal' },
  { key: 'mediumRiskCeiling', min: 0, max: 8, step: 1, tables: ['progress'], table: 'progress' },
  { key: 'explicitFromRisk', min: 0, max: 9, step: 1, tables: ['normal', 'progress'] },
];

const strategyOf = { normal: 'normal', strict: 'normal', progress: 'progress' };

/** Parse every case once; a declared parse failure is not part of calibration. */
function prepared() {
  const out = [];
  for (const entry of cases) {
    if (entry.expectParseFailure !== undefined) continue;
    const declared = entry.signals;
    let signals;
    if (declared.source === 'chat') {
      const parsed = parseChatText(JSON.stringify(declared.raw));
      if (!parsed.ok) throw new Error(`${entry.id}: ${parsed.error}`);
      signals = signalsFromChat(parsed.raw, 0);
    } else {
      const parsed = parseDecisionResponse(
        { result: { response: declared.response } },
        base,
      );
      if (!parsed.ok) throw new Error(`${entry.id}: ${parsed.error}`);
      signals = parsed.signals;
    }
    out.push({ entry, signals });
  }
  return out;
}

const PREPARED = prepared();

function labelsHold(normalThresholds, progressThresholds) {
  const thresholds = {
    normal: normalThresholds,
    strict: normalThresholds,
    progress: progressThresholds,
  };
  for (const { entry, signals } of PREPARED) {
    for (const mode of entry.label.modes ?? ['normal', 'strict', 'progress']) {
      // The gate re-derives decision classes under the *deciding* mode's
      // thresholds (`reclassifySignals`), so each mode is judged by its own
      // classes here rather than by one shared reclassification.
      const rescored =
        entry.signals.source === 'decision'
          ? reclassify(signals, thresholds[mode])
          : signals;
      const decision = decideReview(rescored, strategyOf[mode], thresholds[mode]);
      const isAllow = decision.verdict === 'review-allow';
      if (entry.label.kind === 'must-pass' && !isAllow) return false;
      if (entry.label.kind === 'must-block' && isAllow) return false;
      if (
        entry.label.rule !== undefined &&
        !decision.decisionRules.includes(entry.label.rule)
      )
        return false;
    }
  }
  return true;
}

/**
 * Re-derive decision classes under a candidate threshold set.
 *
 * `parseDecisionResponse` classifies with the *request-time* thresholds; a
 * calibration sweep changes the thresholds a later decision uses, so the classes
 * are recomputed here with the same documented boundaries.
 */
function reclassify(signals, thresholds) {
  const atLeast = (dist, minimum) =>
    Object.entries(dist ?? {}).reduce(
      (sum, [level, p]) => (Number(level) >= minimum ? sum + p : sum),
      0,
    );
  const atMost = (dist, maximum) =>
    Object.entries(dist ?? {}).reduce(
      (sum, [level, p]) => (Number(level) <= maximum ? sum + p : sum),
      0,
    );
  const critical = atLeast(signals.riskDist, 9);
  const low = atMost(signals.riskDist, 3);
  const riskClass =
    critical >= thresholds.tauCritical
      ? 'high'
      : low >= thresholds.tauLow
        ? 'low'
        : 'medium';
  const explicit = atLeast(signals.authDist, 8);
  const implied = atLeast(signals.authDist, 5);
  const authClass =
    explicit >= thresholds.tauAuth
      ? 'explicit'
      : implied >= thresholds.tauAuth
        ? 'implied'
        : 'none';
  return { ...signals, riskClass, authClass };
}

const normalDefaults = { ...base };
const progressDefaults = { ...DEFAULT_CONFIG.policy.progress };
const calibration = [];

for (const field of FIELDS) {
  const candidates = [];
  const steps = Math.round((field.max - field.min) / field.step);
  for (let index = 0; index <= steps; index += 1) {
    candidates.push(Number((field.min + index * field.step).toFixed(2)));
  }
  const admissible = [];
  for (const value of candidates) {
    const normal = field.tables.includes('normal')
      ? { ...normalDefaults, [field.key]: value }
      : { ...normalDefaults };
    const progress = field.tables.includes('progress')
      ? { ...progressDefaults, [field.key]: value }
      : { ...progressDefaults };
    if (labelsHold(normal, progress)) admissible.push(value);
  }
  const shipped = (field.table === 'progress' ? progressDefaults : normalDefaults)[
    field.key
  ];
  calibration.push({
    field: field.key,
    table: field.table ?? 'both',
    grid: { min: field.min, max: field.max, step: field.step },
    shipped,
    admissibleValues: admissible,
    shippedIsAdmissible: admissible.includes(shipped),
    // The open interval the labels permit, from the nearest failing candidate on
    // each side. `null` on a side means no candidate failed there, so that bound
    // is the grid edge and the sample set does not pin it.
    interval: {
      lowerExclusive: lowestFailingBelow(candidates, admissible, shipped),
      upperInclusive: highestFailingAbove(candidates, admissible, shipped),
    },
    midpoint: midpointOf(admissible, field.step),
  });
}

function lowestFailingBelow(candidates, admissible, shipped) {
  const below = candidates.filter((value) => value < shipped);
  for (let index = below.length - 1; index >= 0; index -= 1) {
    if (!admissible.includes(below[index])) return below[index];
  }
  return null;
}

function highestFailingAbove(candidates, admissible, shipped) {
  const above = candidates.filter((value) => value > shipped);
  for (const value of above) {
    if (!admissible.includes(value)) return value;
  }
  return null;
}

/** Nearest grid value to the middle of the admissible run, preferring the run containing `shipped`. */
function midpointOf(admissible, step) {
  if (admissible.length === 0) return null;
  const middle = (admissible[0] + admissible[admissible.length - 1]) / 2;
  return Number((Math.round(middle / step) * step).toFixed(2));
}

const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  method:
    'one field at a time on the shipped UI grid, all other fields at their default; admissible = every labelled case still holds; midpoint = middle of the admissible grid run',
  sampleSize: PREPARED.length,
  calibration,
};
writeFileSync(join(here, 'calibration.json'), `${JSON.stringify(report, null, 2)}\n`);

for (const entry of calibration) {
  const lower = entry.interval.lowerExclusive;
  const upper = entry.interval.upperInclusive;
  console.log(
    `${(entry.field + (entry.table === 'both' ? '' : `[${entry.table}]`)).padEnd(28)} shipped=${String(entry.shipped).padEnd(5)} admissible=[${entry.admissibleValues.join(',')}] interval=(${lower === null ? 'unbounded' : lower},${upper === null ? 'unbounded' : upper}) mid=${String(entry.midpoint)}`,
  );
}
process.exitCode = calibration.every((entry) => entry.shippedIsAdmissible) ? 0 : 1;
if (process.exitCode !== 0)
  console.error('\nA shipped default is not admissible under its own labelled cases.');
