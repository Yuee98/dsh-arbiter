/** Read and validate selected grouped sources; file parsing is shared with legacy readers. */
import { readFile } from 'node:fs/promises';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { readGroupFiles } from './group-files.js';
import { groupedLegacyAuthority } from './legacy-metadata.js';
import { isLegacyCollection } from './dataset-layout.js';
import { checkGroups } from './group-check.js';
import { compileCheckers } from './schemas.js';
import type { CurrentVersions, Finding } from './inspect.js';
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
  const authority = await groupedLegacyAuthority(dataset);
  const checked = checkGroups(raw.groups, checkers, versions, authority);
  const membershipProblems: Finding[] = [];
  if (
    authority !== undefined &&
    (await isLegacyCollection(dataset)) &&
    (raw.scope.group === null || raw.scope.group === 'legacy-v1') &&
    raw.scope.contentSet !== 'workflows-v1'
  ) {
    for (const split of raw.scope.splits)
      if (
        authority.families.some((f) => f.split === split) &&
        !raw.groups.some(
          (g) => g.split === split && g.contentSet === 'legacy-v1',
        )
      )
        membershipProblems.push({
          path: `${split}/legacy-v1/cases.json#`,
          message: `historical legacy group ${split}/legacy-v1 is missing`,
        });
  }
  return {
    ...raw,
    problems: [...raw.problems, ...checked.problems, ...membershipProblems],
    findings: checked.findings,
  };
}
