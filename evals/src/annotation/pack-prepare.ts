import { publishNewDirectory } from './pack-files.js';
/** Model-neutral preparation: exact source selection, never opinions or references. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { AnnotationContext } from '../data/annotation-types.js';
import type { Split } from '../data/types.js';
import type { TaskReceipt } from './pack-receipt.js';
import type { WorkflowBatch, AnnotationPoint } from './workflow-types.js';
import {
  annotationContext,
  buildAnnotationView,
  independentQuestion,
} from './workflow-view.js';
import { packSelection, selectedSources } from './pack-selection.js';
import { annotationOrigin } from './workflow-origin.js';
import { assertWorkflowOutput } from './workflow-store.js';
import {
  absent,
  artifactPath,
  createParents,
  exclusiveJson,
} from './pack-files.js';
import { taskInstructions } from './pack-instructions.js';

export async function newPackDestination(
  root: string,
  dataset: string,
  name: string,
) {
  const out = await artifactPath(root, name);
  const managed = resolve(
    await realpath(root),
    '.local/evals/workflow-annotation',
  );
  const overlap = (a: string, b: string) => {
    const p = relative(a, b);
    return p === '' || (!p.startsWith('..') && !p.startsWith('/'));
  };
  if (overlap(dataset, out) || overlap(out, dataset))
    throw new Error('pack output overlaps its source');
  if (dirname(out) !== managed) assertWorkflowOutput(root, dataset, out);
  else if (basename(out).startsWith('web-') || basename(out).endsWith('.json'))
    throw new Error('reserved private annotation output');
  await absent(out);
  await createParents(out);
  return out;
}
export async function prepareWorkflowPack(options: {
  readonly root: string;
  readonly dataset: string;
  readonly split: Split;
  readonly selection: unknown;
  readonly context: AnnotationContext;
  readonly out: string;
}) {
  const dataset = await realpath(options.dataset),
    context = annotationContext(options.context);
  const selection = packSelection(options.selection);
  const sources = await selectedSources(dataset, options.split, selection);
  const batches: WorkflowBatch[] = [];
  for (const [group, source] of sources) {
    const points: AnnotationPoint[] = [];
    for (const chosen of selection.filter((p) => p.group === group)) {
      const view = await buildAnnotationView(
        source,
        chosen.rootId,
        chosen.pointId,
        context,
      );
      points.push({
        rootId: chosen.rootId,
        pointId: chosen.pointId,
        viewId: chosen.viewId,
        ...view,
        questionId: randomUUID(),
        modelReferenceId: randomUUID(),
        humanReferenceId: randomUUID(),
        registrations: [],
        error: null,
      });
    }
    batches.push({
      batchVersion: 'workflow-annotation-v1',
      purpose: 'prepared',
      batchId: randomUUID(),
      dataset,
      split: options.split,
      group,
      createdAt: new Date().toISOString().slice(0, 10),
      ...(await annotationOrigin(options.root)),
      context,
      models: [],
      points,
      labels: [],
      opinions: [],
    });
  }
  const out = await newPackDestination(options.root, dataset, options.out);
  const tasks: {
    questionId: string;
    directory: string;
    receipt: string;
    result: string;
  }[] = [];
  const stage = await mkdtemp(join(dirname(out), '.prepare-'));
  try {
    await mkdir(join(stage, 'private'), { mode: 0o700 });
    for (const batch of batches) {
      await exclusiveJson(join(stage, 'private', `${batch.group}.json`), batch);
      for (const point of batch.points) {
        const directory = join(
          stage,
          'questions',
          batch.group,
          point.questionId,
        );
        await createParents(join(directory, 'question.json'));
        await writeFile(
          join(directory, 'question.json'),
          JSON.stringify(
            independentQuestion(point.questionId, point.request),
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        );
        const finalDirectory = join(
          out,
          'questions',
          batch.group,
          point.questionId,
        );
        const receipt: TaskReceipt = {
          batchId: batch.batchId,
          questionId: point.questionId,
          modelKey: null,
          responseId: randomUUID(),
          attempt: 'initial',
          directory: finalDirectory,
          channel: 'file',
          createdAt: new Date().toISOString(),
        };
        await exclusiveJson(
          join(stage, 'private', 'attempts', `${receipt.responseId}.json`),
          receipt,
        );
        tasks.push({
          questionId: point.questionId,
          directory: finalDirectory,
          receipt: join(
            out,
            'private',
            'attempts',
            `${receipt.responseId}.json`,
          ),
          result: join(finalDirectory, 'answer.txt'),
        });
        await writeFile(
          join(directory, 'TASK.txt'),
          taskInstructions(
            join(out, 'questions', batch.group, point.questionId),
          ),
          { flag: 'wx' },
        );
      }
    }
    await writeFile(
      join(stage, 'README.txt'),
      '模型中性题本：当前未登记模型、没有意见或参考写入。每个 questions/<组>/<题号>/ 仅供一次独立上下文。只交这一题目录，不交 private/ 或整套题。不同模型、重试必须先 workflow-task 创建新目录；不要共写原题的 answer.txt。网页模型使用同一 question.json，原文由操作者写入该次指定新文件。实际身份明确后 workflow-register，再 workflow-task、workflow-collect 预览后 --write。完整操作见 docs/workflow-annotation.md。\n',
      { flag: 'wx' },
    );
    await publishNewDirectory(stage, out);
  } catch (error) {
    throw new Error(
      `preparation incomplete; retained stage ${stage}: ${String(error)}`,
      { cause: error },
    );
  }
  return {
    out,
    points: selection.length,
    tasks,
    batches: batches.map((b) => ({
      group: b.group,
      batchId: b.batchId,
      baseline: join(out, 'private', `${b.group}.json`),
      questions: b.points.length,
    })),
  };
}
