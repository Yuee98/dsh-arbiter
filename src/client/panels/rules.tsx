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
import type { Draft, DraftRule, Mutable } from '../view-types.js';
import type {
  RuleCondition,
  RuleKind,
  RuleScope,
  RuleTarget,
  RuleVerdict,
  RuleTestResult,
} from '../../types.js';

type MutableRuleCondition = Mutable<RuleCondition>;
type MutableRuleScope = Mutable<RuleScope>;

/**
 * The declaration a canonical rule needs.
 *
 * The page only knows the format identifier as data it sends back; it must not
 * import the backend configuration module, so the constant is repeated here.
 */
const CANONICAL_FORMAT = 'arbiter-config-v2';

const VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];
const TARGETS: readonly RuleTarget[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
  'argument',
];
const KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];

/** A new rule starts on the structural target the old editor defaulted to. */
function defaultCondition(): MutableRuleCondition {
  return { target: 'command', kind: 'regex', pattern: '' };
}

/** The pattern as editable text; a typed pattern keeps its JSON spelling. */
function patternText(condition: RuleCondition): string {
  return typeof condition.pattern === 'string'
    ? condition.pattern
    : JSON.stringify(condition.pattern);
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Replace one scope dimension and drop the scope object when nothing remains.
 *
 * The draft type mirrors a readonly rule, so a scope is rebuilt rather than
 * mutated in place; `exactOptionalPropertyTypes` forbids assigning `undefined`.
 */
function withScope(
  current: MutableRuleScope | undefined,
  change: {
    readonly tools?: readonly string[];
    readonly agents?: readonly string[];
  },
): MutableRuleScope | undefined {
  const tools =
    change.tools === undefined
      ? current?.tools
      : change.tools.length === 0
        ? undefined
        : change.tools;
  const agents =
    change.agents === undefined
      ? current?.agents
      : change.agents.length === 0
        ? undefined
        : change.agents;
  if (tools === undefined && agents === undefined) return undefined;
  return {
    ...(tools === undefined ? {} : { tools: [...tools] }),
    ...(agents === undefined ? {} : { agents: [...agents] }),
  };
}

/** The first condition, which the compact table row edits. */
function primaryCondition(rule: DraftRule): MutableRuleCondition {
  return rule.conditions[0] ?? defaultCondition();
}

/** Edit the first condition, leaving any additional conditions untouched. */
function updatePrimaryCondition(
  rule: DraftRule,
  mutator: (condition: MutableRuleCondition) => void,
): void {
  if (rule.conditions.length === 0) rule.conditions.push(defaultCondition());
  const first = rule.conditions[0];
  if (first !== undefined) mutator(first);
}

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
                  conditions: [defaultCondition()],
                  verdict: 'allow',
                  comment: '',
                });
                // A canonical rule needs the canonical declaration; without it
                // the document would still be read as the legacy format.
                next.format = CANONICAL_FORMAT;
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
          value={primaryCondition(rule).target}
          options={TARGETS}
          onChange={(value) => {
            updateRule(index, (next) => {
              updatePrimaryCondition(next, (condition) => {
                condition.target = value;
                // `path` and `multi` belong to the argument target only, so a
                // target change drops them instead of leaving an invalid rule.
                if (value === 'argument') return;
                delete condition.path;
                delete condition.multi;
              });
            });
          }}
        />
      </td>
      <td style={{ padding: 6, minWidth: 260 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <div style={{ width: 86 }}>
            <Select
              ariaLabel={t('rules.kind')}
              value={primaryCondition(rule).kind}
              options={KINDS}
              onChange={(value) => {
                updateRule(index, (next) => {
                  updatePrimaryCondition(next, (condition) => {
                    condition.kind = value;
                  });
                });
              }}
            />
          </div>
          <TextInput
            ariaLabel={t('rules.pattern')}
            value={patternText(primaryCondition(rule))}
            onChange={(value) => {
              updateRule(index, (next) => {
                updatePrimaryCondition(next, (condition) => {
                  condition.pattern = value;
                  if (condition.kind !== 'exact') condition.pattern = value;
                });
              });
            }}
            monospace
          />
        </div>
        {primaryCondition(rule).target === 'argument' ? (
          <TextInput
            ariaLabel={t('rules.path')}
            value={primaryCondition(rule).path ?? ''}
            placeholder={t('rules.pathPlaceholder')}
            onChange={(value) => {
              updateRule(index, (next) => {
                updatePrimaryCondition(next, (condition) => {
                  if (value.length === 0) delete condition.path;
                  else condition.path = value;
                });
              });
            }}
            monospace
          />
        ) : null}
      </td>
      <td style={{ padding: 6, minWidth: 150 }}>
        <TextInput
          ariaLabel={t('rules.tool')}
          value={(rule.scope?.tools ?? []).join(', ')}
          placeholder={t('rules.tool')}
          onChange={(value) => {
            updateRule(index, (next) => {
              const scope = withScope(next.scope, { tools: splitList(value) });
              if (scope === undefined) delete next.scope;
              else next.scope = scope;
            });
          }}
          monospace
        />
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
          value={(rule.scope?.agents ?? []).join(', ')}
          placeholder={t('rules.agents')}
          onChange={(value) => {
            updateRule(index, (next) => {
              const scope = withScope(next.scope, { agents: splitList(value) });
              if (scope === undefined) delete next.scope;
              else next.scope = scope;
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
