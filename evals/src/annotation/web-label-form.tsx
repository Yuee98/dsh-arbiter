import type { WebForm } from './web-types.js';
import { copy, stateLabels } from './web-copy.js';

export function LabelForm({
  form,
  date,
  sampled,
  disabled,
  onChange,
  onSample,
  onConfirm,
  onConfirmNext,
}: {
  readonly form: WebForm;
  readonly date: string | null;
  readonly sampled: boolean;
  readonly disabled: boolean;
  readonly onChange: (form: WebForm) => void;
  readonly onSample: (sampled: boolean) => void;
  readonly onConfirm: () => void;
  readonly onConfirmNext: () => void;
}) {
  const invalid =
    form.author.trim() === '' ||
    form.rationale.trim() === '' ||
    (form.state === 'confirmed' &&
      (form.behaviour === '' ||
        (form.noScores !== true &&
          (form.pairs.trim() === '' || form.evidence.trim() === ''))));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <fieldset disabled={disabled}>
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
          {copy.pairs}
          <textarea
            disabled={form.noScores === true}
            value={form.pairs}
            onChange={(event) => {
              onChange({ ...form, pairs: event.target.value });
            }}
          />
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
            {[
              'allow',
              'deny',
              'escalate',
              'insufficient-material',
              'review-failure',
            ].map((value) => (
              <option key={value} value={value}>
                {value}
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
          {copy.author}
          <input
            value={form.author}
            onChange={(event) => {
              onChange({ ...form, author: event.target.value });
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
        <button type="submit" disabled={invalid}>
          {copy.confirm}
        </button>
        <button type="button" disabled={invalid} onClick={onConfirmNext}>
          {copy.confirmNext}
        </button>
      </fieldset>
    </form>
  );
}
