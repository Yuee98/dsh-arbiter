import type { WebForm } from './web-types.js';
import { copy, stateLabels } from './web-copy.js';

export function LabelForm({
  form,
  sampled,
  disabled,
  onChange,
  onSample,
  onConfirm,
}: {
  readonly form: WebForm;
  readonly sampled: boolean;
  readonly disabled: boolean;
  readonly onChange: (form: WebForm) => void;
  readonly onSample: (sampled: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <fieldset disabled={disabled}>
        <label>
          {copy.pairs}
          <textarea
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
          {copy.date} {new Date().toISOString().slice(0, 10)}
        </p>
        <button
          type="submit"
          disabled={
            form.author.trim() === '' ||
            form.rationale.trim() === '' ||
            (form.state === 'confirmed' &&
              (form.pairs.trim() === '' ||
                form.behaviour === '' ||
                form.evidence.trim() === ''))
          }
        >
          {copy.confirm}
        </button>
      </fieldset>
    </form>
  );
}
