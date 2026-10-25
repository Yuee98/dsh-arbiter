import { readFileSync } from 'node:fs';
import { parseConfig, stableHash } from '../config.js';
import { isRecord } from './common.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { ConfigEditorEntryLike, HostEnvironment } from './types.js';

/** Reads the live editor after optional service injection/reconciliation. */
export class ConfigurationAccess {
  private readonly host: Pick<HostEnvironment, 'services'>;
  constructor(host: Pick<HostEnvironment, 'services'>) {
    this.host = host;
  }
  entry(): ConfigEditorEntryLike | undefined {
    return this.host.services.configEditor
      ?.entries()
      .find((entry) => entry.options.id === 'arbiter');
  }
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
  ): Promise<ReturnType<typeof parseConfig> | Response> {
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
    try {
      await this.host.services.configEditor.edit(entry, () => candidate.config);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          code: 'config-rejected',
          message: error instanceof Error ? error.message : String(error),
        },
        422,
      );
    }
    // Warnings come from the submitted candidate, including its pre-normalization
    // parser warnings; they are not reconstructed from the normalized config.
    return jsonResponse({
      ok: true,
      fileRevision: this.fileRevision(),
      warnings: candidate.warnings,
    });
  }
}
