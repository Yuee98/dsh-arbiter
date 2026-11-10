import { checked, idSchema } from './workflow-validation.js';
import { workflowSource } from './workflow-view.js';
import type { Split } from '../data/types.js';
import type { GroupedDataset } from '../data/group-types.js';
export interface PackPoint {
  readonly group: string;
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
}
export function packSelection(value: unknown): readonly PackPoint[] {
  const points = checked<readonly PackPoint[]>(
    {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'rootId', 'pointId', 'viewId'],
        properties: {
          group: idSchema,
          rootId: idSchema,
          pointId: idSchema,
          viewId: idSchema,
        },
      },
    },
    value,
  );
  const identities = points.map((p) =>
    JSON.stringify([p.group, p.rootId, p.pointId]),
  );
  if (new Set(identities).size !== points.length)
    throw new Error('duplicate selected point');
  return points;
}
export function assertSelected(source: GroupedDataset, point: PackPoint): void {
  const actual = source.groups
    .flatMap((g) => g.workflows)
    .find((w) => w.document.rootId === point.rootId)
    ?.document.points.find((p) => p.pointId === point.pointId);
  if (actual === undefined || actual.primaryViewId !== point.viewId)
    throw new Error(`unknown selected point/view: ${point.pointId}`);
}
export async function selectedSources(
  dataset: string,
  split: Split,
  points: readonly PackPoint[],
) {
  const sources = new Map<string, GroupedDataset>();
  for (const point of points) {
    let source = sources.get(point.group);
    if (source === undefined) {
      source = await workflowSource(dataset, split, point.group);
      sources.set(point.group, source);
    }
    assertSelected(source, point);
  }
  return sources;
}
