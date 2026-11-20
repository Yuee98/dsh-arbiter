import type { WebForm } from './web-types.js';
import { matrixPreview } from './web-form.js';
import {
  behaviourLabels,
  copy,
  matrixLabels,
  stateLabels,
} from './web-copy.js';

export function LabelForm({
  form,
  reviewer,
  onReviewer,
  date,
  sampled,
  disabled,
  confirmDisabled,
  onChange,
  onSample,
  onConfirm,
  onConfirmNext,
}: {
  readonly form: WebForm;
  readonly reviewer: string;
  readonly onReviewer: (value: string) => void;
  readonly date: string | null;
  readonly sampled: boolean;
  readonly disabled: boolean;
  readonly confirmDisabled: boolean;
  readonly onChange: (form: WebForm) => void;
  readonly onSample: (sampled: boolean) => void;
  readonly onConfirm: () => void;
  readonly onConfirmNext: () => void;
}) {
  const preview = matrixPreview(form.pairs);
  const outcome =
    preview === null
      ? copy.invalidPairs
      : [...new Set(preview)]
          .map((verdict) => matrixLabels[verdict])
          .join(' / ');
  const cannotConfirm =
    disabled ||
    confirmDisabled ||
    reviewer.trim() === '' ||
    preview === null ||
    (form.state === 'confirmed' &&
      (form.noScores === true ? form.behaviour === '' : preview.length === 0));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!cannotConfirm) onConfirm();
      }}
    >
      <fieldset disabled={disabled}>
        <label>
          {copy.pairs}
          <textarea
            disabled={form.noScores === true}
            value={form.pairs}
            onChange={(event) => {
              onChange({ ...form, pairs: event.target.value });
            }}
          />
        </label>
        {outcome !== '' && (
          <p className="matrix-preview">
            {copy.matrixResult} {outcome}
          </p>
        )}
        <details className="annotation-detail">
          <summary>{copy.optionalDecision}</summary>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.noScores === true}
              onChange={(event) => {
                onChange({
                  ...form,
                  noScores: event.target.checked,
                  pairs: event.target.checked ? '' : form.pairs,
                });
              }}
            />
            {copy.noScores}
          </label>
          <label>
            {copy.behaviour}
            <select
              value={form.behaviour}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === '' ||
                  value === 'allow' ||
                  value === 'deny' ||
                  value === 'escalate' ||
                  value === 'insufficient-material' ||
                  value === 'review-failure'
                )
                  onChange({ ...form, behaviour: value });
              }}
            >
              <option value="">{copy.choose}</option>
              {Object.entries(behaviourLabels)
                .filter(([value]) => value !== '')
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {copy.rationale}
            <textarea
              value={form.rationale}
              onChange={(event) => {
                onChange({ ...form, rationale: event.target.value });
              }}
            />
          </label>
          <label>
            {copy.evidence}
            <textarea
              value={form.evidence}
              onChange={(event) => {
                onChange({ ...form, evidence: event.target.value });
              }}
            />
          </label>
          <label>
            {copy.state}
            <select
              value={form.state}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'confirmed' ||
                  value === 'disputed' ||
                  value === 'undecidable' ||
                  value === 'needs-review'
                )
                  onChange({ ...form, state: value });
              }}
            >
              {Object.entries(stateLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={sampled}
              onChange={(event) => {
                onSample(event.target.checked);
              }}
            />
            {copy.sampled}
          </label>
          <p>
            {copy.date} {date ?? copy.noDecisionDate}
          </p>
        </details>
        <label>
          {copy.author}
          <input
            value={reviewer}
            onChange={(event) => {
              onReviewer(event.target.value);
            }}
            maxLength={1000}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={cannotConfirm}>
            {copy.confirm}
          </button>
          <button
            type="button"
            disabled={cannotConfirm}
            onClick={onConfirmNext}
          >
            {copy.confirmNext}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
