/**
 * The experiment commands' command line.
 *
 * These cases pin the two refusals that make the family safe to expose: `plan` cannot
 * be given a flag that writes, and `record` cannot be run without a place to write. Both
 * are parser rules rather than documentation, because a flag that is accepted and
 * ignored is how someone believes a dry run recorded something.
 */

import { describe, expect, test } from 'vitest';

import {
  EXPERIMENT_USAGE,
  isExperimentCommand,
  parseExperimentCommand,
} from '../../evals/src/experiments/args.js';
import { RECORD_FILE } from '../../evals/src/experiments/commands.js';
import { parseCommand } from '../../evals/src/cli/run.js';

describe('the experiment commands', () => {
  test('names three subcommands and no other', () => {
    expect(isExperimentCommand('check-all')).toBe(true);
    expect(isExperimentCommand('plan')).toBe(true);
    expect(isExperimentCommand('record')).toBe(true);
    expect(isExperimentCommand('run')).toBe(false);
    expect(isExperimentCommand('')).toBe(false);
  });

  test('check-all takes no argument', () => {
    expect(parseExperimentCommand('check-all', [])).toEqual({
      name: 'check-all',
      definition: null,
      out: null,
    });
    expect(parseExperimentCommand('check-all', ['extra'])).toContain(
      'takes no argument',
    );
  });

  test('plan needs a definition and writes nowhere', () => {
    expect(parseExperimentCommand('plan', ['matrix.json'])).toEqual({
      name: 'plan',
      definition: 'matrix.json',
      out: null,
    });
    expect(parseExperimentCommand('plan', [])).toContain('needs a definition');
    // A flag the command would not honour is refused rather than ignored.
    expect(
      parseExperimentCommand('plan', ['matrix.json', '--out', 'record.json']),
    ).toContain('does not take --out');
  });

  test('record defaults its output and honours an explicit one', () => {
    expect(parseExperimentCommand('record', ['matrix.json'])).toEqual({
      name: 'record',
      definition: 'matrix.json',
      out: RECORD_FILE,
    });
    expect(
      parseExperimentCommand('record', [
        'matrix.json',
        '--out',
        'validation/record.json',
      ]),
    ).toEqual({
      name: 'record',
      definition: 'matrix.json',
      out: 'validation/record.json',
    });
    expect(
      parseExperimentCommand('record', ['matrix.json', '--out']),
    ).toContain('--out needs a value');
    expect(
      parseExperimentCommand('record', ['matrix.json', '--write']),
    ).toContain('unknown option --write');
  });

  test('is reachable from the top-level parser without shadowing the others', () => {
    const parsed = parseCommand([
      'experiments',
      'plan',
      'evals/experiments/rq14-matrix.json',
    ]);
    // One dispatch key distinguishes the family, the same way a run command is found.
    expect(parsed).toMatchObject({
      name: 'plan',
      definition: 'evals/experiments/rq14-matrix.json',
    });
    // The dataset and run families are untouched.
    expect(typeof parseCommand(['check', 'evals/datasets/core-v1'])).not.toBe(
      'string',
    );
    expect(typeof parseCommand(['plan', 'plan.json'])).not.toBe('string');
  });

  test('refuses a subcommand the family does not have', () => {
    const parsed = parseCommand(['experiments', 'dispatch']);
    expect(parsed).toContain('unknown experiment command');
    expect(parsed).toContain(EXPERIMENT_USAGE.split('\n')[0]);
  });

  test('refuses the family with no subcommand', () => {
    expect(parseCommand(['experiments'])).toContain(
      'unknown experiment command',
    );
  });
});
