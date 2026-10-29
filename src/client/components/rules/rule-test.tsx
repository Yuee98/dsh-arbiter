import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SessionKind } from '../../../types.js';
import { ApiError, postJson } from '../../api.js';
import { ruleTestResponse } from '../../decoders/rules.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { configErrors, errorText } from '../../view-helpers.js';
import { issuesText } from '../../view-issues.js';
import type { ConfigIssueView } from '../../view-issues.js';
import type { Draft, DraftRule, RuleTestResultView } from '../../view-types.js';
import { Button, Field, Notice, Select, TextInput } from '../controls.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { ruleName } from './draft.js';
import { RuleTestImport } from './rule-test-import.js';
import {
  recordedSampleOf,
  recordedStillMatches,
  useSeedApplication,
} from './rule-test-recorded.js';
import type { RecordedSample } from './rule-test-recorded.js';
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
import { RuleTestConclusion, RuleTestDetails } from './rule-test-result.js';
import type { ImportedTestSample } from './rule-test-source.js';

interface RejectedDraft {
  readonly targets: readonly IssueTarget[];
  readonly rules: Draft['rules'];
}

function IssueLocators(props: {
  readonly issues: RejectedDraft;
  readonly currentRules: Draft['rules'];
  readonly onLocate: (target: IssueTarget) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const current = JSON.stringify(props.currentRules);
  if (current !== JSON.stringify(props.issues.rules)) {
    return <Notice kind="info" text={t('ruleTest.issuesOutdated')} />;
  }
  return (
    <div className="arb:flex arb:flex-col arb:gap-1.5">
      {props.issues.targets.map((target) => (
        <div key={target.path}>
          <Button
            onClick={() => {
              props.onLocate(target);
            }}
          >
            {t('ruleTest.locateIssue', { path: target.path })}
          </Button>
        </div>
      ))}
    </div>
  );
}

interface Answered {
  readonly result: RuleTestResultView;
  readonly signature: string;
}

/**
 * A recorded call to load into the tester.
 *
 * `nonce` identifies one request: re-targeting the tester with the same sample
 * twice must still reload it, and a new sample must replace what is on screen.
 * The `callId` is kept so the tester can name the recorded call the inputs came
 * from instead of presenting them as a sample someone just typed.
 */
export interface SampleSeed {
  readonly nonce: number;
  readonly callId: string;
  readonly imported: ImportedTestSample;
}

export function RuleTest(props: {
  readonly draft: Draft;
  readonly focusedRule: DraftRule | null;
  readonly focusRequest: number;
  readonly renderTrigger?: boolean | undefined;
  readonly openerRef?: React.RefObject<HTMLElement | null> | undefined;
  readonly onLocateIssue?: (target: IssueTarget) => void;
  readonly onClearFocus?: () => void;
  readonly sampleSeed?: SampleSeed | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const locatingRef = useRef(false);
  const internalOpenerRef = useRef<HTMLElement | null>(null);

  const [handled, setHandled] = useState(0);

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

  const handleLocate = (target: IssueTarget): void => {
    locatingRef.current = true;
    setOpen(false);
    props.onLocateIssue?.(target);
  };

  return (
    <>
      {props.renderTrigger !== false ? (
        <div className="arb:flex arb:gap-2">
          <Button
            onClick={(event) => {
              internalOpenerRef.current = event.currentTarget;
              setOpen(true);
            }}
          >
            {t('ruleTest.open')}
          </Button>
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-rule-tester-dialog=""
          surface="rule-test-dialog"
          closeLabel={t('ruleTest.close')}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            bodyRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (locatingRef.current) {
              event.preventDefault();
              locatingRef.current = false;
              return;
            }
            event.preventDefault();
            const opener =
              props.openerRef?.current ?? internalOpenerRef.current;
            if (opener !== null && document.contains(opener)) {
              opener.focus();
            } else {
              const fallback =
                document.querySelector<HTMLElement>(
                  '[data-arbiter-surface="rules-panel"] button, [data-arbiter-root] button, button',
                ) ?? null;
              fallback?.focus();
            }
          }}
          className="arb:max-h-[90vh] arb:max-w-4xl arb:overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>{t('ruleTest.title')}</DialogTitle>
            <DialogDescription>
              {t('ruleTest.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div
            ref={bodyRef}
            tabIndex={-1}
            data-testid="rule-test-body"
            data-rule-test=""
            className="arb:flex arb:flex-col arb:gap-3"
          >
            <Notice kind="info" text={t('ruleTest.draftNotice')} />

            {props.focusedRule !== null ? (
              <div
                data-testid="rule-test-target"
                className="arb:flex arb:items-center arb:justify-between arb:gap-2 arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:p-2.5 arb:text-xs arb:text-secondary"
              >
                <span>
                  {t('ruleTest.testTarget', {
                    name: ruleName(props.focusedRule, t),
                  })}
                </span>
                {props.onClearFocus !== undefined ? (
                  <Button onClick={props.onClearFocus} tone="plain">
                    {t('ruleTest.clearFocusedRule')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <RuleTestForm
              draft={props.draft}
              focusedRule={props.focusedRule}
              onLocateIssue={handleLocate}
              {...(props.sampleSeed === undefined
                ? {}
                : { seed: props.sampleSeed })}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function useFocusedRuleSample(rule: DraftRule | null) {
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
  readonly seed?: SampleSeed | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  const { mode, setMode, tool, setTool, text, setText } = useFocusedRuleSample(
    props.focusedRule,
  );
  const [identity, setIdentity] = useState<SessionKind>('main');
  const [cwd, setCwd] = useState('');
  const [problem, setProblem] = useState<SampleProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [issues, setIssues] = useState<RejectedDraft | null>(null);
  const [answer, setAnswer] = useState<Answered | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<RecordedSample | null>(null);

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

  const importSample = useCallback(
    (callId: string, imported: ImportedTestSample): void => {
      setTool(imported.sample.tool);
      setMode('arguments');
      setText(imported.sample.input);
      setIdentity(imported.identity);
      setCwd(imported.cwd ?? '');
      setProblem(null);
      setFailure(null);
      setSource(recordedSampleOf(callId, imported));
    },
    [setMode, setText, setTool],
  );

  // A draft created from a call hands its sample here. The nonce makes this one
  // load per request, so re-opening the same call reloads the recorded values
  // instead of keeping whatever was typed in between.
  const seed = props.seed;
  useSeedApplication(seed, () => {
    if (seed !== undefined) importSample(seed.callId, seed.imported);
  });

  const recorded = recordedStillMatches(source, {
    tool,
    text,
    mode,
    identity,
    cwd,
  });

  const run = async (): Promise<void> => {
    const built = buildSample({ tool, identity, mode, text });
    if (!built.ok) {
      setProblem(built.problem);
      setFailure(null);
      return;
    }
    setProblem(null);
    setFailure(null);
    setIssues(null);
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
      if (error instanceof ApiError) {
        const reported = configErrors(error.payload);
        setIssues({
          targets: reported.map((issue) =>
            issueTarget(issue.path, props.draft.rules),
          ),
          rules: props.draft.rules,
        });
        setFailure(invalidDraftText(error, reported, t));
      } else {
        setIssues(null);
        setFailure(t('ruleTest.requestFailed', { error: errorText(error) }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="arb:flex arb:flex-col arb:gap-3">
      <RecordedNote source={source} recorded={recorded} />
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
        className="arb:w-full arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:p-2.5 arb:font-mono arb:text-xs arb:text-primary arb:focus:border-accent arb:focus:outline-none"
      />
      {problem === null ? null : (
        <Notice kind="error" text={problemText(problem, t)} />
      )}
      <div className="arb:flex arb:items-center arb:gap-2">
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
      {issues === null || props.onLocateIssue === undefined ? null : (
        <IssueLocators
          issues={issues}
          currentRules={props.draft.rules}
          onLocate={props.onLocateIssue}
        />
      )}
      {stale ? <Notice kind="info" text={t('ruleTest.needsRetest')} /> : null}
      <AnswerBlock
        answer={answer === null ? null : answer.result}
        rule={props.focusedRule}
        stale={stale}
      />
    </div>
  );
}

/**
 * The two conclusions, kept in one block.
 *
 * They answer different questions — did the selected rule match, and which path
 * did the whole draft take — so they are rendered together but never merged, and
 * both carry the same stale flag.
 */
function AnswerBlock(props: {
  readonly answer: RuleTestResultView | null;
  readonly rule: DraftRule | null;
  readonly stale: boolean;
}): ReactNode {
  if (props.answer === null) return null;
  return (
    <div
      data-testid="rule-test-answer"
      data-arbiter-test-answer=""
      className="arb:flex arb:flex-col arb:gap-3"
    >
      <RuleTestConclusion
        result={props.answer}
        rule={props.rule}
        stale={props.stale}
      />
      <RuleTestDetails result={props.answer} rule={props.rule} />
    </div>
  );
}

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
 * Which recorded call the inputs came from, and whether they still are it.
 *
 * The two sentences must stay distinct: after an edit the answer is about the
 * sample on screen, and continuing to present the recorded call would credit the
 * result to a call nobody is testing any more.
 */
function RecordedNote(props: {
  readonly source: RecordedSample | null;
  readonly recorded: boolean;
}): ReactNode {
  const t = useArbiterTranslation();
  if (props.source === null) return null;
  return (
    <p
      role="note"
      data-rule-test-source={props.source.callId}
      data-rule-test-source-recorded={props.recorded ? 'yes' : 'no'}
      className="arb:m-0 arb:text-xs arb:text-secondary"
    >
      {props.recorded
        ? t('ruleTest.sourceCall', { call: props.source.callId })
        : t('ruleTest.sourceCallEdited', { call: props.source.callId })}
    </p>
  );
}

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
  readonly onImport: (callId: string, imported: ImportedTestSample) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div className="arb:flex arb:flex-wrap arb:items-end arb:gap-2">
      <div className="arb:w-40">
        <Field label={t('ruleTest.tool')}>
          <TextInput
            ariaLabel={t('ruleTest.tool')}
            value={props.tool}
            onChange={props.onTool}
            monospace
          />
        </Field>
      </div>
      <div className="arb:w-40">
        <Field label={t('ruleTest.agent')}>
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
        </Field>
      </div>
      <div className="arb:w-44">
        <Field label={t('ruleTest.mode')}>
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
        </Field>
      </div>
      <div className="arb:w-52">
        <Field label={t('ruleTest.cwd')}>
          <TextInput
            ariaLabel={t('ruleTest.cwd')}
            value={props.cwd}
            onChange={props.onCwd}
            placeholder={t('ruleTest.cwdPlaceholder')}
            monospace
          />
        </Field>
      </div>
      <div className="arb:mb-0.5">
        <RuleTestImport disabled={props.busy} onImport={props.onImport} />
      </div>
    </div>
  );
}
