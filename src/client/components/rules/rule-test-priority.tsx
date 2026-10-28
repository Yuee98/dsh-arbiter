import type { ReactNode } from 'react';

import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { DraftRule, RuleTestResultView } from '../../view-types.js';
import {
  coverageDetail,
  priorityView,
  verdictLabel,
} from './rule-test-model.js';
import type { CoverageDetail, PriorityLevel } from './rule-test-model.js';

/**
 * The whole-config precedence beside this answer.
 *
 * The list is fixed, so it also teaches the order a reader has to know before
 * writing a rule: a wide `force-review` really does outrank a narrow `allow`.
 * Each level says what it did for this call, which is the part a rule list alone
 * cannot show.
 */
export function PriorityBlock(props: {
  readonly result: RuleTestResultView;
  readonly rule: DraftRule | null;
}): ReactNode {
  const t = useArbiterTranslation();
  const levels = priorityView(props.result, props.rule?.id ?? null);
  return (
    <div
      data-testid="rule-test-priority"
      className="arb:flex arb:flex-col arb:gap-0.5 arb:rounded-md arb:border arb:border-border-default arb:p-2 arb:text-xs"
    >
      <strong>{t('ruleTest.priorityTitle')}</strong>
      <ol className="arb:m-0 arb:list-none arb:p-0 arb:flex arb:flex-col arb:gap-0.5">
        {levels.map((level) => (
          <li
            key={level.kind === 'fallback' ? 'fallback' : (level.verdict ?? '')}
            data-arbiter-test-priority={
              level.kind === 'fallback' ? 'fallback' : (level.verdict ?? '')
            }
            data-arbiter-test-priority-decision={level.decision}
            className="arb:flex arb:flex-wrap arb:items-center arb:gap-1.5"
          >
            <span className="arb:font-mono">
              {level.verdict === null
                ? t('ruleTest.priorityFallback')
                : verdictLabel(level.verdict, t)}
            </span>
            <span className="arb:text-secondary">
              {priorityDecisionText(level, t)}
            </span>
            {level.focused ? (
              <span className="arb:text-tertiary">
                {t('ruleTest.priorityCurrent')}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the call offered and what an `allow` actually covered.
 *
 * The effective allow's own match text is not the same claim as "the whole call
 * is allowed": in `cmd1 && cmd2` the second command still decides the path. The
 * block therefore lists every command the parse published, marks the ones the
 * allow named, and states which conclusion follows.
 */
/**
 * What this level did, stated separately for each finding.
 *
 * The distinct cases are the point: a rule that could not be determined is not a
 * non-match, another match at the winning tier was not outranked, and an `allow`
 * that left the call in review lost on coverage rather than on priority.
 */
function priorityDecisionText(level: PriorityLevel, t: Translate): string {
  switch (level.decision) {
    case 'effective':
      return level.winnerId === null
        ? t('ruleTest.priorityFallbackEffective')
        : t('ruleTest.priorityEffective', { ids: level.winnerId });
    case 'tier-match':
      return t('ruleTest.priorityTierMatch', {
        ids: [level.winnerId ?? '', ...level.otherIds]
          .filter((id) => id.length > 0)
          .join(', '),
      });
    case 'shadowed':
      return t('ruleTest.priorityShadowed', {
        ids: [level.winnerId ?? '', ...level.otherIds]
          .filter((id) => id.length > 0)
          .join(', '),
      });
    case 'insufficient-coverage':
      return t('ruleTest.priorityInsufficientCoverage');
    case 'unknown':
      return t('ruleTest.priorityUnknown', {
        ids: level.unknownIds.join(', '),
      });
    case 'none':
      return t('ruleTest.priorityNone');
  }
}

export function CoverageBlock(props: {
  readonly result: RuleTestResultView;
}): ReactNode {
  const t = useArbiterTranslation();
  const detail = coverageDetail(props.result);
  return (
    <div
      data-testid="rule-test-coverage"
      data-arbiter-test-coverage={detail.state}
      className="arb:flex arb:flex-col arb:gap-0.5 arb:rounded-md arb:border arb:border-border-default arb:p-2 arb:text-xs"
    >
      <strong>{t('ruleTest.coverageTitle')}</strong>
      {detail.structural ? (
        <>
          <span className="arb:text-secondary">
            {t('ruleTest.coverageNodes', {
              named: detail.namedCount,
              total: detail.total,
            })}
          </span>
          <ul className="arb:m-0 arb:list-none arb:p-0">
            {detail.nodes.map((node) => (
              <li
                key={node.index}
                className="arb:font-mono"
                data-arbiter-test-coverage-node={
                  node.named ? 'named' : 'unnamed'
                }
              >
                {node.named
                  ? t('ruleTest.coverageNodeNamed', { text: node.text })
                  : t('ruleTest.coverageNodeUnnamed', { text: node.text })}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <span className="arb:text-secondary">
          {t('ruleTest.coverageNoStructure')}
        </span>
      )}
      <span
        className="arb:text-secondary"
        data-arbiter-test-coverage-state={detail.state}
      >
        {coverageConclusion(detail, t)}
      </span>
    </div>
  );
}

/**
 * The sentence the evaluator's own classification supports.
 *
 * The text never infers coverage from the node list: `partial` and `incomplete`
 * are separate answers from the engine, and a call whose path is `deny` or
 * `force-ask` never makes a coverage claim at all.
 */
function coverageConclusion(detail: CoverageDetail, t: Translate): string {
  switch (detail.state) {
    case 'complete':
      return t('ruleTest.coverageComplete');
    case 'incomplete':
      return t('ruleTest.coverageIncomplete');
    case 'unresolved':
      return t('ruleTest.coverageUnresolved');
    case 'partial':
      return coveragePartialText(detail, t);
    case 'unknown-structure':
      return t('ruleTest.coverageNoEvidence');
    case 'not-allow':
      return t('ruleTest.coverageNotAllow');
  }
}

/**
 * Why an `allow` that matched did not cover the call.
 *
 * Unnamed commands are only one possible cause. A redirect or an assignment is a
 * separate structural target that a command match never authorizes, so the
 * sentence names that instead of implying a missing command.
 */
function coveragePartialText(detail: CoverageDetail, t: Translate): string {
  const unnamed = detail.total - detail.namedCount;
  if (detail.otherTargets.length > 0)
    return t('ruleTest.coveragePartialOther', {
      targets: detail.otherTargets
        .map((target) =>
          t(
            target === 'file_redirect'
              ? 'rules.targetOption.fileRedirect'
              : 'rules.targetOption.variableAssignment',
          ),
        )
        .join(', '),
    });
  return t('ruleTest.coveragePartial', { unnamed });
}
