import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../../i18n-provider.js';
import type { Translate } from '../../i18n.js';
import type {
  RuleConditionResult,
  RuleResult,
  RuleTarget,
  RuleVerdict,
} from '../../../types.js';
import type { DraftRule, RuleTestResultView } from '../../view-types.js';
import {
  conditionViews,
  coverageView,
  finalPath,
  ruleConclusion,
} from './rule-test-model.js';
import type { ConditionView } from './rule-test-model.js';

const muted = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
} as const;

const mono = { fontFamily: 'var(--dsw-font-mono, monospace)' } as const;

/** A localized verdict label; the protocol value itself stays visible. */
export function verdictLabel(verdict: RuleVerdict, t: Translate): string {
  switch (verdict) {
    case 'allow':
      return t('rules.verdictOption.allow');
    case 'deny':
      return t('rules.verdictOption.deny');
    case 'force-ask':
      return t('rules.verdictOption.forceAsk');
    case 'force-review':
      return t('rules.verdictOption.forceReview');
  }
}

function targetLabel(target: RuleTarget, t: Translate): string {
  switch (target) {
    case 'command':
      return t('rules.targetOption.command');
    case 'file_redirect':
      return t('rules.targetOption.fileRedirect');
    case 'variable_assignment':
      return t('rules.targetOption.variableAssignment');
    case 'tool':
      return t('rules.targetOption.tool');
    case 'argument':
      return t('rules.targetOption.argument');
  }
}

function patternText(condition: RuleConditionResult): string {
  return typeof condition.pattern === 'string'
    ? condition.pattern
    : JSON.stringify(condition.pattern);
}

function reasonText(condition: RuleConditionResult, t: Translate): string {
  switch (condition.reason) {
    case 'missing':
      return t('ruleTest.reasonMissing');
    case 'empty-selection':
      return t('ruleTest.reasonEmptySelection');
    case 'value-mismatch':
      return t('ruleTest.reasonValueMismatch');
    case 'scope':
      return t('ruleTest.reasonScope');
    case 'resolved':
      return t('ruleTest.reasonResolved');
    case 'unresolved-structure':
      return t('ruleTest.reasonUnresolvedStructure');
    case 'parse-error':
      return t('ruleTest.reasonParseError');
    case 'unsupported-value':
      return t('ruleTest.reasonUnsupported');
    case undefined:
      return t('ruleTest.reasonUnknown');
  }
  return t('ruleTest.reasonUnknown');
}

function outcomeText(condition: RuleConditionResult, t: Translate): string {
  switch (condition.outcome) {
    case 'match':
      return t('ruleTest.ruleMatch');
    case 'no-match':
      return t('ruleTest.ruleNoMatch');
    case 'unknown':
      return t('ruleTest.ruleUnknown');
  }
}

/** One value as written; user input and JSON types stay unchanged. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The two conclusions the contract requires, side by side.
 *
 * "本规则匹配" answers whether the selected rule applies to this call, and
 * "最终规则路径" answers what the whole draft decides. Keeping them separate is
 * the point: a matching rule that a higher-priority rule outranks must not read
 * as the outcome.
 */
