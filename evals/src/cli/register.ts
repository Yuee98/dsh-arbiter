/**
 * The loader hook the evals CLI runs under.
 *
 * This file is the only place in the repository that names a TypeScript file with
 * its extension in an import. Node resolves specifiers literally and has no
 * `.js` → `.ts` mapping, so the hook has to be installed before any evals module
 * that imports the shared contract is resolved — including this one, which is why
 * the import below is the exception rather than the rule.
 *
 * Nothing else loads this module: production never imports evals, and the tests
 * exercise the resolution rule directly instead of installing a process hook.
 */

import { installTypeScriptSiblings } from '../data/ts-modules.ts';

installTypeScriptSiblings();
