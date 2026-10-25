import { jsonResponse } from './http.js';
import type { LlmModelLike, LlmProviderLike } from '../reviewer.js';
import type { FetchRouteLike, HostEnvironment } from './types.js';

/** A provider whose catalog lookup failed; the host never echoes its message. */
const PROVIDER_FAILURE_CODE = 'provider-catalog-failed';

/** The whole directory could not be read, which is not one provider failing. */
const DIRECTORY_FAILURE_CODE = 'catalog-unavailable';

interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

interface CatalogGroup {
  readonly id: string;
  readonly name: string;
  readonly models: readonly CatalogModel[];
}

interface CatalogFailure {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

function modelPayload(model: LlmModelLike): CatalogModel {
  return {
    id: model.id,
    name: model.name,
    ...(model.description === undefined
      ? {}
      : { description: model.description }),
  };
}

/**
 * One provider's models, a stable failure code, or nothing to offer.
 *
 * A provider error message may quote an endpoint or credential reference, so it
 * is replaced by a code the client localizes; the diagnostic stays in the host
 * logger rather than the page or an HTTP body. An adapter with no credential
 * advertises no models: that is a provider with nothing to offer, so it is
 * omitted rather than shown as an empty group or a failure.
 */
async function groupOf(
  provider: LlmProviderLike,
  listModels: (provider: string) => Promise<readonly LlmModelLike[]>,
  logger: HostEnvironment['ctx']['logger'],
): Promise<CatalogGroup | CatalogFailure | null> {
  try {
    const models = await listModels(provider.id);
    if (models.length === 0) return null;
    return { ...provider, models: models.map(modelPayload) };
  } catch (error) {
    logger.warn('arbiter: model catalog failed for provider %s', provider.id);
    logger.warn(error);
    return { ...provider, code: PROVIDER_FAILURE_CODE };
  }
}

function isFailure(
  entry: CatalogGroup | CatalogFailure | null,
): entry is CatalogFailure {
  return entry !== null && 'code' in entry;
}

function isGroup(
  entry: CatalogGroup | CatalogFailure | null,
): entry is CatalogGroup {
  return entry !== null && !('code' in entry);
}

/**
 * The read-only Reviewer model directory.
 *
 * This is a catalog read, never an inference request: it lists what the host's
 * LLM runtime already advertises, grouped by provider route, and reports each
 * provider that could not be read instead of inventing options for it.
 */
export async function modelCatalogPayload(
  host: HostEnvironment,
): Promise<unknown> {
  const llm = host.services.llm;
  const listModels = llm?.listModels?.bind(llm);
  const listProviders = llm?.listProviders?.bind(llm);
  if (
    llm === undefined ||
    listModels === undefined ||
    listProviders === undefined
  )
    return { ok: true, supported: false, groups: [], failures: [] };
  try {
    const entries = await Promise.all(
      listProviders().map((provider) =>
        groupOf(provider, listModels, host.ctx.logger),
      ),
    );
    return {
      ok: true,
      supported: true,
      groups: entries.filter(isGroup),
      failures: entries.filter(isFailure),
    };
  } catch (error) {
    host.ctx.logger.warn('arbiter: model catalog is unavailable');
    host.ctx.logger.warn(error);
    return {
      ok: false,
      code: DIRECTORY_FAILURE_CODE,
      supported: true,
      groups: [],
      failures: [],
    };
  }
}

export function modelCatalogRoute(host: HostEnvironment): FetchRouteLike {
  return {
    path: `/api/arbiter/models`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await modelCatalogPayload(host)),
  };
}
