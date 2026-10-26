import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, postJson } from '../../api.js';
import { ruleTestResponse } from '../../decoders/rules.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { SessionKind } from '../../../types.js';
import { configErrors, errorText } from '../../view-helpers.js';
import { issuesText } from '../../view-issues.js';
import type { ConfigIssueView } from '../../view-issues.js';
import type { Draft, DraftRule, RuleTestResultView } from '../../view-types.js';
import {
  Button,
  Notice,
  Section,
  Select,
  TextInput,
  inputStyle,
} from '../controls.js';
import { ruleName } from './draft.js';
import { RuleTestImport } from './rule-test-import.js';
import type { ImportedTestSample } from './rule-test-source.js';
import { RuleTestConclusion, RuleTestDetails } from './rule-test-result.js';
import {
  buildSample,
  defaultTool,
  issueTarget,
  testSignature,
} from './rule-test-model.js';
import type {
  IssueTarget,
  SampleProblem,
  TestInputMode,
} from './rule-test-model.js';

/** One answer, kept with the signature of the sample and draft that produced it. */
interface Answered {
  readonly result: RuleTestResultView;
  readonly signature: string;
}

/**
 * The rule tester.
 *
 * Two boundaries define it. It evaluates the whole current draft, never the saved
 * document, and it answers through the host route that runs the same evaluator as
 * the gate — this component decides nothing about matching. It also writes
 * nothing: no tool runs, the Reviewer is never asked, and no approval audit row
 * is produced.
 *
 * A result is tied to the sample and rules that produced it. Editing either one
 * keeps the old answer readable but marks it as needing another run, which is
 * more useful than silently presenting a stale verdict as current.
 */
