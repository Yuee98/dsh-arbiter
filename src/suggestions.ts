/**
 * Offline rule suggestions and policy replay.
 *
 * Analysis is read-only. It groups already-decided calls, refuses hard-risk
 * categories, and writes pending candidates to the audit database. Nothing here
 * changes runtime rules; accepting a candidate is a separate, ordinary
 * configuration save performed by the host.
 */

import { createHash } from 'node:crypto';

import type { AuditStore, CandidateRecord } from './audit.js';
import type { PolicyThresholds, ReviewSignals } from './types.js';
import { compareStrategies } from './policy.js';
import { parseShell } from './shell/parse.js';

export interface SuggestionOptions {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly minOccurrences: number;
  readonly maxCandidates: number;
}

export interface CandidateProposal {
  readonly candidateId: string;
  readonly stats: {
    readonly occurrences: number;
    readonly approved: number;
    readonly rejected: number;
    readonly failed: number;
    readonly window: string;
  };
  readonly rule: {
    readonly id: string;
    readonly comment: string;
    readonly match: {
      readonly node: 'command';
      readonly kind: 'regex';
      readonly pattern: string;
      readonly agents: readonly string[];
    };
    readonly verdict: 'allow';
  };
  readonly evidence: {
    readonly callIds: readonly string[];
    readonly deniedCallIds: readonly string[];
    readonly commands: readonly string[];
    readonly skipped: readonly string[];
  };
}

