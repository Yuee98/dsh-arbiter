import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  ChevronUp,
  Copy,
  FlaskConical,
  GripVertical,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { Draft, DraftRule } from '../../view-types.js';
import { Select, TextInput } from '../controls.js';
import { IconButton } from '../ui/button.js';
import { cn } from '../ui/cn.js';
import {
  VERDICT_LABEL_KEY,
  VERDICT_ORDER,
  addDuplicate,
  canMoveRule,
  moveRule,
  ruleName,
  ruleSummary,
  withRule,
} from './draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
  RuleIssue,
} from './draft.js';
import { RuleEditor } from './rule-editor.js';

export interface InlineDeleteRuleButtonProps {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly isArmed: boolean;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  readonly onDelete: () => void;
}

export function InlineDeleteRuleButton({
  ruleName,
  isArmed,
  onArm,
  onDisarm,
  onDelete,
}: InlineDeleteRuleButtonProps): ReactNode {
  const t = useArbiterTranslation();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isArmed) return;

    const timer = window.setTimeout(() => {
      onDisarm();
    }, 3000);

    const handlePointerDown = (event: PointerEvent) => {
      if (
        buttonRef.current &&
        event.target instanceof Node &&
        !buttonRef.current.contains(event.target)
      ) {
        onDisarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDisarm();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isArmed, onDisarm]);

  if (isArmed) {
    return (
      <button
        ref={buttonRef}
        type="button"
        data-confirming="true"
        aria-label={t('rules.confirmDeleteRule', { name: ruleName })}
        onClick={() => {
          onDelete();
        }}
        className="arb:inline-flex arb:h-7 arb:items-center arb:justify-center arb:rounded arb:border arb:border-error arb:bg-error arb:px-2 arb:py-1 arb:text-xs arb:font-medium arb:text-white arb:shadow-sm arb:hover:bg-error/90 arb:animate-in arb:fade-in-0"
      >
        {t('rules.confirmDeleteShort')}
      </button>
    );
  }

  return (
    <IconButton
      label={t('rules.deleteRule', { name: ruleName })}
      icon={Trash2}
      tone="danger"
      onClick={() => {
        onArm();
      }}
    />
  );
}

export interface RuleRowProps {
  readonly rule: DraftRule;
  readonly index: number;
  readonly rules: readonly DraftRule[];
  readonly issues: readonly RuleIssue[];
  readonly expanded: boolean;
  readonly isArmedDelete: boolean;
  readonly pendingExactTypes?: PendingExactTypeMap | undefined;
  readonly onSelect: (id: string | null) => void;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly onTest: (id: string, opener?: HTMLElement | null) => void;
  readonly onArmDelete: (ruleId: string) => void;
  readonly onDisarmDelete: () => void;
  readonly onDeleteRule: (ruleId: string) => void;
  readonly onPendingTypeChange?:
    | ((
        ruleId: string,
        conditionIndex: number,
        type: PendingExactType | null,
      ) => void)
    | undefined;
  readonly onRemoveCondition?:
    ((ruleId: string, conditionIndex: number) => void) | undefined;
}

export function RuleRow(props: RuleRowProps): ReactNode {
  const t = useArbiterTranslation();
  const bodyId = useId();
  const {
    rule,
    index,
    rules,
    expanded,
    isArmedDelete,
    onSelect,
    onDraft,
    onTest,
    onArmDelete,
    onDisarmDelete,
    onDeleteRule,
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id });

  const name = ruleName(rule, t);
  const summary = ruleSummary(rule, t);
  const hasError = props.issues.some((issue) => issue.severity === 'error');

  const update = (mutator: (next: DraftRule) => void): void => {
    onDraft((draft) => {
      withRule(draft, rule.id, mutator);
    });
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-rule-row={rule.id}
      data-rule-verdict={rule.verdict}
      className={cn(
        'arb:mb-2 arb:rounded-lg arb:border arb:border-border-subtle arb:bg-layer-2 arb:transition-colors',
        isDragging && 'arb:opacity-50',
      )}
    >
      <RuleRowToolbar
        rule={rule}
        index={index}
        rules={rules}
        name={name}
        summary={summary}
        expanded={expanded}
        isArmedDelete={isArmedDelete}
        bodyId={bodyId}
        attributes={attributes}
        listeners={listeners}
        onSelect={onSelect}
        onDraft={onDraft}
        onTest={onTest}
        onArmDelete={onArmDelete}
        onDisarmDelete={onDisarmDelete}
        onDeleteRule={onDeleteRule}
        update={update}
      />

      {hasError || rule.enabled === false ? (
        <div
          className={cn(
            'arb:px-3 arb:pb-2 arb:text-[11.5px]',
            hasError ? 'arb:text-error' : 'arb:text-tertiary',
          )}
        >
          {hasError ? t('rules.hasErrors') : t('rules.disabled')}
        </div>
      ) : null}

      {expanded ? (
        <div
          id={bodyId}
          className="arb:border-t arb:border-border-subtle arb:p-3"
        >
          <RuleEditor
            rule={rule}
            issues={props.issues}
            pendingExactTypes={props.pendingExactTypes}
            onPendingTypeChange={props.onPendingTypeChange}
            onRemoveCondition={props.onRemoveCondition}
            onChange={update}
          />
        </div>
      ) : null}
    </li>
  );
}

