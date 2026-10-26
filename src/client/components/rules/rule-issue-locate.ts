/**
 * Bringing one rejected condition into view.
 *
 * The rule editor owns the condition fields and names them with localized
 * accessible labels (`条件 N`, `JSONPath`). A locate request therefore only has
 * to expand the owning rule (the panel does that by selecting it) and then find
 * that labelled group and its JSONPath input.
 *
 * Reading the labels rather than holding refs into another owner's components
 * keeps the editor free of a focus API it does not otherwise need, and it uses
 * the same names a screen-reader user hears. Nothing here edits a draft or
 * changes a rule.
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

/** The element the request should focus, when the editor has rendered it. */
function targetOf(conditionIndex: number | null): HTMLElement | null {
  if (conditionIndex === null) return null;
  const groups = document.querySelectorAll<HTMLElement>('[role="group"]');
  for (const group of groups) {
    const label = group.getAttribute('aria-label') ?? '';
    // `条件 N` is the editor's own accessible name for one condition.
    if (!/^(?:条件|Condition)\s+\d+$/u.test(label)) continue;
    if (!label.endsWith(String(conditionIndex + 1))) continue;
    // A rejected selector always lives in the JSONPath text field, so prefer it
    // over the target and matching-kind selects that come first in the group.
    const jsonPath = group.querySelector<HTMLElement>(
      'input[aria-label="JSONPath"]',
    );
    if (jsonPath !== null) return jsonPath;
    const firstField = group.querySelector<HTMLElement>(
      'input[aria-label], textarea[aria-label]',
    );
    return firstField ?? group;
  }
  return null;
}

/**
 * Focus the condition a rejected issue belongs to.
 *
 * Returns whether anything was found, so a caller can tell a locate that ran
 * from one whose rule or editor was not on screen.
 */
export function focusConditionField(conditionIndex: number | null): boolean {
  const target = targetOf(conditionIndex);
  if (target === null) return false;
  target.focus();
  // Scrolling is a convenience, not the location itself; a test environment
  // without it (jsdom) must still reach the focus assertion.
  if (typeof target.scrollIntoView === 'function')
    target.scrollIntoView({ block: 'nearest' });
  return true;
}
