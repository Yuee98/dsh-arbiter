import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { postJsonWithSignal } from '../api.js';
import { probeResponse } from '../decoders/reviewer.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { Button } from './controls.js';
import type {
  Draft,
  ReviewerProbeFailure,
  ReviewerProbeView,
} from '../view-types.js';

/** The dialog's own lifecycle; nothing here is kept after it closes. */
type ProbeRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'done'; readonly result: ReviewerProbeView }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The one-shot Reviewer connection test.
 *
 * It posts the draft captured when the button was pressed, so a later edit does
 * not change a run already in flight, and it never applies that draft. Cancelling
 * and closing both abort the request, which the host forwards to the provider;
 * the result lives only in this component, so closing it discards the diagnosis.
 */
export function ReviewerTestDialog(props: {
  readonly draft: Draft;
  readonly onClose: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const [run, setRun] = useState<ProbeRun>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  // The request carries this snapshot, not the live draft: pressing run must
  // test what the operator saw, and later edits are a separate decision.
  const captured = useRef<Draft>(structuredClone(props.draft));

  const cancel = useCallback((): void => {
    controller.current?.abort();
    setRun({ kind: 'cancelled' });
  }, []);

  const close = useCallback((): void => {
    controller.current?.abort();
    controller.current = null;
    props.onClose();
  }, [props]);

  useEffect(() => {
    const current = controller.current;
    return () => {
      // Unmount is a close: an unfinished probe must not keep running.
      current?.abort();
    };
  }, []);

  const runProbe = useCallback((): void => {
    const abort = new AbortController();
    controller.current = abort;
    setRun({ kind: 'running' });
    postJsonWithSignal(
      '/reviewer-test',
      {
        draft: {
          reviewer: captured.current.reviewer,
          policy: captured.current.policy,
        },
      },
      abort.signal,
      probeResponse,
    )
      .then((result) => {
        if (!abort.signal.aborted) setRun({ kind: 'done', result });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setRun({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('reviewer.test.title')}
        data-arbiter-reviewer-test=""
        style={{
          width: 'min(760px, 92vw)',
          maxHeight: '82vh',
          overflow: 'auto',
          background: 'var(--dsw-alias-bg-layer-3)',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: 10,
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {t('reviewer.test.title')}
          </h3>
          <Button onClick={close}>{t('reviewer.test.close')}</Button>
        </div>

        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
          }}
        >
          {t('reviewer.test.costNotice')}
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            tone="primary"
            disabled={run.kind === 'running'}
            onClick={runProbe}
          >
            {run.kind === 'running'
              ? t('reviewer.test.running')
              : t('reviewer.test.run')}
          </Button>
          {run.kind === 'running' ? (
            <Button onClick={cancel}>{t('reviewer.test.cancel')}</Button>
          ) : null}
        </div>

        <ProbeSummary run={run} captured={captured.current} />
      </div>
    </div>
  );
}

/**
 * One localized sentence per stable failure code.
 *
 * The host sends a machine code, never a provider sentence, so the page owns the
 * wording and an unmapped code still renders a sentence rather than a bare key.
 */
function failureText(
  failure: ReviewerProbeFailure,
  t: ReturnType<typeof useArbiterTranslation>,
): string {
  switch (failure) {
    case 'model-required':
      return t('reviewer.test.failure.modelRequired');
    case 'credential-missing':
      return t('reviewer.test.failure.credentialMissing');
    case 'unauthorized':
      return t('reviewer.test.failure.unauthorized');
    case 'rate-limited':
      return t('reviewer.test.failure.rateLimited');
    case 'unavailable':
      return t('reviewer.test.failure.unavailable');
    case 'network':
      return t('reviewer.test.failure.network');
    case 'timed-out':
      return t('reviewer.test.failure.timedOut');
    case 'invalid-output':
      return t('reviewer.test.failure.invalidOutput');
    case 'cancelled':
      return t('reviewer.test.failure.cancelled');
    case 'unknown':
      return t('reviewer.test.failure.unknown');
  }
}

/** Status, actual model, duration and result summary. */
function ProbeSummary(props: {
  readonly run: ProbeRun;
  readonly captured: Draft;
}): ReactNode {
  const t = useArbiterTranslation();
  const { run, captured } = props;
  const route =
    captured.reviewer.type === 'chat'
      ? `${captured.reviewer.chat.provider} / ${captured.reviewer.chat.model}`
      : `decision / ${captured.reviewer.decision.model}`;
  const muted = {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
  } as const;

  if (run.kind === 'idle') {
    return <p style={{ margin: 0, ...muted }}>{t('reviewer.test.idle')}</p>;
  }
  if (run.kind === 'running') {
    return (
      <p role="status" style={{ margin: 0, ...muted }}>
        {t('reviewer.test.runningHint', { route })}
      </p>
    );
  }
  if (run.kind === 'cancelled') {
    return (
      <p role="status" style={{ margin: 0, ...muted }}>
        {t('reviewer.test.cancelled')}
      </p>
    );
  }
  if (run.kind === 'error') {
    return (
      <p role="status" style={{ margin: 0, ...muted }}>
        {t('reviewer.test.requestFailed', { error: run.message })}
      </p>
    );
  }

  const result = run.result;
  const actual = `${result.provider} / ${result.model}`;
  const headline =
    result.status === 'passed'
      ? result.repairs === 0
        ? t('reviewer.test.passedFirst')
        : t('reviewer.test.passedRepaired', { count: result.repairs })
      : result.status === 'cancelled'
        ? t('reviewer.test.cancelled')
        : t('reviewer.test.failed', { reason: failureText(result.failure, t) });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p
        role="status"
        data-arbiter-probe-status={result.status}
        {...(result.status === 'passed'
          ? {}
          : { 'data-arbiter-probe-failure': result.failure })}
        style={{ margin: 0, fontSize: 13, fontWeight: 600 }}
      >
        {headline}
      </p>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '4px 12px',
          fontSize: 12,
        }}
      >
        <dt style={muted}>{t('reviewer.test.actualModel')}</dt>
        <dd style={{ margin: 0 }}>{actual}</dd>
        <dt style={muted}>{t('reviewer.test.backend')}</dt>
        <dd style={{ margin: 0 }}>{result.backend}</dd>
        <dt style={muted}>{t('reviewer.test.protocol')}</dt>
        <dd style={{ margin: 0 }}>{result.protocol}</dd>
        <dt style={muted}>{t('reviewer.test.duration')}</dt>
        <dd style={{ margin: 0 }}>
          {t('reviewer.test.durationValue', { ms: result.durationMs })}
        </dd>
      </dl>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>
          {t('reviewer.test.details')}
        </summary>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            marginTop: 8,
          }}
        >
          {result.attempts.map((attempt) => (
            <ProbeAttemptBlock
              key={attempt.attempt}
              label={t('reviewer.test.attempt', { n: attempt.attempt })}
              attempt={attempt}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

/** One attempt's submitted material, raw answer and parser result. */
function ProbeAttemptBlock(props: {
  readonly label: string;
  readonly attempt: ReviewerProbeView['attempts'][number];
}): ReactNode {
  const t = useArbiterTranslation();
  const { attempt } = props;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{props.label}</div>
      <div
        style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}
      >
        {t('reviewer.test.attemptMeta', {
          ms: attempt.durationMs,
          protocol: attempt.protocol,
        })}
      </div>
      <RawBlock label={t('reviewer.test.input')} value={attempt.request} />
      <RawBlock
        label={t('reviewer.test.output')}
        value={attempt.responseText}
      />
      {attempt.error === null ? null : (
        <RawBlock label={t('reviewer.test.error')} value={attempt.error} />
      )}
      {attempt.parsed === null ? null : (
        <RawBlock label={t('reviewer.test.parsed')} value={attempt.parsed} />
      )}
    </section>
  );
}

/** Model text and parser output stay verbatim: they are evidence, not copy. */
function RawBlock(props: {
  readonly label: string;
  readonly value: unknown;
}): ReactNode {
  const rendered =
    typeof props.value === 'string'
      ? props.value
      : JSON.stringify(props.value, null, 2);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}
      >
        {props.label}
      </span>
      <pre
        style={{
          margin: 0,
          padding: 8,
          maxHeight: 220,
          overflow: 'auto',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-module-platform)',
          fontSize: 11.5,
          fontFamily: 'var(--dsw-font-mono, monospace)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {rendered}
      </pre>
    </div>
  );
}
