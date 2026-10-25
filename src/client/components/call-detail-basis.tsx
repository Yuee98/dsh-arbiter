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
import { Collapsible } from './call-detail-collapsible.js';
import { stageLabel, verdictLabel } from './call-detail-labels.js';
import { JsonBlock } from './controls.js';
import { formatTime } from '../view-helpers.js';
import type { CallDetailView } from '../view-types.js';

/** The matched rule, or the review strategy when no rule decided the call. */
function Grounds({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { rule, policyStrategy } = detail.basis;
  if (rule !== null) {
    return (
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          <tr>
            <th scope="row" style={labelStyle}>
              {t('callDetail.hitRule')}
            </th>
            <td style={{ padding: '3px 0' }}>
              <code>{rule.ruleId}</code>
            </td>
          </tr>
          <tr>
            <th scope="row" style={labelStyle}>
              {t('callDetail.ruleName')}
            </th>
            <td style={{ padding: '3px 0' }} data-call-detail-rule-name>
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
    <div style={{ fontSize: 12.5 }} data-call-detail-strategy>
      {t('callDetail.strategy')}:{' '}
      <code>{policyStrategy ?? t('callDetail.unknown')}</code>
    </div>
  );
}

const labelStyle = {
  padding: '3px 12px 3px 0',
  textAlign: 'left' as const,
  fontWeight: 400,
  verticalAlign: 'top' as const,
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap' as const,
};

/** The stage chain as it actually happened, in order. */
function Chain({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { chain, trace } = detail.basis;
  if (chain === null) {
    // The record carries only result strings, so no stage name, reason or rule
    // is invented for it.
    return (
      <div style={{ fontSize: 12.5 }} data-call-detail-chain="results">
        <div>{t('callDetail.chainResultsOnly')}</div>
        <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
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
      style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5 }}
    >
      {chain.map((stage) => (
        <li key={`${String(stage.seq)}-${stage.stage}`}>
          <strong>{stageLabel(t, stage.stage)}</strong>
          {' → '}
          {verdictLabel(t, stage.result)}
          {stage.ruleId === null ? null : (
            <>
              {' '}
              (<code>{stage.ruleId}</code>)
            </>
          )}
          {stage.decisionRules.length === 0 ? null : (
            <span> [{stage.decisionRules.join(', ')}]</span>
          )}
          {stage.ts === null ? null : (
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
              {' '}
              {formatTime(stage.ts)}
            </span>
          )}
          {stage.reason === null ? null : (
            <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
              {stage.reason}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
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
        <div style={{ fontSize: 12.5 }}>
          <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
            {t('callDetail.decisionRules')}
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {decisionRules.map((rule) => (
              <li key={rule}>
                <code>{rule}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshotMissing.length === 0 ? null : (
        <div style={{ fontSize: 12.5 }} data-call-detail-snapshot-missing>
          <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
            {t('callDetail.snapshotMissingInputs')}
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {snapshotMissing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** What the review was given: evidence, materials and their truncation facts. */
function SubmittedEvidence({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { evidence, materials, evidenceTruncated } = detail.basis;
  if (evidence.length === 0 && materials.length === 0) {
    return (
      <div style={{ fontSize: 12.5 }} data-call-detail-evidence="none">
        {t('callDetail.noEvidence')}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {evidenceTruncated ? (
        <div style={{ fontSize: 12 }}>{t('callDetail.evidenceTruncated')}</div>
      ) : null}
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
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <strong style={{ fontSize: 13 }}>{t('callDetail.basisTitle')}</strong>
      <Grounds detail={detail} />
      <div>
        <div
          style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}
        >
          {t('callDetail.chain')}
        </div>
        <Chain detail={detail} />
      </div>
      <DecisionRules detail={detail} />
      <SubmittedEvidence detail={detail} />
    </div>
  );
}
