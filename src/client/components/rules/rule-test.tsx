import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { RuleTestResult } from '../../../types.js';
import { postJson } from '../../api.js';
import { ruleTestResponse } from '../../decoders/rules.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { errorText } from '../../view-helpers.js';
import type { Draft, DraftRule } from '../../view-types.js';
import { Button, JsonBlock, Notice, Section, inputStyle } from '../controls.js';
import { ruleName } from './draft.js';

/**
 * The rule tester.
 *
 * It answers from the whole current draft, never from the effective document,
 * and it does not save. The block is a separate component so the list stays a
 * list and a later issue can replace this body without touching the editor.
 */
export function RuleTest(props: {
  readonly draft: Draft;
  readonly focusedRule: DraftRule | null;
  readonly focusRequest: number;
}): ReactNode {
  const t = useArbiterTranslation();
  const [testInput, setTestInput] = useState(
    'gh pr view 42\ngpt-relay send --to-prod\nrm -rf /tmp/build',
  );
  const [testResults, setTestResults] = useState<readonly RuleTestResult[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // A header "test" action only focuses the tester for that rule; it never
  // answers by itself, so the operator still chooses the sample input.
  useEffect(() => {
    if (props.focusRequest === 0) return;
    inputRef.current?.focus();
  }, [props.focusRequest]);

  const runTest = async (): Promise<void> => {
    setBusy(true);
    setTestError(null);
    try {
      const response = await postJson(
        '/test',
        {
          inputs: testInput
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
          rules: props.draft.rules,
        },
        ruleTestResponse,
      );
      setTestResults(response.results);
    } catch (error) {
      setTestError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t('rules.testTitle')}
      description={t('rules.testDescription')}
    >
      {props.focusedRule === null ? null : (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          {t('rules.testTarget', {
            name: ruleName(props.focusedRule, t),
          })}
        </p>
      )}
      <textarea
        ref={inputRef}
        aria-label={t('rules.input')}
        value={testInput}
        onChange={(event) => {
          setTestInput(event.target.value);
        }}
        rows={5}
        style={{
          ...inputStyle,
          height: 'auto',
          padding: 8,
          fontFamily: 'var(--dsw-font-mono, monospace)',
        }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          onClick={() => {
            runTest().catch((failure: unknown) => {
              setTestError(errorText(failure));
            });
          }}
          disabled={busy}
          tone="primary"
        >
          {busy ? t('rules.testing') : t('rules.runTest')}
        </Button>
        <span
          style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
        >
          {t('rules.inputHint')}
        </span>
      </div>
      {testError === null ? null : <Notice kind="error" text={testError} />}
      {testResults.length === 0 ? null : (
        <table
          style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}
        >
          <thead>
            <tr
              style={{
                textAlign: 'left',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              <th style={{ padding: 6 }}>{t('rules.path')}</th>
              <th style={{ padding: 6 }}>{t('rules.input')}</th>
              <th style={{ padding: 6 }}>{t('rules.matched')}</th>
              <th style={{ padding: 6 }}>{t('rules.shadowed')}</th>
            </tr>
          </thead>
          <tbody>
            {testResults.map((result, index) => (
              <tr
                key={`${result.input}-${String(index)}`}
                onClick={() => {
                  setExpanded(expanded === index ? null : index);
                }}
                style={{
                  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                  cursor: 'pointer',
                  verticalAlign: 'top',
                }}
              >
                <td
                  style={{
                    padding: 6,
                    fontFamily: 'var(--dsw-font-mono, monospace)',
                  }}
                >
                  {result.path}
                </td>
                <td
                  style={{
                    padding: 6,
                    fontFamily: 'var(--dsw-font-mono, monospace)',
                  }}
                >
                  {result.input}
                </td>
                <td style={{ padding: 6 }}>
                  {result.rule?.id ?? t('rules.unmatched')}
                </td>
                <td style={{ padding: 6 }}>
                  {result.shadowed.length > 0
                    ? result.shadowed.join(', ')
                    : '—'}
                  <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                    {result.parse.completeness} ·{' '}
                    {result.parse.nodes.join(', ') || '—'}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {expanded === null ? null : <JsonBlock value={testResults[expanded]} />}
    </Section>
  );
}
