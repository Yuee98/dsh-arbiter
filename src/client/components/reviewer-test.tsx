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
  | { readonly kind: 'error' };

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

  useEffect(
    () => () => {
      // Unmount is a close — including a parent remount or a tab switch, not
      // only the explicit close button. Read the ref at cleanup time, because
      // the controller is created when the run starts, after this effect.
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

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
      .catch(() => {
        if (abort.signal.aborted) return;
        setRun({ kind: 'error' });
      });
  }, []);

  // The frozen design starts the run when the entry is pressed, so opening this
  // dialog is the action — an extra confirmation click would contradict it. The
  // cost notice is already shown next to the entry.
  useEffect(() => {
    runProbe();
  }, [runProbe]);

  return (
    <div
      role="presentation"
      className="arb:fixed arb:inset-0 arb:z-50 arb:flex arb:items-center arb:justify-center arb:bg-black/45"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('reviewer.test.title')}
        data-arbiter-reviewer-test=""
        data-arbiter-surface="reviewer-test-dialog"
        className="arb:flex arb:max-h-[82vh] arb:w-[min(760px,92vw)] arb:flex-col arb:gap-3 arb:overflow-auto arb:rounded-lg arb:bg-layer-3 arb:p-4.5 arb:text-primary"
      >
        <div className="arb:flex arb:items-center arb:justify-between arb:gap-3">
          <h3 className="arb:m-0 arb:text-base arb:font-semibold">
            {t('reviewer.test.title')}
          </h3>
          <Button onClick={close}>{t('reviewer.test.close')}</Button>
        </div>

        <p className="arb:m-0 arb:text-xs arb:text-secondary">
          {t('reviewer.test.costNotice')}
        </p>

        <div className="arb:flex arb:items-center arb:gap-2">
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

  if (run.kind === 'idle') {
    return (
      <p className="arb:m-0 arb:text-xs arb:text-secondary">
        {t('reviewer.test.idle')}
      </p>
    );
  }
  if (run.kind === 'running') {
    return (
      <p role="status" className="arb:m-0 arb:text-xs arb:text-secondary">
        {t('reviewer.test.runningHint', { route })}
      </p>
    );
  }
  if (run.kind === 'cancelled') {
    return (
      <p role="status" className="arb:m-0 arb:text-xs arb:text-secondary">
        {t('reviewer.test.cancelled')}
      </p>
    );
  }
  if (run.kind === 'error') {
    return (
      <p role="status" className="arb:m-0 arb:text-xs arb:text-secondary">
        {t('reviewer.test.requestFailed')}
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
    <div className="arb:flex arb:flex-col arb:gap-2">
      <p
        role="status"
        data-arbiter-probe-status={result.status}
        {...(result.status === 'passed'
          ? {}
          : { 'data-arbiter-probe-failure': result.failure })}
        className="arb:m-0 arb:text-sm arb:font-semibold"
      >
        {headline}
      </p>
      <dl className="arb:m-0 arb:grid arb:grid-cols-[max-content_1fr] arb:gap-x-3 arb:gap-y-1 arb:text-xs">
        <dt className="arb:text-secondary">{t('reviewer.test.actualModel')}</dt>
        <dd className="arb:m-0">{actual}</dd>
        <dt className="arb:text-secondary">{t('reviewer.test.backend')}</dt>
        <dd className="arb:m-0">{result.backend}</dd>
        <dt className="arb:text-secondary">{t('reviewer.test.protocol')}</dt>
        <dd className="arb:m-0">{result.protocol}</dd>
        <dt className="arb:text-secondary">{t('reviewer.test.duration')}</dt>
        <dd className="arb:m-0">
          {t('reviewer.test.durationValue', { ms: result.durationMs })}
        </dd>
      </dl>
      <details>
        <summary className="arb:cursor-pointer arb:text-xs">
          {t('reviewer.test.details')}
        </summary>
        <div className="arb:mt-2 arb:flex arb:flex-col arb:gap-2.5">
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
    <section className="arb:flex arb:flex-col arb:gap-1">
      <div className="arb:text-xs arb:font-semibold">{props.label}</div>
      <div className="arb:text-[11.5px] arb:text-secondary">
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
    <div className="arb:flex arb:flex-col arb:gap-0.5">
      <span className="arb:text-[11.5px] arb:text-secondary">
        {props.label}
      </span>
      <pre className="arb:m-0 arb:max-h-[220px] arb:overflow-auto arb:rounded-md arb:bg-layer-4 arb:p-2 arb:font-mono arb:text-[11.5px] arb:whitespace-pre-wrap">
        {rendered}
      </pre>
    </div>
  );
}
