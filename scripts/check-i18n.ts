import chinese from '../locale/zh.json' with { type: 'json' };
import english from '../locale/en.json' with { type: 'json' };
import { inspectCatalog } from '../src/client/i18n/catalog.ts';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--release')) {
  throw new Error('Usage: node scripts/check-i18n.ts [--release]');
}
const requireComplete = flags.includes('--release');
const problems = inspectCatalog(chinese, english, { requireComplete });
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(
    `Locale validation passed (${requireComplete ? 'release' : 'development'}).`,
  );
}
