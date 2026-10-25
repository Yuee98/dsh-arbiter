import type { ReactNode } from 'react';

import { CoexistenceAlert } from './components/coexistence.js';
import { useCoexistenceFeed } from './coexistence-feed.js';

/**
 * The application-wide conflict host.
 *
 * `shell.overlay` is a root-scoped overlay the host renders above every panel,
 * not just Arbiter's settings page, so a conflict found while the user is in a
 * conversation still surfaces as the one reminder the contract asks for. The
 * persistent detail stays in the Arbiter status panel; this component owns only
 * the transient notice, its dismissal and the route into plugin management.
 */
export function CoexistenceOverlay(props: {
  /**
   * Opens the host's own plugin panel.
   *
   * Supplied as a callback because the service is provided by the plugin manager
   * at runtime: looking it up at click time means a deployment without that
   * panel loses the button, not the reminder.
   */
  readonly onOpenPluginManager?: (() => void) | undefined;
}): ReactNode {
  const feed = useCoexistenceFeed(null);
  return (
    <CoexistenceAlert
      coexistence={feed.view}
      onAcknowledge={feed.acknowledge}
      onOpenPluginManager={props.onOpenPluginManager}
    />
  );
}