export function RuleTest(props: {
  readonly draft: Draft;
  /**
   * Asked to bring one condition's error into view.
   *
   * The tester owns the request it produced: a rejected selector comes back with
   * the rule and condition path, and the operator can jump there instead of
   * reading a bare path. The panel decides how to show the condition, so this
   * component does not reach into the editor.
   */
  readonly onLocateIssue?: (target: IssueTarget) => void;
  /**
   * The rule whose header "test" action opened the tester.
   *
   * The prop names here are the ones the rule-list panel already passes, so this
   * component can replace the placeholder tester without changing its wiring.
   */
  readonly focusedRule: DraftRule | null;
  /**
   * Bumped by the rule list each time its "test" action runs.
   *
   * The counter, not the rule id, is what opens and focuses the tester: asking
   * to test the rule that is already selected must still bring the sample into
   * view, and it must never start a run by itself.
   */
  readonly focusRequest: number;
}): ReactNode {
  const t = useArbiterTranslation();
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Requests start at zero, so a non-zero initial value means the list already
  // asked for this tester and the block opens on first render.
  const [handled, setHandled] = useState(0);

  // A header action opens the block and moves focus to its sample. Focus moves
  // to the container rather than the textarea so screen readers announce the
  // block's label first; the operator then tabs into the sample.
  //
  // The request only sets the intent: the body does not exist yet in that
  // render, so focusing happens in the effect that runs once it is mounted.
  const [pendingFocus, setPendingFocus] = useState(false);
  useEffect(() => {
    if (props.focusRequest === handled) return;
    setHandled(props.focusRequest);
    setOpen(true);
    setPendingFocus(true);
  }, [props.focusRequest, handled]);
  useEffect(() => {
    if (!pendingFocus || !open) return;
    bodyRef.current?.focus();
    setPendingFocus(false);
  }, [pendingFocus, open]);

  return (
    <Section
      title={t('ruleTest.title')}
      description={t('ruleTest.draftNotice')}
      ariaLabel={t('ruleTest.title')}
    >
      {props.focusedRule === null ? null : (
        // The tester answers about one rule, so it names that rule; a focus
        // request that landed on a different rule would otherwise be invisible.
        <p
          data-testid="rule-test-target"
          style={{
            margin: 0,
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          {t('ruleTest.testTarget', {
            name: ruleName(props.focusedRule, t),
          })}
        </p>
      )}
      {open ? (
        <div
          ref={bodyRef}
          tabIndex={-1}
          data-testid="rule-test-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('ruleTest.close')}
            </Button>
          </div>
          <RuleTestForm
            draft={props.draft}
            focusedRule={props.focusedRule}
            {...(props.onLocateIssue === undefined
              ? {}
              : { onLocateIssue: props.onLocateIssue })}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('ruleTest.open')}
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * The editable sample, reset when the focused rule changes.
 *
 * Switching rules seeds a starter sample for the new rule but keeps the answer
 * already on screen; that answer is marked stale by the form instead of being
 * discarded.
 */
function useFocusedRuleSample(rule: DraftRule | null): {
  readonly mode: TestInputMode;
  readonly setMode: (mode: TestInputMode) => void;
  readonly tool: string;
  readonly setTool: (tool: string) => void;
  readonly text: string;
  readonly setText: (text: string) => void;
} {
  const initialMode = defaultMode(rule);
  const [mode, setMode] = useState<TestInputMode>(initialMode);
  const [tool, setTool] = useState(() => defaultTool(rule));
  const [text, setText] = useState(() => defaultText(rule, initialMode));
  const [seededRule, setSeededRule] = useState(rule?.id ?? null);
  if ((rule?.id ?? null) !== seededRule) {
    setSeededRule(rule?.id ?? null);
    const nextMode = defaultMode(rule);
    setMode(nextMode);
    setTool(defaultTool(rule));
    setText(defaultText(rule, nextMode));
  }
  return { mode, setMode, tool, setTool, text, setText };
}

function RuleTestForm(props: {
  readonly draft: Draft;
  readonly focusedRule: DraftRule | null;
  readonly onLocateIssue?: (target: IssueTarget) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { mode, setMode, tool, setTool, text, setText } = useFocusedRuleSample(
    props.focusedRule,
  );
  const [identity, setIdentity] = useState<SessionKind>('main');
  // The directory the sample is evaluated in. Empty means "let the host use its
  // own process directory", which is only a display default: a redirect rule
  // needs a real cwd to resolve against.
  const [cwd, setCwd] = useState('');
  const [problem, setProblem] = useState<SampleProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [issueTargets, setIssueTargets] = useState<readonly IssueTarget[]>([]);
  const [answer, setAnswer] = useState<Answered | null>(null);
  const [busy, setBusy] = useState(false);

  // A result becomes stale when the sample, the focused rule or any draft rule
  // changes. The signature covers the whole rule list because the tester
  // evaluates all of it, and the focused rule because the rule conclusion is
  // read from it.
  const signature = useMemo(() => {
    const sample = buildSample({ tool, identity, mode, text });
    if (!sample.ok) return null;
    return testSignature(
      sample.sample,
      identity,
      props.draft.rules,
      props.focusedRule?.id ?? null,
      cwd,
    );
  }, [
    tool,
    identity,
    mode,
    text,
    props.draft.rules,
    props.focusedRule?.id,
    cwd,
  ]);

  const stale = answer !== null && signature !== answer.signature;

  // An imported call brings its own identity and working directory: both are
  // evaluation inputs, so the sample is replayed under the context it was
  // judged in rather than under the form's current values.
  const importSample = useCallback(
    (imported: ImportedTestSample): void => {
      setTool(imported.sample.tool);
      setMode('arguments');
      setText(imported.sample.input);
      setIdentity(imported.identity);
      setCwd(imported.cwd ?? '');
      setProblem(null);
      setFailure(null);
    },
    [setMode, setText, setTool],
  );

  const run = async (): Promise<void> => {
    const built = buildSample({ tool, identity, mode, text });
    if (!built.ok) {
      setProblem(built.problem);
      setFailure(null);
      return;
    }
    setProblem(null);
    setFailure(null);
    setIssueTargets([]);
    setBusy(true);
    try {
      const response = await postJson(
        '/test',
        {
          samples: [
            {
              tool: built.sample.tool,
              args: built.sample.args,
              ...(cwd.trim().length === 0 ? {} : { cwd: cwd.trim() }),
            },
          ],
          rules: props.draft.rules,
          identity,
        },
        ruleTestResponse,
      );
      const first = response.results[0];
      setAnswer(
        first === undefined
          ? null
          : {
              result: first,
              signature: testSignature(
                built.sample,
                identity,
                props.draft.rules,
                props.focusedRule?.id ?? null,
                cwd,
              ),
            },
      );
    } catch (error) {
      // Invalid draft rules are a draft problem, not a transport failure: the
      // backend names the rule and condition so the editor can be corrected.
      if (error instanceof ApiError) {
        const issues = configErrors(error.payload);
        // Resolved against the draft that produced the error, so the target
        // keeps naming the same rule after a later insert or reorder.
        setIssueTargets(
          issues.map((issue) => issueTarget(issue.path, props.draft.rules)),
        );
        setFailure(invalidDraftText(error, issues, t));
      } else {
        setIssueTargets([]);
        setFailure(t('ruleTest.requestFailed', { error: errorText(error) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <RuleTestInputs
        tool={tool}
        identity={identity}
        mode={mode}
        cwd={cwd}
        busy={busy}
        onTool={(next) => {
          setTool(next);
          setProblem(null);
        }}
        onIdentity={setIdentity}
        onMode={(next) => {
          setMode(next);
          setProblem(null);
        }}
        onCwd={setCwd}
        onImport={importSample}
      />
      <textarea
        aria-label={
          mode === 'command' ? t('ruleTest.command') : t('ruleTest.arguments')
        }
        {...(problem === null ? {} : { 'aria-invalid': true })}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(null);
        }}
        placeholder={
          mode === 'command'
            ? t('ruleTest.commandPlaceholder')
            : t('ruleTest.argumentsPlaceholder')
        }
        rows={mode === 'command' ? 3 : 6}
        style={{
          ...inputStyle,
          height: 'auto',
          padding: 8,
          fontFamily: 'var(--dsw-font-mono, monospace)',
        }}
      />
      {problem === null ? null : (
        <Notice kind="error" text={problemText(problem, t)} />
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          onClick={() => {
            run().catch((error: unknown) => {
              setFailure(
                t('ruleTest.requestFailed', { error: errorText(error) }),
              );
            });
          }}
          disabled={busy}
          tone="primary"
        >
          {busy ? t('ruleTest.running') : t('ruleTest.run')}
        </Button>
      </div>
      {failure === null ? null : <Notice kind="error" text={failure} />}
      {issueTargets.length === 0 || props.onLocateIssue === undefined
        ? null
        : issueTargets.map((target) => (
            <div key={target.path}>
              <Button
                onClick={() => {
                  props.onLocateIssue?.(target);
                }}
              >
                {t('ruleTest.locateIssue', { path: target.path })}
              </Button>
            </div>
          ))}
      {stale ? <Notice kind="info" text={t('ruleTest.needsRetest')} /> : null}
      {answer === null ? null : (
        <div
          data-testid="rule-test-answer"
          data-arbiter-test-answer=""
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <RuleTestConclusion
            result={answer.result}
            rule={props.focusedRule}
            stale={stale}
          />
          <RuleTestDetails result={answer.result} rule={props.focusedRule} />
        </div>
      )}
    </div>
  );
}

/** Argument conditions read an object, so a rule with one starts in JSON mode. */
function defaultMode(rule: DraftRule | null): TestInputMode {
  return rule?.conditions.some(
    (condition) => condition.target === 'argument',
  ) === true
    ? 'arguments'
    : 'command';
}

function defaultText(rule: DraftRule | null, mode: TestInputMode): string {
  if (mode === 'arguments') return '{}';
  const pattern = rule?.conditions.find(
    (condition) =>
      condition.target === 'command' && typeof condition.pattern === 'string',
  )?.pattern;
  return typeof pattern === 'string' ? sampleFor(pattern) : 'gh pr view 42';
}

/**
 * A runnable starter for a plain command condition.
 *
 * A regex or glob pattern is not a command, so the placeholder sample stays
 * generic; turning an expression into a concrete command would imply the tester
 * saw an input it never saw.
 */
function sampleFor(pattern: string): string {
  return /^[\w .:/-]+$/u.test(pattern) ? pattern : 'gh pr view 42';
}

function problemText(
  problem: SampleProblem,
  t: ReturnType<typeof useArbiterTranslation>,
): string {
  switch (problem.kind) {
    case 'tool-required':
      return t('ruleTest.toolRequired');
    case 'command-required':
      return t('ruleTest.commandRequired');
    case 'json-syntax':
      return t('ruleTest.jsonSyntax', { message: problem.message });
    case 'json-shape':
      return t('ruleTest.jsonShape');
  }
}

/**
 * Turn a rejected draft into the rule and condition it names.
 *
 * The backend already sends paths such as `rules[2].conditions[0].path`, which is
 * exactly where a bad JSONPath lives; keeping that path lets the reader find the
 * condition instead of being told only that the tester failed.
 */
function invalidDraftText(
  error: ApiError,
  issues: readonly ConfigIssueView[],
  t: ReturnType<typeof useArbiterTranslation>,
): string {
  if (issues.length === 0)
    return t('ruleTest.requestFailed', { error: error.message });
  return `${t('ruleTest.invalidRules')}\n${issuesText(issues, t)}`;
}

/**
 * Tool, agent, input mode and working directory.
 *
 * These are the evaluation inputs, not presentation: each one changes what the
 * evaluator sees, so they stay visible above the sample instead of behind a
 * "advanced" disclosure.
 */
function RuleTestInputs(props: {
  readonly tool: string;
  readonly identity: SessionKind;
  readonly mode: TestInputMode;
  readonly cwd: string;
  readonly busy: boolean;
  readonly onTool: (tool: string) => void;
  readonly onIdentity: (identity: SessionKind) => void;
  readonly onMode: (mode: TestInputMode) => void;
  readonly onCwd: (cwd: string) => void;
  readonly onImport: (imported: ImportedTestSample) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        alignItems: 'flex-end',
      }}
    >
      <div style={{ width: 170 }}>
        <TextInput
          ariaLabel={t('ruleTest.tool')}
          value={props.tool}
          onChange={props.onTool}
          monospace
        />
      </div>
      <div style={{ width: 170 }}>
        <Select
          ariaLabel={t('ruleTest.agent')}
          value={props.identity}
          options={['main', 'subagent'] as const}
          labels={{
            main: t('ruleTest.agentMain'),
            subagent: t('ruleTest.agentSubagent'),
          }}
          onChange={props.onIdentity}
        />
      </div>
      <div style={{ width: 190 }}>
        <Select
          ariaLabel={t('ruleTest.mode')}
          value={props.mode}
          options={['command', 'arguments'] as const}
          labels={{
            command: t('ruleTest.modeCommand'),
            arguments: t('ruleTest.modeArguments'),
          }}
          onChange={props.onMode}
        />
      </div>
      <div style={{ width: 220 }}>
        <TextInput
          ariaLabel={t('ruleTest.cwd')}
          value={props.cwd}
          onChange={props.onCwd}
          placeholder={t('ruleTest.cwdPlaceholder')}
          monospace
        />
      </div>
      <RuleTestImport disabled={props.busy} onImport={props.onImport} />
    </div>
  );
}
