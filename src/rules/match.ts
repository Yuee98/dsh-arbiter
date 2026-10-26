/**
 * Rule evaluation: subjects, matching, priority and coverage.
 *
 * Rule priority is fixed: deny > force-ask > force-review > allow >
 * review(default). The last item is the fallback path, not a configurable
 * verdict. A complete `allow` never grants a partial parse, and a matching
 * higher-priority rule shadows an allow even when the allow pattern is more
 * specific.
 *
 * Conditions are ORed inside a rule. A condition may also be `unknown` when the
 * structure it needs could not be determined; an unknown is never a verdict. A
 * certain higher-priority match still decides, but an unknown higher-priority
 * rule keeps an `allow` from short-circuiting, so the call goes to review
 * default instead of being allowed on an incomplete judgement.
 */

import { compileRules } from './compile.js';
import type {
  CallSubjects,
  CompiledRule,
  RuleCompileError,
  Subject,
} from './compile.js';
export type { RuleCompileError } from './compile.js';

import {
  buildFacts,
  nodeTypes,
  parseShell,
  resolvePath,
  type ShellParse,
} from '../shell/parse.js';
import type {
  CommandRule,
  NormalizationDetail,
  RuleConditionResult,
  RuleEvaluation,
  RuleMatchDetail,
  RulePath,
  RuleResult,
  RuleTestResult,
  RuleVerdict,
  SessionKind,
} from '../types.js';

const VERDICT_PRIORITY: Record<RuleVerdict, number> = {
  deny: 0,
  'force-ask': 1,
  'force-review': 2,
  allow: 3,
};

/**
 * Tools whose command text is a POSIX-style shell command line.
 *
 * The parser is a bash parser, so only these may receive a complete structure.
 * `pwsh`/`powershell` carry a different language: bash quoting and expansion do
 * not describe what PowerShell will run (`'a''b'` is `a'b` in PowerShell and `ab`
 * in bash). Their calls still go through the same rule engine and can be matched
 * on the tool name or raw arguments, but their structure is never claimed.
 */
const SHELL_TOOLS = new Set(['bash', 'terminal', 'shell']);

/**
 * Shell-family tools whose dialect the parser is not verified for.
 *
 * They are shell calls — they run a command line — so an argument condition does
 * not cover them — but no command/redirect/assignment node is published from
 * unverified syntax.
 */
const OTHER_SHELL_TOOLS = new Set(['pwsh', 'powershell']);

/**
 * Every tool that executes a command line.
 *
 * The distinction between the two sets decides whether a parse may be used, not
 * whether the tool is a shell tool: treating a PowerShell call as a non-shell
 * tool would let an argument condition authorize it on arguments alone.
 */
function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool) || OTHER_SHELL_TOOLS.has(tool);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Text a shell call carries as its command line.
 *
 * This reader only finds the conventional command fields. It never normalizes
 * anything: normalization is the shell adapter's single job, so a rule that
 * matches here and a rule that matches at runtime cannot disagree about which
 * text they compared.
 */
function shellTextOf(argumentsValue: unknown): string | null {
  if (!isPlainRecord(argumentsValue)) return null;
  for (const key of ['command', 'cmd', 'script'] as const) {
    const value = argumentsValue[key];
    if (typeof value === 'string') return value;
  }
  const command = argumentsValue['command'];
  if (Array.isArray(command)) {
    const parts = command.filter(
      (part): part is string => typeof part === 'string',
    );
    if (parts.length > 0) return parts.join(' ');
  }
  return null;
}

interface SubjectInputs {
  readonly tool: string;
  readonly argumentsValue: unknown;
  readonly parse: ShellParse | null;
}

/**
 * Structural subjects the matcher may compare against.
 *
 * Command text comes from the adapter's canonical form, so `echo "a b"` and
 * `echo a b` are different subjects with different text while both keep their
 * argument boundaries. A command containing a dynamic word is still matchable on
 * its raw expression: the caller wrote it, and the rule may describe exactly what
 * was written. A redirect whose target is dynamic or whose directory is unknown
 * is a subject only `unknown` can satisfy, because no path can be confirmed.
 */
