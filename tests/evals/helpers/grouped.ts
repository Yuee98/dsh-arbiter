import { readGroupedDataset } from '../../../evals/src/data/group-read.js';
import type {
  GroupedDataset,
  GroupSelection,
} from '../../../evals/src/data/group-types.js';
import { collectionOf, workflow } from '../fixtures/workflow.js';
import { temporaryDataset } from './dataset.js';

export async function loadWorkflow(
  value: unknown = workflow(),
  extra: Readonly<Record<string, unknown>> = {},
  selection: GroupSelection = { references: true },
): Promise<GroupedDataset> {
  const dataset = await temporaryDataset();
  try {
    await dataset.write('dev/f01/workflows.json', collectionOf(value));
    for (const [path, document] of Object.entries(extra))
      await dataset.write(path, document);
    return await readGroupedDataset(dataset.path, selection);
  } finally {
    await dataset.remove();
  }
}

export function changeEvent(
  eventId: string,
  patch: Readonly<Record<string, unknown>>,
): unknown {
  const root = workflow();
  return {
    ...root,
    events: root.events.map((event) =>
      event.eventId === eventId ? { ...event, ...patch } : event,
    ),
  };
}

export function problemText(dataset: GroupedDataset): string {
  return dataset.problems
    .map((problem) => `${problem.path}: ${problem.message}`)
    .join('\n');
}
