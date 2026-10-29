/**
 * One coherent view of the effective configuration at a stage boundary.
 *
 * The plugin reads its configuration from a mutable runtime, and a review has
 * several boundaries where a change can land: while the working directory is
 * being ensured, while the snapshot is being built, and after the model request is
 * already out. Each stage must run under *one* configuration, and the audit must
 * name the revision that actually governed it — otherwise a call can be evaluated
 * with one revision's rules and a different revision's mode.
 *
 * A stage view is captured, never re-read: a caller passes it down so that the rule
 * evaluation, the recorded revision, the snapshot and the reviewer settings it uses
 * all come from the same moment.
 */

import { askPolicyForSession } from '../config.js';
import type {
  ApprovalMode,
  ArbiterConfig,
  ReviewerType,
  SessionKind,
} from '../types.js';

/** The configuration one stage actually used, as of the moment it began. */
export interface StageView {
  readonly config: ArbiterConfig;
  readonly revision: string;
  readonly snapshotId: string;
  readonly mode: ApprovalMode;
  /** The reviewer backend and settings frozen when the model request is sent. */
  readonly reviewerType: ReviewerType;
}

/**
 * Capture the effective configuration for one stage.
 *
 * There is no strategy field: the matrix is the shared contract and does not vary
 * by mode, so carrying a strategy here would reintroduce the second engine the
 * switch removed.
 */
export function stageView(
  config: ArbiterConfig,
  revision: string,
  snapshotId: string,
  sessionKind: SessionKind,
): StageView {
  return {
    config,
    revision,
    snapshotId,
    mode: askPolicyForSession(config, sessionKind),
    reviewerType: config.reviewer.type,
  };
}
