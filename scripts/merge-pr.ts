import console from 'node:console';
import process from 'node:process';

import { squashMerge } from './github/squash-merge.ts';

console.log(squashMerge(process.argv.slice(2)));
