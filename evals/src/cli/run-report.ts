/** Only explicit run invocations can request an offline report afterwards. */
import { parseReportCommand } from '../report/command.js';
import type { ReportCommand } from '../report/command.js';

export type PostRunReport = Omit<ReportCommand, 'directory'>;

export function runReportFlags(
  name: string,
  args: readonly string[],
):
  | { readonly rest: readonly string[]; readonly report?: PostRunReport }
  | string {
  const rest: string[] = [];
  const reportArgs: string[] = [];
  let requested = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dir') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        return '--dir needs a value';
      rest.push(flag, value);
      index += 1;
    } else if (flag === '--report') {
      if (name !== 'run') return `${name} does not take --report`;
      requested = true;
    } else if (
      [
        '--out',
        '--references',
        '--dataset',
        '--mode',
        '--channel',
        '--force',
      ].includes(flag ?? '')
    ) {
      if (name !== 'run') return `${name} does not take ${String(flag)}`;
      if (flag === undefined) return 'missing report option';
      reportArgs.push(flag);
      if (flag !== '--force') {
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--'))
          return `${flag} needs a value`;
        reportArgs.push(value);
        index += 1;
      }
    } else if (flag !== undefined) rest.push(flag);
  }
  if (!requested)
    return reportArgs.length === 0
      ? { rest }
      : `unknown option ${reportArgs[0] ?? ''}; report options require run --report`;
  if (rest.includes('--dry-run')) return 'run --dry-run does not take --report';
  const parsed = parseReportCommand(['pending', ...reportArgs]);
  if (typeof parsed === 'string') return parsed;
  return {
    rest,
    report: {
      output: parsed.output,
      dataset: parsed.dataset,
      mode: parsed.mode,
      channel: parsed.channel,
      force: parsed.force,
      ...(parsed.references === undefined
        ? {}
        : { references: parsed.references }),
    },
  };
}
