/**
 * The one place "does this answer say the action is prohibited?" is decided.
 *
 * The live engine (until RQ-04 replaces it) and the shared contract both need this
 * answer, and they receive it in two different shapes: the chat backend reports a
 * public integer, while the decision backend reports a native distribution whose
 * public score has to be derived by N0. Asking the question twice, once per shape,
 * is how the two would drift apart.
 *
 * Note what is deliberately *not* used: the legacy `authClass` label. Its `none`
 * bucket covers both "no permission at all" and "an effective prohibition", and the
 * new matrix allows the former at low risk while denying the latter. Reading the
 * label would deny the operations the matrix permits.
 */

import type { PublicScore, ScoreDistribution } from './types.js';
import {
  bandFromPublic,
  chatScore,
  validatePublicDistribution,
} from './normalize.js';

/** The authorization level one answer states, or why it states none. */
export type AuthorizationLevel =
  | { readonly ok: true; readonly score: PublicScore }
  | { readonly ok: false; readonly reason: string };

/**
 * Both shapes one caller may hold.
 *
 * Note the two numberings, which are not interchangeable: a chat answer carries one
 * public integer, while the decision adapter publishes its distribution on the
 * **public** 1..10 scale (`ReviewSignals.authDist`), because that is what the
 * consuming engine reads. The native 0..9 form is validated during parsing, before
 * this point, so nothing here re-derives it.
 */
export interface AuthorizationInput {
  /** A chat answer's public integer, when the source was chat. */
  readonly point: number | null;
  /** A decision answer's distribution, already re-keyed to the public 1..10 scale. */
  readonly distribution: ScoreDistribution | null;
}

/**
 * The public authorization score this answer states.
 *
 * A point value is taken as given (validated); a public distribution is read by the
 * authorization lower median, the same cumulative rule the contract uses everywhere
 * else. An unreadable distribution reports a reason instead of a level, so a caller
 * can keep its existing failure path rather than treating a broken answer as a
 * prohibition.
 */
export function authorizationLevel(
  input: AuthorizationInput,
): AuthorizationLevel {
  if (input.point !== null) {
    const score = chatScore(input.point);
    return score.ok
      ? { ok: true, score: score.score }
      : { ok: false, reason: score.detail };
  }
  if (input.distribution === null) {
    return { ok: false, reason: 'the answer carries no authorization signal' };
  }
  const distribution = validatePublicDistribution(input.distribution);
  if (!distribution.ok) {
    return { ok: false, reason: distribution.detail };
  }
  return {
    ok: true,
    score: bandFromPublic(distribution.value, 'authorization'),
  };
}

/** Whether this answer states an effective prohibition (authorization band 1). */
export function isProhibited(input: AuthorizationInput): boolean {
  const level = authorizationLevel(input);
  return level.ok && level.score === 1;
}
