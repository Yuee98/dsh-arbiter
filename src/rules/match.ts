/**
 * Command-rule compilation, matching, priority and coverage.
 *
 * Rule priority is fixed: deny > force-ask > force-review > allow >
 * review(default). The last item is the fallback path, not a configurable
 * verdict. A complete `allow` never grants a partial parse, and a matching
 * higher-priority rule shadows an allow even when the allow pattern is more
 * specific.
 */

import { compileRules } from './compile.js';
import type { CompiledRule, RuleCompileError, Subject } from './compile.js';
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
  RuleEvaluation,
  RuleMatchDetail,
  RulePath,
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

const SHELL_TOOLS = new Set([
  'bash',
  'terminal',
  'shell',
  'pwsh',
  'powershell',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectArgument(argumentsValue: unknown, selector: string): string[] {
  let current: unknown = argumentsValue;
  for (const part of selector.split('.')) {
    if (!isPlainRecord(current) && !Array.isArray(current)) return [];
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isSafeInteger(index) ? current[index] : undefined;
    } else {
      current = current[part];
    }
  }
  if (typeof current === 'string') return [current];
  if (typeof current === 'number' || typeof current === 'boolean')
    return [String(current)];
  if (Array.isArray(current)) {
    return current.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

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

function selectAll(
  argumentsValue: unknown,
  selectors: readonly string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const selector of selectors) {
    const [value] = selectArgument(argumentsValue, selector);
    if (value !== undefined) selected[selector] = value;
  }
  return selected;
}

function subjectsFor(
  tool: string,
  argumentsValue: unknown,
  parse: ShellParse | null,
  identity: SessionKind,
  selectors: readonly string[],
  _cwd: string,
): Subject[] {
  const subjects: Subject[] = [];
  if (parse !== null) {
    for (const command of parse.commands) {
      subjects.push({
        node: 'command',
        text: command.argv.join(' '),
        tool,
        identity,
        selected: {},
        unresolved: false,
        nodeIndex: subjects.length,
        commandIndex: command.index,
        raw: command.raw,
      });
    }
    for (const redirect of parse.redirects) {
      const absolute = redirect.target.startsWith('/');
      const cwdKnown = redirect.cwd !== null;
      subjects.push({
        node: 'file_redirect',
        text: absolute
          ? redirect.target
          : redirect.target.includes('$') || !cwdKnown
            ? redirect.target
            : resolvePath(redirect.target, redirect.cwd),
        tool,
        identity,
        selected: {},
        unresolved: !absolute && (redirect.target.includes('$') || !cwdKnown),
        nodeIndex: subjects.length,
        commandIndex: redirect.commandIndex,
        raw: redirect.raw,
      });
    }
    for (const assignment of parse.assignments) {
      subjects.push({
        node: 'variable_assignment',
        text: `${assignment.name}=${assignment.value}`,
        tool,
        identity,
        selected: {},
        unresolved: false,
        nodeIndex: subjects.length,
        commandIndex: assignment.commandIndex,
        raw: assignment.raw,
      });
    }
  }

  // One bare tool subject (name matching) plus one subject per selector used by
  // the current rule set. Selector subjects are deduplicated so coverage is not
  // inflated by several rules naming the same argument.
  subjects.push({
    node: 'tool',
    text: '',
    tool,
    identity,
    selected: selectAll(argumentsValue, selectors),
    unresolved: false,
    nodeIndex: subjects.length,
    commandIndex: 0,
    raw: '',
  });
  return subjects;
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

interface MatchEntry {
  detail: RuleMatchDetail;
  layer: number;
  order: number;
  subject: Subject;
}

function collectMatches(
  compiled: readonly CompiledRule[],
  subjects: readonly Subject[],
): MatchEntry[] {
  const matches: MatchEntry[] = [];
  for (const rule of compiled) {
    for (const subject of subjects) {
      if (!rule.matches(subject)) continue;
      matches.push({
        detail: {
          index: rule.index,
          id: rule.rule.id,
          verdict: rule.rule.verdict,
          effective: false,
          node: subject.node,
          nodeIndex: subject.nodeIndex,
          matchedText:
            subject.node === 'tool'
              ? rule.rule.match.selector === undefined
                ? subject.tool
                : (subject.selected[rule.rule.match.selector] ?? subject.tool)
              : subject.text,
          ...(rule.rule.hint === undefined ? {} : { hint: rule.rule.hint }),
        },
        layer: VERDICT_PRIORITY[rule.rule.verdict],
        order: rule.index,
        subject,
      });
      break;
    }
  }

  matches.sort(
    (left, right) => left.layer - right.layer || left.order - right.order,
  );
  return matches;
}

function allowCoverage(
  compiled: readonly CompiledRule[],
  subjects: readonly Subject[],
  parse: ShellParse | null,
): { readonly complete: boolean; readonly covered: boolean } {
  const coverageSubjects =
    parse !== null && subjects.some((subject) => subject.node !== 'tool')
      ? subjects.filter((subject) => subject.node !== 'tool')
      : subjects;
  const allowCoverage = new Map<number, boolean>();
  for (const subject of coverageSubjects)
    allowCoverage.set(subject.nodeIndex, false);
  for (const rule of compiled) {
    if (rule.rule.verdict !== 'allow') continue;
    for (const subject of coverageSubjects) {
      if (!rule.matches(subject)) continue;
      allowCoverage.set(subject.nodeIndex, true);
    }
  }
  const toolSubject = subjects.find((subject) => subject.node === 'tool');
  const wholeToolAllow =
    toolSubject !== undefined &&
    compiled.some(
      (rule) =>
        rule.rule.verdict === 'allow' &&
        rule.rule.match.node === 'tool' &&
        rule.rule.match.selector === undefined &&
        rule.matches(toolSubject),
    );
  const complete = parse === null || parse.completeness === 'complete';
  const covered =
    wholeToolAllow ||
    (coverageSubjects.length > 0 && [...allowCoverage.values()].every(Boolean));
  return { complete, covered };
}

function evaluationRulePath(
  matches: readonly MatchEntry[],
  compiled: readonly CompiledRule[],
  subjects: readonly Subject[],
  parse: ShellParse | null,
): RulePath {
  const winner = matches[0];
  let path: RulePath;
  if (winner !== undefined && winner.detail.verdict !== 'allow') {
    path = {
      kind: 'rule',
      verdict: winner.detail.verdict,
      ruleId: winner.detail.id,
      ...(winner.detail.hint === undefined ? {} : { hint: winner.detail.hint }),
    };
  } else {
    const { complete, covered } = allowCoverage(compiled, subjects, parse);
    if (matches.length > 0 && complete && covered) {
      const allow = matches.find((entry) => entry.detail.verdict === 'allow');
      if (allow !== undefined) {
        path = { kind: 'rule', verdict: 'allow', ruleId: allow.detail.id };
      } else {
        path = { kind: 'review-default', reason: 'partial-allow' };
      }
    } else if (matches.length === 0) {
      path = { kind: 'review-default', reason: 'no-match' };
    } else if (!complete) {
      path = { kind: 'review-default', reason: 'incomplete' };
    } else {
      path = { kind: 'review-default', reason: 'partial-allow' };
    }
  }

  return path;
}

export function evaluateCall(options: EvaluateOptions): RuleEvaluation {
  const commandText = SHELL_TOOLS.has(options.tool)
    ? shellTextOf(options.arguments)
    : null;
  const parse =
    commandText === null ? null : parseShell(commandText, options.cwd);
  const selectors = [
    ...new Set(
      options.rules.flatMap((rule) =>
        rule.match.node === 'tool' && rule.match.selector !== undefined
          ? [rule.match.selector]
          : [],
      ),
    ),
  ];
  const subjects = subjectsFor(
    options.tool,
    options.arguments,
    parse,
    options.identity,
    selectors,
    options.cwd,
  );

  const compiled = compileRules(options.rules);
  const matches = collectMatches(compiled.compiled, subjects);
  const details = matches.map((entry) => entry.detail);
  if (matches[0] !== undefined && details[0] !== undefined) {
    details[0] = { ...details[0], effective: true };
  }

  const path = evaluationRulePath(matches, compiled.compiled, subjects, parse);

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
    parse: parse ?? {
      status: 'ok',
      statements: 1,
      commands: [],
      redirects: [],
      assignments: [],
      subshells: 0,
      substitutions: 0,
      heredocs: 0,
      unresolved: [],
      opaque: false,
      opaqueReasons: [],
      completeness: 'complete',
      background: false,
      nodes: ['tool'],
      argv: [],
      comments: [],
    },
    argv: parse?.argv ?? [],
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
    parse: {
      status: evaluation.parse.status,
      statements: evaluation.parse.statements,
      nodes: nodeTypes(evaluation.parse),
      completeness: evaluation.parse.completeness,
      opaque: evaluation.parse.opaque,
      unresolved: evaluation.parse.unresolved,
    },
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
): readonly RuleCompileError[] {
  return compileRules(rules).errors;
}
