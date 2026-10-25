import { readFileSync } from 'node:fs';
import { parseConfig, stableHash } from '../config.js';
import type { ConfigParseResult } from '../types.js';
import { applyConfig, clearUiApply, markUiApply } from './runtime.js';
import type { ConfigActivation } from './runtime.js';
import { isRecord } from './common.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { ConfigEditorEntryLike, HostEnvironment } from './types.js';

/**
 * The revision a save was prepared against is no longer current.
 *
 * Raised inside the editor's serialized `change` callback, so it is the write
 * lock — not a check before the lock — that decides whether the save may land.
 */
export class ConfigConflict extends Error {
  readonly fileRevision: string | null;
  constructor(fileRevision: string | null) {
    super('the profile patch changed after this draft was read');
    this.name = 'ConfigConflict';
    this.fileRevision = fileRevision;
  }
}

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

  private async candidate(request: Request): Promise<
    | {
        readonly expected: string;
        readonly parsed: ConfigParseResult;
      }
    | Response
  > {
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
    // A save must carry an explicit document. Absence is only legal for the
    // host's first-install load, never for an HTTP write.
    if (!isRecord(body['config'])) {
      return jsonResponse(
        {
          ok: false,
          code: 'bad-request',
          message: 'config must be an object',
          errors: [
            {
              path: '',
              message: 'config must be an object',
              code: 'config.not-object',
            },
          ],
          warnings: [],
        },
        400,
      );
    }
    const expected = body['revision'];
    const current = this.fileRevision();
    if (current !== null && expected !== current) {
      return jsonResponse(
        {
          ok: false,
          code: 'config-conflict',
          message: 'the profile patch changed after this draft was read',
          fileRevision: current,
        },
        409,
      );
    }
    const parsed = parseConfig(body['config']);
    if (parsed.errors.length > 0) {
      return jsonResponse(
        {
          ok: false,
          code: 'config-invalid',
          errors: parsed.errors,
          warnings: parsed.warnings,
        },
        422,
      );
    }
    return { expected, parsed };
  }

  async save(request: Request): Promise<Response> {
    const prepared = await this.candidate(request);
    if (prepared instanceof Response) return prepared;
    // Resolve the live services after the body is read: a configuration editor
    // injected during that await must serve this request, and the same instance
    // must own both the write lock and its revision check.
    const editor = this.host.services.configEditor;
    if (editor === undefined)
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
    // The comparison baseline is what was in effect when the request arrived:
    // the Loader reload that `edit()` performs can re-apply this content before
    // the call returns, which must not turn a real change into "unchanged".
    const { runtime } = this.host;
    const before = JSON.stringify(runtime.config);
    const activationsBefore = runtime.configActivations;
    markUiApply(runtime);
    try {
      await editor.edit(entry, () => {
        // Re-check under the editor's write lock: a competing save can win
        // between request parsing and this callback.
        const current = this.fileRevision();
        if (current !== null && current !== prepared.expected)
          throw new ConfigConflict(current);
        return prepared.parsed.config;
      });
    } catch (error) {
      clearUiApply(runtime);
      if (error instanceof ConfigConflict) {
        return jsonResponse(
          {
            ok: false,
            code: 'config-conflict',
            message: error.message,
            fileRevision: error.fileRevision,
          },
          409,
        );
      }
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
    const activation = applyConfig(this.host, prepared.parsed.config, 'ui');
    const changed = before !== JSON.stringify(prepared.parsed.config);
    return jsonResponse({
      ok: true,
      ...saveResult(this.host, activation, {
        changed,
        recorded: runtime.configActivations > activationsBefore,
      }),
      warnings: prepared.parsed.warnings,
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