function structuralSubjects(inputs: SubjectInputs): Subject[] {
  const { parse } = inputs;
  const subjects: Subject[] = [];
  if (parse === null) return subjects;
  for (const command of parse.commands) {
    subjects.push({
      target: 'command',
      text: command.text,
      nodeIndex: subjects.length,
      unresolved: false,
    });
  }
  for (const redirect of parse.redirects) {
    // A dynamic target is never a confirmed path, even when it looks absolute:
    // `/workspace/$REL` can expand to `../../etc/passwd`. Only a static target can
    // be resolved, and only a relative one depends on the directory being known.
    const absolute = !redirect.dynamic && redirect.target.startsWith('/');
    // The adapter has already decided whether the target is confirmed; a repeated
    // body or an unknown directory both make a relative path unconfirmed.
    const unresolved = redirect.unresolved;
    subjects.push({
      target: 'file_redirect',
      text:
        absolute || !unresolved
          ? resolvePath(redirect.target, redirect.cwd ?? '/')
          : redirect.target,
      nodeIndex: subjects.length,
      unresolved,
    });
  }
  for (const assignment of parse.assignments) {
    // The assignment's text is what the user wrote, so a rule can match it even
    // when the value is dynamic. Only a value the adapter could not even attribute
    // to the word would be unresolved here; expansions are covered by the command
    // subjects they run.
    subjects.push({
      target: 'variable_assignment',
      text: `${assignment.name}=${assignment.value}`,
      nodeIndex: subjects.length,
      unresolved: false,
    });
  }
  return subjects;
}

function callSubjects(
  tool: string,
  argumentsValue: unknown,
  parse: ShellParse | null,
  identity: SessionKind,
): CallSubjects {
  // The tool category is a fact about the tool name, not about whether a command
  // could be extracted. A shell tool whose arguments carry no usable command text
  // still carries shell structure in principle; treating it as a non-shell tool
  // would let an argument condition cover a call whose structure is unknown.
  const isShellCall = isShellTool(tool);
  const complete =
    isShellCall &&
    SHELL_TOOLS.has(tool) &&
    parse !== null &&
    parse.status === 'ok' &&
    parse.completeness === 'complete';
  return {
    tool,
    identity,
    argumentsValue,
    subjects: structuralSubjects({ tool, argumentsValue, parse }),
    shellCall: isShellCall,
    // A shell call with no readable command text has no trustworthy structure at
    // all. A partially read command stays matchable on what was extracted, but
    // the missing structure is still reported separately so coverage cannot be
    // claimed from it.
    structureUnknown:
      isShellCall &&
      (!SHELL_TOOLS.has(tool) || parse === null || parse.status === 'error'),
    structureComplete: !isShellCall || complete,
  };
}

interface MatchEntry {
  detail: RuleMatchDetail;
  layer: number;
  order: number;
  subject: Subject | null;
}

/** The concrete subject a matched condition refers to, when it has one. */
function matchSubject(
  call: CallSubjects,
  condition: RuleConditionResult,
): Subject | null {
  if (condition.target === 'argument' || condition.target === 'tool')
    return null;
  return (
    call.subjects.find(
      (candidate) =>
        candidate.target === condition.target &&
        !candidate.unresolved &&
        candidate.text === condition.matchedValue,
    ) ?? null
  );
}

