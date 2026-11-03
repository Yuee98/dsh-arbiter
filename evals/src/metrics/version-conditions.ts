/** Publish existing policy/replay facts; never evaluate an answer a second way here. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  requiredAuthorizationFor,
  REVIEW_CONTRACT_VERSION,
} from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { RUNNER_IMPLEMENTATION_VERSION } from '../run/types.js';
import { verifiedReplayOrigin } from '../replay/origin.js';
import { parseVariants } from '../replay/variants.js';
import {
  PRODUCTION_THRESHOLDS,
  REPLAY_IMPLEMENTATION_VERSION,
  REPLAY_VARIANTS_VERSION,
} from '../replay/types.js';
import type { ReplayVariant } from '../replay/types.js';
import type { Observation } from './observe.js';
function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export interface VersionConditions {
  readonly origin:
    'saved-model-execution' | 'verified-offline-replay' | 'unverified';
  readonly contract: string;
  readonly answer: ReplayVariant['answer'] | null;
  readonly thresholds:
    | readonly {
        readonly field: 'risk' | 'authorization';
        readonly mode: 'strict' | 'at-least';
      }[]
    | null;
  readonly requiredAuthorization: readonly number[] | null;
  readonly settlement: ReplayVariant['settlement'] | null;
}
export async function versionConditions(
  directory: string,
  root: string,
  observation: Observation,
): Promise<VersionConditions> {
  const artifact = observation.artifact;
  const contract = artifact.index.versions.contract;
  const unavailable: VersionConditions = {
    origin: 'unverified',
    contract,
    answer: null,
    thresholds: null,
    requiredAuthorization: null,
    settlement: null,
  };
  if (
    contract !== REVIEW_CONTRACT_VERSION ||
    artifact.index.versions.prompt !== REVIEW_PROMPT_VERSION ||
    artifact.records.some(
      (record) =>
        record.versions.contract !== contract ||
        record.versions.prompt !== artifact.index.versions.prompt,
    )
  )
    return unavailable;
  if (
    artifact.index.versions.implementation !== REPLAY_IMPLEMENTATION_VERSION &&
    artifact.index.versions.implementation !== RUNNER_IMPLEMENTATION_VERSION
  )
    return unavailable;
  if (artifact.index.versions.implementation !== REPLAY_IMPLEMENTATION_VERSION)
    return {
      origin: 'saved-model-execution',
      contract,
      answer: null,
      thresholds: [
        { field: 'risk', mode: PRODUCTION_THRESHOLDS.risk },
        { field: 'authorization', mode: PRODUCTION_THRESHOLDS.authorization },
      ],
      settlement: null,
      requiredAuthorization: ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map(
        requiredAuthorizationFor,
      ),
    };
  if (!(await verifiedReplayOrigin({ directory, root, artifact })))
    return unavailable;
  const raw: unknown = JSON.parse(
    await readFile(join(directory, 'lineage.json'), 'utf8'),
  );
  if (raw === null || typeof raw !== 'object') return unavailable;
  const replay: unknown = Reflect.get(raw, 'replay');
  if (replay === null || typeof replay !== 'object') return unavailable;
  const matrix: unknown = Reflect.get(replay, 'matrix');
  const parsed = parseVariants({
    variantsVersion: REPLAY_VARIANTS_VERSION,
    variants: [
      {
        answer: field(replay, 'answer'),
        thresholds: field(replay, 'thresholds'),
        settlement: field(replay, 'settlement'),
        ...(matrix === 'shared' ? {} : { matrix }),
      },
    ],
  });
  const variant = parsed.ok ? parsed.variants[0] : undefined;
  if (variant === undefined) return unavailable;
  return {
    origin: 'verified-offline-replay',
    contract,
    answer: variant.answer,
    thresholds: [
      { field: 'risk', mode: variant.thresholds.risk },
      { field: 'authorization', mode: variant.thresholds.authorization },
    ],
    settlement: variant.settlement,
    requiredAuthorization:
      variant.matrix?.requiredAuthorization ??
      ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const).map(requiredAuthorizationFor),
  };
}
