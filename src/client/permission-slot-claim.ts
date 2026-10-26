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
 *
 * A failed probe must not be permanent. The same page can lose the connection
 * while it boots and recover later, so the check is retried when the host
 * signals a recovered connection generation; a genuinely absent host half stays
 * absent and the seat stays native.
 */

import { getJson } from './api.js';

/** How long one presence probe may take before it counts as "absent". */
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

/**
 * Run `claim` once the host half answers, and again after a connection recovery.
 *
 * `subscribe` installs the recovery signal and returns its disposer; the caller
 * owns both through one effect, so a disposed plugin releases the seat and stops
 * listening. A successful claim is never repeated, and a failed probe only
 * retries when the host says the connection was re-established — no timer and no
 * polling.
 */
export function claimWhenPresent(options: {
  readonly present: () => Promise<boolean>;
  readonly claim: () => () => void;
  readonly subscribe: (retry: () => void) => () => void;
}): () => void {
  let claimDisposer: (() => void) | null = null;
  let stopped = false;
  let running = false;
  /** Set when a recovery arrives mid-probe, so that signal is not lost. */
  let pending = false;
  const run = (): void => {
    if (stopped || claimDisposer !== null) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    options
      .present()
      .then((present) => {
        if (stopped || !present || claimDisposer !== null) return;
        claimDisposer = options.claim();
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
        const again = pending;
        pending = false;
        if (again && claimDisposer === null) run();
      });
  };
  const unsubscribe = options.subscribe(run);
  run();
  return () => {
    stopped = true;
    unsubscribe();
    claimDisposer?.();
    claimDisposer = null;
  };
}