function ruleResults(
  compiled: readonly CompiledRule[],
  call: CallSubjects,
): {
  readonly results: readonly RuleResult[];
  readonly matched: readonly MatchEntry[];
} {
  const results: RuleResult[] = [];
  const matched: MatchEntry[] = [];
  for (const rule of compiled) {
    const evaluation = rule.evaluate(call);
    results.push({
      index: rule.index,
      id: rule.rule.id,
      verdict: rule.rule.verdict,
      outcome: evaluation.outcome,
      ...(rule.rule.name === undefined ? {} : { name: rule.rule.name }),
      conditions: evaluation.conditions,
    });
    if (evaluation.outcome !== 'match') continue;
    const condition = evaluation.conditions.find(
      (result) => result.outcome === 'match',
    );
    if (condition === undefined) continue;
    const subject = matchSubject(call, condition);
    matched.push({
      detail: {
        index: rule.index,
        id: rule.rule.id,
        verdict: rule.rule.verdict,
        effective: false,
        target: condition.target,
        conditionIndex: condition.index,
        nodeIndex: subject?.nodeIndex ?? 0,
        matchedText: subject?.text ?? condition.matchedValue ?? '',
        ...(rule.rule.name === undefined ? {} : { name: rule.rule.name }),
        ...(rule.rule.hint === undefined ? {} : { hint: rule.rule.hint }),
      },
      layer: VERDICT_PRIORITY[rule.rule.verdict],
      order: rule.index,
      subject,
    });
  }
  matched.sort(
    (left, right) => left.layer - right.layer || left.order - right.order,
  );
  return { results, matched };
}

export interface EvaluateOptions {
  readonly rules: readonly CommandRule[];
  readonly tool: string;
  readonly arguments: unknown;
  readonly identity: SessionKind;
  readonly workspaceRoot: string | null;
  readonly cwd: string;
  readonly parentAuthorizationPresent: boolean | null;
  readonly historyTruncated: boolean;
  readonly overlapsDeniedEffect: boolean;
  readonly environment?: Readonly<Record<string, string>>;
}

/**
 * Whether a complete `allow` covers the whole call.
 *
 * Three cases are enough for the first version:
 *
 *   - a matched `tool`-target condition covers the whole tool call;
 *   - for a call with no shell structure at all (a non-shell tool), a matched
 *     `argument` condition covers the call, because the arguments are the whole
 *     input the rule judged;
 *   - otherwise a structural allow covers the call only when every structural
 *     subject is covered and the parse is complete.
 *
 * `scope` contributes nothing: it decides which calls a rule applies to, never
 * that those calls are allowed. An `argument` condition on a shell call covers no
 * AST node, so it narrows rather than widens. #8 owns the refined evaluator.
 */
function allowCoverage(
  call: CallSubjects,
  results: readonly RuleResult[],
): { readonly wholeTool: boolean; readonly covered: boolean } {
  const structural = call.subjects;
  const allows = results.filter(
    (result) => result.verdict === 'allow' && result.outcome === 'match',
  );
  // The rule matched because some alternative matched. A tool target only
  // covers the whole call when that alternative is the one that matched;
  // otherwise a matching command alternative would silently extend its coverage
  // to an unrelated tool alternative.
  const wholeTool = allows.some((result) =>
    result.conditions.some(
      (condition) =>
        condition.target === 'tool' && condition.outcome === 'match',
    ),
  );
  // A non-shell call has no AST to cover; its arguments are the entire judged
  // input, so a matching argument condition covers it. The tool category decides
  // this, never an empty subject list: a shell call whose structure could not be
  // determined also has no subjects, and its arguments are not the whole input.
  const argumentOnly =
    !call.shellCall &&
    allows.some((result) =>
      result.conditions.some(
        (condition) =>
          condition.target === 'argument' && condition.outcome === 'match',
      ),
    );
  // Compare against every text the condition actually matched: one condition can
  // match several distinct subjects (a case-insensitive exact value, or a regex
  // over several commands), and keeping only the first would mark the rest as
  // uncovered.
  const covers = (subject: Subject): boolean =>
    allows.some((result) =>
      result.conditions.some(
        (condition) =>
          condition.outcome === 'match' &&
          condition.target === subject.target &&
          (condition.matchedValues ?? []).includes(subject.text),
      ),
    );
  // An argument condition covers no structural node, and a partial parse hides
  // nodes the matcher never saw, so neither can complete a structural cover.
  const covered =
    argumentOnly ||
    (structural.length > 0 &&
      call.structureComplete &&
      structural.every((subject) => covers(subject)));
  return { wholeTool, covered };
}

