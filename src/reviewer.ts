/**
 * Reviewer modules.
 *
 * This barrel is the reviewer's public surface: the shared service, its transports,
 * the prompt renderer, the usage contract and the connection probe. There is one
 * renderer, one parser, one normalization and one outcome type, so a production
 * review and an eval review of the same material are the same call.
 *
 * The previous adapters (`chat`/`decision`/`prompt`/`signals`) and their signal
 * shape are gone with the shared-contract switch. They existed to feed a
 * threshold engine that no longer exists, and keeping them would let a caller pick
 * up a probe the matrix does not read.
 */

export * from './reviewer/index.js';
export { PROBE_SNAPSHOT, runReviewerProbe } from './reviewer/diagnostic.js';
