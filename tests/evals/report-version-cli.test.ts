import { describe, expect, it } from 'vitest';
import { parseReportCommand } from '../../evals/src/report/command.js';
import { parseRunCommand } from '../../evals/src/cli/run-commands.js';

describe('comparison CLI arguments', () => {
  it('accepts a baseline run and explicit original-side inputs', () => {
    expect(
      parseReportCommand([
        'current',
        '--compare',
        'baseline',
        '--baseline-dataset',
        'old-data',
        '--baseline-references',
        'old-a.json',
        '--baseline-references',
        'old-b.json',
        '--references',
        'common.json',
      ]),
    ).toMatchObject({
      compare: 'baseline',
      baselineDataset: 'old-data',
      baselineReferences: ['old-a.json', 'old-b.json'],
      references: ['common.json'],
    });
  });
  it.each(['--compare', '--baseline-references', '--baseline-dataset'])(
    'requires an actual %s value',
    (flag) => {
      expect(parseReportCommand(['current', flag])).toContain('needs a value');
      expect(parseReportCommand(['current', flag, '--force'])).toContain(
        'needs a value',
      );
    },
  );
  it('rejects baseline overrides without a baseline and repeated singleton selectors', () => {
    expect(
      parseReportCommand(['current', '--baseline-dataset', 'data']),
    ).toContain('require --compare');
    expect(
      parseReportCommand(['current', '--baseline-references', 'a.json']),
    ).toContain('require --compare');
    expect(
      parseReportCommand(['current', '--compare', 'a', '--compare', 'b']),
    ).toContain('once');
  });
  it('keeps comparison outside the existing run --report whitelist', () => {
    expect(
      parseRunCommand('run', ['plan', '--report', '--compare', 'baseline']),
    ).toContain('unknown option');
    expect(
      parseRunCommand('run', ['plan', '--report', '--baseline-dataset', 'old']),
    ).toContain('unknown option');
  });
});
