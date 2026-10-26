import type { ReactNode } from 'react';

export function Section(props: {
  readonly title: string;
  readonly description?: string;
  /** An accessible name, so the block is a landmark the page can be read by. */
  readonly ariaLabel?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      {...(props.ariaLabel === undefined
        ? {}
        : { 'aria-label': props.ariaLabel })}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginBottom: 24,
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {props.title}
        </h3>
        {props.description === undefined ? null : (
          <p
            style={{
              margin: '4px 0 0',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 12.5,
            }}
          >
            {props.description}
          </p>
        )}
      </div>
      {props.children}
    </section>
  );
}

export function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12.5,
      }}
    >
      <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
        {props.label}
      </span>
      {props.children}
      {props.hint === undefined ? null : (
        <span
          style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
        >
          {props.hint}
        </span>
      )}
    </label>
  );
}

export const inputStyle = {
  boxSizing: 'border-box' as const,
  height: 30,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  padding: '0 8px',
  fontSize: 12.5,
  width: '100%',
};

export function TextInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly placeholder?: string;
  readonly monospace?: boolean;
  readonly ariaLabel?: string;
}): ReactNode {
  return (
    <input
      type="text"
      aria-label={props.ariaLabel}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => {
        props.onChange(event.target.value);
      }}
      onBlur={props.onBlur}
      style={{
        ...inputStyle,
        fontFamily:
          props.monospace === true
            ? 'var(--dsw-font-mono, monospace)'
            : undefined,
      }}
    />
  );
}

export function NumberInput(props: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}): ReactNode {
  return (
    <input
      type="number"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) props.onChange(next);
      }}
      style={inputStyle}
    />
  );
}

export function Select<T extends string>(props: {
  readonly value: string;
  readonly options: readonly T[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly ariaLabel?: string;
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => {
        const option = props.options.find(
          (candidate) => candidate === event.target.value,
        );
        if (option !== undefined) props.onChange(option);
      }}
      style={inputStyle}
    >
      {props.options.map((option) => (
        <option key={option} value={option}>
          {props.labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

export function Button(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'danger' | 'plain';
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        height: 30,
        padding: '0 12px',
        borderRadius: 6,
        cursor: props.disabled === true ? 'default' : 'pointer',
        opacity: props.disabled === true ? 0.5 : 1,
        fontSize: 12.5,
        border:
          props.tone === 'primary'
            ? '0.5px solid var(--dsw-alias-state-business-primary)'
            : '0.5px solid var(--dsw-alias-border-l4)',
        background:
          props.tone === 'primary'
            ? 'var(--dsw-alias-state-business-primary)'
            : props.tone === 'danger'
              ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
              : 'var(--dsw-alias-bg-layer-3)',
        color:
          props.tone === 'primary'
            ? 'var(--dsw-alias-label-primary-foreground, white)'
            : props.tone === 'danger'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-primary)',
      }}
    >
      {props.children}
    </button>
  );
}

export function Notice(props: {
  readonly kind: 'ok' | 'error' | 'info';
  readonly text: string;
}): ReactNode {
  const color =
    props.kind === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : props.kind === 'ok'
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-label-secondary)';
  return (
    <div
      role="status"
      style={{
        border: `0.5px solid ${color}`,
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 12.5,
        color,
        whiteSpace: 'pre-wrap',
      }}
    >
      {props.text}
    </div>
  );
}

export function JsonBlock(props: { readonly value: unknown }): ReactNode {
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        maxHeight: 360,
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-module-platform)',
        borderRadius: 6,
        fontSize: 11.5,
        fontFamily: 'var(--dsw-font-mono, monospace)',
        whiteSpace: 'pre-wrap',
      }}
    >
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}
