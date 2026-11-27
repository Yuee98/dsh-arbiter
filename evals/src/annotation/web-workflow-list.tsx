import type { WebConsensusStatus, WebPointSummary } from './web-types.js';
import { copy, statusLabels, referenceLabels } from './web-copy.js';

const LABELS = {
  agreed: copy.consensusAgreed,
  disagreed: copy.consensusDisagreed,
  unavailable: copy.consensusMissing,
};
export function pointMatches(
  point: WebPointSummary,
  progress: string,
  consensus: string,
  statuses: ReadonlyMap<string, WebConsensusStatus> | null,
): boolean {
  const progressMatches =
    progress === 'all' ||
    (progress === 'pending' &&
      ['none', 'stale', 'unresolved', 'preparation-failed'].includes(
        point.referenceStatus,
      )) ||
    (progress === 'sampled' && point.sampled) ||
    point.referenceStatus === progress ||
    (progress === 'draft' && point.status === 'draft');
  return (
    progressMatches &&
    (consensus === 'all' || statuses?.get(point.token) === consensus)
  );
}

export function WorkflowList({
  points,
  visible,
  current,
  assisted,
  statuses,
  statusError,
  retryStatus,
  progress,
  consensus,
  onProgress,
  onConsensus,
  busy,
  onOpen,
}: {
  readonly points: readonly WebPointSummary[];
  readonly visible: readonly WebPointSummary[];
  readonly current: string | null;
  readonly assisted: boolean;
  readonly statuses: ReadonlyMap<string, WebConsensusStatus> | null;
  readonly statusError: boolean;
  readonly retryStatus: () => void;
  readonly progress: string;
  readonly consensus: string;
  readonly onProgress: (value: string) => void;
  readonly onConsensus: (value: string) => void;
  readonly busy: boolean;
  readonly onOpen: (token: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const status of statuses?.values() ?? [])
    counts.set(status, (counts.get(status) ?? 0) + 1);
  return (
    <nav className="workflow-index" aria-label={copy.workflows}>
      <h2>{copy.workflows}</h2>
      <p className="progress">
        <strong>
          {
            points.filter((point) => point.referenceStatus === 'confirmed')
              .length
          }{' '}
          / {points.length}
        </strong>
        {copy.progress}
      </p>
      <label>
        {copy.filter}
        <select
          aria-label={copy.filter}
          value={progress}
          onChange={(event) => {
            onProgress(event.target.value);
          }}
        >
          <option value="all">{copy.all}</option>
          <option value="pending">{copy.pending}</option>
          <option value="confirmed">{copy.reviewed}</option>
          <option value="draft">{statusLabels.draft}</option>
          <option value="undecidable">{referenceLabels.undecidable}</option>
          <option value="needs-review">{copy.needsReview}</option>
          <option value="disputed">{copy.disputed}</option>
          <option value="sampled">{copy.sampled}</option>
        </select>
      </label>
      {assisted && (
        <>
          <label>
            {copy.consensus}
            <select
              aria-label={copy.consensus}
              value={consensus}
              disabled={statuses === null}
              onChange={(event) => {
                onConsensus(event.target.value);
              }}
            >
              <option value="all">{copy.all}</option>
              {Object.entries(LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                  {statuses !== null && ` (${String(counts.get(key) ?? 0)})`}
                </option>
              ))}
            </select>
          </label>
          {statuses === null && (
            <p className="material-muted">
              {statusError ? copy.consensusError : copy.consensusLoading}
              {statusError && (
                <button type="button" onClick={retryStatus}>
                  {copy.retryRead}
                </button>
              )}
            </p>
          )}
        </>
      )}
      <ol>
        {visible.map((point) => {
          const status = statuses?.get(point.token);
          return (
            <li key={point.token}>
              <button
                type="button"
                disabled={busy}
                aria-current={current === point.token ? 'step' : undefined}
                onClick={() => {
                  onOpen(point.token);
                }}
              >
                <span className="index-title">
                  {copy.workflow} {point.workflow} · {copy.point}{' '}
                  {point.position}
                </span>
                <span className="index-status">
                  {point.status === 'draft'
                    ? statusLabels.draft
                    : referenceLabels[point.referenceStatus]}
                  {status !== undefined && (
                    <span className="index-consensus" data-consensus={status}>
                      {LABELS[status]}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {visible.length === 0 && (
        <p className="material-muted">{copy.emptyFilter}</p>
      )}
    </nav>
  );
}
