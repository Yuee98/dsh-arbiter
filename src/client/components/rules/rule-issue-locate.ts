/**
 * Bringing one rejected condition into view.
 *
 * The rule editor owns the condition fields and names them with localized
 * accessible labels (`条件 N`, `JSONPath`); each row already carries its rule id
 * as `data-rule-row`. A locate request therefore only has to expand the owning
 * rule (the panel does that by selecting it) and then, inside that row, find the
 * labelled condition group and its JSONPath field.
 *
 * Reading the editor's own names rather than threading refs into it keeps that
 * component free of a focus API it does not otherwise need, and it uses the same
 * words a screen-reader user hears. The labels are passed in rather than
 * hardcoded, so a locale change moves both together. Nothing here edits a draft
 * or changes a rule.
 */

/** What a locate action asks the panel to reveal. */
export interface LocateRequest {
  /** The rule to expand, resolved when the error arrived. */
  readonly ruleId: string | null;
  /** The condition inside that rule, or null for a rule-level issue. */
  readonly conditionIndex: number | null;
  /** Bumped per request so asking twice for the same issue is a new action. */
  readonly nonce: number;
}

/** The labels the editor actually renders, supplied by the caller's translator. */
export interface LocateLabels {
  /** The condition group's accessible name, e.g. `条件 2`. */
  readonly condition: (index: number) => string;
  /** The JSONPath field's accessible name. */
  readonly jsonPath: string;
}

/** The row of one rule, when it is on screen. */
function ruleRow(ruleId: string, root: ParentNode): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>('[data-rule-row]')) {
    if (row.getAttribute('data-rule-row') === ruleId) return row;
  }
  return null;
}

/** A field inside one condition group, matched by its accessible name. */
function labelledField(group: HTMLElement, label: string): HTMLElement | null {
  for (const field of group.querySelectorAll<HTMLElement>('input, textarea')) {
    if (field.getAttribute('aria-label') === label) return field;
  }
  return null;
}

/** The condition group a rejected selector belongs to, inside that rule's row. */
function conditionGroup(
  ruleId: string,
  conditionIndex: number,
  labels: LocateLabels,
  root: ParentNode,
): HTMLElement | null {
  const row = ruleRow(ruleId, root);
  if (row === null) return null;
  const wanted = labels.condition(conditionIndex);
  for (const group of row.querySelectorAll<HTMLElement>('[role="group"]')) {
    if (group.getAttribute('aria-label') === wanted) return group;
  }
  return null;
}

/**
 * Focus the condition a rejected issue belongs to.
 *
 * Returns whether a field was found, so a caller can tell a locate that ran from
 * one whose rule or editor was not on screen.
 */
export function focusConditionField(
  request: Pick<LocateRequest, 'ruleId' | 'conditionIndex'>,
  labels: LocateLabels,
  root: ParentNode = document,
): boolean {
  const { ruleId, conditionIndex } = request;
  if (ruleId === null || conditionIndex === null) return false;
  const group = conditionGroup(ruleId, conditionIndex, labels, root);
  if (group === null) return false;
  // A rejected selector always lives in the JSONPath text field, so prefer it
  // over the target and matching-kind selects that come first in the group.
  const field =
    labelledField(group, labels.jsonPath) ??
    group.querySelector<HTMLElement>(
      'input[aria-label], textarea[aria-label]',
    ) ??
    group;
  field.focus();
  // Scrolling is a convenience, not the location itself; a test environment
  // without it (jsdom) must still reach the focus assertion.
  if (typeof field.scrollIntoView === 'function')
    field.scrollIntoView({ block: 'nearest' });
  return true;
}
