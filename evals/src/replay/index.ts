/**
 * The offline replay's public surface.
 *
 * A replay answers one question about evidence that already exists: under another
 * reading rule, what would this run have concluded? It re-uses the production
 * parser, the shared N0 comparison and the one shared matrix, writes each variant
 * into its own derived run directory, and rebuilds the three-layer report for that
 * directory through the report layer's own reader — with no model request anywhere
 * in the path.
 *
 * The four modules are separate for the reason the rest of `evals/src` is:
 *
 *   types      the vocabulary, including the thresholds production itself uses
 *   variants   the three axes and how a caller states them
 *   source     reading a run directory, with a digest of every document read
 *   derive     one cell's re-derivation, and the failure precedence
 *   assemble   one variant's derived run and its lineage
 *   write      the derived directory, its report and the safety refusals
 *   command    the `replay` command line
 */

export type {
  AnswerCandidate,
  InputStanding,
  OutcomeFacts,
  ReplayCellLineage,
  ReplayDisposition,
  ReplayLineage,
  ReplaySource,
  ReplayTotals,
  ReplayVariant,
  SettlementChoice,
  SourceFile,
  ThresholdRule,
  ThresholdRules,
} from './types.js';
export {
  PRODUCTION_THRESHOLDS,
  REPLAY_IMPLEMENTATION_VERSION,
  REPLAY_LINEAGE_VERSION,
  REPLAY_VARIANTS_VERSION,
} from './types.js';

export type { FlagsVariant, StatedVariant, VariantsParse } from './variants.js';
export {
  parseVariants,
  resolveVariant,
  statesAnyAxis,
  variantDigest,
  variantFromFlags,
} from './variants.js';

export type { InputComparison, InputDrift, UnverifiedInput } from './inputs.js';
export { compareInputs } from './inputs.js';

export type { SourceRead, SourcedRecord } from './source.js';
export { readSource } from './source.js';

export type { CellReplay } from './derive.js';
export {
  bandUnder,
  factsChanged,
  factsOf,
  replayCell,
  thresholdsAreProduction,
} from './derive.js';

export type { Derivation, DerivedRun, ReadableSource } from './assemble.js';
export { deriveRun, pathOfDerivedRecord, replayRunIdOf } from './assemble.js';

export type { DerivedWrite, WriteRefusal } from './write.js';
export {
  destinationRefusal,
  REPLAY_FILES,
  variantDirectoryOf,
  writeDerivation,
} from './write.js';

export type { ReplayCommand, ReplayIo } from './command.js';
export {
  isReplayCommand,
  parseReplayCommand,
  REPLAY_USAGE,
  replayRun,
} from './command.js';
