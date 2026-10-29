/**
 * The shared review contract's public surface.
 *
 * Production (after RQ-04) and the evals tooling call this module and nothing else
 * for scoring semantics, so the two cannot disagree about what a number means. The
 * version names the semantic contract, not a file format: a change to band meaning,
 * the N0 rule or the matrix requires a new value here.
 */

export const REVIEW_CONTRACT_VERSION = 'review-contract-v1';

export type { AuthorizationInput, AuthorizationLevel } from './prohibition.js';
export { authorizationLevel, isProhibited } from './prohibition.js';

export type {
  ApprovalChannel,
  AskPolicy,
  ReviewStage,
  SettlementInstruction,
} from './matrix.js';
export { scoreReview, settle, verdictFor } from './matrix.js';

export type {
  ChatScores,
  DecisionScores,
  InsufficientMaterialReview,
  MaterialAvailability,
  MaterialGap,
  NativeLevel,
  ProtocolScores,
  PublicScore,
  ReviewEvaluation,
  ReviewFailureOutcome,
  ReviewOutcome,
  ScoreAudit,
  ScoreDistribution,
  ScoreFailure,
  ScoreFailureReason,
  ScoreSource,
  ScoreTrail,
  ScoredReview,
} from './types.js';

export {
  evaluateReview,
  materialAvailability,
  outcomeStatus,
  reviewFailure,
  summarizeFailures,
} from './evaluate.js';

export {
  addDecimals,
  bandFrom,
  bandFromNative,
  bandFromPublic,
  compareToHalf,
  chatScore,
  cumulative,
  distributionToPublic,
  exactDecimal,
  readProtocolScores,
  SUM_TOLERANCE,
  validateNativeDistribution,
  validatePublicDistribution,
  weightedBand,
} from './normalize.js';

export type { RubricBand } from './rubrics.js';
export {
  anchorTextOf,
  AUTHORIZATION_BANDS,
  AUTHORIZATION_DENIAL_SCORE,
  authorizationCriteria,
  criteriaOf,
  isNativeLevel,
  isPublicScore,
  nativeLevelOf,
  publicScoreOf,
  requiredAuthorizationFor,
  RISK_BANDS,
  riskCriteria,
} from './rubrics.js';