export function RuleTestConclusion(props: {
  readonly result: RuleTestResultView;
  readonly rule: DraftRule | null;
  readonly stale: boolean;
}): ReactNode {
  const t = useArbiterTranslation();
  const conclusion = ruleConclusion(props.result, props.rule);
  const path = finalPath(props.result);
  const coverage = coverageView(props.result);
  return (
    <div
      data-arbiter-test-conclusion=""
      data-testid="rule-test-conclusion"
      data-arbiter-test-stale={props.stale ? 'true' : 'false'}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}
    >
      <section
        data-testid="rule-test-rule"
        data-arbiter-test-rule-state={conclusion.state}
        style={{
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 6,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <h4 style={{ margin: 0, fontSize: 12.5 }}>
          {t('ruleTest.ruleConclusion')}
        </h4>
        <strong
          style={{ fontSize: 13 }}
          data-arbiter-test-rule-outcome={conclusion.state}
        >
          {ruleStateText(conclusion.state, t)}
        </strong>
        {props.rule === null ? (
          <span style={muted}>{t('ruleTest.noRuleHint')}</span>
        ) : null}
      </section>
      <section
        data-testid="rule-test-path"
        data-arbiter-test-path={props.result.path}
        style={{
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 6,
          padding: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <h4 style={{ margin: 0, fontSize: 12.5 }}>{t('ruleTest.finalPath')}</h4>
        <strong style={{ fontSize: 13 }}>
          {path.kind === 'rule'
            ? t('ruleTest.pathVerdict', {
                verdict: verdictLabel(path.verdict, t),
                id: path.ruleId,
              })
            : t('ruleTest.pathReviewDefault')}
        </strong>
        <span style={muted}>{pathReasonText(path, coverage, t)}</span>
        <span style={muted}>{t('ruleTest.reviewHint')}</span>
        {/* The effective directory is shown, not implied: a relative redirect
            resolves against it, so the conclusion is only reproducible with it. */}
        <span style={muted} data-testid="rule-test-cwd">
          {t('ruleTest.effectiveCwd', { cwd: props.result.cwd })}
        </span>
      </section>
    </div>
  );
}

function ruleStateText(
  state: ReturnType<typeof ruleConclusion>['state'],
  t: Translate,
): string {
  switch (state) {
    case 'match':
      return t('ruleTest.ruleMatch');
    case 'no-match':
      return t('ruleTest.ruleNoMatch');
    case 'unknown':
      return t('ruleTest.ruleUnknown');
    case 'scope':
      return t('ruleTest.ruleScope');
    case 'disabled':
      return t('ruleTest.ruleDisabled');
    case 'not-tested':
      return t('ruleTest.noRule');
  }
}

/**
 * Why the whole draft took this path.
 *
 * `unresolved` covers two different situations the evaluator distinguishes only
 * through the rule outcomes: a higher-priority unknown blocked a matching
 * `allow`, or nothing matched and an unknown rule might have decided. Claiming
 * "the allow was not adopted" in the second case would assert something the
 * answer does not say, so the sentence follows the outcomes rather than the
 * reason alone.
 */
function pathReasonText(
  path: ReturnType<typeof finalPath>,
  coverage: ReturnType<typeof coverageView>,
  t: Translate,
): string {
  if (path.kind === 'rule') return t('ruleTest.pathRule', { id: path.ruleId });
  switch (path.reason) {
    case 'no-match':
      return t('ruleTest.reviewNoMatch');
    case 'incomplete':
      return t('ruleTest.reviewIncomplete');
    case 'unresolved':
      return coverage.allowMatched
        ? t('ruleTest.reviewUnresolved')
        : t('ruleTest.reviewUnresolvedNoAllow');
    case 'partial-allow':
      return t('ruleTest.reviewPartialAllow');
  }
}

/**
 * The expandable explanation: per-condition values, then the draft-wide
 * coverage, then the parse. Each layer is a real `<details>` so a reader can stop
 * after the conclusion.
 */
export function RuleTestDetails(props: {
  readonly result: RuleTestResultView;
  readonly rule: DraftRule | null;
}): ReactNode {
  const t = useArbiterTranslation();
  const coverage = coverageView(props.result);
  const selected =
    props.rule === null
      ? null
      : (props.result.rules.find((entry) => entry.id === props.rule?.id) ??
        null);
  return (
    <details data-arbiter-test-details="">
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
        {t('ruleTest.details')}
      </summary>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          marginTop: 8,
        }}
      >
        {selected === null ? null : (
          <ConditionList result={selected} name={props.rule?.name ?? null} />
        )}
        <ShadowList
          shadowed={coverage.shadowed}
          unknown={coverage.unknown}
          allowMatched={coverage.allowMatched}
        />
        <ParseBlock result={props.result} />
        <NormalizationBlock result={props.result} />
      </div>
    </details>
  );
}

function ConditionList(props: {
  readonly result: RuleResult;
  readonly name: string | null;
}): ReactNode {
  const views = conditionViews(props.result);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>
        {props.name ?? props.result.id}
      </div>
      {views.map((view) => (
        <ConditionBlock
          key={`${props.result.id}-${String(view.index)}`}
          view={view}
        />
      ))}
    </div>
  );
}

function ConditionBlock(props: { readonly view: ConditionView }): ReactNode {
  const t = useArbiterTranslation();
  const { view } = props;
  const { condition } = view;
  return (
    <div
      data-testid="rule-test-condition"
      data-arbiter-test-condition={String(view.index)}
      data-arbiter-test-condition-outcome={condition.outcome}
      style={{
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 12,
      }}
    >
      <strong>{t('ruleTest.conditionHead', { n: view.index + 1 })}</strong>
      <span style={muted}>
        {t('ruleTest.conditionTarget', {
          target: targetLabel(condition.target, t),
        })}
      </span>
      {condition.path === undefined ? null : (
        <span style={{ ...mono, fontSize: 11.5 }}>
          {t('ruleTest.conditionPath', { path: condition.path })}
        </span>
      )}
      {view.multi === null ? null : (
        <span style={muted}>
          {t('ruleTest.conditionMulti', {
            mode:
              view.multi === 'all'
                ? t('ruleTest.multiAll')
                : t('ruleTest.multiAny'),
          })}
        </span>
      )}
      <span style={mono}>
        {t('ruleTest.conditionExpression', {
          kind: condition.kind,
          pattern: patternText(condition),
        })}
      </span>
      {condition.target === 'argument' ? (
        <ValueBlock values={view.values} matched={view.matchedValues} />
      ) : null}
      <span data-arbiter-test-reason={condition.reason ?? ''}>
        {t('ruleTest.conditionOutcome', { outcome: outcomeText(condition, t) })}{' '}
        · {reasonText(condition, t)}
      </span>
    </div>
  );
}

