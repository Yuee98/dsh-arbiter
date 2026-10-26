/**
 * The shipped policy defaults must stay inside the interval their own labelled
 * sample set allows.
 *
 * `validation/arbiter-integration/2026-10-26-policy-calibration/cases.json` is
 * the evaluation set for issue #22: every entry carries a synthetic action, the
 * signal facts a reviewer would report for it, and a label saying whether the
 * documented rule matrix intends an allow or a block. This test replays those
 * labels against the *shipped* defaults, so changing a threshold without
 * updating its evidence fails CI instead of silently moving the release
 * boundary.
 *
 * It is deterministic policy evidence, not model-quality evidence: no case here
 * says anything about how a real reviewer model would score an unseen call.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import { decideReview, reclassifySignals, strategyFor } from '../src/policy.js';
import {
  parseChatText,
  parseDecisionResponse,
  signalsFromChat,
} from '../src/reviewer.js';
import type { PolicyThresholds, ReviewSignals } from '../src/types.js';

interface SampleCase {
  readonly id: string;
  readonly signals:
    | {
        readonly source: 'chat';
        readonly raw: Record<string, unknown>;
      }
    | {
        readonly source: 'decision';
        readonly response: Record<string, unknown>;
      };
  readonly expectParseFailure?: string;
  readonly label: {
    readonly kind: 'must-pass' | 'must-block';
    readonly rule?: string;
    readonly modes?: readonly ('normal' | 'strict' | 'progress')[];
    /** Present only for the mode-dependent R6 row; otherwise the rule decides. */
    readonly verdict?: Partial<
      Record<
        'normal' | 'strict' | 'progress',
        'review-allow' | 'review-escalate' | 'review-deny'
      >
    >;
  };
}

interface Calibration {
  readonly calibration: readonly {
    readonly field: keyof PolicyThresholds;
    readonly table: 'both' | 'normal' | 'progress';
    readonly shipped: number;
    readonly admissibleValues: readonly number[];
    readonly shippedIsAdmissible: boolean;
    readonly interval: {
      readonly lowerExclusive: number | null;
      readonly upperInclusive: number | null;
    };
  }[];
}

const POLICY_FIELDS = [
  'tauAuth',
  'tauRisk',
  'tauCritical',
  'tauLow',
  'chatMediumRiskMax',
  'mediumRiskCeiling',
  'explicitFromRisk',
  'allowBulkEgress',
] as const satisfies readonly (keyof PolicyThresholds)[];

function isPolicyField(value: string): value is keyof PolicyThresholds {
  return (POLICY_FIELDS as readonly string[]).includes(value);
}

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Read the checked-in calibration artifacts.
 *
 * `JSON.parse` returns `any`, and a blind assertion over it would let a
 * hand-edited artifact of the wrong shape reach the assertions below with no
 * error. The reader therefore checks the two things this test relies on: that
 * `cases` is an array, and that `calibration` is an array.
 */
function readArtifact(name: string): unknown {
  return JSON.parse(
    readFileSync(
      `${root}validation/arbiter-integration/2026-10-26-policy-calibration/${name}`,
      'utf8',
    ),
  ) as unknown;
}

const rawCases = readArtifact('cases.json');
if (!isRecord(rawCases) || !Array.isArray(rawCases['cases']))
  throw new Error('cases.json must carry a cases array');
