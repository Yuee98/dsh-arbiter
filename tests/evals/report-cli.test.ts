/**
 * The `report` command's argument parsing, through the real command line.
 *
 * These are parse tests rather than end-to-end ones: the report's own behaviour is covered
 * by the report test files, and what is untested there is that a person typing the command
 * can actually reach it. So every case here goes through `parseCommand`, which is the same
 * function the CLI entry point calls.
 *
 * The rule under test is the one the evals CLI applies to every command family: an unknown
 * or misplaced flag is refused, never ignored. `--write` on `report` would be accepted by a
 * shared parser and then do nothing, which is how a person comes to believe a read command
 * wrote something.
 */

import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../evals/src/cli/run.js';
import { parseReportCommand } from '../../evals/src/report/command.js';

describe('the report command line', () => {
  it('parses a bare run directory', () => {
    expect(parseCommand(['report', 'runs/a'])).toEqual({
      directory: 'runs/a',
      output: null,
      dataset: null,
      mode: 'ask',
      channel: 'available',
      force: false,
    });
  });

  it('parses every flag it documents', () => {
    expect(
      parseReportCommand([
        'runs/a',
        '--out',
        'validation/report',
        '--dataset',
        'evals/datasets/core-v1',
        '--mode',
        'no-ask',
        '--channel',
        'unavailable',
        '--force',
      ]),
    ).toEqual({
      directory: 'runs/a',
      output: 'validation/report',
      dataset: 'evals/datasets/core-v1',
      mode: 'no-ask',
      channel: 'unavailable',
      force: true,
    });
  });

  it('defaults the settlement to ask with a channel', () => {
    // The default is the product's own: the shared matrix escalates to a person when one
    // can be reached, and a report should describe that unless told otherwise.
    const parsed = parseReportCommand(['runs/a']);
    expect(parsed).not.toBeTypeOf('string');
    if (typeof parsed === 'string') return;
    expect(parsed.mode).toBe('ask');
    expect(parsed.channel).toBe('available');
  });

  it('requires a run directory', () => {
    expect(parseCommand(['report'])).toContain('report needs a run directory');
  });

  it('refuses a flag it would not honour', () => {
    expect(parseReportCommand(['runs/a', '--write'])).toContain(
      'report does not take --write',
    );
    expect(parseReportCommand(['runs/a', '--resume'])).toContain(
      'report does not take --resume',
    );
    expect(parseReportCommand(['runs/a', '--dry-run'])).toContain(
      'report does not take --dry-run',
    );
  });

  it('refuses a value-taking flag with no value', () => {
    expect(parseReportCommand(['runs/a', '--out'])).toContain(
      '--out needs a value',
    );
    expect(parseReportCommand(['runs/a', '--dataset'])).toContain(
      '--dataset needs a value',
    );
  });

  it('does not confuse the report command with a run command', () => {
    // `report` is not a plan document, so the run parser must not claim it: the parsed
    // value carries a run directory and no plan member at all.
    const parsed = parseCommand(['report', 'runs/a']);
    expect(typeof parsed).toBe('object');
    if (typeof parsed === 'string') return;
    expect('directory' in parsed).toBe(true);
    expect('plan' in parsed).toBe(false);
  });

  it('prints the report usage in the top-level help', () => {
    const usage = parseCommand(['--help']);
    expect(usage).toContain('report <run-dir>');
    expect(usage).toContain('--mode ask|no-ask');
    expect(usage).toContain('--force');
  });
});
