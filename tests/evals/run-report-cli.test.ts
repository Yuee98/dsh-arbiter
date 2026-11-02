import { expect, test } from 'vitest';
import { parseRunCommand } from '../../evals/src/cli/run-commands.js';

test('run explicitly composes existing report options and preserves bare-run shape', () => {
  expect(parseRunCommand('run', ['plan.json'])).not.toHaveProperty('report');
  expect(
    parseRunCommand('run', [
      'plan.json',
      '--report',
      '--out',
      'reports/a',
      '--references',
      'f.json',
      '--force',
    ]),
  ).toMatchObject({
    name: 'run',
    report: { output: 'reports/a', references: ['f.json'], force: true },
  });
});
test('report-only options are never silently used on other run commands or dry-run', () => {
  for (const name of ['plan', 'resume', 'show'] as const)
    expect(parseRunCommand(name, ['target', '--report'])).toContain(
      'does not take',
    );
  expect(parseRunCommand('run', ['p', '--out', 'x'])).toContain(
    'require run --report',
  );
  expect(parseRunCommand('run', ['p', '--report', '--dry-run'])).toContain(
    'does not take',
  );
  expect(
    parseRunCommand('run', ['p', '--report', '--out', '--force']),
  ).toContain('needs a value');
  expect(parseRunCommand('run', ['p', '--report', '--unknown'])).toContain(
    'unknown option',
  );
});
