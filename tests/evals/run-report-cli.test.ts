import { expect, test } from 'vitest';
import { parseReportCommand } from '../../evals/src/report/command.js';
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

test.each(['--mode', '--channel'])(
  'rejects an invalid %s before building an executable run command',
  (flag) => {
    expect(
      parseRunCommand('run', ['plan.json', '--report', flag, 'typo']),
    ).toContain(`${flag} takes`);
    expect(
      parseRunCommand('run', [
        'plan.json',
        '--resume',
        '--report',
        flag,
        'typo',
      ]),
    ).toContain(`${flag} takes`);
  },
);

test.each([
  { mode: 'ask', channel: 'available' },
  { mode: 'ask', channel: 'unavailable' },
  { mode: 'no-ask', channel: 'available' },
  { mode: 'no-ask', channel: 'unavailable' },
])(
  'keeps valid report selection $mode/$channel before dispatch',
  ({ mode, channel }) => {
    const flags = ['--mode', mode, '--channel', channel];
    expect(
      parseRunCommand('run', ['plan.json', '--report', ...flags]),
    ).toHaveProperty('report', expect.objectContaining({ mode, channel }));
    expect(parseReportCommand(['run-dir', ...flags])).toMatchObject({
      mode,
      channel,
    });
  },
);
