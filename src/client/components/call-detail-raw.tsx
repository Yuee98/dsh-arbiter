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

import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { Collapsible } from './call-detail-collapsible.js';
import { JsonBlock } from './controls.js';
import { formatTime } from '../view-helpers.js';
import type {
  CallDetailModelAttemptView,
  CallDetailView,
} from '../view-types.js';

/** One submitted value, or the sentence for a value that was not stored. */
function Material(props: {
  readonly label: string;
  readonly value: unknown;
  readonly missingText: string;
}): ReactNode {
  const present = props.value !== null && props.value !== undefined;
  return (
    <Collapsible summary={props.label} level="item">
      {present ? (
        <JsonBlock value={props.value} />
      ) : (
        <p style={{ margin: '4px 0', fontSize: 12 }}>{props.missingText}</p>
      )}
    </Collapsible>
  );
}

/** One model attempt: what was sent, what came back, what was parsed. */
function Attempt({
  attempt,
}: {
  readonly attempt: CallDetailModelAttemptView;
}): ReactNode {
  const t = useArbiterTranslation();
  const summary = t('callDetail.attemptTitle', { attempt: attempt.attempt });
  return (
    <div data-call-detail-attempt={attempt.attempt}>
      <Collapsible summary={summary}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            <tr>
              <th scope="row">{t('callDetail.attemptBackend')}</th>
              <td style={{ padding: '2px 8px' }}>{attempt.backend}</td>
              <th scope="row">{t('callDetail.attemptProtocol')}</th>
              <td style={{ padding: '2px 8px' }}>{attempt.protocol}</td>
            </tr>
            <tr>
              <th scope="row">{t('callDetail.attemptTemplate')}</th>
              <td style={{ padding: '2px 8px' }}>
                <code>{attempt.templateId ?? t('callDetail.unknown')}</code>
              </td>
              <th scope="row">{t('callDetail.attemptTokens')}</th>
              <td style={{ padding: '2px 8px' }}>
                {attempt.estimatedInputTokens}
              </td>
            </tr>
            <tr>
              <th scope="row">{t('callDetail.attemptStarted')}</th>
              <td style={{ padding: '2px 8px' }}>
                {formatTime(attempt.startedAt)}
              </td>
              <th scope="row">{t('callDetail.attemptDuration')}</th>
              <td style={{ padding: '2px 8px' }}>
                {t('callDetail.attemptDurationValue', {
                  ms: attempt.durationMs,
                })}
              </td>
            </tr>
          </tbody>
        </table>
        <Material
          label={t('callDetail.attemptRequest')}
          value={attempt.request}
          missingText={t('callDetail.attemptRequestMissing')}
        />
        <Material
          label={t('callDetail.attemptResponse')}
          value={attempt.responseText}
          missingText={t('callDetail.attemptResponseMissing')}
        />
        <Material
          label={t('callDetail.attemptParsed')}
          value={attempt.parsed}
          missingText={t('callDetail.attemptParsedMissing')}
        />
        <Material
          label={t('callDetail.attemptError')}
          value={attempt.error}
          missingText={t('callDetail.attemptErrorMissing')}
        />
        <Material
          label={t('callDetail.attemptUsage')}
          value={attempt.usage}
          missingText={t('callDetail.attemptUsageMissing')}
        />
      </Collapsible>
    </div>
  );
}

/** Every stored attempt, in attempt order. */
function Attempts({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { modelAttempts } = detail.raw;
  if (modelAttempts.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12 }} data-call-detail-attempts="none">
        {t('callDetail.noAttempts')}
      </p>
    );
  }
  return (
    <div
      data-call-detail-attempts={modelAttempts.length}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      {modelAttempts.map((attempt) => (
        <Attempt key={attempt.requestId} attempt={attempt} />
      ))}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Material
            label={t('callDetail.rawArguments')}
            value={raw.arguments}
            missingText={t('callDetail.rawArgumentsMissing')}
          />
          <Material
            label={t('callDetail.rawArgumentsSchema')}
            value={raw.argumentsSchema}
            missingText={t('callDetail.rawArgumentsSchemaMissing')}
          />
          <div style={{ fontSize: 12.5 }}>
            <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
              {t('callDetail.modelAttempts', {
                count: raw.modelAttempts.length,
              })}
            </div>
            <Attempts detail={detail} />
          </div>
          <Material
            label={t('callDetail.rawSnapshot', {
              version: raw.snapshotFormatVersion ?? t('callDetail.unknown'),
            })}
            value={raw.snapshot}
            missingText={t('callDetail.rawSnapshotMissing')}
          />
          <Material
            label={t('callDetail.rawConfig', {
              version: raw.configFormatVersion ?? t('callDetail.unknown'),
            })}
            value={raw.config}
            missingText={t('callDetail.rawConfigMissing')}
          />
          <Material
            label={t('callDetail.rawTemplates', {
              count: raw.templates.length,
            })}
            value={raw.templates}
            missingText={t('callDetail.rawTemplatesMissing')}
          />
          <div style={{ fontSize: 12 }}>
            {t('callDetail.sessionRecordState')}:{' '}
            <code>{raw.sessionRecordState ?? t('callDetail.unknown')}</code>
          </div>
        </div>
      </Collapsible>
    </div>
  );
}
