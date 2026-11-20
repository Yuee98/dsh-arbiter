import type { WebOpinion, WebOpinionReport } from './web-types.js';
import { behaviourLabels, consensusReasons, copy } from './web-copy.js';

function scoreLabel(pairs: string): string {
  return pairs
    .split('\n')
    .filter(Boolean)
    .map((pair) => {
      const [risk, authorization] = pair.split(',');
      return `R${risk ?? '–'} / A${authorization ?? '–'}`;
    })
    .join(' · ');
}

function OpinionRow({
  opinion,
  busy,
  onSelect,
}: {
  readonly opinion: WebOpinion;
  readonly busy: boolean;
  readonly onSelect: (opinion: WebOpinion) => void;
}) {
  return (
    <details className="model-row">
      <summary>
        <span className="model-name">{opinion.model}</span>
        <span className="model-score">{scoreLabel(opinion.pairs) || '—'}</span>
        <span className="model-behaviour">
          {behaviourLabels[opinion.behaviour]}
        </span>
      </summary>
      <div className="model-detail">
        {!opinion.complete && (
          <p className="material-muted">{copy.incomplete}</p>
        )}
        {opinion.rationale && (
          <>
            <h4>{copy.rationale}</h4>
            <p className="event-text">{opinion.rationale}</p>
          </>
        )}
        {opinion.evidence && (
          <>
            <h4>{copy.modelEvidence}</h4>
            <ul>
              {opinion.evidence
                .split('\n')
                .filter(Boolean)
                .map((quote, index) => (
                  <li key={String(index)}>{quote}</li>
                ))}
            </ul>
          </>
        )}
        {opinion.complete && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onSelect(opinion);
            }}
          >
            {copy.selectOpinion}
          </button>
        )}
      </div>
    </details>
  );
}

export function OpinionPanel({
  report,
  busy,
  failed,
  onRetry,
  onSelect,
}: {
  readonly report: WebOpinionReport | null;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly onSelect: (opinion: WebOpinion) => void;
}) {
  const consensus = report?.consensus;
  const draft = consensus?.draft;
  const agreed = draft != null;
  const state = agreed
    ? copy.consensusAgreed
    : consensus?.valid === 0
      ? copy.consensusMissing
      : copy.consensusDisagreed;
  return (
    <section className="model-opinions" aria-label={copy.opinions}>
      <div className="opinion-heading">
        <h3>{copy.opinions}</h3>
        {consensus !== undefined && (
          <span className="consensus-badge" data-agreed={agreed}>
            {state}
            {consensus.n > 0 &&
              ` · ${String(consensus.k)}/${String(consensus.n)}`}
          </span>
        )}
      </div>
      {report === null ? (
        <p className="material-muted">
          {failed ? copy.opinionError : copy.loading}
          {failed && (
            <button type="button" onClick={onRetry}>
              {copy.retryRead}
            </button>
          )}
        </p>
      ) : (
        <>
          {report.opinions.length === 0 && (
            <p className="material-muted">{copy.noOpinions}</p>
          )}
          {report.opinions.map((opinion) => (
            <OpinionRow
              key={opinion.id}
              opinion={opinion}
              busy={busy}
              onSelect={onSelect}
            />
          ))}
          {draft != null ? (
            <button
              type="button"
              className="consensus-action"
              disabled={busy}
              onClick={() => {
                onSelect(draft);
              }}
            >
              {copy.consensusSelect}
            </button>
          ) : (
            consensus !== undefined &&
            consensus.valid > 0 && (
              <details className="consensus-detail">
                <summary>{copy.consensusWhy}</summary>
                <ul>
                  {consensus.reasons.map((reason) => (
                    <li key={reason}>
                      {consensusReasons.get(reason) ?? reason}
                    </li>
                  ))}
                </ul>
              </details>
            )
          )}
        </>
      )}
    </section>
  );
}
