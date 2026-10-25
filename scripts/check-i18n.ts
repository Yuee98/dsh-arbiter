import { fileURLToPath } from 'node:url';
import { localeResources } from '../src/client/i18n/resources.ts';
import { inspectLocaleInventory } from './i18n/inventory.ts';
import { inspectLocaleDirectory } from './i18n/load.ts';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--release')) {
  throw new Error('Usage: node scripts/check-i18n.ts [--release]');
}
const requireComplete = flags.includes('--release');
const inspection = await inspectLocaleDirectory(
  fileURLToPath(new URL('../locale/', import.meta.url)),
  { requireComplete },
);
const problems = [
  ...inspection.problems,
  ...inspectLocaleInventory(inspection.resources, localeResources),
];
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(
    `Locale validation passed (${requireComplete ? 'release' : 'development'}).`,
  );
}
