/**
 * The decision-basis layer: why this call was decided the way it was.
 *
 * Three questions are separated here, because answering one with another's data
 * is how a detail starts lying:
 *
 *   - the chain is what actually happened, in stage order;
 *   - the hit rule (or policy strategy) is what decided it, named as it was then;
 *   - the evidence is what the review was *given*, not what it is assumed to
 *     have used.
 *
 * A rule short-circuit never reached a model, so it has no review stage and no
 * evidence — the view says so instead of inventing either.
 */

import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { Collapsible, CollapsibleCard } from './call-detail-collapsible.js';
import { stageLabel, verdictLabel } from './call-detail-labels.js';
import { JsonBlock, Notice } from './controls.js';
import { formatTime } from '../view-helpers.js';
import type {
  RuleConjunctionEvidence,
  RuleConjunctionGroup,
} from '../../types.js';
import type { CallDetailView } from '../view-types.js';

const labelClass =
  'arb:py-1 arb:pr-3 arb:text-left arb:font-normal arb:align-top arb:text-secondary arb:whitespace-nowrap';

/** The matched rule, or the review strategy when no rule decided the call. */
function Grounds({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { rule, policyStrategy } = detail.basis;
  if (rule !== null) {
    return (
      <table className="arb:border-collapse arb:text-[12.5px]">
        <tbody>
          <tr>
            <th scope="row" className={labelClass}>
              {t('callDetail.hitRule')}
            </th>
            <td className="arb:py-0.5">
              <code className="arb:font-mono">{rule.ruleId}</code>
            </td>
          </tr>
          <tr>
            <th scope="row" className={labelClass}>
              {t('callDetail.ruleName')}
            </th>
            <td className="arb:py-0.5" data-call-detail-rule-name>
              {rule.ruleName === null
                ? t('callDetail.ruleNameMissing')
                : rule.ruleName}
            </td>
          </tr>
        </tbody>
      </table>
    );
  }
  return (
    <div className="arb:text-[12.5px]" data-call-detail-strategy>
      {t('callDetail.strategy')}:{' '}
      <code className="arb:font-mono">
        {policyStrategy ?? t('callDetail.unknown')}
      </code>
    </div>
  );
}

/** The stage chain as it actually happened, in order. */
function Chain({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { chain, trace } = detail.basis;
  if (chain === null) {
    // The record carries only result strings, so no stage name, reason or rule
    // is invented for it.
    return (
      <div className="arb:text-[12.5px]" data-call-detail-chain="results">
        <div>{t('callDetail.chainResultsOnly')}</div>
        <ol className="arb:mt-1.5 arb:pl-5">
          {trace.map((result, index) => (
            <li key={`${String(index)}-${result}`}>
              {verdictLabel(t, result)}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <ol
      data-call-detail-chain="stages"
      className="arb:mt-1.5 arb:pl-5 arb:text-[12.5px]"
    >
      {chain.map((stage) => (
        <li key={`${String(stage.seq)}-${stage.stage}`}>
          <strong>{stageLabel(t, stage.stage)}</strong>
          {' → '}
          {verdictLabel(t, stage.result)}
          {stage.ruleId === null ? null : (
            <>
              {' '}
              (<code className="arb:font-mono">{stage.ruleId}</code>)
            </>
          )}
          {stage.decisionRules.length === 0 ? null : (
            <span> [{stage.decisionRules.join(', ')}]</span>
          )}
          {stage.ts === null ? null : (
            <span className="arb:text-tertiary"> {formatTime(stage.ts)}</span>
          )}
          {stage.reason === null ? null : (
            <div className="arb:text-secondary">{stage.reason}</div>
          )}
          {stage.conjunction === null ? null : (
            <Conjunction evidence={stage.conjunction} />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The conjunction a rule stage actually used.
 *
 * Only the groups that matched are listed with their witness node: that pair is
 * what made the call allowed, and reproducing it from the rule as it stands now
 * would describe a decision this record did not make.
 */
function Conjunction(props: {
  readonly evidence: RuleConjunctionEvidence;
}): ReactNode {
  const t = useArbiterTranslation();
  // Every matched group is listed, including the ones whose target has no node
  // text: a value target's matched value is the evidence for that conjunct, and
  // dropping it would describe a conjunction of command-plus-argument as a
  // command-only decision.
  const matched = props.evidence.groups.filter(
    (group) => group.outcome === 'match',
  );
  return (
    <div
      className="arb:mt-0.5 arb:text-[11.5px]"
      data-call-detail-conjunction=""
    >
      <div className="arb:text-secondary">{t('callDetail.conjunction')}</div>
      {matched.length === 0 ? (
        <div>{t('callDetail.conjunctionNoWitness')}</div>
      ) : (
        <ul className="arb:mt-0.5 arb:pl-4">
          {matched.map((group) => (
            <li
              key={`${group.target}-${String(group.conditionIndices[0])}`}
              data-call-detail-conjunction-group={group.target}
            >
              {t('callDetail.conjunctionWitness', {
                // The target is a protocol value, so it stays as written rather
                // than being translated into a name this build might rename.
                target: group.target,
                text: groupText(group),
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What one matched group can show about itself.
 *
 * A structural group names the node that satisfied every condition; a value
 * group has no node, so its own matched values are the evidence. Neither is
 * invented when the record lacks it.
 */
function groupText(group: RuleConjunctionGroup): string {
  if (group.witnessText !== undefined) return group.witnessText;
  if (group.witnessValues !== undefined)
    return group.witnessValues.map((entry) => entry.text).join(', ');
  return '';
}

/** The decision rules the policy applied, when the call reached a review. */
function DecisionRules({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { decisionRules, snapshotMissing } = detail.basis;
  return (
    <>
      {decisionRules.length === 0 ? null : (
        <div className="arb:text-[12.5px]">
          <div className="arb:text-secondary">
            {t('callDetail.decisionRules')}
          </div>
          <ul className="arb:mt-1 arb:pl-5">
            {decisionRules.map((rule) => (
              <li key={rule}>
                <code className="arb:font-mono">{rule}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshotMissing.length === 0 ? null : (
        <div className="arb:text-[12.5px]" data-call-detail-snapshot-missing>
          <div className="arb:text-secondary">
            {t('callDetail.snapshotMissingInputs')}
          </div>
          <ul className="arb:mt-1 arb:pl-5">
            {snapshotMissing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** What the review was given and what it produced: evidence, scores and usage. */
function BasisCollapsibles({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { evidence, materials, evidenceTruncated, scores, usage, effect } =
    detail.basis;
  const hasEvidence = evidence.length > 0 || materials.length > 0;
  const hasResult = scores !== null || usage !== null || effect !== null;

  if (!hasEvidence && !hasResult) {
    const text =
      detail.basis.reviewState === 'reviewed'
        ? t('callDetail.evidenceLost')
        : detail.basis.reviewState === 'none'
          ? t('callDetail.noEvidenceNotNeeded')
          : t('callDetail.reviewUnknown');
    return (
      <div className="arb:text-[12.5px]" data-call-detail-evidence="none">
        {text}
      </div>
    );
  }

  return (
    <div className="arb:flex arb:flex-col arb:gap-1.5">
      {evidenceTruncated ? (
        <div className="arb:text-xs">{t('callDetail.evidenceTruncated')}</div>
      ) : null}
      <CollapsibleCard>
        {hasEvidence ? (
          <>
            <Collapsible
              summary={t('callDetail.evidence', { count: evidence.length })}
            >
              <JsonBlock value={evidence} />
            </Collapsible>
            <Collapsible
              summary={t('callDetail.materials', { count: materials.length })}
            >
              <JsonBlock value={materials} />
            </Collapsible>
          </>
        ) : null}
        {hasResult ? (
          <Collapsible summary={t('callDetail.signals')}>
            <div className="arb:flex arb:flex-col arb:gap-1.5">
              {scores === null ? null : (
                <section aria-label={t('callDetail.scores')}>
                  <div className="arb:text-[12.5px]">
                    {t('callDetail.scores')}
                  </div>
                  <JsonBlock value={scores} />
                </section>
              )}
              {usage === null ? null : (
                <section aria-label={t('callDetail.usage')}>
                  <div className="arb:text-[12.5px]">
                    {t('callDetail.usage')}
                  </div>
                  <JsonBlock value={usage} />
                </section>
              )}
              {effect === null ? null : (
                <section aria-label={t('callDetail.effect')}>
                  <div className="arb:text-[12.5px]">
                    {t('callDetail.effect')}
                  </div>
                  <JsonBlock value={effect} />
                </section>
              )}
            </div>
          </Collapsible>
        ) : null}
      </CollapsibleCard>
    </div>
  );
}

/**
 * Sources that disagree about this call.
 *
 * `#16` keeps both readings instead of choosing one; showing them is what stops
 * a disputed verdict from reading as an established fact. The fields name where
 * the readings differ, and no value here is resolved or averaged.
 */
function Conflicts({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { conflicts, conflictsTruncated } = detail.basis;
  if (conflicts.length === 0 && !conflictsTruncated) return null;
  return (
    <div data-call-detail-conflicts>
      <Notice kind="info" text={t('callDetail.conflictsTitle')} />
      {conflicts.length === 0 ? null : (
        <table className="arb:border-collapse arb:text-[12.5px]">
          <thead>
            <tr className="arb:text-left">
              <th className={labelClass}>{t('callDetail.conflictField')}</th>
              <th className={labelClass}>{t('callDetail.conflictObserved')}</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((conflict) => (
              <tr key={conflict.field}>
                <td className="arb:py-1 arb:pr-3">
                  <code className="arb:font-mono">{conflict.field}</code>
                </td>
                <td className="arb:py-1">{conflict.observed.join(' / ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {conflictsTruncated ? (
        <p className="arb:m-0 arb:text-xs">
          {t('callDetail.conflictsTruncated')}
        </p>
      ) : null}
    </div>
  );
}

/** The basis layer of one detail. */
export function CallDetailBasis({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      role="group"
      aria-label={t('callDetail.basisTitle')}
      data-call-detail-basis
      className="arb:flex arb:flex-col arb:gap-2.5"
    >
      <strong className="arb:text-[13px]">{t('callDetail.basisTitle')}</strong>
      <Conflicts detail={detail} />
      <Grounds detail={detail} />
      <div>
        <div className="arb:text-[12.5px] arb:text-secondary">
          {t('callDetail.chain')}
        </div>
        <Chain detail={detail} />
      </div>
      <DecisionRules detail={detail} />
      <BasisCollapsibles detail={detail} />
    </div>
  );
}
