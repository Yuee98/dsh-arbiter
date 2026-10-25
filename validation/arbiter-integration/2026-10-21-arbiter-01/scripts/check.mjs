#!/usr/bin/env node
/**
 * Fixed expectations for the recorded integration cases.
 * Reads raw/results.json only; does not rerun DSH or call a model.
 */
import { readFileSync } from 'node:fs';

const results = JSON.parse(readFileSync(new URL('../raw/results.json', import.meta.url), 'utf8'));
const byId = new Map(results.map((result) => [result.caseId, result]));
let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`);
}

function traceOf(result) {
  return result.audit.calls[0]?.trace.map((stage) => stage.result) ?? [];
}

function expectCase(id, expected) {
  const result = byId.get(id);
  check(`${id} exists`, result !== undefined);
  if (result === undefined) return;
  check(`${id} exit 0`, result.exitCode === 0, String(result.exitCode));
  check(`${id} no import failure`, !result.stderrTail.includes('failed to import'), result.stderrTail.slice(0, 200));
  check(`${id} marker`, result.marker.exists === expected.marker, String(result.marker.exists));
  check(`${id} audit exists`, result.audit.exists === expected.audit, String(result.audit.exists));
  const [call] = result.audit.calls;
  check(`${id} result`, call?.result === expected.result, String(call?.result));
  check(`${id} execution`, call?.execution_status === expected.execution, String(call?.execution_status));
  check(`${id} model calls`, result.audit.modelCalls.length === expected.models, String(result.audit.modelCalls.length));
  check(`${id} reviewer requests`, result.reviewerRequests.length === expected.reviewers, String(result.reviewerRequests.length));
  check(
    `${id} trace`,
    JSON.stringify(traceOf(result)) === JSON.stringify(expected.trace),
    JSON.stringify(traceOf(result)),
  );
  if (expected.human !== undefined) {
    const answers = result.approvalSim.filter((entry) => entry.event === 'approval-sim/answer');
    check(`${id} simulated answers`, answers.length === expected.human, String(answers.length));
    check(`${id} simulated flag`, answers.every((entry) => entry.simulated === true));
  }
}

expectCase('allow-rule', {
  marker: true, audit: true, result: 'allow', execution: 'success', models: 0, reviewers: 0, trace: ['allow'],
});
expectCase('deny-rule', {
  marker: false, audit: true, result: 'deny', execution: 'not-started', models: 0, reviewers: 0, trace: ['deny'],
});
expectCase('review-allow', {
  marker: true, audit: true, result: 'review-allow', execution: 'success', models: 1, reviewers: 1,
  trace: ['review(default)', 'review-allow'],
});
expectCase('review-deny', {
  marker: false, audit: true, result: 'review-deny', execution: 'not-started', models: 1, reviewers: 1,
  trace: ['review(default)', 'review-deny'],
});
expectCase('review-error-fallback', {
  marker: false, audit: true, result: 'fallback-deny', execution: 'not-started', models: 2, reviewers: 2,
  trace: ['review(default)', 'error-escalate', 'fallback-deny'],
});
expectCase('force-ask-strict', {
  marker: false, audit: true, result: 'fallback-deny', execution: 'not-started', models: 0, reviewers: 0,
  trace: ['force-ask', 'fallback-deny'],
});
expectCase('force-review-shadow', {
  marker: true, audit: true, result: 'review-allow', execution: 'success', models: 1, reviewers: 1,
  trace: ['force-review', 'review-allow'],
});
expectCase('audit-unavailable', {
  marker: true, audit: false, result: undefined, execution: undefined, models: 0, reviewers: 0, trace: [],
});
expectCase('force-ask-human-allow', {
  marker: true, audit: true, result: 'human-allow', execution: 'success', models: 0, reviewers: 0,
  trace: ['force-ask', 'human-allow'], human: 1,
});
expectCase('force-ask-human-deny', {
  marker: false, audit: true, result: 'human-deny', execution: 'not-started', models: 0, reviewers: 0,
  trace: ['force-ask', 'human-deny'], human: 1,
});
expectCase('review-escalate-human-allow', {
  marker: true, audit: true, result: 'human-allow', execution: 'success', models: 1, reviewers: 1,
  trace: ['review(default)', 'review-escalate', 'human-allow'], human: 1,
});
expectCase('review-escalate-human-abort', {
  marker: false, audit: true, result: 'human-abort', execution: 'not-started', models: 1, reviewers: 1,
  trace: ['review(default)', 'review-escalate', 'human-abort'], human: 1,
});

expectCase('probe-override', {
  marker: false, audit: true, result: 'review-deny', execution: 'not-started', models: 1, reviewers: 1,
  trace: ['review(default)', 'review-deny'],
});

// Parent delegation and the child's own call are two independently gated calls.
const subagent = byId.get('subagent-allow');
check('subagent-allow exists', subagent !== undefined);
if (subagent !== undefined) {
  check('subagent-allow exit 0', subagent.exitCode === 0);
  check('subagent-allow marker', subagent.marker.exists === true);
  check('subagent-allow five calls', subagent.audit.calls.length === 2, String(subagent.audit.calls.length));
  check(
    'subagent-allow kinds',
    JSON.stringify(subagent.audit.calls.map((call) => call.session_kind)) === JSON.stringify(['main', 'subagent']),
    JSON.stringify(subagent.audit.calls.map((call) => call.session_kind)),
  );
  check(
    'subagent-allow results',
    subagent.audit.calls.every((call) => call.result === 'allow' && call.execution_status === 'success'),
  );
  check('subagent-allow no model', subagent.audit.modelCalls.length === 0);
}

// The audit-unavailable case has no database row; its session record is the
// only durable decision evidence. The runner copied the session log.
const auditMissing = byId.get('audit-unavailable');
check(
  'audit-unavailable session record copied',
  Array.isArray(auditMissing?.sessionLogs) && auditMissing.sessionLogs.length > 0,
);

console.log(`${String(passed)} passed, ${String(failures.length)} failed`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
