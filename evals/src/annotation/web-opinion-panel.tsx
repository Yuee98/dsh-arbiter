import type { WebOpinion } from './web-types.js';
import { copy } from './web-copy.js';

export function OpinionPanel({
  opinions,
  busy,
  loaded,
  onLoad,
  onSelect,
}: {
  readonly opinions: readonly WebOpinion[];
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly onLoad: () => void;
  readonly onSelect: (opinion: WebOpinion) => void;
}) {
  return (
    <section>
      <button type="button" onClick={onLoad} disabled={busy}>
        {copy.opinions}
      </button>
      {loaded && opinions.length === 0 && <p>{copy.noOpinions}</p>}
      {opinions.map((opinion) => (
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
    </section>
  );
}
