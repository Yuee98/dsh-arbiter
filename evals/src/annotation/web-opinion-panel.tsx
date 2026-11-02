import { useState } from 'react';
import type { WebOpinion, WebOpinionReport } from './web-types.js';
import { copy } from './web-copy.js';
export function OpinionPanel({
  report,
  busy,
  onLoad,
  onSelect,
}: {
  readonly report: WebOpinionReport | null;
  readonly busy: boolean;
  readonly onLoad: () => void;
  readonly onSelect: (opinion: WebOpinion) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <section>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (report === null) {
            setVisible(true);
            onLoad();
          } else {
            if (!visible) onLoad();
            setVisible((value) => !value);
          }
        }}
      >
        {visible && report !== null ? copy.hideOpinions : copy.opinions}
      </button>
      {visible && report !== null && (
        <>
          <h3>{copy.consensus}</h3>
          <p>
            {copy.consensusCounts}: {report.consensus.k}/{report.consensus.n} /{' '}
            {report.consensus.valid} / {report.consensus.missing} /{' '}
            {report.consensus.failed}
          </p>
          {report.consensus.draft === null ? (
            <>
              <p>{copy.consensusUnavailable}</p>
              <ul>
                {report.consensus.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (report.consensus.draft !== null)
                  onSelect(report.consensus.draft);
              }}
            >
              {copy.consensusSelect}
            </button>
          )}
          {report.opinions.length === 0 && <p>{copy.noOpinions}</p>}
          {report.opinions.map((opinion) => (
            <article key={opinion.id}>
              <h3>{opinion.model}</h3>
              <pre>{opinion.rawResponse}</pre>
              <p>{opinion.rationale}</p>
              <pre>{opinion.evidence}</pre>
              {!opinion.complete && <p>{copy.incomplete}</p>}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onSelect(opinion);
                }}
              >
                {copy.selectOpinion}
              </button>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
