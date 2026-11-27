import { sameAnnotationView } from '../data/annotation-binding.js';
import type { AnnotationBinding } from '../data/annotation-types.js';
import type { WorkflowOpinion } from '../data/group-types.js';
import { modelConsensus } from './consensus.js';
import type { DraftPoint } from './web-draft-store.js';
import type { WebConsensusStatus, WebConsensusSummary } from './web-types.js';
import type { WebScope } from './web-workspace.js';
import { workflowRecords, workflowState } from './workflow-store.js';
import { buildAnnotationView } from './workflow-view.js';

export function opinionsForView(
  opinions: readonly WorkflowOpinion[],
  view: Pick<DraftPoint, 'rootId' | 'pointId' | 'viewId'> & {
    readonly binding: AnnotationBinding;
  },
): readonly WorkflowOpinion[] {
  return opinions.filter(
    (opinion) =>
      opinion.rootId === view.rootId &&
      opinion.pointId === view.pointId &&
      opinion.viewId === view.viewId &&
      opinion.annotation !== undefined &&
      sameAnnotationView(opinion.annotation.binding, view.binding),
  );
}

function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

/** Summarize every point without materializing a private baseline or exposing its answers. */
export async function workspaceConsensus(
  scope: WebScope,
  points: readonly DraftPoint[],
): Promise<readonly WebConsensusSummary[]> {
  const summaries: WebConsensusSummary[] = [];
  for (const [group, members] of groupBy(points, (point) => point.group)) {
    const source = await workflowState(scope.dataset, scope.split, group);
    const byPoint = groupBy(
      workflowRecords(source).opinions,
      (opinion) => opinion.pointId,
    );
    for (const point of members) {
      let status: WebConsensusStatus = 'unavailable';
      const candidates = byPoint.get(point.pointId);
      if (candidates !== undefined) {
        const view = await buildAnnotationView(
          source,
          point.rootId,
          point.pointId,
          scope.context,
        ).catch(() => null);
        if (view !== null) {
          const consensus = modelConsensus(
            opinionsForView(candidates, { ...point, binding: view.binding }),
            view.request,
          );
          if (consensus.valid > 0)
            status = consensus.pair === null ? 'disagreed' : 'agreed';
        }
      }
      summaries.push({ token: point.token, status });
    }
  }
  return summaries;
}