function evaluationRulePath(
  call: CallSubjects,
  results: readonly RuleResult[],
  matched: readonly MatchEntry[],
): RulePath {
  const winner = matched[0];
  if (winner !== undefined && winner.detail.verdict !== 'allow') {
    return {
      kind: 'rule',
      verdict: winner.detail.verdict,
      ruleId: winner.detail.id,
      ...(winner.detail.hint === undefined ? {} : { hint: winner.detail.hint }),
    };
  }
  // An allow only decides when nothing more authoritative is undecided. A rule
  // with higher priority that could not be judged might have denied this call, so
  // letting the allow through would turn an unknown into an authorization.
  const allow = matched.find((entry) => entry.detail.verdict === 'allow');
  if (allow !== undefined) {
    const priority = VERDICT_PRIORITY.allow;
    const blocking = results.some(
      (result) =>
        result.outcome === 'unknown' &&
        VERDICT_PRIORITY[result.verdict] < priority,
    );
    if (blocking) return { kind: 'review-default', reason: 'unresolved' };
    const { wholeTool, covered } = allowCoverage(call, results);
    if (wholeTool || covered)
      return { kind: 'rule', verdict: 'allow', ruleId: allow.detail.id };
    // Every node that was read is allowed, but the parse hid others, so the
    // reason is incompleteness rather than a partial cover.
    if (!call.structureComplete)
      return { kind: 'review-default', reason: 'incomplete' };
    return { kind: 'review-default', reason: 'partial-allow' };
  }
  // Nothing was certain. An unknown rule might have decided this call, so the
  // honest reason is not "no rule matched".
  if (results.some((result) => result.outcome === 'unknown'))
    return { kind: 'review-default', reason: 'unresolved' };
  if (matched.length === 0) {
    return call.structureUnknown
      ? { kind: 'review-default', reason: 'incomplete' }
      : { kind: 'review-default', reason: 'no-match' };
  }
  return { kind: 'review-default', reason: 'partial-allow' };
}

export function evaluateCall(options: EvaluateOptions): RuleEvaluation {
  // Only a verified shell dialect is parsed. A PowerShell command line is not a
  // bash command line, so no structure is derived from it and its conditions stay
  // unknown rather than being compared against a second language's syntax.
  const commandText =
    isShellTool(options.tool) && SHELL_TOOLS.has(options.tool)
      ? shellTextOf(options.arguments)
      : null;
  const parse =
    commandText === null ? null : parseShell(commandText, options.cwd);
  const call = callSubjects(
    options.tool,
    options.arguments,
    parse,
    options.identity,
  );
  const compiled = compileRules(options.rules);
  const { results, matched } = ruleResults(compiled.compiled, call);
  const details = matched.map((entry) => entry.detail);
  if (details[0] !== undefined) details[0] = { ...details[0], effective: true };

  const path = evaluationRulePath(call, results, matched);

  const factsResult =
    parse === null
      ? null
      : buildFacts(parse, {
          cwd: options.cwd,
          workspaceRoot: options.workspaceRoot,
          parentAuthorizationPresent: options.parentAuthorizationPresent,
          historyTruncated: options.historyTruncated,
          overlapsDeniedEffect: options.overlapsDeniedEffect,
        });

  return {
    path,
    matches: details,
    rules: results,
    // A call with no shell text has no shell parse at all; reporting an empty
    // "complete" parse would claim a structure nobody read.
    parse: parse ?? {
      status: 'ok',
      statements: 1,
      commands: [],
      redirects: [],
      assignments: [],
      words: [],
      subshells: 0,
      substitutions: 0,
      heredocs: 0,
      unresolved: [],
      opaque: false,
      opaqueReasons: [],
      completeness: 'complete',
      structure: { issues: [], errors: [], nodes: 0 },
      background: false,
      nodes: ['tool'],
      argv: [],
    },
    argv: parse?.argv ?? [],
    normalization: normalizationOf(commandText, parse),
    facts: factsResult?.facts ?? null,
    shadowed: details
      .filter((detail) => !detail.effective)
      .map((detail) => `${detail.id}(${detail.verdict})`),
  };
}