const cases: readonly SampleCase[] = rawCases['cases'].map((entry, index) => {
  if (!isRecord(entry))
    throw new Error(`cases[${String(index)}] is not an object`);
  const id = entry['id'];
  const signals = entry['signals'];
  const label = entry['label'];
  if (typeof id !== 'string' || !isRecord(signals) || !isRecord(label))
    throw new Error(`cases[${String(index)}] is missing id/signals/label`);
  const source = signals['source'];
  if (source !== 'chat' && source !== 'decision')
    throw new Error(`cases[${String(index)}] has an unknown signal source`);
  const kind = label['kind'];
  if (kind !== 'must-pass' && kind !== 'must-block')
    throw new Error(`cases[${String(index)}] has an unknown label kind`);
  const rule = label['rule'];
  const modes = label['modes'];
  const verdict = label['verdict'];
  const expectParseFailure = entry['expectParseFailure'];
  return {
    id,
    signals:
      source === 'chat'
        ? {
            source,
            raw: asRecord(signals['raw'], `${id}.signals.raw`),
          }
        : {
            source,
            response: asRecord(signals['response'], `${id}.signals.response`),
          },
    ...(typeof expectParseFailure === 'string' ? { expectParseFailure } : {}),
    label: {
      kind,
      ...(typeof rule === 'string' ? { rule } : {}),
      ...(Array.isArray(modes) ? { modes: asModes(modes, id) } : {}),
      ...(isRecord(verdict) ? { verdict: asVerdictMap(verdict, id) } : {}),
    },
  };
});

const rawCalibration = readArtifact('calibration.json');
if (!isRecord(rawCalibration) || !Array.isArray(rawCalibration['calibration']))
  throw new Error('calibration.json must carry a calibration array');
const calibration: Calibration = {
  calibration: rawCalibration['calibration'].map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`calibration[${String(index)}] is not an object`);
    const field = entry['field'];
    const table = entry['table'];
    const shipped = entry['shipped'];
    const admissibleValues = entry['admissibleValues'];
    const shippedIsAdmissible = entry['shippedIsAdmissible'];
    const interval = entry['interval'];
    if (typeof field !== 'string' || typeof shipped !== 'number')
      throw new Error(`calibration[${String(index)}] is missing field/shipped`);
    if (!isPolicyField(field))
      throw new Error(
        `calibration[${String(index)}] names an unknown policy field`,
      );
    if (table !== 'both' && table !== 'normal' && table !== 'progress')
      throw new Error(`calibration[${String(index)}] has an unknown table`);
    if (!Array.isArray(admissibleValues) || !isRecord(interval))
      throw new Error(`calibration[${String(index)}] is missing its interval`);
    const lower = interval['lowerExclusive'];
    const upper = interval['upperInclusive'];
    for (const bound of [lower, upper])
      if (bound !== null && typeof bound !== 'number')
        throw new Error(`calibration[${String(index)}] has a bad bound`);
    return {
      field,
      table,
      shipped,
      admissibleValues: admissibleValues.map((value) => {
        if (typeof value !== 'number')
          throw new Error(
            `calibration[${String(index)}] has a non-numeric value`,
          );
        return value;
      }),
      shippedIsAdmissible: shippedIsAdmissible === true,
      interval: {
        lowerExclusive: typeof lower === 'number' ? lower : null,
        upperInclusive: typeof upper === 'number' ? upper : null,
      },
    };
  }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function asModes(
  value: readonly unknown[],
  id: string,
): readonly ('normal' | 'strict' | 'progress')[] {
  return value.map((mode) => {
    if (mode !== 'normal' && mode !== 'strict' && mode !== 'progress')
      throw new Error(`${id} names an unknown mode`);
    return mode;
  });
}

function asVerdictMap(
  value: Record<string, unknown>,
  id: string,
): Partial<
  Record<
    'normal' | 'strict' | 'progress',
    'review-allow' | 'review-escalate' | 'review-deny'
  >
> {
  const out: Partial<
    Record<
      'normal' | 'strict' | 'progress',
      'review-allow' | 'review-escalate' | 'review-deny'
    >
  > = {};
  for (const [mode, verdict] of Object.entries(value)) {
    if (mode !== 'normal' && mode !== 'strict' && mode !== 'progress')
      throw new Error(`${id} names an unknown mode in its verdict map`);
    if (
      verdict !== 'review-allow' &&
      verdict !== 'review-escalate' &&
      verdict !== 'review-deny'
    )
      throw new Error(`${id} has an unknown verdict`);
    out[mode] = verdict;
  }
  return out;
}

