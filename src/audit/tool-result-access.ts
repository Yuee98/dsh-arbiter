/** Lifecycle-aware facade; keeps the audit entry point responsible for wiring. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  ToolResultObservation,
  ToolResultReceipt,
} from './tool-result-types.js';
import {
  saveToolResult,
  recoverToolResults,
  toolResultGeneration,
  unavailableToolResultSave,
} from './tool-results.js';
import { readToolResult, emptyToolResult } from './tool-result-reader.js';

export class ToolResultAccess {
  private readonly path: string;
  private readonly open: () => DatabaseSync | null;
  private readonly enabled: () => boolean;
  private readonly days: () => number;
  private readonly degrade: (error: Error) => void;
  constructor(
    path: string,
    open: () => DatabaseSync | null,
    enabled: () => boolean,
    days: () => number,
    degrade: (error: Error) => void,
  ) {
    this.path = path;
    this.open = open;
    this.enabled = enabled;
    this.days = days;
    this.degrade = degrade;
  }
  generation(): string | null {
    const db = this.open();
    if (db === null) return null;
    try {
      return toolResultGeneration(db);
    } catch {
      this.degrade(new Error('result-generation-unavailable'));
      return null;
    }
  }
  save(observation: ToolResultObservation) {
    const db = this.open();
    if (db === null || !this.enabled()) return unavailableToolResultSave();
    try {
      const result = saveToolResult(
        db,
        this.path,
        observation,
        this.days(),
        Date.now(),
      );
      if (result.state === 'failed')
        this.degrade(new Error(result.reason ?? 'result-persistence-failed'));
      return result;
    } catch {
      this.degrade(new Error('result-persistence-failed'));
      return unavailableToolResultSave();
    }
  }
  get(sessionId: string, callId: string, expected?: ToolResultReceipt) {
    const db = this.open();
    if (db === null) return emptyToolResult('unavailable');
    try {
      const result = readToolResult(db, this.path, sessionId, callId, expected);
      if (
        ['missing-file', 'unreadable', 'storage-failed'].includes(result.state)
      )
        this.degrade(new Error('result-body-unavailable'));
      return result;
    } catch {
      this.degrade(new Error('result-body-unavailable'));
      return emptyToolResult('unreadable');
    }
  }
  recover() {
    const db = this.open();
    if (db === null) return { ok: false, removed: 0, cleanupPending: false };
    try {
      const result = recoverToolResults(db, this.path);
      if (result.cleanupPending)
        this.degrade(new Error('result-cleanup-pending'));
      return result;
    } catch {
      this.degrade(new Error('result-recovery-failed'));
      return { ok: false, removed: 0, cleanupPending: true };
    }
  }
}
