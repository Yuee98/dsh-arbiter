import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { DraftRule, RuleListProps } from '../../view-types.js';
import { reorderRuleWithinVerdict, ruleIssues } from './draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
  RuleIssue,
} from './draft.js';
import { RuleRow } from './rule-row.js';

export interface ExtendedRuleListProps extends RuleListProps {
  readonly pendingExactTypes?: PendingExactTypeMap | undefined;
  readonly onPendingTypeChange?:
    | ((
        ruleId: string,
        conditionIndex: number,
        type: PendingExactType | null,
      ) => void)
    | undefined;
  readonly onRemoveCondition?:
    ((ruleId: string, conditionIndex: number) => void) | undefined;
  readonly onDeleteRule?: ((ruleId: string) => void) | undefined;
}

export function RuleList(props: ExtendedRuleListProps): ReactNode {
  const t = useArbiterTranslation();
  const {
    draft,
    selectedId,
    onSelect,
    onDraft,
    onTest,
    pendingExactTypes,
    onPendingTypeChange,
    onRemoveCondition,
    onDeleteRule,
  } = props;

  const [armedDeleteRuleId, setArmedDeleteRuleId] = useState<string | null>(
    null,
  );

  const clearArmedDelete = (): void => {
    setArmedDeleteRuleId(null);
  };

  useEffect(() => {
    if (
      armedDeleteRuleId !== null &&
      !draft.rules.some((r) => r.id === armedDeleteRuleId)
    ) {
      setArmedDeleteRuleId(null);
    }
  }, [armedDeleteRuleId, draft.rules]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (): void => {
    clearArmedDelete();
  };

  const handleDragCancel = (): void => {
    clearArmedDelete();
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    clearArmedDelete();
    const { active, over } = event;
    if (over !== null && active.id !== over.id) {
      const activeRule = draft.rules.find((r) => r.id === String(active.id));
      const overRule = draft.rules.find((r) => r.id === String(over.id));
      if (
        activeRule !== undefined &&
        overRule !== undefined &&
        activeRule.verdict === overRule.verdict
      ) {
        onDraft((d) => {
          reorderRuleWithinVerdict(d.rules, String(active.id), String(over.id));
        });
      }
    }
  };

  if (draft.rules.length === 0) {
    return (
      <p className="arb:m-0 arb:text-xs arb:text-tertiary">
        {t('rules.empty')}
      </p>
    );
  }

  const handleDeleteRule = (ruleId: string): void => {
    clearArmedDelete();
    if (onDeleteRule !== undefined) {
      onDeleteRule(ruleId);
    } else {
      onDraft((d) => {
        const at = d.rules.findIndex((candidate) => candidate.id === ruleId);
        if (at >= 0) d.rules.splice(at, 1);
      });
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext
        items={draft.rules.map((r) => r.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          aria-label={t('rules.title')}
          className="arb:m-0 arb:list-none arb:p-0"
        >
          {draft.rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={index}
              rules={draft.rules}
              issues={ruleIssuesOf(rule, index, props)}
              expanded={selectedId === rule.id}
              isArmedDelete={armedDeleteRuleId === rule.id}
              pendingExactTypes={pendingExactTypes}
              onSelect={onSelect}
              onDraft={onDraft}
              onTest={onTest}
              onArmDelete={(id) => {
                setArmedDeleteRuleId(id);
              }}
              onDisarmDelete={clearArmedDelete}
              onDeleteRule={handleDeleteRule}
              onPendingTypeChange={onPendingTypeChange}
              onRemoveCondition={onRemoveCondition}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function ruleIssuesOf(
  rule: DraftRule,
  index: number,
  props: RuleListProps,
): readonly RuleIssue[] {
  return [
    ...ruleIssues(
      (props.errors ?? []).map((issue) => ({
        issue,
        field: issue.path,
        severity: 'error' as const,
      })),
      rule,
      index,
    ),
    ...ruleIssues(
      (props.warnings ?? []).map((issue) => ({
        issue,
        field: issue.path,
        severity: 'warning' as const,
      })),
      rule,
      index,
    ),
  ];
}
