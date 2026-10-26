import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../../i18n-provider.js';
import { Button, Notice } from '../controls.js';
import { errorText } from '../../view-helpers.js';
import { importedSample, recentCalls } from './rule-test-source.js';
import type { ImportableCall, ImportedTestSample } from './rule-test-source.js';

/**
 * "从调用记录带入": choose a past call and replay its original tool input.
 *
 * This is a read of the audit log, never a new judgement: the imported sample is
 * only a starting point the operator can edit, and the answer still comes from
 * the current draft. The recorded arguments object is preserved as-is, so the
 * tester evaluates the same tool input the call carried.
 */
export function RuleTestImport(props: {
  readonly disabled: boolean;
  readonly onImport: (imported: ImportedTestSample) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<readonly ImportableCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const recent = await recentCalls();
      if (!recent.ok) {
        setError(
          recent.code === 'audit-unavailable'
            ? t('ruleTest.importUnavailable')
            : t('ruleTest.importFailed', { error: recent.code }),
        );
        setCalls([]);
        return;
      }
      setCalls(recent.calls);
    } catch (failure) {
      setError(t('ruleTest.importFailed', { error: errorText(failure) }));
      setCalls([]);
    } finally {
      setBusy(false);
    }
  }, [t]);

  // Opening the picker is what reads the log; the panel does not query the
  // audit store on every tab visit.
  useEffect(() => {
    if (!open || calls !== null) return;
    load().catch((failure: unknown) => {
      setError(t('ruleTest.importFailed', { error: errorText(failure) }));
    });
  }, [open, calls, load, t]);

  const take = async (call: ImportableCall): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const imported = await importedSample(call.callId);
      if (!imported.ok) {
        setError(t('ruleTest.importFailed', { error: imported.code }));
        return;
      }
      props.onImport(imported.imported);
      setOpen(false);
    } catch (failure) {
      setError(t('ruleTest.importFailed', { error: errorText(failure) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Button
        disabled={props.disabled}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {t('ruleTest.importOpen')}
      </Button>
      {open ? (
        <div
          data-arbiter-test-import=""
          style={{
            border: '0.5px solid var(--dsw-alias-border-l2)',
            borderRadius: 6,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {busy && calls === null ? (
            <span style={{ fontSize: 12 }}>{t('ruleTest.running')}</span>
          ) : null}
          {error === null ? null : <Notice kind="error" text={error} />}
          {calls === null || calls.length > 0 ? null : (
            <span
              style={{
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('ruleTest.importEmpty')}
            </span>
          )}
          {(calls ?? []).map((call) => (
            <Button
              key={call.callId}
              disabled={busy}
              onClick={() => {
                take(call).catch((failure: unknown) => {
                  setError(
                    t('ruleTest.importFailed', { error: errorText(failure) }),
                  );
                });
              }}
            >
              {t('ruleTest.importCall', {
                tool: call.tool,
                call: call.callId,
              })}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