const ALLOWED_RESULTS = new Set(['allow', 'review-allow', 'human-allow']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandOf(argumentsValue: unknown): string | null {
  if (!isRecord(argumentsValue)) return null;
  const command = argumentsValue['command'];
  if (typeof command === 'string') return command;
  if (typeof argumentsValue['cmd'] === 'string') return argumentsValue['cmd'];
  return null;
}

function hardCategory(
  signals: ReviewSignals | null,
  effect: unknown,
): string | null {
  if (signals === null) return null;
  if (signals.secrets && signals.egress)
    return 'credential or sensitive material egress';
  if (signals.secrets) return 'credential material';
  if (signals.destructive) return 'destructive effect';
  if (signals.egress) return 'network egress';
  if (signals.bulk) return 'bulk or unbounded effect';
  return observedCategory(effect);
}

function observedCategory(effect: unknown): string | null {
  if (isRecord(effect)) {
    const observed = effect['observed'];
    if (isRecord(observed)) {
      const network = observed['networkCommands'];
      if (Array.isArray(network) && network.length > 0)
        return 'observed network command';
      const credential = observed['credentialPaths'];
      if (Array.isArray(credential) && credential.length > 0)
        return 'observed credential path';
      const pipeline = observed['pipelineExec'];
      if (Array.isArray(pipeline) && pipeline.length > 0)
        return 'pipeline execution';
    }
    const outside = effect['writesOutsideWorkspace'];
    if (Array.isArray(outside) && outside.length > 0)
      return 'write outside the workspace';
  }
  return null;
}

interface Group {
  readonly key: string;
  occurrences: number;
  approved: number;
  rejected: number;
  failed: number;
  readonly callIds: string[];
  readonly deniedCallIds: string[];
  readonly commands: string[];
  readonly skipped: string[];
}

/** Find repeatable, fully parsed command families that were allowed every time. */
export function generateCandidates(
  store: AuditStore,
  options: SuggestionOptions,
): readonly CandidateProposal[] {
  const groups = new Map<string, Group>();
  for (const call of store.callsForAnalysis(
    options.windowStart,
    options.windowEnd,
  )) {
    accumulateCall(groups, call);
  }
  const proposals: CandidateProposal[] = [];
  for (const group of [...groups.values()].sort(
    (left, right) => right.occurrences - left.occurrences,
  )) {
    if (!eligibleGroup(group, options.minOccurrences)) continue;
    const proposal = proposalFor(group, options);
    if (proposal === null) continue;
    proposals.push(proposal);
    if (proposals.length >= options.maxCandidates) break;
  }
  return proposals;
}

type AnalysisCall = ReturnType<AuditStore['callsForAnalysis']>[number];

function commandFamily(
  call: AnalysisCall,
): { key: string; command: string } | null {
  if (call.tool !== 'bash' && call.tool !== 'terminal') return null;
  const command = commandOf(call.arguments);
  if (command === null) return null;
  const parse = parseShell(command, '/');
  if (parse.status !== 'ok' || parse.completeness !== 'complete') return null;
  if (parse.commands.length !== 1) return null;
  const argv = parse.commands[0]?.argv;
  if (argv === undefined || argv.length === 0) return null;
  const first = argv[0] ?? '';
  if (first.length === 0) return null;
  const second = argv[1];
  const prefix =
    second !== undefined && !second.startsWith('-')
      ? `${first} ${second}`
      : first;
  return { key: `${call.tool}:${prefix}`, command };
}

function accumulateCall(groups: Map<string, Group>, call: AnalysisCall): void {
  const family = commandFamily(call);
  if (family === null) return;
  const { key, command } = family;
  const existing = groups.get(key);
  const group: Group = existing ?? {
    key,
    occurrences: 0,
    approved: 0,
    rejected: 0,
    failed: 0,
    callIds: [],
    deniedCallIds: [],
    commands: [],
    skipped: [],
  };
  const category = hardCategory(call.signals, call.effect);
  group.occurrences += 1;
  if (ALLOWED_RESULTS.has(call.result)) {
    if (category !== null) group.skipped.push(category);
    else group.approved += 1;
  } else {
    group.rejected += 1;
    if (group.deniedCallIds.length < 8) group.deniedCallIds.push(call.callId);
  }
  if (call.executionStatus === 'failed') group.failed += 1;
  if (group.callIds.length < 8) group.callIds.push(call.callId);
  if (group.commands.length < 5 && !group.commands.includes(command))
    group.commands.push(command);
  groups.set(key, group);
}

function eligibleGroup(group: Group, minimum: number): boolean {
  return (
    group.occurrences >= minimum &&
    group.approved === group.occurrences &&
    group.rejected === 0 &&
    group.failed === 0 &&
    group.skipped.length === 0
  );
}

function proposalFor(
  group: Group,
  options: SuggestionOptions,
): CandidateProposal | null {
  const [tool, ...rest] = group.key.split(':');
  const words = rest.join(':').trim();
  if (words.length === 0) return null;
  const pattern = `^${words
    .split(/\s+/u)
    .map(escapeRegex)
    .join('\\s+')}(?:\\s|$)`;
  const idBase = `auto-${slug(words)}`;
  const hash = createHash('sha256')
    .update(`${tool ?? ''}:${pattern}`)
    .digest('hex')
    .slice(0, 6);
  const candidateId = `candidate-${idBase}-${hash}`;
  return {
    candidateId,
    stats: {
      occurrences: group.occurrences,
      approved: group.approved,
      rejected: group.rejected,
      failed: group.failed,
      window: `${new Date(options.windowStart).toISOString().slice(0, 10)}..${new Date(options.windowEnd).toISOString().slice(0, 10)}`,
    },
    rule: {
      id: `${idBase}-${hash}`,
      comment: `离线建议：${String(group.occurrences)} 次已放行、无可见失败的 ${words} 调用`,
      match: {
        node: 'command',
        kind: 'regex',
        pattern,
        agents: ['main'],
      },
      verdict: 'allow',
    },
    evidence: {
      callIds: group.callIds,
      deniedCallIds: group.deniedCallIds,
      commands: group.commands,
      skipped: group.skipped,
    },
  };
}

/** Persist proposals as pending candidates; existing rows keep their review status. */
export function persistCandidates(
  store: AuditStore,
  proposals: readonly CandidateProposal[],
  windowStart: number,
  windowEnd: number,
): number {
  let created = 0;
  const existing = new Set(
    store.listCandidates().map((candidate) => candidate.candidateId),
  );
  for (const proposal of proposals) {
    if (existing.has(proposal.candidateId)) continue;
    const record: CandidateRecord = {
      candidateId: proposal.candidateId,
      createdAt: Date.now(),
      status: 'pending',
      rule: proposal.rule,
      stats: proposal.stats,
      evidence: proposal.evidence,
      windowStart,
      windowEnd,
      note: null,
    };
    store.saveCandidate(record);
    created += 1;
  }
  store.recordAnalysis(windowStart, windowEnd, proposals.length, created);
  return created;
}

export interface ReplayResult {
  readonly considered: number;
  readonly comparable: number;
  readonly promoted: number;
  readonly normalAllow: number;
  readonly progressAllow: number;
  readonly changed: number;
  readonly skipped: number;
  readonly items: readonly {
    readonly callId: string;
    readonly tool: string;
    readonly normal: string;
    readonly progress: string;
    readonly promoted: boolean;
  }[];
}

/** Compare the regular and progress strategies over stored signals only. */
export function replayPolicy(
  store: AuditStore,
  normal: PolicyThresholds,
  progress: PolicyThresholds,
  limit = 200,
): ReplayResult {
  const rows = store.recentForReplay(limit);
  const items: Array<{
    readonly callId: string;
    readonly tool: string;
    readonly normal: string;
    readonly progress: string;
    readonly promoted: boolean;
  }> = [];
  let comparable = 0;
  let promoted = 0;
  let normalAllow = 0;
  let progressAllow = 0;
  let changed = 0;
  for (const row of rows) {
    comparable += 1;
    const compared = compareStrategies(row.signals, normal, progress);
    if (compared.normal === 'review-allow') normalAllow += 1;
    if (compared.progress === 'review-allow') progressAllow += 1;
    if (compared.normal !== compared.progress) changed += 1;
    if (compared.promoted) promoted += 1;
    items.push({
      callId: row.callId,
      tool: row.tool,
      normal: compared.normal,
      progress: compared.progress,
      promoted: compared.promoted,
    });
  }
  return {
    considered: rows.length,
    comparable,
    promoted,
    normalAllow,
    progressAllow,
    changed,
    skipped: rows.length - comparable,
    items: items.slice(0, 50),
  };
}
