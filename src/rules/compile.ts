/** Compile validated rule matchers shared by runtime evaluation and the tester. */
import picomatch from 'picomatch';
import { RE2JS } from 're2js';
import type { CommandRule, RuleNode, SessionKind } from '../types.js';

export interface RuleCompileError {
  readonly id: string;
  readonly path: string;
  readonly message: string;
  readonly code?: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface CompiledRule {
  readonly rule: CommandRule;
  readonly index: number;
  readonly matches: (subject: Subject) => boolean;
}

export interface Subject {
  readonly node: RuleNode;
  readonly text: string;
  readonly tool: string;
  readonly identity: SessionKind;
  readonly selected: Readonly<Record<string, string>>;
  readonly unresolved: boolean;
  readonly nodeIndex: number;
  readonly commandIndex: number;
  readonly raw: string;
}

function anchorError(pattern: string): string | null {
  if (pattern.startsWith('^') || pattern.startsWith('(?:^')) return null;
  return 'regex patterns must be anchored with "^" or "(?:^"';
}

function hasParentSegment(pattern: string): boolean {
  return pattern.split(/[\\/]/u).some((segment) => segment === '..');
}

function compileRegex(pattern: string): RE2JS {
  return RE2JS.compile(pattern);
}

function compileGlob(pattern: string): (value: string) => boolean {
  const matcher = picomatch(pattern, { dot: true, nocase: false });
  return (value: string) => matcher(value);
}

function validateAgentIdentities(agents: readonly string[] | undefined): void {
  if (agents !== undefined) {
    if (agents.length === 0)
      throw new Error('agents must not be empty when present');
    for (const agent of agents) {
      if (
        agent !== 'main' &&
        agent !== 'subagent' &&
        !agent.startsWith('preset:')
      ) {
        throw new Error(`unknown agent identity "${agent}"`);
      }
    }
  }
}

function validateRuleShape(rule: CommandRule): void {
  const { match } = rule;
  if (rule.id.length === 0) throw new Error('rule id must not be empty');
  if (match.pattern.length === 0) throw new Error('pattern must not be empty');
  if (
    match.node === 'tool' &&
    (match.tool === undefined || match.tool.length === 0)
  ) {
    throw new Error('node "tool" requires an explicit tool name');
  }
  if (match.node !== 'tool' && match.tool !== undefined) {
    throw new Error('tool is only valid for node "tool"');
  }
  if (match.selector !== undefined && match.node !== 'tool') {
    throw new Error('selector is only valid for node "tool"');
  }
  if (match.node === 'file_redirect' && match.kind === 'regex') {
    throw new Error('path targets use glob or exact matching, not regex');
  }
  if (match.node === 'command' && match.kind === 'glob') {
    throw new Error('command nodes use exact or regex matching, not glob');
  }
  validateAgentIdentities(match.agents);
}

function compilePattern(
  match: CommandRule['match'],
): (value: string) => boolean {
  let test: (value: string) => boolean;
  if (match.kind === 'regex') {
    const anchor = anchorError(match.pattern);
    if (anchor !== null) throw new Error(anchor);
    const regex = compileRegex(match.pattern);
    test = (value: string) => regex.test(value);
  } else if (match.kind === 'glob') {
    if (hasParentSegment(match.pattern))
      throw new Error('glob patterns must not contain ".." segments');
    test = compileGlob(match.pattern);
  } else {
    const expected = match.pattern;
    test = (value: string) => value === expected;
  }

  return test;
}

/**
 * Validate one rule and return a compiled matcher.
 *
 * Compilation is the only place that accepts a regex or glob; both the
 * configuration page and the runtime gate call it, so a rule that loads is a
 * rule the tester can match.
 */
export function compileRule(rule: CommandRule, index: number): CompiledRule {
  const { match } = rule;
  validateRuleShape(rule);
  const test = compilePattern(match);

  const toolMatcher =
    match.tool === undefined
      ? null
      : match.tool.includes('*')
        ? compileGlob(match.tool)
        : (value: string) => value === match.tool;

  return {
    rule,
    index,
    matches: (subject: Subject): boolean => {
      if (subject.unresolved || rule.enabled === false) return false;
      if (subject.node !== match.node) return false;
      if (
        match.agents !== undefined &&
        !match.agents.includes(subject.identity)
      ) {
        // Unknown identities are represented only by main/subagent here; a
        // `preset:<name>` rule cannot match until the host reports a preset.
        return false;
      }
      if (match.node !== 'tool') return test(subject.text);
      if (toolMatcher === null || !toolMatcher(subject.tool)) return false;
      if (match.selector === undefined) return test(subject.tool);
      const selected = subject.selected[match.selector];
      return selected !== undefined && test(selected);
    },
  };
}

export function compileRules(rules: readonly CommandRule[]): {
  readonly compiled: readonly CompiledRule[];
  readonly errors: readonly RuleCompileError[];
} {
  const compiled: CompiledRule[] = [];
  const errors: RuleCompileError[] = [];
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    if (ids.has(rule.id)) {
      errors.push({
        id: rule.id,
        path: `rules[${String(index)}].id`,
        message: 'duplicate rule id',
        code: 'rule.duplicateId',
        params: { id: rule.id },
      });
      return;
    }
    ids.add(rule.id);
    try {
      compiled.push(compileRule(rule, index));
    } catch (error) {
      errors.push({
        id: rule.id,
        path: `rules[${String(index)}]`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { compiled, errors };
}
