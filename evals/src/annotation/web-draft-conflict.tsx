import type { WebPoint } from './web-types.js';
import { copy } from './web-copy.js';
export function DraftConflict({
  newer,
  busy,
  onResolve,
}: {
  readonly newer: WebPoint;
  readonly busy: boolean;
  readonly onResolve: (keepLocal: boolean) => void;
}) {
  return (
    <section aria-label={copy.newerDraft}>
      <h3>{copy.newerDraft}</h3>
      <pre>{JSON.stringify(newer.form, null, 2)}</pre>
      {newer.publicationPending && <p>{copy.pendingRebase}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          onResolve(false);
        }}
      >
        {copy.adoptNewer}
      </button>
      <button
        type="button"
        disabled={busy || newer.publicationPending}
        onClick={() => {
          onResolve(true);
        }}
      >
        {copy.keepMine}
      </button>
    </section>
  );
}
