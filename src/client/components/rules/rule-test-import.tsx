import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { errorText, formatTime } from '../../view-helpers.js';
import { Button, Notice } from '../controls.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { importedSample, recentCalls } from './rule-test-source.js';
import type { ImportableCall, ImportedTestSample } from './rule-test-source.js';

/**
 * Pick one recorded call.
 *
 * The chosen call is reported with its id as well as the replayable sample, so a
 * caller can keep the source for a draft, not only fill the tester's inputs.
 */
export function RuleTestImport(props: {
  readonly disabled: boolean;
  /** The trigger's copy; the tester's own label stays the default. */
  readonly triggerLabelKey?: string | undefined;
  readonly onImport: (callId: string, imported: ImportedTestSample) => void;
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
      props.onImport(call.callId, imported.imported);
      setOpen(false);
    } catch (failure) {
      setError(t('ruleTest.importFailed', { error: errorText(failure) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button disabled={props.disabled}>
          {t(props.triggerLabelKey ?? 'ruleTest.importOpen')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-arbiter-test-import=""
        data-rule-test-import-content=""
        aria-label={t('ruleTest.importOpen')}
        className="arb:max-h-80 arb:w-80 arb:overflow-y-auto arb:p-3"
      >
        <div className="arb:flex arb:flex-col arb:gap-2">
          {busy && calls === null ? (
            <span className="arb:text-xs arb:text-secondary">
              {t('ruleTest.running')}
            </span>
          ) : null}
          {error === null ? null : <Notice kind="error" text={error} />}
          {calls !== null && calls.length === 0 && error === null ? (
            <span className="arb:text-xs arb:text-secondary">
              {t('ruleTest.importEmpty')}
            </span>
          ) : null}
          {(calls ?? []).map((call) => {
            const accessibleTitle = t('ruleTest.importCall', {
              tool: call.tool,
              call: call.callId,
            });
            const summary = call.command ?? t('ruleTest.importCommandEmpty');
            const time = call.ts > 0 ? formatTime(call.ts) : '';

            return (
              <button
                key={call.callId}
                type="button"
                disabled={busy}
                onClick={() => {
                  take(call).catch((failure: unknown) => {
                    setError(
                      t('ruleTest.importFailed', {
                        error: errorText(failure),
                      }),
                    );
                  });
                }}
                className="arb:flex arb:flex-col arb:gap-1 arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:p-2 arb:text-left arb:transition-colors hover:arb:bg-layer-4 disabled:arb:opacity-50"
              >
                <div className="arb:flex arb:items-center arb:justify-between arb:gap-2">
                  <span className="arb:truncate arb:text-xs arb:font-medium arb:text-primary">
                    {accessibleTitle}
                  </span>
                  {time ? (
                    <span className="arb:shrink-0 arb:text-xs arb:text-secondary">
                      {time}
                    </span>
                  ) : null}
                </div>
                <div className="arb:text-xs arb:text-secondary arb:line-clamp-2 arb:break-all">
                  {summary}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
