import type { CandidateRecord } from '../audit.js';
import { parseConfig } from '../config.js';
import { generateCandidates, persistCandidates } from '../suggestions.js';
import type { CommandRule } from '../types.js';
import { isRecord } from './common.js';
import type { ConfigurationAccess } from './configuration.js';
import { asRule, jsonResponse, readJsonBody } from './http.js';
import type {
  ConfigEditorEntryLike,
  ConfigEditorLike,
  FetchRouteLike,
  HostEnvironment,
} from './types.js';

export function analyzeRoute(host: HostEnvironment): FetchRouteLike {
  return {
    path: '/api/arbiter/analyze',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { audit } = host;
      if (audit === null)
        return jsonResponse({ ok: false, code: 'audit-unavailable' }, 409);
      const body: unknown = await readJsonBody(request).catch(() => ({}));
      const windowDays =
        isRecord(body) && typeof body['windowDays'] === 'number'
          ? body['windowDays']
          : 30;
      const minOccurrences =
        isRecord(body) && typeof body['minOccurrences'] === 'number'
          ? body['minOccurrences']
          : 3;
      const windowEnd = Date.now();
      const windowStart =
        windowEnd - Math.max(1, windowDays) * 24 * 60 * 60 * 1000;
      const proposals = generateCandidates(audit, {
        windowStart,
        windowEnd,
        minOccurrences: Math.max(2, minOccurrences),
        maxCandidates: 20,
      });
      const created = persistCandidates(
        audit,
        proposals,
        windowStart,
        windowEnd,
      );
      return jsonResponse({ ok: true, proposals, created });
    },
  };
}

/** Offline suggestions write ordinary rules through the existing editor. */
export class SuggestionActions {
  private readonly host: HostEnvironment;
  private readonly configuration: ConfigurationAccess;
  constructor(host: HostEnvironment, configuration: ConfigurationAccess) {
    this.host = host;
    this.configuration = configuration;
  }

  route(): FetchRouteLike {
    return {
      path: '/api/arbiter/suggestions/act',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => this.act(request),
    };
  }

  private async act(request: Request): Promise<Response> {
    const store = this.host.currentAudit();
    if (store === null)
      return jsonResponse({ ok: false, code: 'audit-unavailable' }, 409);
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return jsonResponse(
        { ok: false, code: 'bad-request', message: String(error) },
        400,
      );
    }
    if (!isRecord(body) || typeof body['candidateId'] !== 'string')
      return jsonResponse({ ok: false, code: 'bad-request' }, 400);
    const candidateId = body['candidateId'];
    const candidate = store
      .listCandidates()
      .find((item) => item.candidateId === candidateId);
    if (candidate === undefined)
      return jsonResponse({ ok: false, code: 'not-found' }, 404);
    if (body['action'] === 'reject') {
      store.updateCandidateStatus(
        candidateId,
        'rejected',
        typeof body['note'] === 'string' ? body['note'] : null,
      );
      return jsonResponse({ ok: true, status: 'rejected' });
    }
    if (body['action'] !== 'accept')
      return jsonResponse(
        {
          ok: false,
          code: 'bad-request',
          message: 'action must be accept or reject',
        },
        400,
      );
    return this.accept(candidate, body);
  }

  private async accept(
    candidate: CandidateRecord,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const rule = asRule(body['rule'] ?? candidate.rule);
    if (rule === null)
      return jsonResponse({ ok: false, code: 'rule-invalid' }, 422);
    const editor = this.host.services.configEditor;
    if (editor === undefined)
      return jsonResponse({ ok: false, code: 'config-readonly' }, 409);
    const entry = this.configuration.entry();
    if (entry === undefined)
      return jsonResponse({ ok: false, code: 'config-entry-missing' }, 409);
    const candidateId = candidate.candidateId;
    // A prior request may have applied config before losing the audit update.
    if (
      this.host.runtime.config.rules.some((existing) => existing.id === rule.id)
    ) {
      try {
        this.host
          .currentAudit()
          ?.updateCandidateStatus(candidateId, 'accepted', null);
      } catch {
        /* Report the durable configuration state. */
      }
      return jsonResponse({
        ok: true,
        status: 'accepted',
        rule,
        alreadyApplied: true,
      });
    }
    const validated = parseConfig({
      ...this.host.runtime.config,
      rules: [...this.host.runtime.config.rules, rule],
    });
    if (validated.errors.length > 0)
      return jsonResponse(
        { ok: false, code: 'config-invalid', errors: validated.errors },
        422,
      );
    const failed = await this.edit(editor, entry, rule);
    if (failed !== null) return failed;
    return this.settle(candidateId, rule);
  }

  private async edit(
    editor: ConfigEditorLike,
    entry: ConfigEditorEntryLike,
    rule: CommandRule,
  ): Promise<Response | null> {
    try {
      await editor.edit(entry, (current) => {
        const config = parseConfig(current).config;
        if (config.rules.some((existing) => existing.id === rule.id))
          throw new Error(`rule "${rule.id}" already exists`);
        return { ...config, rules: [...config.rules, rule] };
      });
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
    return null;
  }

  private settle(candidateId: string, rule: CommandRule): Response {
    let warning: string | null = null;
    try {
      const settled = this.host.currentAudit();
      if (settled === null) throw new Error('audit storage is unavailable');
      settled.updateCandidateStatus(candidateId, 'accepted', null);
    } catch (error) {
      warning = `rule applied, candidate status not persisted: ${error instanceof Error ? error.message : String(error)}`;
    }
    return jsonResponse({
      ok: true,
      status: 'accepted',
      rule,
      ...(warning === null ? {} : { warning }),
    });
  }
}