export function evaluationPath(
  evaluation: RuleEvaluation,
): RuleTestResult['path'] {
  return evaluation.path.kind === 'rule'
    ? evaluation.path.verdict
    : 'review(default)';
}

/**
 * Diagnostic evidence about how the command text was read and normalized.
 *
 * The contract requires the tester and call explanations to show the original
 * command, the text that was actually matched, and why a word was not normalized.
 * This is derived from the same parse the evaluator used, so it cannot describe a
 * different normalization than the one that decided the verdict.
 */
function normalizationOf(
  commandText: string | null,
  parse: ShellParse | null,
): NormalizationDetail | null {
  if (commandText === null || parse === null) return null;
  return {
    raw: commandText,
    completeness: parse.completeness,
    issues: parse.structure.issues.map((issue) => ({
      kind: issue.kind,
      message: issue.message,
      pos: issue.pos,
    })),
    commands: parse.commands.map((command) => ({
      text: command.text,
      raw: command.raw,
      words: command.words.map((word) => ({
        raw: word.raw,
        text: word.text,
        status: word.status,
        reasons: [...word.reasons],
        ...(word.value === undefined ? {} : { value: word.value }),
      })),
    })),
  };
}

/** Parse one rule-tester input line: a bare command, `tool: command`, or JSON. */
export function parseTestInput(input: string): {
  readonly tool: string;
  readonly arguments: unknown;
  readonly display: string;
} {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isPlainRecord(value) && typeof value['tool'] === 'string') {
        return {
          tool: value['tool'],
          arguments: value['args'] ?? value['arguments'] ?? {},
          display: trimmed,
        };
      }
    } catch {
      // Fall through to shell parsing; the caller still reports the input.
    }
  }
  const separator = trimmed.indexOf(':');
  if (separator > 0) {
    const candidate = trimmed.slice(0, separator).trim();
    if (/^[A-Za-z0-9_.-]+$/u.test(candidate)) {
      const rest = trimmed.slice(separator + 1).trimStart();
      const tool = candidate;
      if (tool === 'bash' || tool === 'terminal' || tool === 'pwsh') {
        return { tool, arguments: { command: rest }, display: trimmed };
      }
      return { tool, arguments: { path: rest }, display: trimmed };
    }
  }
  return { tool: 'bash', arguments: { command: trimmed }, display: trimmed };
}

export function testRules(
  input: string,
  rules: readonly CommandRule[],
  options: {
    readonly identity: SessionKind;
    readonly workspaceRoot: string | null;
    readonly cwd: string;
  },
): RuleTestResult {
  const parsed = parseTestInput(input);
  const evaluation = evaluateCall({
    rules,
    tool: parsed.tool,
    arguments: parsed.arguments,
    identity: options.identity,
    workspaceRoot: options.workspaceRoot,
    cwd: options.cwd,
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });
  const rule =
    evaluation.matches.find((match: RuleMatchDetail) => match.effective) ??
    null;
  return {
    input,
    tool: parsed.tool,
    path: evaluationPath(evaluation),
    rule,
    matches: evaluation.matches,
    rules: evaluation.rules,
    parse: {
      status: evaluation.parse.status,
      statements: evaluation.parse.statements,
      nodes: nodeTypes(evaluation.parse),
      completeness: evaluation.parse.completeness,
      opaque: evaluation.parse.opaque,
      unresolved: evaluation.parse.unresolved,
    },
    normalization: evaluation.normalization,
    argv: parsed.tool === 'bash' ? evaluation.argv : [],
    shadowed: evaluation.shadowed,
    ...(evaluation.parse.error === undefined
      ? {}
      : { error: evaluation.parse.error }),
  };
}

/** Validate only the pattern-bearing fields, used while editing a draft. */
export function validateRules(
  rules: readonly CommandRule[],
  sourceIndices?: readonly number[],
): readonly RuleCompileError[] {
  return compileRules(rules, sourceIndices).errors;
}
