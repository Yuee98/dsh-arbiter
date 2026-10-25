import { recordOf } from '../records.js';
import type { PriorVerdictItem } from '../types.js';
import type { HostEnvironment } from './types.js';
import { asCallResult, isRecord } from './common.js';

function priorFromRecord(committed: {
  readonly data: Record<string, unknown>;
  readonly time: number | undefined;
  readonly seq: number;
}): PriorVerdictItem | null {
  const data = committed.data;
  const result = asCallResult(data['result']);
  if (typeof data['tool'] !== 'string' || result === null) return null;
  return {
    ts: typeof committed.time === 'number' ? committed.time : committed.seq,
    callId:
      typeof data['callId'] === 'string'
        ? data['callId']
        : `seq-${String(committed.seq)}`,
    configRevision:
      typeof data['configRevision'] === 'string'
        ? data['configRevision']
        : 'unknown',
    tool: data['tool'],
    fingerprint:
      typeof data['fingerprint'] === 'string' ? data['fingerprint'] : '',
    trace: Array.isArray(data['trace'])
      ? data['trace'].filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    result,
    ...(typeof data['reason'] === 'string' ? { reason: data['reason'] } : {}),
    ...(typeof data['ruleId'] === 'string' ? { ruleId: data['ruleId'] } : {}),
    ...(Array.isArray(data['decisionRules'])
      ? {
          decisionRules: data['decisionRules'].filter(
            (entry): entry is string => typeof entry === 'string',
          ),
        }
      : {}),
  };
}

export class DecisionHistory {
  private readonly host: HostEnvironment;
  constructor(host: HostEnvironment) {
    this.host = host;
  }
  breakerOpen(sessionId: string): boolean {
    const { runtime } = this.host;
    if (runtime.config.breaker.mode === 'off') return false;
    const breaker = runtime.breakers.get(sessionId);
    if (breaker === undefined) return false;
    const now = Date.now();
    const window = breaker.denials.filter((ts) => now - ts < 60 * 60 * 1_000);
    breaker.denials.splice(0, breaker.denials.length, ...window);
    const preset =
      runtime.config.breaker.mode === 'custom'
        ? {
            consecutive: runtime.config.breaker.consecutiveDenials,
            window: runtime.config.breaker.windowDenials,
            size: runtime.config.breaker.windowSize,
          }
        : runtime.config.breaker.preset === 'strict'
          ? { consecutive: 2, window: 4, size: 10 }
          : runtime.config.breaker.preset === 'lenient'
            ? { consecutive: 5, window: 10, size: 20 }
            : { consecutive: 3, window: 6, size: 10 };
    let consecutive = 0;
    for (let index = breaker.denials.length - 1; index >= 0; index -= 1) {
      consecutive += 1;
      if (index === 0) break;
    }
    return (
      consecutive >= preset.consecutive ||
      breaker.denials.filter((ts) => now - ts < 30 * 60 * 1_000).length >=
        preset.window
    );
  }

  noteDenial(sessionId: string): void {
    const { runtime } = this.host;
    const breaker = runtime.breakers.get(sessionId) ?? { denials: [] };
    breaker.denials.push(Date.now());
    runtime.breakers.set(sessionId, breaker);
  }

  resetBreaker(sessionId: string): void {
    const { runtime } = this.host;
    runtime.breakers.delete(sessionId);
  }

  rememberPrior(sessionId: string, item: PriorVerdictItem): void {
    const { runtime } = this.host;
    const list = runtime.priorVerdicts.get(sessionId) ?? [];
    list.push(item);
    runtime.priorVerdicts.set(
      sessionId,
      list.slice(-Math.max(1, runtime.config.context.historyMaxItems)),
    );
  }

  priorFor(sessionId: string): PriorVerdictItem[] {
    const { runtime } = this.host;
    const limit = Math.max(1, runtime.config.context.historyMaxItems);
    const inMemory = runtime.priorVerdicts.get(sessionId) ?? [];
    if (inMemory.length > 0) return inMemory.slice(-limit);
    const restored = this.fromSession(sessionId);
    this.fromAudit(sessionId, limit, restored);
    const sorted = restored
      .sort((left, right) => left.ts - right.ts)
      .slice(-limit);
    runtime.priorVerdicts.set(sessionId, sorted);
    return sorted;
  }
  private fromSession(sessionId: string): PriorVerdictItem[] {
    const restored: PriorVerdictItem[] = [];
    const session = this.host.services.sessions?.get?.(sessionId);
    if (session !== undefined && typeof session.snapshotEvents === 'function') {
      try {
        for (const event of session.snapshotEvents()) {
          const committed = recordOf(event);
          if (committed?.type !== 'plugin:arbiter/decision') continue;
          if (!isRecord(committed.data)) continue;
          const item = priorFromRecord({ ...committed, data: committed.data });
          if (item !== null) restored.push(item);
        }
      } catch {
        // A missing record source is reported through the snapshot's missing list.
      }
    }
    return restored;
  }
  private fromAudit(
    sessionId: string,
    limit: number,
    restored: PriorVerdictItem[],
  ): void {
    const priorAudit = this.host.currentAudit();
    if (priorAudit !== null) {
      try {
        const seen = new Set(restored.map((item) => item.callId));
        // Minimal adaptation to the audit reader's new shape: it now also
        // reports how many rows were excluded because this build cannot read
        // their format, which the history-merge work (#16) consumes.
        for (const row of priorAudit.priorVerdictsForSession(sessionId, limit)
          .verdicts) {
          if (seen.has(row.callId)) continue;
          const result = asCallResult(row.result);
          if (result === null) continue;
          seen.add(row.callId);
          restored.push({
            ts: row.ts,
            callId: row.callId,
            configRevision: row.configRevision,
            tool: row.tool,
            fingerprint: row.fingerprint,
            trace: row.trace,
            result,
            ...(row.reason === '' ? {} : { reason: row.reason }),
            ...(row.ruleId === null ? {} : { ruleId: row.ruleId }),
            decisionRules: row.decisionRules,
          });
        }
      } catch {
        // Ignore; the reviewer sees a missing-history marker instead.
      }
    }
  }
}