function ValueBlock(props: {
  readonly values: readonly unknown[];
  readonly matched: readonly unknown[];
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <>
      <span style={muted}>
        {t('ruleTest.values', { count: props.values.length })}
      </span>
      {props.values.length === 0 ? (
        <span style={muted}>{t('ruleTest.valuesEmpty')}</span>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {props.values.map((value, index) => (
            <li key={`${String(index)}-${valueText(value)}`} style={mono}>
              {valueText(value)}
            </li>
          ))}
        </ul>
      )}
      {props.matched.length === 0 ? null : (
        <>
          <span style={muted}>
            {t('ruleTest.matchedValues', { count: props.matched.length })}
          </span>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {props.matched.map((value, index) => (
              <li key={`m-${String(index)}-${valueText(value)}`} style={mono}>
                {valueText(value)}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ShadowList(props: {
  readonly shadowed: readonly {
    readonly id: string;
    readonly verdict: RuleVerdict;
  }[];
  readonly unknown: readonly string[];
  readonly allowMatched: boolean;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      style={{
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 12,
      }}
    >
      <strong>{t('ruleTest.shadowedTitle')}</strong>
      {props.shadowed.length === 0 ? (
        <span style={muted}>{t('ruleTest.shadowedNone')}</span>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {props.shadowed.map((match) => (
            <li key={`${match.id}-${match.verdict}`}>
              {t('ruleTest.shadowedEntry', {
                id: match.id,
                verdict: verdictLabel(match.verdict, t),
              })}
            </li>
          ))}
        </ul>
      )}
      <strong>{t('ruleTest.unknownTitle')}</strong>
      <span style={muted}>
        {props.unknown.length === 0
          ? t('ruleTest.unknownNone')
          : props.unknown.join(', ')}
      </span>
      {props.allowMatched ? null : (
        <span style={muted}>{t('ruleTest.noAllow')}</span>
      )}
    </div>
  );
}

/**
 * The matched text and how each word got there.
 *
 * A reader has to be able to see why `echo "a b"` and `echo a b` take different
 * paths, and why a word kept its original expression instead of becoming a value.
 * The backend produces this from the same parse it matched against, so it cannot
 * describe a different normalization than the one that decided the answer.
 */
function NormalizationBlock(props: {
  readonly result: RuleTestResultView;
}): ReactNode {
  const t = useArbiterTranslation();
  const detail = props.result.normalization;
  if (detail === null || detail === undefined) return null;
  return (
    <div
      data-testid="rule-test-normalization"
      style={{
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12,
      }}
    >
      <strong>{t('ruleTest.normalizationTitle')}</strong>
      {detail.commands.length === 0 ? (
        <span style={muted}>{t('ruleTest.normalizationEmpty')}</span>
      ) : (
        detail.commands.map((command, index) => (
          <div
            key={`${String(index)}-${command.text}`}
            style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            <span style={mono}>
              {t('ruleTest.normalizationCommand', { text: command.text })}
            </span>
            {command.words.map((word, at) => (
              <span
                key={`${String(at)}-${word.raw}`}
                style={{ ...muted, ...mono }}
              >
                {t('ruleTest.normalizationWord', {
                  raw: word.raw,
                  text: word.text,
                  status:
                    word.status === 'static'
                      ? t('ruleTest.normalizationStatic')
                      : t('ruleTest.normalizationDynamic', {
                          reasons: word.reasons.join(', '),
                        }),
                })}
              </span>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function ParseBlock(props: { readonly result: RuleTestResultView }): ReactNode {
  const t = useArbiterTranslation();
  const { parse } = props.result;
  return (
    <div
      data-arbiter-test-parse={parse.status}
      style={{
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 12,
      }}
    >
      <strong>{t('ruleTest.parseTitle')}</strong>
      <span style={muted}>
        {t('ruleTest.parseStatusValue', {
          status: parse.status,
          completeness: parse.completeness,
        })}
      </span>
      <span style={mono}>
        {t('ruleTest.parseNodes', {
          nodes:
            parse.nodes.length === 0
              ? t('ruleTest.parseEmpty')
              : parse.nodes.join(', '),
        })}
      </span>
      <span style={mono}>
        {t('ruleTest.parseUnresolved', {
          values:
            parse.unresolved.length === 0
              ? t('ruleTest.parseEmpty')
              : parse.unresolved.join(', '),
        })}
      </span>
      {parse.opaque ? (
        <span style={muted}>{t('ruleTest.parseOpaque')}</span>
      ) : null}
      {props.result.error === undefined ? null : (
        <span
          style={{ ...mono, color: 'var(--dsw-alias-state-error-primary)' }}
        >
          {t('ruleTest.parseError', { error: props.result.error })}
        </span>
      )}
    </div>
  );
}
