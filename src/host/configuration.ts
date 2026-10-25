import { readFileSync } from 'node:fs';
import { parseConfig, stableHash } from '../config.js';
import type { ConfigParseResult } from '../types.js';
import { applyConfig, clearUiApply, markUiApply } from './runtime.js';
import type { ConfigActivation } from './runtime.js';
import { isRecord } from './common.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { ConfigEditorEntryLike, HostEnvironment } from './types.js';

/**
 * The save endpoint.
 *
 * UI save and external file replacement share one validation and one
 * application path: the revision guard protects concurrent edits, a single
 * `parseConfig` decides validity, and a single `applyConfig` decides what is in
 * effect. A failure at any step leaves the current effective configuration and
 * the profile file unchanged.
 */
export class ConfigurationAccess {
  private readonly host: HostEnvironment;
  constructor(host: HostEnvironment) {
    this.host = host;
  }

  entry(): ConfigEditorEntryLike | undefined {
    return this.host.services.configEditor
      ?.entries()
      .find((entry) => entry.options.id === 'arbiter');
  }

  /** The revision of the profile patch as it currently is on disk. */
  fileRevision(): string | null {
    const editor = this.host.services.configEditor;
    if (editor === undefined) return null;
    try {
      return stableHash(readFileSync(editor.documentPath, 'utf8'));
    } catch {
      return null;
    }
  }

  private async candidate(
    request: Request,
  ): Promise<ConfigParseResult | Response> {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return jsonResponse(
        { ok: false, code: 'bad-request', message: String(error) },
        400,
      );
    }
    if (!isRecord(body) || typeof body['revision'] !== 'string') {
      return jsonResponse(
        { ok: false, code: 'bad-request', message: 'revision is required' },
        400,
      );
    }
    const revision = this.fileRevision();
    if (revision !== null && body['revision'] !== revision) {
      return jsonResponse(
        {
          ok: false,
          code: 'config-conflict',
          message: 'the profile patch changed after this draft was read',
          fileRevision: revision,
        },
        409,
      );
    }
    const candidate = parseConfig(body['config']);
    if (candidate.errors.length > 0) {
      return jsonResponse(
        {
          ok: false,
          code: 'config-invalid',
          errors: candidate.errors,
          warnings: candidate.warnings,
        },
        422,
      );
    }
    return candidate;
  }

  async save(request: Request): Promise<Response> {
    if (this.host.services.configEditor === undefined)
      return jsonResponse(
        {
          ok: false,
          code: 'config-readonly',
          message: 'config editor is unavailable',
        },
        409,
      );
    const entry = this.entry();
    if (entry === undefined)
      return jsonResponse(
        {
          ok: false,
          code: 'config-entry-missing',
          message: 'profile entry "arbiter" is not addressable',
        },
        409,
      );
    const candidate = await this.candidate(request);
    if (candidate instanceof Response) return candidate;
    // The comparison baseline is what was in effect when the request arrived:
    // the Loader reload that `edit()` performs can re-apply this content before
    // the call returns, which must not turn a real change into "unchanged".
    const { runtime } = this.host;
    const before = JSON.stringify(runtime.config);
    const activationsBefore = runtime.configActivations;
    markUiApply(runtime);
    try {
      await this.host.services.configEditor.edit(entry, () => candidate.config);
    } catch (error) {
      clearUiApply(runtime);
      return jsonResponse(
        {
          ok: false,
          code: 'config-rejected',
          message: error instanceof Error ? error.message : String(error),
        },
        422,
      );
    }
    // The editor reconciled the Loader, which may already have re-initialized
    // this plugin. Applying the same normalized content records nothing twice.
    clearUiApply(runtime);
    const activation = applyConfig(this.host, candidate.config, 'ui');
    const changed = before !== JSON.stringify(candidate.config);
    return jsonResponse({
      ok: true,
      ...saveResult(this.host, activation, {
        changed,
        recorded: runtime.configActivations > activationsBefore,
      }),
      warnings: candidate.warnings,
    });
  }
}

/** The observable save outcome; `saved` and `effective` are separate facts. */
export function saveResult(
  host: HostEnvironment,
  activation: ConfigActivation,
  observed: { readonly changed: boolean; readonly recorded: boolean },
): Record<string, unknown> {
  return {
    saved: true,
    changed: observed.changed,
    effective: true,
    effectiveRevision: activation.revision,
    configSnapshotId: activation.snapshotId,
    activationRecorded: observed.recorded,
    configFormat: host.runtime.configFormat,
    configFormatExplicit: host.runtime.configFormatExplicit,
    auditError: activation.auditError,
  };
}
