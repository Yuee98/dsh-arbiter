import console from 'node:console';
import process from 'node:process';

import { assertMessageTitle } from './github/message-policy.ts';

const args = process.argv.slice(2);
if (args.length > 1)
  throw new Error('Usage: pnpm check:pr-title "type: summary"');
const title = args[0] ?? process.env['PR_TITLE'];
if (title === undefined)
  throw new Error('Provide a title argument or PR_TITLE.');

assertMessageTitle(title);
console.log(`Valid PR title: ${title}`);
