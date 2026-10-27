import type { ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import { cn } from './ui/cn.js';

export function Section(props: {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section
      {...(props.ariaLabel === undefined
        ? {}
        : { 'aria-label': props.ariaLabel })}
      className="arb:mb-6 arb:flex arb:flex-col arb:gap-3"
    >
      {(props.title !== undefined || props.description !== undefined) && (
        <div>
          {props.title !== undefined && (
            <h3 className="arb:m-0 arb:text-sm arb:font-semibold arb:text-primary">
              {props.title}
            </h3>
          )}
          {props.description === undefined ? null : (
            <p className="arb:mt-1 arb:text-xs arb:text-secondary">
              {props.description}
            </p>
          )}
        </div>
      )}
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
    <label className="arb:flex arb:flex-col arb:gap-1 arb:text-xs">
      <span className="arb:text-secondary">{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : (
        <span className="arb:text-[11px] arb:text-tertiary">{props.hint}</span>
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

export const inputClassName =
  'arb:h-[30px] arb:w-full arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:px-2 arb:text-xs arb:text-primary arb:focus:border-accent arb:focus:outline-none arb:disabled:cursor-not-allowed arb:disabled:opacity-50';

export function TextInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: (() => void) | undefined;
  readonly placeholder?: string | undefined;
  readonly monospace?: boolean | undefined;
  readonly ariaLabel?: string | undefined;
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
      className={cn(
        inputClassName,
        props.monospace === true && 'arb:font-mono',
      )}
    />
  );
}

export function NumberInput(props: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly ariaLabel?: string;
}): ReactNode {
  const [editingText, setEditingText] = useState<string | null>(null);

  return (
    <input
      type="number"
      aria-label={props.ariaLabel}
      value={editingText ?? String(props.value)}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={(event) => {
        setEditingText(event.target.value);
        if (event.target.value.trim() !== '') {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(next);
        }
      }}
      onBlur={() => {
        setEditingText(null);
      }}
      className={inputClassName}
    />
  );
}

export function Select<T extends string>(props: {
  readonly value: string;
  readonly options: readonly T[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}): ReactNode {
  return (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => {
        const option = props.options.find(
          (candidate) => candidate === event.target.value,
        );
        if (option !== undefined) props.onChange(option);
      }}
      className={inputClassName}
    >
      {props.options.map((option) => (
        <option key={option} value={option}>
          {props.labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly tone?: 'primary' | 'danger' | 'plain' | undefined;
  readonly type?: 'button' | 'submit' | undefined;
  readonly className?: string | undefined;
  readonly 'aria-label'?: string | undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    return (
      <button
        ref={ref}
        type={props.type ?? 'button'}
        onClick={props.onClick}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        className={cn(
          'arb:inline-flex arb:h-[30px] arb:items-center arb:justify-center arb:rounded-md arb:px-3 arb:text-xs arb:font-medium arb:transition-colors arb:focus-visible:outline-none arb:focus-visible:ring-1 arb:focus-visible:ring-accent arb:disabled:cursor-default arb:disabled:opacity-50',
          props.tone === 'primary' &&
            'arb:border arb:border-accent arb:bg-accent arb:text-accent-foreground arb:hover:opacity-90',
          props.tone === 'danger' &&
            'arb:border arb:border-error arb:bg-error/10 arb:text-error arb:hover:bg-error/20',
          (props.tone === undefined || props.tone === 'plain') &&
            'arb:border arb:border-border-default arb:bg-layer-3 arb:text-primary arb:hover:bg-layer-4',
          props.className,
        )}
      >
        {props.children}
      </button>
    );
  },
);

export function Notice(props: {
  readonly kind: 'ok' | 'error' | 'info';
  readonly text: string;
}): ReactNode {
  const toneClass =
    props.kind === 'error'
      ? 'arb:border-error arb:text-error'
      : props.kind === 'ok'
        ? 'arb:border-success arb:text-success'
        : 'arb:border-border-default arb:text-secondary';
  return (
    <div
      role="status"
      className={cn(
        'arb:rounded-md arb:border arb:p-2.5 arb:text-xs arb:whitespace-pre-wrap',
        toneClass,
      )}
    >
      {props.text}
    </div>
  );
}

export function JsonBlock(props: { readonly value: unknown }): ReactNode {
  return (
    <pre className="arb:m-0 arb:max-h-[360px] arb:overflow-auto arb:rounded-md arb:bg-canvas arb:p-2.5 arb:font-mono arb:text-xs arb:whitespace-pre-wrap">
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}
