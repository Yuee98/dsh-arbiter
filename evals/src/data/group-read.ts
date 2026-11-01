/** Read and validate selected grouped sources; file parsing is shared with legacy readers. */
import { readFile } from 'node:fs/promises';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { readGroupFiles } from './group-files.js';
import { legacyMetadata } from './legacy-metadata.js';
import { checkGroups } from './group-check.js';
import { compileCheckers } from './schemas.js';
import type { CurrentVersions } from './inspect.js';
import type { GroupedDataset, GroupSelection } from './group-types.js';
export { hasGroupedLayout } from './group-files.js';
export async function readGroupedDataset(
  dataset: string,
  selection: GroupSelection = {},
  current?: CurrentVersions,
): Promise<GroupedDataset> {
  const raw = await readGroupFiles(dataset, selection);
  const checkers = await compileCheckers();
  let versions = current;
  if (versions === undefined) {
    const rubric = checkers.rubric(
      JSON.parse(
        await readFile(
          new URL('../../rubrics/rubric-v1.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    if (!rubric.ok) throw new Error(rubric.problems.join('; '));
    versions = {
      contract: REVIEW_CONTRACT_VERSION,
      rubric: rubric.document.rubricVersion,
    };
  }
  const checked = checkGroups(
    raw.groups,
    checkers,
    versions,
    await legacyMetadata(),
  );
  return {
    ...raw,
    problems: [...raw.problems, ...checked.problems],
    findings: checked.findings,
  };
}