function RuleRowToolbar(props: {
  readonly rule: DraftRule;
  readonly index: number;
  readonly rules: readonly DraftRule[];
  readonly name: string;
  readonly summary: string;
  readonly expanded: boolean;
  readonly isArmedDelete: boolean;
  readonly bodyId: string;
  readonly attributes: ReturnType<typeof useSortable>['attributes'];
  readonly listeners: ReturnType<typeof useSortable>['listeners'];
  readonly onSelect: (id: string | null) => void;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly onTest: (id: string, opener?: HTMLElement | null) => void;
  readonly onArmDelete: (ruleId: string) => void;
  readonly onDisarmDelete: () => void;
  readonly onDeleteRule: (ruleId: string) => void;
  readonly update: (mutator: (next: DraftRule) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const {
    rule,
    index,
    rules,
    name,
    summary,
    expanded,
    isArmedDelete,
    bodyId,
    attributes,
    listeners,
    onSelect,
    onDraft,
    onTest,
    onArmDelete,
    onDisarmDelete,
    onDeleteRule,
    update,
  } = props;
  const labels = verdictLabels(t);

  return (
    <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-2 arb:p-2.5">
      <IconButton
        label={t('rules.dragRule', { name })}
        icon={GripVertical}
        disabled={
          !canMoveRule(rules, index, -1) && !canMoveRule(rules, index, 1)
        }
        className="arb:cursor-grab arb:active:cursor-grabbing"
        {...attributes}
        {...listeners}
      />

      <input
        type="checkbox"
        aria-label={t('rules.enabledRule', { name })}
        checked={rule.enabled !== false}
        onChange={(event) => {
          onDisarmDelete();
          update((next) => {
            next.enabled = event.target.checked;
          });
        }}
        className="arb:rounded arb:border-border-default arb:accent-accent"
      />

      <div className="arb:flex arb:min-w-[180px] arb:flex-1 arb:items-center arb:gap-1.5">
        <div
          className="arb:flex-1"
          title={`${summary}\n${t('rules.nameTitle')}`}
        >
          <TextInput
            ariaLabel={t('rules.name')}
            value={rule.name ?? ''}
            placeholder={summary}
            onChange={(value) => {
              onDisarmDelete();
              update((next) => {
                if (value.trim().length === 0) delete next.name;
                else next.name = value;
              });
            }}
          />
        </div>
        {rule.name !== undefined ? (
          <IconButton
            label={t('rules.restoreName')}
            icon={RotateCcw}
            onClick={() => {
              onDisarmDelete();
              update((next) => {
                delete next.name;
              });
            }}
          />
        ) : null}
      </div>

      <div className="arb:w-32">
        <Select
          ariaLabel={t('rules.verdictRule', { name })}
          value={rule.verdict}
          options={VERDICT_ORDER}
          labels={labels}
          onChange={(value) => {
            onDisarmDelete();
            update((next) => {
              next.verdict = value;
            });
          }}
        />
      </div>

      <IconButton
        label={t('rules.testRule', { name })}
        icon={FlaskConical}
        onClick={(event) => {
          onDisarmDelete();
          onTest(rule.id, event.currentTarget);
        }}
      />

      <IconButton
        label={
          expanded
            ? t('rules.collapseRule', { name })
            : t('rules.editRule', { name })
        }
        icon={expanded ? ChevronUp : Pencil}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => {
          onDisarmDelete();
          onSelect(expanded ? null : rule.id);
        }}
      />

      <IconButton
        label={t('rules.moveUpRule', { name })}
        icon={ArrowUp}
        disabled={!canMoveRule(rules, index, -1)}
        onClick={() => {
          onDisarmDelete();
          onDraft((draft) => {
            moveRule(draft.rules, index, -1);
          });
        }}
      />

      <IconButton
        label={t('rules.moveDownRule', { name })}
        icon={ArrowDown}
        disabled={!canMoveRule(rules, index, 1)}
        onClick={() => {
          onDisarmDelete();
          onDraft((draft) => {
            moveRule(draft.rules, index, 1);
          });
        }}
      />

      <IconButton
        label={t('rules.duplicateRule', { name })}
        icon={Copy}
        onClick={() => {
          onDisarmDelete();
          onDraft((draft) => {
            addDuplicate(draft, rule);
          });
        }}
      />

      <InlineDeleteRuleButton
        ruleId={rule.id}
        ruleName={name}
        isArmed={isArmedDelete}
        onArm={() => {
          onArmDelete(rule.id);
        }}
        onDisarm={() => {
          onDisarmDelete();
        }}
        onDelete={() => {
          onDeleteRule(rule.id);
        }}
      />
    </div>
  );
}

function verdictLabels(t: Translate): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const verdict of VERDICT_ORDER) {
    labels[verdict] = t(VERDICT_LABEL_KEY[verdict]);
  }
  return labels;
}
