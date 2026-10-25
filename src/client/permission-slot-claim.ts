/**
 * Whether this page may occupy the host's permission seat.
 *
 * The browser module outlives its host half in one real case: the plugin is
 * disabled or removed through the host's manager, the routes disappear, but the
 * already-served client bundle stays in the page's boot graph. Registering the
 * seat unconditionally then leaves an inert override on top of the host's own
 * control, which is worse than not having the selector at all.
 *
 * The claim therefore asks the plugin's own host half — one read of its state
 * route — and only registers when that half answers. It is a presence check,
 * not a state probe: the answer's content is never used for admission, and a
 * failed probe is the only signal this module produces.
 */

import { getJson } from './api.js';

/** How long the presence probe may take before the seat stays untouched. */
const CLAIM_TIMEOUT_MS = 4000;

/**
 * Report whether the Arbiter host half is reachable from this page.
 *
 * A missing route (404), a missing cookie or an unreachable host all mean "no":
 * in every one of those cases the selector could not confirm or change anything,
 * so it must not take the seat.
 */
export async function hostHalfPresent(): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, CLAIM_TIMEOUT_MS);
  });
  const probe = getJson('/state').then(
    () => true,
    () => false,
  );
  return Promise.race([probe, timeout]);
}
