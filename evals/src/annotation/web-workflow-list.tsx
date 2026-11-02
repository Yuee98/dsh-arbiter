import { useState } from 'react';
import type { WebPointSummary } from './web-types.js';
import { copy, statusLabels } from './web-copy.js';

export function WorkflowList({
  points,
  current,
  assisted,
  disagreements,
  busy,
  onOpen,
}: {
  readonly points: readonly WebPointSummary[];
  readonly current: string | null;
  readonly assisted: boolean;
  readonly disagreements: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onOpen: (token: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const visible = points.filter(
    (point) =>
      filter === 'all' ||
      (filter === 'pending' &&
        !['confirmed', 'disputed', 'needs-review', 'undecidable'].includes(
          point.status,
        )) ||
      (filter === 'sampled' && point.sampled) ||
      (filter === 'disagreements' && disagreements.has(point.token)) ||
      point.status === filter,
  );
  return (
    <nav aria-label={copy.workflows}>
      <h2>{copy.workflows}</h2>
      <p>
        {points.filter((point) => point.status === 'confirmed').length} /{' '}
        {points.length} {copy.progress}
      </p>
      <label>
        {copy.filter}
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        >
          <option value="all">{copy.all}</option>
          <option value="pending">{copy.pending}</option>
          <option value="confirmed">{copy.reviewed}</option>
          <option value="needs-review">{copy.needsReview}</option>
          <option value="disputed">{copy.disputed}</option>
          <option value="sampled">{copy.sampled}</option>
          {assisted && (
            <option value="disagreements">{copy.disagreements}</option>
          )}
        </select>
      </label>
      <ol>
        {visible.map((point) => (
          <li key={point.token}>
            <button
              type="button"
              disabled={busy}
              aria-current={current === point.token ? 'step' : undefined}
              onClick={() => {
                onOpen(point.token);
              }}
            >
              {copy.workflow} {point.workflow} / {copy.point} {point.position} ·{' '}
              {statusLabels[point.status]}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
