import { ruleTestResponse } from '../decoders/rules.js';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { postJson } from '../api.js';
import {
  Button,
  JsonBlock,
  Notice,
  Section,
  Select,
  TextInput,
  inputStyle,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { errorText } from '../view-helpers.js';
import type { Draft, DraftRule } from '../view-types.js';
import type {
  RuleKind,
  RuleNode,
  RuleVerdict,
  RuleTestResult,
} from '../../types.js';

const VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];
const NODES: readonly RuleNode[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
];
const KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];

export function RulesPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { draft, onDraft } = props;

  return (
    <>
      <Section title={t('rules.title')} description={t('rules.description')}>
        <div style={{ overflowX: 'auto' }}>
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
                <th style={{ padding: 6 }}>{t('rules.enabled')}</th>
                <th style={{ padding: 6 }}>{t('rules.id')}</th>
                <th style={{ padding: 6 }}>{t('rules.node')}</th>
                <th style={{ padding: 6 }}>{t('rules.match')}</th>
                <th style={{ padding: 6 }}>{t('rules.toolSelector')}</th>
                <th style={{ padding: 6 }}>{t('rules.verdict')}</th>
                <th style={{ padding: 6 }}>{t('rules.scope')}</th>
                <th style={{ padding: 6 }}>{t('rules.comment')}</th>
                <th style={{ padding: 6 }}>{t('rules.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {draft.rules.map((rule, index) => (
                <RuleRow
                  key={`${rule.id}-${String(index)}`}
                  rule={rule}
                  index={index}
                  onDraft={onDraft}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() => {
              onDraft((next) => {
                next.rules.push({
                  id: `rule-${String(next.rules.length + 1)}`,
                  match: { node: 'command', kind: 'regex', pattern: '^' },
                  verdict: 'allow',
                  comment: '',
                });
              });
            }}
          >
            {t('rules.add')}
          </Button>
        </div>
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 11.5,
          }}
        >
          {t('rules.syntax')}
        </p>
      </Section>

      <RuleTests draft={draft} />
    </>
  );
}

function RuleRow({
  rule,
  index,
  onDraft,
}: {
  readonly rule: DraftRule;
  readonly index: number;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const updateRule = (
    _index: number,
    mutator: (rule: DraftRule) => void,
  ): void => {
    onDraft((next) => {
      const selected = next.rules[index];
      if (selected !== undefined) mutator(selected);
    });
  };
  return (
    <tr
      key={`${rule.id}-${String(index)}`}
      style={{
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      }}
    >
      <td style={{ padding: 6 }}>
        <input
          type="checkbox"
          aria-label={t('rules.enabled')}
          checked={rule.enabled !== false}
          onChange={(event) => {
            updateRule(index, (next) => {
              next.enabled = event.target.checked;
            });
          }}
        />
      </td>
      <td style={{ padding: 6, minWidth: 120 }}>
        <TextInput
          ariaLabel={t('rules.id')}
          value={rule.id}
          onChange={(value) => {
            updateRule(index, (next) => {
              next.id = value;
            });
          }}
          monospace
        />
      </td>
      <td style={{ padding: 6 }}>
        <Select
          ariaLabel={t('rules.node')}
          value={rule.match.node}
          options={NODES}
          onChange={(value) => {
            updateRule(index, (next) => {
              next.match.node = value;
            });
          }}
        />
      </td>
      <td style={{ padding: 6, minWidth: 220 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <div style={{ width: 86 }}>
            <Select
              ariaLabel={t('rules.kind')}
              value={rule.match.kind}
              options={KINDS}
              onChange={(value) => {
                updateRule(index, (next) => {
                  next.match.kind = value;
                });
              }}
            />
          </div>
          <TextInput
            ariaLabel={t('rules.pattern')}
            value={rule.match.pattern}
            onChange={(value) => {
              updateRule(index, (next) => {
                next.match.pattern = value;
              });
            }}
            monospace
          />
        </div>
      </td>
      <td style={{ padding: 6, minWidth: 150 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <TextInput
            ariaLabel={t('rules.tool')}
            value={rule.match.tool ?? ''}
            placeholder={t('rules.tool')}
            onChange={(value) => {
              updateRule(index, (next) => {
                if (value.length === 0) delete next.match.tool;
                else next.match.tool = value;
              });
            }}
            monospace
          />
          <TextInput
            ariaLabel={t('rules.selector')}
            value={rule.match.selector ?? ''}
            placeholder={t('rules.selector')}
            onChange={(value) => {
              updateRule(index, (next) => {
                if (value.length === 0) delete next.match.selector;
                else next.match.selector = value;
              });
            }}
            monospace
          />
        </div>
      </td>
      <td style={{ padding: 6, minWidth: 110 }}>
        <Select
          ariaLabel={t('rules.verdict')}
          value={rule.verdict}
          options={VERDICTS}
          labels={{
            allow: t('rules.allow'),
            deny: t('rules.deny'),
            'force-ask': t('rules.forceAsk'),
            'force-review': t('rules.forceReview'),
          }}
          onChange={(value) => {
            updateRule(index, (next) => {
              next.verdict = value;
            });
          }}
        />
      </td>
      <td style={{ padding: 6, minWidth: 150 }}>
        <TextInput
          ariaLabel={t('rules.scope')}
          value={(rule.match.agents ?? []).join(', ')}
          placeholder={t('rules.agents')}
          onChange={(value) => {
            updateRule(index, (next) => {
              const agents = value
                .split(',')
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
              if (agents.length === 0) delete next.match.agents;
              else next.match.agents = agents;
            });
          }}
        />
      </td>
      <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
        <Button
          onClick={() => {
            onDraft((next) => {
              next.rules.splice(index, 1);
            });
          }}
          tone="danger"
        >
          {t('rules.delete')}
        </Button>
      </td>
    </tr>
  );
}

function RuleTests({ draft }: { readonly draft: Draft }): ReactNode {
  const t = useArbiterTranslation();
  const [testInput, setTestInput] = useState(
    'gh pr view 42\ngpt-relay send --to-prod\nrm -rf /tmp/build',
  );
  const [testResults, setTestResults] = useState<readonly RuleTestResult[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

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
          rules: draft.rules,
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
      <textarea
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
