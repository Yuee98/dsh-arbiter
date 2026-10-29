/**
 * Turning a plan and an outcome into the text an operator checks.
 *
 * The report is the audit trail for RQ-18: it names the data directory, every
 * file considered (with the decision and the reason), the profiles and projects
 * the rows belong to, what the run actually removed, and the parts of the impact
 * scope this tool deliberately leaves alone. It is printed identically for a
 * dry run and for a real run, with the outcome section saying which of the two it
 * was, so the two records can be compared line by line.
 */
import type { ResetOutcome } from './apply.ts';
import { rowsText } from './plan.ts';
import type { ResetPlan, ResetTarget } from './plan.ts';

/** A byte count with thousands separators, for a report a human reads. */
function bytes(value: number): string {
  return value.toLocaleString('en-US');
}

/** The one-line summary of a target. */
function targetLine(target: ResetTarget): string {
  const size = `${bytes(target.bytes)} B`;
  const digest =
    target.sha256 === null
      ? 'no digest'
      : `sha256 ${target.sha256.slice(0, 12)}`;
  const tables = target.probe?.tables;
  const tableList =
    tables === null || tables === undefined
      ? ''
      : `, tables: ${tables.length === 0 ? '(none)' : tables.join(',')}`;
  // The row count is printed only where a structure was actually read: a sidecar
  // or a refused residue has no tables of its own, and "unreadable rows" there
  // would look like a failure rather than "not applicable".
  const rows = target.probe === null ? '' : `, ${rowsText(target.records)}`;
  return `  ${target.action.toUpperCase().padEnd(6)} ${target.name} [${target.group}] ${size}${rows}${tableList}, ${digest}`;
}

/** One section of the report, with an explicit "nothing here" line. */
function section(title: string, lines: readonly string[]): readonly string[] {
  if (lines.length === 0) return [title, '  (none)'];
  return [title, ...lines];
}

/** The reason lines for every target, aligned under the plan. */
function reasonLines(targets: readonly ResetTarget[]): readonly string[] {
  return targets.map((target) => `  - ${target.name}: ${target.reason}`);
}

/** Values and counts, one per line. */
function valueLines(
  values: readonly { readonly value: string; readonly records: number }[],
): readonly string[] {
  return values.map(
    (entry) => `  ${entry.value}: ${bytes(entry.records)} record(s)`,
  );
}

/** The session-log section: what was found, and why it is not a target. */
function sessionLogLines(plan: ResetPlan): readonly string[] {
  const withRecords = plan.sessionLogs.filter(
    (finding) => finding.arbiterRecords > 0,
  );
  const unreadable = plan.sessionLogs.filter(
    (finding) => finding.problem !== null || finding.undecodable > 0,
  );
  return [
    `  logs scanned: ${bytes(plan.sessionLogs.length)}, holding this plugin records: ${bytes(
      withRecords.length,
    )}`,
    ...withRecords.map(
      (finding) =>
        `  - ${finding.relative}: ${bytes(finding.arbiterRecords)} arbiter record(s) (${finding.recordTypes.join(', ')}) in ${bytes(finding.bytes)} B`,
    ),
    ...unreadable.map(
      (finding) =>
        `  ! ${finding.relative}: ${
          finding.problem ?? `${bytes(finding.undecodable)} undecodable unit(s)`
        }`,
    ),
  ];
}

/**
 * The top-level result of a run.
 *
 * "Nothing removed" and "removed some, then stopped" are different facts, and the
 * report is the record the later operations task reconciles against. A partial
 * run that printed "nothing removed" directly above "files removed: 1" would be
 * contradictory evidence.
 */
function resultLabel(outcome: ResetOutcome): string {
  if (outcome.removed.length === 0) return 'nothing removed';
  return outcome.applied
    ? 'removed every planned file'
    : 'PARTIAL: stopped before finishing';
}

/** The outcome section of a real run. */
function outcomeLines(outcome: ResetOutcome): readonly string[] {
  return [
    `  result: ${resultLabel(outcome)}`,
    ...(outcome.reason === null ? [] : [`  reason: ${outcome.reason}`]),
    `  files removed: ${bytes(outcome.removed.length)}`,
    `  bytes removed: ${bytes(outcome.removedBytes)}`,
    `  records removed: ${bytes(outcome.removedRecords)}`,
    ...outcome.removed.map(
      (file) =>
        `  - ${file.name} [${file.group}]: ${bytes(file.bytes)} B, ${rowsText(
          file.records,
        )}${file.sha256 === null ? '' : `, sha256 ${file.sha256.slice(0, 12)}`}`,
    ),
    ...outcome.skipped.map((file) => `  ! ${file.name}: ${file.reason}`),
    `  left in the directory: ${
      outcome.remaining.length === 0
        ? '(the directory is empty, so the next start creates a fresh database)'
        : outcome.remaining.join(', ')
    }`,
  ];
}

/** The whole report for a dry run. */
export function renderPlan(plan: ResetPlan): string {
  const lines: readonly string[] = [
    `Arbiter test-data reset — ${plan.directoryExists ? 'preview (nothing was deleted)' : 'preview, no plugin directory (nothing was deleted)'}`,
    `data directory: ${plan.home}`,
    `plugin directory: ${plan.directory}`,
    `plan id: ${plan.planId === '' ? '(blocked)' : plan.planId}`,
    '',
    ...section(
      'Targets',
      plan.targets.map((target) => targetLine(target)),
    ),
    '',
    ...section('Reasons', reasonLines(plan.targets)),
    '',
    ...section('Removal tally', [
      `  files: ${bytes(plan.deleteCount)}`,
      `  bytes: ${bytes(plan.deleteBytes)}`,
      `  records: ${bytes(plan.deleteRecords)}`,
      `  kept files: ${bytes(plan.keepCount)}`,
    ]),
    '',
    ...section('Profiles in the deleted data', valueLines(plan.profiles)),
    '',
    ...section('Projects in the deleted data', valueLines(plan.projects)),
    '',
    ...section(
      'Host session logs (reported, never deleted)',
      sessionLogLines(plan),
    ),
    '',
    ...section(
      'Excluded from this scope',
      plan.exclusions.map((item) => `  - ${item}`),
    ),
    ...(plan.refusals.length === 0
      ? []
      : [
          '',
          ...section(
            'Refused (the plan cannot be applied)',
            plan.refusals.map((item) => `  ! ${item}`),
          ),
        ]),
  ];
  return lines.join('\n');
}

/** The whole report for a real run: the plan it applied, then the outcome. */
export function renderOutcome(plan: ResetPlan, outcome: ResetOutcome): string {
  return [renderPlan(plan), '', 'Execution:', ...outcomeLines(outcome)].join(
    '\n',
  );
}