/**
 * The exact verdict each rule row produces, taken from the matrix: R1 and R2 are
 * the fixed denials, R3–R6 and R8 require a human, R7 is the delegable row.
 */
const VERDICT_OF_RULE: Readonly<Record<string, string>> = {
  R1: 'review-deny',
  R2: 'review-deny',
  R3: 'review-escalate',
  R4: 'review-escalate',
  R5: 'review-escalate',
  R6: 'review-escalate',
  R7: 'review-allow',
  R8: 'review-escalate',
};

const thresholdsFor = (mode: string): PolicyThresholds =>
  mode === 'progress'
    ? DEFAULT_CONFIG.policy.progress
    : DEFAULT_CONFIG.policy.normal;

type ReadCase =
  | { readonly ok: true; readonly signals: ReviewSignals }
  | { readonly ok: false; readonly error: string };

/** Parse one case into engine input; a malformed answer stays a failure. */
function readCase(entry: SampleCase): ReadCase {
  if (entry.signals.source === 'chat') {
    const parsed = parseChatText(JSON.stringify(entry.signals.raw));
    if (!parsed.ok) return { ok: false, error: parsed.error ?? 'rejected' };
    if (parsed.raw === undefined) return { ok: false, error: 'rejected' };
    return { ok: true, signals: signalsFromChat(parsed.raw, 0) };
  }
  const parsed = parseDecisionResponse(
    { result: { response: entry.signals.response } },
    DEFAULT_CONFIG.policy.normal,
  );
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, signals: parsed.signals };
}

