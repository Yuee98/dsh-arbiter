/**
 * The shared call detail: the one view a session entry and the log list open.
 *
 * The layer order is fixed by the design: the overview answers "what was decided
 * and why", the basis answers "on what grounds", and the raw materials are
 * collapsed until someone needs to inspect them. The two facts that must never
 * be conflated are kept in separate blocks and separate sentences:
 *
 *   - the permission verdict is this plugin's decision;
 *   - the execution status is what the host observed afterwards.
 *
 * A partial (session-sourced) detail renders the same layers with the absent
 * ones reported as missing, so the shape of the view does not change with the
 * source — only the evidence does.
 */

import { Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { CallDetailBasis } from './call-detail-basis.js';
import {
  executionLabel,
  missingLabel,
  verdictLabel,
} from './call-detail-labels.js';
import { CallDetailRaw } from './call-detail-raw.js';
import { Button, JsonBlock, Notice, Section } from './controls.js';
import { callSourceOfDetail } from './rules/rule-from-call-model.js';
import type { RuleCallSource } from './rules/rule-from-call-model.js';
import { formatTime } from '../view-helpers.js';
import type { CallDetailView } from '../view-types.js';

/** One label/value row of the overview table. */
function Fact(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <tr data-call-detail-fact={props.label}>
      <th
        scope="row"
        className="arb:py-1 arb:pr-3 arb:text-left arb:font-normal arb:align-top arb:text-secondary arb:whitespace-nowrap"
      >
        {props.label}
      </th>
      <td className="arb:py-1 arb:text-primary">{props.children}</td>
    </tr>
  );
}

