/**
 * Operator entry for the legacy session-log repair.
 *
 *   node scripts/repair-session.ts --inspect <session.v*.jsonl.zstd>
 *   node scripts/repair-session.ts --dry-run <session.v*.jsonl.zstd>
 *   node scripts/repair-session.ts <session.v*.jsonl.zstd> [--force]
 *
 * Default mode inspects and asks for nothing; writing requires either
 * `--force` (unattended) or an interactive confirmation.
 *
 * Node 24 runs the repair source directly; no prior build is required.
 */
import { createInterface } from 'node:readline/promises';
import { inspectSessionLog, repairSessionLog } from '../src/repair.ts';

const args = process.argv.slice(2);
const inspectOnly = args.includes('--inspect');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const path = args.find((arg) => !arg.startsWith('--'));

if (path === undefined) {
  process.stderr.write(
    'usage: repair-session.ts [--inspect|--dry-run|--force] <session.v*.jsonl.zstd>\n',
  );
  process.exit(2);
}

if (inspectOnly) {
  process.stdout.write(JSON.stringify(inspectSessionLog(path), null, 2) + '\n');
  process.exit(0);
}

const preview = inspectSessionLog(path);
if (preview.repairable.length === 0) {
  process.stdout.write(
    JSON.stringify(
      {
        changed: false,
        reason: 'no arbiter records are missing the ignorable marker',
        ...preview,
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

if (dryRun) {
  process.stdout.write(
    JSON.stringify(repairSessionLog(path, { dryRun: true }), null, 2) + '\n',
  );
  process.exit(0);
}

if (!force) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await readline.question(
    `Repair ${String(preview.repairable.length)} arbiter record(s) in\n  ${path}\nA backup will be written next to it. Type "repair" to continue: `,
  );
  readline.close();
  if (answer.trim() !== 'repair') {
    process.stderr.write('aborted; nothing was written\n');
    process.exit(1);
  }
}

process.stdout.write(JSON.stringify(repairSessionLog(path), null, 2) + '\n');
