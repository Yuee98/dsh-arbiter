import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type { RuleVerdict } from '../../../types.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { Draft, DraftRule } from '../../view-types.js';
import { Button, Field, Notice, Select } from '../controls.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { VERDICT_BEHAVIOR_KEY, VERDICT_ORDER } from './draft.js';
import {
  callFields,
  draftRuleFromCall,
  initialSelection,
  unconstrainedFields,
} from './rule-from-call-model.js';
import type {
  CallField,
  RuleCallSource,
  UnconstrainedField,
} from './rule-from-call-model.js';

/**
 * The draft-from-call dialog: pick the recorded facts a rule should pin.
 *
 * The dialog owns no draft. It reports the rule it built and the caller decides
 * what that means, which is what keeps "cancel" from being an edit: until the
 * create action runs, nothing in the draft has moved.
 *
 * Everything the call contains is shown. A value the user leaves unchecked and a
 * value no exact condition can express are listed with the same weight, because
 * "this rule reproduces the call" is only true when nothing is left open, and a
 * silent omission would let a rule look narrower than it is.
 */
export function RuleFromCallDialog(props: {
  readonly source: RuleCallSource;
  readonly draft: Draft;
  readonly onCreate: (rule: DraftRule, test: boolean) => void;
  readonly onClose: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const fieldSet = useMemo(() => callFields(props.source), [props.source]);
  const [selected, setSelected] = useState<readonly string[]>(() =>
    initialSelection(fieldSet.fields),
  );
  const [verdict, setVerdict] = useState<RuleVerdict>('force-review');

  const unfixed = unconstrainedFields(fieldSet, selected);
  const rule = draftRuleFromCall({
    rules: props.draft.rules,
    fields: fieldSet.fields,
    selected,
    verdict,
    comment: props.source.callId,
  });

  const create = (test: boolean): void => {
    if (rule === null) return;
    props.onCreate(rule, test);
  };

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        data-rule-from-call=""
        surface="rule-from-call-dialog"
        closeLabel={t('rules.fromCallClose')}
        className="arb:flex arb:max-h-[85vh] arb:max-w-2xl arb:flex-col arb:gap-4 arb:overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t('rules.fromCallTitle')}</DialogTitle>
          <DialogDescription>
            {t('rules.fromCallDescription', {
              call: props.source.callId,
            })}
          </DialogDescription>
        </DialogHeader>

        <p
          data-rule-from-call-source={props.source.callId}
          className="arb:m-0 arb:text-xs arb:text-secondary"
        >
          {t('rules.fromCallSource', {
            tool: props.source.tool,
            call: props.source.callId,
          })}
        </p>

        <Field label={t('rules.fromCallRecorded')}>
          <pre
            data-rule-from-call-input=""
            className="arb:m-0 arb:max-h-40 arb:overflow-auto arb:whitespace-pre-wrap arb:rounded-md arb:bg-canvas arb:p-2.5 arb:font-mono arb:text-xs"
          >
            {props.source.sample.input}
          </pre>
        </Field>

        <Field label={t('rules.fromCallFields')}>
          <ul className="arb:m-0 arb:flex arb:list-none arb:flex-col arb:gap-1.5 arb:p-0">
            {fieldSet.fields.map((field) => (
              <li key={field.id}>
                <label className="arb:flex arb:cursor-pointer arb:items-start arb:gap-1.5 arb:text-xs arb:text-primary">
                  <input
                    type="checkbox"
                    checked={selected.includes(field.id)}
                    onChange={(event) => {
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, field.id]
                          : current.filter((id) => id !== field.id),
                      );
                    }}
                    className="arb:mt-0.5 arb:rounded arb:border-border-default arb:accent-accent"
                  />
                  <span className="arb:font-mono">{fieldText(field)}</span>
                </label>
              </li>
            ))}
          </ul>
        </Field>

        <p role="note" className="arb:m-0 arb:text-xs arb:text-secondary">
          {t('rules.fromCallCombine')}
        </p>

        <section
          aria-label={t('rules.fromCallUnfixed')}
          data-rule-from-call-unfixed={unfixed.length}
          className="arb:flex arb:flex-col arb:gap-1"
        >
          <h3 className="arb:m-0 arb:text-xs arb:font-semibold arb:text-primary">
            {t('rules.fromCallUnfixed')}
          </h3>
          {unfixed.length === 0 ? (
            <p className="arb:m-0 arb:text-xs arb:text-secondary">
              {t('rules.fromCallUnfixedNone')}
            </p>
          ) : (
            <ul className="arb:m-0 arb:flex arb:list-none arb:flex-col arb:gap-0.5 arb:p-0">
              {unfixed.map((entry) => (
                <li
                  key={`${entry.kind}-${entry.id}`}
                  data-rule-from-call-unfixed-entry={entry.kind}
                  className="arb:text-xs arb:text-secondary"
                >
                  {unfixedText(entry, t)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="arb:flex arb:flex-col arb:gap-1">
          <Field label={t('rules.fromCallBehavior')}>
            <Select
              ariaLabel={t('rules.fromCallBehavior')}
              value={verdict}
              options={VERDICT_ORDER}
              labels={{
                deny: t('rules.verdictOption.deny'),
                'force-ask': t('rules.verdictOption.forceAsk'),
                'force-review': t('rules.verdictOption.forceReview'),
                allow: t('rules.verdictOption.allow'),
              }}
              onChange={setVerdict}
            />
          </Field>
          <p
            role="note"
            data-rule-from-call-behavior={verdict}
            className="arb:m-0 arb:text-xs arb:text-secondary"
          >
            {t(VERDICT_BEHAVIOR_KEY[verdict])}
          </p>
        </div>

        {rule === null ? (
          <Notice kind="info" text={t('rules.fromCallEmptySelection')} />
        ) : null}

        <p role="note" className="arb:m-0 arb:text-xs arb:text-secondary">
          {t('rules.fromCallDraftNote')}
        </p>

        <div className="arb:flex arb:flex-wrap arb:items-center arb:justify-end arb:gap-2">
          <Button onClick={props.onClose}>{t('rules.fromCallCancel')}</Button>
          <Button
            disabled={rule === null}
            onClick={() => {
              create(false);
            }}
          >
            {t('rules.fromCallCreate')}
          </Button>
          <Button
            disabled={rule === null}
            tone="primary"
            onClick={() => {
              create(true);
            }}
          >
            {t('rules.fromCallCreateTest')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One pinnable value, keyed by the JSONPath the rule will carry. */
function fieldText(field: CallField): string {
  return `${field.label} = ${field.valueText}`;
}

/** Why one recorded value is not part of the rule, in the reader's words. */
function unfixedText(
  entry: UnconstrainedField,
  t: ReturnType<typeof useArbiterTranslation>,
): string {
  switch (entry.kind) {
    case 'deselected':
      return t('rules.fromCallUnfixedDeselected', { field: entry.label });
    case 'array':
      return t('rules.fromCallUnfixedArray', { field: entry.label });
    case 'empty-object':
      return t('rules.fromCallUnfixedEmptyObject', { field: entry.label });
    case 'too-deep':
      return t('rules.fromCallUnfixedNested', { field: entry.label });
    case 'too-many':
      return t('rules.fromCallUnfixedTooMany', { field: entry.label });
    case 'non-object-arguments':
      return t('rules.fromCallUnfixedNonObject');
  }
}