/** The verdict and its reason, shown before every other overview fact. */
function FinalVerdict({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { verdict, verdictReason, cancelled } = detail.overview;
  return (
    <section
      aria-label={t('callDetail.finalVerdict')}
      data-call-detail-verdict
      className="arb:flex arb:flex-col arb:gap-1 arb:rounded-md arb:bg-canvas arb:p-2.5"
    >
      <div className="arb:flex arb:items-baseline arb:gap-2">
        <span className="arb:text-[12.5px] arb:text-secondary">
          {t('callDetail.finalVerdict')}
        </span>
        <strong className="arb:text-sm arb:text-primary">
          {verdict === null
            ? t('callDetail.verdictUnknown')
            : verdictLabel(t, verdict)}
        </strong>
        {cancelled ? (
          <span className="arb:text-xs arb:text-secondary">
            {t('callDetail.cancelled')}
          </span>
        ) : null}
      </div>
      <div className="arb:whitespace-pre-wrap arb:text-[12.5px] arb:text-primary">
        {verdictReason === null ? t('callDetail.reasonMissing') : verdictReason}
      </div>
    </section>
  );
}

/** One execution observation, worded so it cannot read as a permission verdict. */
function ExecutionResult({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { execution } = detail.overview;
  if (execution.status === null)
    return <span>{t('callDetail.executionNotObserved')}</span>;
  return (
    <div data-call-detail-execution>
      <div>{executionLabel(t, execution.status)}</div>
      <div className="arb:text-[11.5px] arb:text-secondary">
        {t('callDetail.executionNote')}
      </div>
      {execution.startedAt === null ? null : (
        <div className="arb:text-[11.5px]">
          {t('callDetail.executionStarted', {
            time: formatTime(execution.startedAt),
          })}
        </div>
      )}
      {execution.finishedAt === null ? null : (
        <div className="arb:text-[11.5px]">
          {t('callDetail.executionFinished', {
            time: formatTime(execution.finishedAt),
          })}
        </div>
      )}
    </div>
  );
}

/** Everything the view knows is missing, as sentences. */
export function MissingNotices({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const labels = detail.missing.flatMap((code) => {
    const label = missingLabel(t, code);
    return label === null ? [] : [label];
  });
  if (labels.length === 0 && detail.missingUnknown === 0) return null;
  const lines = [
    ...labels,
    ...(detail.missingUnknown === 0
      ? []
      : [t('callDetail.missingUnknown', { count: detail.missingUnknown })]),
  ];
  return (
    <div
      data-call-detail-missing
      role="group"
      aria-label={t('callDetail.missingTitle')}
    >
      <Notice kind="info" text={lines.join('\n')} />
    </div>
  );
}

/** The overview layer: the call, its final verdict and its execution result. */
function Overview({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { overview } = detail;
  return (
    <div
      role="group"
      aria-label={t('callDetail.overview')}
      className="arb:flex arb:flex-col arb:gap-2.5"
    >
      <FinalVerdict detail={detail} />
      <table className="arb:border-collapse arb:text-[12.5px]">
        <tbody>
          <Fact label={t('callDetail.tool')}>{overview.tool}</Fact>
          <Fact label={t('callDetail.time')}>{formatTime(overview.ts)}</Fact>
          <Fact label={t('callDetail.approvalMode')}>
            {overview.approvalMode ?? t('callDetail.unknown')}
          </Fact>
          <Fact label={t('callDetail.executionMode')}>
            {overview.executionMode ?? t('callDetail.unknown')}
          </Fact>
          <Fact label={t('callDetail.execution')}>
            <ExecutionResult detail={detail} />
          </Fact>
          <Fact label={t('callDetail.session')}>
            {overview.sessionId === null
              ? t('callDetail.unknown')
              : t('callDetail.sessionValue', {
                  id: overview.sessionId,
                  kind: overview.sessionKind ?? t('callDetail.unknown'),
                })}
          </Fact>
          {overview.parentSession === null ? null : (
            <Fact label={t('callDetail.parentSession')}>
              {overview.parentSession}
            </Fact>
          )}
          <Fact label={t('callDetail.configRevision')}>
            <code className="arb:font-mono">
              {overview.configRevision ?? t('callDetail.unknown')}
            </code>
          </Fact>
          <Fact label={t('callDetail.fingerprint')}>
            <code className="arb:font-mono">
              {overview.fingerprint ?? t('callDetail.unknown')}
            </code>
          </Fact>
          <Fact label={t('callDetail.workspace')}>
            {overview.cwd ?? overview.workspace ?? t('callDetail.unknown')}
          </Fact>
        </tbody>
      </table>
    </div>
  );
}

/** Where a partial detail came from, stated before the layers themselves. */
function SourceNotice({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  if (detail.source === 'audit') return null;
  return (
    <div data-call-detail-source="session">
      <Notice kind="info" text={t('callDetail.partialSource')} />
    </div>
  );
}

/** A record whose stored format this build cannot interpret. */
function UnreadableRecord({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div data-call-detail-unreadable className="arb:text-[12.5px]">
      <p className="arb:m-0 arb:mb-2">{t('callDetail.unreadable')}</p>
      {detail.unreadableReason === null ? null : (
        <JsonBlock value={detail.unreadableReason} />
      )}
      <MissingNotices detail={detail} />
    </div>
  );
}

/**
 * The entry that turns this call into a rule draft.
 *
 * It appears only when the record carries the input a draft needs. A record
 * without one says so instead of offering an action that would build a rule from
 * an invented empty object, and the button never saves anything by itself: it
 * opens the draft dialog, and the draft still goes through save-and-apply.
 */
function CreateRuleFromCall(props: {
  readonly detail: CallDetailView;
  readonly onCreateRule: (source: RuleCallSource) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const source = callSourceOfDetail(props.detail);
  if (source === null)
    return <Notice kind="info" text={t('callDetail.createRuleUnavailable')} />;
  return (
    <div className="arb:flex arb:flex-col arb:gap-1">
      <div data-call-detail-create-rule={source.callId}>
        <Button
          onClick={() => {
            props.onCreateRule(source);
          }}
        >
          <Wand2 className="arb:h-3.5 arb:w-3.5" aria-hidden="true" />
          <span>{t('callDetail.createRuleOpen')}</span>
        </Button>
      </div>
      <p className="arb:m-0 arb:text-[11.5px] arb:text-tertiary">
        {t('callDetail.createRuleHint')}
      </p>
    </div>
  );
}

/**
 * The shared detail for one decoded record.
 *
 * It takes a decoded detail rather than a call id so a caller that already holds
 * a record (a future session entry, a test) renders exactly the same view
 * without a second request.
 */
export function CallDetail({
  detail,
  onCreateRule,
}: {
  readonly detail: CallDetailView;
  /**
   * Where a rule draft from this call goes.
   *
   * A caller without a rules surface omits it; the detail then renders exactly
   * the same layers, without an action it cannot complete.
   */
  readonly onCreateRule?: ((source: RuleCallSource) => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      data-call-detail={detail.callId}
      className="arb:flex arb:flex-col arb:gap-3"
    >
      <Section description={t('callDetail.description')}>
        <SourceNotice detail={detail} />
        {detail.unreadable ? (
          <UnreadableRecord detail={detail} />
        ) : (
          <>
            <Overview detail={detail} />
            <MissingNotices detail={detail} />
            {onCreateRule === undefined ? null : (
              <CreateRuleFromCall detail={detail} onCreateRule={onCreateRule} />
            )}
            <CallDetailBasis detail={detail} />
            <CallDetailRaw detail={detail} />
          </>
        )}
      </Section>
    </div>
  );
}
