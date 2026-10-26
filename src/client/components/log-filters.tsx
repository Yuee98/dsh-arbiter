import type { ReactNode } from 'react';
import { Button, Field, Select, TextInput } from './controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { RESULT_OPTIONS, verdictLabel } from '../log-list.js';
import type { LogQuery } from '../log-list.js';
import type { Translate } from '../i18n.js';

/** The session classifications the list offers, in display order. */
const SESSION_KIND_OPTIONS = ['', 'main', 'subagent'] as const;

/** The classification labels; an unrecognized value is never selectable. */
function sessionKindLabels(
  translate: Translate,
): Readonly<Record<string, string>> {
  return {
    '': translate('logs.sessionKinds.all'),
    main: translate('logs.sessionKinds.main'),
    subagent: translate('logs.sessionKinds.subagent'),
  };
}

/** One labelled control in the filter row. */
function FilterField(props: {
  readonly label: string;
  readonly width: number;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div style={{ width: props.width }}>
      <Field label={props.label}>{props.children}</Field>
    </div>
  );
}

/** A checkbox filter, so a shortcut reads as a question rather than a value. */
function FilterToggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <label
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        fontSize: 12.5,
        paddingBottom: 6,
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.target.checked);
        }}
      />
      {props.label}
    </label>
  );
}

/**
 * The confirmed filters above the list.
 *
 * Controls edit a draft, and only "apply" replaces the query the list is
 * reading. That keeps one request per confirmed filter instead of one per
 * keystroke, and makes "a filter change starts a new result set" a single place
 * in the panel rather than a property of every widget.
 */
export function LogFilters({
  draft,
  onDraft,
  onApply,
  onClear,
}: {
  readonly draft: LogQuery;
  readonly onDraft: (draft: LogQuery) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const labels: Record<string, string> = { '': t('logs.all') };
  for (const option of RESULT_OPTIONS) {
    if (option === '') continue;
    labels[option] = verdictLabel(t, option);
  }
  const edit = (patch: Partial<LogQuery>): void => {
    onDraft({ ...draft, ...patch });
  };
  return (
    <div
      role="group"
      aria-label={t('logs.filters.apply')}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      <FilterField label={t('logs.result')} width={170}>
        <Select
          value={draft.result}
          options={RESULT_OPTIONS}
          labels={labels}
          ariaLabel={t('logs.result')}
          onChange={(value) => {
            edit({ result: value });
          }}
        />
      </FilterField>
      <FilterField label={t('logs.search')} width={240}>
        <TextInput
          value={draft.query}
          onChange={(value) => {
            edit({ query: value });
          }}
          placeholder={t('logs.searchPlaceholder')}
          ariaLabel={t('logs.search')}
        />
      </FilterField>
      <FilterField label={t('logs.filters.tool')} width={120}>
        <TextInput
          value={draft.tool}
          onChange={(value) => {
            edit({ tool: value });
          }}
          placeholder={t('logs.filters.toolPlaceholder')}
          ariaLabel={t('logs.filters.tool')}
          monospace
        />
      </FilterField>
      <FilterField label={t('logs.filters.session')} width={160}>
        <TextInput
          value={draft.session}
          onChange={(value) => {
            edit({ session: value });
          }}
          placeholder={t('logs.filters.sessionPlaceholder')}
          ariaLabel={t('logs.filters.session')}
          monospace
        />
      </FilterField>
      <FilterField label={t('logs.filters.sessionKind')} width={130}>
        <Select
          value={draft.sessionKind}
          options={SESSION_KIND_OPTIONS}
          labels={sessionKindLabels(t)}
          ariaLabel={t('logs.filters.sessionKind')}
          onChange={(value) => {
            edit({ sessionKind: value });
          }}
        />
      </FilterField>
      <FilterField label={t('logs.filters.rule')} width={140}>
        <TextInput
          value={draft.rule}
          onChange={(value) => {
            edit({ rule: value });
          }}
          placeholder={t('logs.filters.rulePlaceholder')}
          ariaLabel={t('logs.filters.rule')}
          monospace
        />
      </FilterField>
      <FilterField label={t('logs.filters.from')} width={130}>
        <TextInput
          value={draft.from}
          onChange={(value) => {
            edit({ from: value });
          }}
          placeholder={t('logs.filters.datePlaceholder')}
          ariaLabel={t('logs.filters.from')}
        />
      </FilterField>
      <FilterField label={t('logs.filters.to')} width={130}>
        <TextInput
          value={draft.to}
          onChange={(value) => {
            edit({ to: value });
          }}
          placeholder={t('logs.filters.datePlaceholder')}
          ariaLabel={t('logs.filters.to')}
        />
      </FilterField>
      <FilterToggle
        label={t('logs.filters.denied')}
        checked={draft.deniedOnly}
        onChange={(checked) => {
          edit({ deniedOnly: checked });
        }}
      />
      <FilterToggle
        label={t('logs.filters.reviewFailure')}
        checked={draft.reviewFailureOnly}
        onChange={(checked) => {
          edit({ reviewFailureOnly: checked });
        }}
      />
      {/*
        Both controls stay enabled while a read is in flight: an operator who
        changes their mind should not have to wait for a slow request. The
        panel's request generation decides which answer wins, so an overlapping
        read is safe rather than a reason to block the interaction.
      */}
      <div style={{ paddingBottom: 1 }}>
        <Button onClick={onApply} tone="primary">
          {t('logs.filters.apply')}
        </Button>
      </div>
      <div style={{ paddingBottom: 1 }}>
        <Button onClick={onClear}>{t('logs.filters.clear')}</Button>
      </div>
    </div>
  );
}
