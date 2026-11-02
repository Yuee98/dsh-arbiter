import type { GroupedDataset, WorkflowLabel } from '../data/group-types.js';
import type { AnnotationContext } from '../data/annotation-types.js';
import type { DraftPoint } from './web-draft-store.js';
import type { WebPointSummary } from './web-types.js';
import { buildAnnotationView } from './workflow-view.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import { currentReference } from './reference.js';

/** Only a status crosses into blind mode; no other annotator's answer is returned. */
export async function humanReferenceStatus(
  source: GroupedDataset,
  labels: readonly WorkflowLabel[],
  point: DraftPoint,
  context: AnnotationContext,
): Promise<WebPointSummary['referenceStatus']> {
  try {
    const view = await buildAnnotationView(
      source,
      point.rootId,
      point.pointId,
      context,
    );
    const human = labels.filter(
      (label) =>
        label.rootId === point.rootId &&
        label.pointId === point.pointId &&
        label.viewId === point.viewId &&
        ['human', 'human-inherited'].includes(label.source) &&
        label.annotation?.humanState !== 'draft',
    );
    const applicable = human.filter(
      (label) =>
        label.annotation !== undefined &&
        sameAnnotationView(label.annotation.binding, view.binding),
    );
    if (applicable.length === 0) return human.length === 0 ? 'none' : 'stale';
    const current = currentReference(
      {
        rootId: point.rootId,
        pointId: point.pointId,
        viewId: point.viewId,
        binding: view.binding,
      },
      applicable,
      [],
      'human-status',
      'human-status',
    );
    if (current.humanConfirmed) return 'confirmed';
    if (current.reasons.includes('human-reference-conflict')) return 'disputed';
    const direct = applicable.filter((label) => label.source === 'human');
    const effective = direct.length === 0 ? applicable : direct;
    for (const state of ['disputed', 'needs-review', 'undecidable'] as const)
      if (
        effective.some(
          (label) =>
            label.annotation?.humanState === state ||
            (state === 'disputed' && label.target.status === 'disputed'),
        )
      )
        return state;
    return 'unresolved';
  } catch {
    return 'preparation-failed';
  }
}
