/**
 * The raw-material layer: everything stored, collapsed by default.
 *
 * This is the "look it up yourself" layer, so it obeys two rules:
 *
 *   - every attempt is shown on its own, with the submitted request, the model's
 *     own answer text and the parser's reading kept apart — a runtime reason is
 *     never substituted for what the model returned;
 *   - the section is closed until requested, because the material is large and
 *     by design not pre-trimmed beyond what the audit already stored.
 *
 * Material arrives already free of authentication headers; the host removes them
 * on the read path, so nothing here re-exposes a credential in a tooltip or a
 * JSON dump.
 */

import { useState, type ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { Collapsible } from './call-detail-collapsible.js';
import { JsonBlock } from './controls.js';
import { formatTime } from '../view-helpers.js';
import type {
  CallDetailModelAttemptView,
  CallDetailView,
} from '../view-types.js';

/** One submitted value, or the sentence for a value that was not stored. */
function MaterialCard(props: {
  readonly label: string;
  readonly value: unknown;
  readonly missingText: string;
}): ReactNode {
  const present = props.value !== null && props.value !== undefined;
  return (
    <div className="arb:flex arb:flex-col arb:gap-1 arb:rounded arb:border arb:border-border-subtle arb:p-2.5">
      <span className="arb:text-xs arb:font-medium arb:text-secondary">
        {props.label}
      </span>
      {present ? (
        <JsonBlock value={props.value} />
      ) : (
        <p className="arb:my-1 arb:text-xs arb:text-tertiary">
          {props.missingText}
        </p>
      )}
    </div>
  );
}

/** One model attempt: what was sent, what came back, what was parsed. */
function Attempt({
  attempt,
}: {
  readonly attempt: CallDetailModelAttemptView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      data-call-detail-attempt={attempt.attempt}
      className="arb:flex arb:flex-col arb:gap-2.5 arb:rounded-md arb:border arb:border-border-subtle arb:p-3"
    >
      <div className="arb:text-xs arb:font-semibold arb:text-primary">
        {t('callDetail.attemptTitle', { attempt: attempt.attempt })}
      </div>
      <table className="arb:w-full arb:border-collapse arb:text-xs">
        <tbody>
          <tr>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptBackend')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              {attempt.backend}
            </td>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptProtocol')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              {attempt.protocol}
            </td>
          </tr>
          <tr>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptTemplate')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              <code className="arb:font-mono">
                {attempt.templateId ?? t('callDetail.unknown')}
              </code>
            </td>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptTokens')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              {attempt.estimatedInputTokens}
            </td>
          </tr>
          <tr>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptStarted')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              {formatTime(attempt.startedAt)}
            </td>
            <th
              scope="row"
              className="arb:py-0.5 arb:pr-2 arb:text-left arb:font-medium arb:text-secondary"
            >
              {t('callDetail.attemptDuration')}
            </th>
            <td className="arb:px-2 arb:py-0.5 arb:text-primary">
              {t('callDetail.attemptDurationValue', {
                ms: attempt.durationMs,
              })}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="arb:flex arb:flex-col arb:gap-2">
        <MaterialCard
          label={t('callDetail.attemptRequest')}
          value={attempt.request}
          missingText={t('callDetail.attemptRequestMissing')}
        />
        <MaterialCard
          label={t('callDetail.attemptResponse')}
          value={attempt.responseText}
          missingText={t('callDetail.attemptResponseMissing')}
        />
        <MaterialCard
          label={t('callDetail.attemptParsed')}
          value={attempt.parsed}
          missingText={t('callDetail.attemptParsedMissing')}
        />
        {attempt.error !== null ? (
          <MaterialCard
            label={t('callDetail.attemptError')}
            value={attempt.error}
            missingText={t('callDetail.attemptErrorMissing')}
          />
        ) : null}
        {attempt.usage !== null && attempt.usage !== undefined ? (
          <MaterialCard
            label={t('callDetail.attemptUsage')}
            value={attempt.usage}
            missingText={t('callDetail.attemptUsageMissing')}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Every stored attempt, in attempt order. */
function Attempts({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { modelAttempts } = detail.raw;
  const [selectedAttempt, setSelectedAttempt] = useState(0);

  if (modelAttempts.length === 0) {
    const text =
      detail.basis.reviewState === 'reviewed'
        ? t('callDetail.attemptsLost')
        : detail.basis.reviewState === 'none'
          ? t('callDetail.noAttemptsNotNeeded')
          : t('callDetail.attemptsUnknown');
    return (
      <p
        className="arb:m-0 arb:text-xs arb:text-tertiary"
        data-call-detail-attempts="none"
      >
        {text}
      </p>
    );
  }

  const activeAttempt = modelAttempts[selectedAttempt] ?? modelAttempts[0];

  return (
    <div
      data-call-detail-attempts={modelAttempts.length}
      className="arb:flex arb:flex-col arb:gap-2.5"
    >
      {modelAttempts.length > 1 ? (
        <div
          role="group"
          aria-label={t('callDetail.modelAttempts', {
            count: modelAttempts.length,
          })}
          className="arb:flex arb:flex-wrap arb:gap-1.5"
        >
          {modelAttempts.map((attempt, index) => (
            <button
              key={attempt.requestId}
              type="button"
              aria-pressed={index === selectedAttempt}
              onClick={() => {
                setSelectedAttempt(index);
              }}
              className={`arb:rounded arb:px-2.5 arb:py-1 arb:text-xs arb:transition-colors ${
                index === selectedAttempt
                  ? 'arb:bg-layer-4 arb:font-medium arb:text-primary'
                  : 'arb:bg-layer-2 arb:text-secondary hover:arb:text-primary'
              }`}
            >
              {t('callDetail.attemptTitle', { attempt: attempt.attempt })}
            </button>
          ))}
        </div>
      ) : null}
      {activeAttempt !== undefined ? (
        <Attempt key={activeAttempt.requestId} attempt={activeAttempt} />
      ) : null}
    </div>
  );
}

/** The raw-material layer of one detail. */
export function CallDetailRaw({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { raw } = detail;
  return (
    <div data-call-detail-raw>
      <Collapsible summary={t('callDetail.rawTitle')}>
        <div className="arb:flex arb:flex-col arb:gap-2.5">
          <MaterialCard
            label={t('callDetail.rawArguments')}
            value={raw.arguments}
            missingText={t('callDetail.rawArgumentsMissing')}
          />
          <MaterialCard
            label={t('callDetail.rawArgumentsSchema')}
            value={raw.argumentsSchema}
            missingText={t('callDetail.rawArgumentsSchemaMissing')}
          />
          <div className="arb:flex arb:flex-col arb:gap-1.5 arb:text-[12.5px]">
            <div className="arb:text-xs arb:font-medium arb:text-secondary">
              {t('callDetail.modelAttempts', {
                count: raw.modelAttempts.length,
              })}
            </div>
            <Attempts detail={detail} />
          </div>
          <MaterialCard
            label={t('callDetail.rawSnapshot', {
              version: raw.snapshotFormatVersion ?? t('callDetail.unknown'),
            })}
            value={raw.snapshot}
            missingText={t('callDetail.rawSnapshotMissing')}
          />
          <MaterialCard
            label={t('callDetail.rawConfig', {
              version: raw.configFormatVersion ?? t('callDetail.unknown'),
            })}
            value={raw.config}
            missingText={t('callDetail.rawConfigMissing')}
          />
          <MaterialCard
            label={t('callDetail.rawTemplates', {
              count: raw.templates.length,
            })}
            value={raw.templates}
            missingText={t('callDetail.rawTemplatesMissing')}
          />
          <div className="arb:text-xs arb:text-secondary">
            {t('callDetail.sessionRecordState')}:{' '}
            <code className="arb:font-mono">
              {raw.sessionRecordState ?? t('callDetail.unknown')}
            </code>
          </div>
        </div>
      </Collapsible>
    </div>
  );
}
