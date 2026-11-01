/** Final tool observations are independent of the review pending map. */
import type { AuditStore } from '../audit.js';
import { appendRecord } from '../records.js';
import { rememberRecordError } from './record-errors.js';
import { RESULT_REFERENCE } from '../snapshot/tool-result-reference.js';
import { callRedactor } from './call-snapshot.js';
import type { SessionAdmissions } from './session-admission.js';
import { resultStatus, toolResultMaterial } from './tool-result-material.js';
import type {
  HostEnvironment,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

interface Started {
  readonly audit: AuditStore;
  readonly generation: string;
  cwd?: string;
}
export class ToolResultObserver {
  private readonly host: HostEnvironment;
  private readonly admissions: SessionAdmissions;
  private readonly started = new WeakMap<ToolExecutionLike, Started>();
  private active = true;
  constructor(host: HostEnvironment, admissions: SessionAdmissions) {
    this.host = host;
    this.admissions = admissions;
    host.ctx.effect(() => () => {
      this.active = false;
    });
  }
  private auditFor(exec: ToolExecutionLike): AuditStore | null {
    const { runtime } = this.host;
    const session = exec.agent?.session;
    if (
      !this.active ||
      !runtime.config.enabled ||
      !runtime.accepting ||
      !runtime.config.audit.enabled ||
      session?.id === undefined
    )
      return null;
    this.admissions.observe(session);
    return this.admissions.view(session.id, runtime.effectiveRevision)
      ?.managed === true
      ? this.host.currentAudit()
      : null;
  }
  begin(exec: ToolExecutionLike): void {
    try {
      const audit = this.auditFor(exec);
      const generation = audit?.captureToolResultGeneration();
      if (audit !== null && generation !== null && generation !== undefined)
        this.started.set(exec, { audit, generation });
    } catch {
      /* Observation cannot change permission handling. */
    }
  }
  prepared(exec: ToolExecutionLike, cwd: string): void {
    const started = this.started.get(exec);
    if (started !== undefined) started.cwd = cwd;
  }
  observe(exec: ToolExecutionLike, result: ToolResultLike): void {
    try {
      this.collect(exec, result);
    } catch {
      this.host.lifecycle('tool-result/gap', {
        callId: exec.callId,
        reason: 'result-observation-failed',
      });
    } finally {
      this.started.delete(exec);
    }
  }
  private collect(exec: ToolExecutionLike, result: ToolResultLike): void {
    const audit = this.auditFor(exec);
    const session = exec.agent?.session;
    if (audit === null || session?.id === undefined) return;
    const started = this.started.get(exec);
    if (started !== undefined && started.audit !== audit) return;
    const generation =
      started?.generation ?? audit.captureToolResultGeneration();
    if (generation === null) return;
    const material = toolResultMaterial(
      result,
      callRedactor(this.host, session),
    );
    const status = resultStatus(result);
    const saved = audit.saveToolResult({
      sessionId: session.id,
      callId: exec.callId,
      observedAt: Date.now(),
      generation,
      ...(session.header?.parentSession === undefined
        ? {}
        : { parentSession: session.header.parentSession }),
      status,
      ...material,
      invocation: {
        tool: exec.name,
        arguments: exec.arguments,
        ...(started?.cwd === undefined ? {} : { cwd: started.cwd }),
      },
    });
    const record = appendRecord(session, RESULT_REFERENCE, {
      version: 1,
      sessionId: session.id,
      callId: exec.callId,
      tool: exec.name,
      status,
      contentState: material.contentState,
      save: saved.state,
      receipt: saved.receipt,
    });
    if (record !== 'written') {
      rememberRecordError(
        this.host.runtime.sessionRecordErrors,
        exec.callId,
        'tool result reference could not be written',
      );
      this.host.lifecycle('tool-result/gap', {
        callId: exec.callId,
        reason: 'reference-write-failed',
      });
    }
  }
}