describe('first-release policy calibration', () => {
  test('the evaluation set is present and labelled', () => {
    // A silently emptied set would make every assertion below vacuous.
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const ids = cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(cases.map((entry) => entry.label.kind));
    expect([...kinds].sort()).toEqual(['must-block', 'must-pass']);
  });

  test('every malformed-answer case is rejected before it can become an allow', () => {
    const declared = cases.filter(
      (entry) => entry.expectParseFailure !== undefined,
    );
    expect(declared.length).toBeGreaterThanOrEqual(2);
    const observed = declared.map((entry) => {
      const read = readCase(entry);
      return {
        id: entry.id,
        expected: entry.expectParseFailure,
        error: read.ok ? null : read.error,
      };
    });
    for (const entry of observed) {
      expect(entry.error, `${entry.id} must be rejected`).not.toBeNull();
      expect(entry.error ?? '', `${entry.id} rejection reason`).toContain(
        entry.expected,
      );
    }
  });

  test.each(
    cases
      .filter((entry) => entry.expectParseFailure === undefined)
      .map((entry) => [entry.id, entry] as const),
  )(
    '%s decides the exact labelled verdict in every mode it names',
    (id, entry) => {
      const read = readCase(entry);
      if (!read.ok) throw new Error(`${id}: ${read.error}`);
      const signals = read.signals;
      const rule = entry.label.rule;
      if (rule === undefined)
        throw new Error(`${id}: a labelled case needs a rule`);
      const base = VERDICT_OF_RULE[rule];
      if (base === undefined) throw new Error(`${id}: unknown rule ${rule}`);
      for (const mode of entry.label.modes ?? [
        'normal',
        'strict',
        'progress',
      ]) {
        const wanted = entry.label.verdict?.[mode] ?? base;
        const decision = decideReview(
          signals,
          strategyFor(mode),
          thresholdsFor(mode),
        );
        // Exact verdict, because escalate and deny settle differently: one can
        // invoke human handling in normal mode, the other is an outright denial.
        expect(decision.verdict, `${id}/${mode} ${decision.reason}`).toBe(
          wanted,
        );
        // Exact first rule, because R5 and R8 share a verdict but are different
        // findings, and R2 must win over R5 when both would apply.
        expect(decision.decisionRules[0], `${id}/${mode}`).toBe(rule);
      }
    },
  );

  test('every recorded admissible value really holds with the production engine', () => {
    // The calibrator once carried its own copy of the decision classifier, so it
    // published candidates the real policy rejected. Replaying the recorded
    // admissible values here, through the same engine the gate uses, is what
    // makes that class of disagreement fail instead of ship.
    const labelled = cases.filter(
      (entry) => entry.expectParseFailure === undefined,
    );
    const checked = calibration.calibration.map((entry) => {
      const wrong: string[] = [];
      for (const candidate of entry.admissibleValues) {
        const normal = {
          ...DEFAULT_CONFIG.policy.normal,
          ...(entry.table === 'normal' || entry.table === 'both'
            ? { [entry.field]: candidate }
            : {}),
        };
        const progress = {
          ...DEFAULT_CONFIG.policy.progress,
          ...(entry.table === 'progress' || entry.table === 'both'
            ? { [entry.field]: candidate }
            : {}),
        };
        const thresholdsFor = (mode: string) =>
          mode === 'progress' ? progress : normal;
        for (const sample of labelled) {
          const read = readCase(sample);
          if (!read.ok)
            throw new Error(`${sample.id} should parse: ${read.error}`);
          const rule = sample.label.rule;
          if (rule === undefined) continue;
          for (const mode of sample.label.modes ?? [
            'normal',
            'strict',
            'progress',
          ]) {
            const thresholds = thresholdsFor(mode);
            // Re-derive decision classes under the candidate, exactly as the
            // gate does, so a candidate cannot pass on stale classification.
            const signals =
              read.signals.source === 'decision'
                ? reclassifySignals(read.signals, thresholds)
                : read.signals;
            const decision = decideReview(
              signals,
              strategyFor(mode),
              thresholds,
            );
            if (decision.decisionRules[0] !== rule)
              wrong.push(
                `${entry.field}/${entry.table}=${String(candidate)}: ${sample.id}/${mode} -> ${decision.decisionRules.join(',') || decision.verdict}`,
              );
          }
        }
      }
      return { field: `${entry.field}/${entry.table}`, wrong };
    });
    for (const entry of checked)
      expect(
        entry.wrong,
        `${entry.field} publishes a rejected candidate`,
      ).toEqual([]);
  });

  test('the shipped defaults are each admissible under the labelled set', () => {
    expect(calibration.calibration.length).toBeGreaterThan(0);
    for (const entry of calibration.calibration) {
      const table =
        entry.table === 'progress'
          ? DEFAULT_CONFIG.policy.progress
          : DEFAULT_CONFIG.policy.normal;
      expect(table[entry.field], `${entry.field}/${entry.table}`).toBe(
        entry.shipped,
      );
      expect(entry.shippedIsAdmissible, `${entry.field}/${entry.table}`).toBe(
        true,
      );
      expect(entry.admissibleValues).toContain(entry.shipped);
    }
  });

  test('each admissible interval actually brackets its shipped value', () => {
    // Four gates and the two point ceilings are pinned on both sides by the
    // sample set; the rest are recorded as one-sided by the calibrator, which is
    // the honest state of the evidence rather than a fabricated bracket.
    const twoSided = calibration.calibration.filter(
      (entry) =>
        entry.interval.lowerExclusive !== null &&
        entry.interval.upperInclusive !== null,
    );
    const pinned = twoSided.map((entry) => `${entry.field}/${entry.table}`);
    for (const field of [
      'tauAuth/both',
      'tauRisk/both',
      'tauCritical/both',
      'tauLow/both',
      'chatMediumRiskMax/normal',
      'mediumRiskCeiling/normal',
      'explicitFromRisk/both',
    ])
      expect(pinned).toContain(field);
    for (const entry of twoSided) {
      expect(entry.shipped).toBeGreaterThan(
        entry.interval.lowerExclusive ?? -1,
      );
      expect(entry.shipped).toBeLessThanOrEqual(
        entry.interval.upperInclusive ?? Number.POSITIVE_INFINITY,
      );
    }
  });
});
