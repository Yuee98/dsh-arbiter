/** Independent registration avoids the legacy export/import dispatch seam. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runPackCli } from './pack-command.js';
import { exportWorkflowBatch } from './workflow-export.js';
import {
  importWorkflowHuman,
  importWorkflowOpinions,
  workflowReferences,
} from './workflow-service.js';
import {
  annotationContext,
  DEFAULT_ANNOTATION_CONTEXT,
} from './workflow-view.js';
import { assertWorkflowOutput, readJson } from './workflow-store.js';
import type { Split } from '../data/types.js';

interface Io {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}
const COMMANDS = [
  'workflow-export',
  'workflow-import',
  'workflow-adjudicate',
  'workflow-reference',
];
const USAGE = `workflow-export <dataset> --group <group> --models <models.json> --out <new-directory> [--split dev|calibration|holdout] [--context <context.json>]\n  导出隔离题本并立即将所有模型登记为未返回；不触发模型请求。\nworkflow-import <dataset> --batch <local-baseline.json> --answers <returns.json> [--write] [--context <context.json>]\n  保存模型原始回复并重算模型参考；转交回复不构成人工确认。\nworkflow-adjudicate <dataset> --batch <local-baseline.json> --fill <human-fill.json> [--write]\n  明确人工状态的共享导入入口；独立人工标注页由 #128 提供。\nworkflow-reference <dataset> --group <group> [--split dev|calibration|holdout] [--context <context.json>] [--out <new-snapshot.json>]\n  当前参考只读重算；候选比较共用同一保存的参考快照。`;
function flags(
  argv: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !allowed.includes(flag) || values.has(flag))
      throw new Error(`unknown/duplicate option ${flag ?? ''}`);
    if (flag === '--write') {
      values.set(flag, 'true');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    index += 1;
  }
  return values;
}
function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}
function splitOf(values: ReadonlyMap<string, string>): Split {
  const value = values.get('--split') ?? 'dev';
  if (value !== 'dev' && value !== 'calibration' && value !== 'holdout')
    throw new Error('select exactly one split: dev, calibration or holdout');
  return value;
}
export async function runWorkflowAnnotationCli(
  argv: readonly string[],
  io: Io,
): Promise<number | null> {
  const packCode = await runPackCli(argv, io);
  if (packCode !== null) return packCode;
  if (['help', '--help', '-h'].includes(argv[0] ?? '')) {
    io.out(USAGE);
    return null;
  }
  const [command, name, ...rest] = argv;
  if (command === undefined || !COMMANDS.includes(command)) return null;
  try {
    if (name === undefined || name.startsWith('--'))
      throw new Error('dataset is required');
    const dataset = resolve(io.root, name);
    const allowed =
      command === 'workflow-export'
        ? ['--split', '--group', '--models', '--context', '--out']
        : command === 'workflow-reference'
          ? ['--split', '--group', '--context', '--out']
          : command === 'workflow-import'
            ? ['--batch', '--answers', '--write', '--context']
            : ['--batch', '--fill', '--write'];
    const values = flags(rest, allowed);
    const contextPath = values.get('--context');
    const context =
      contextPath === undefined
        ? DEFAULT_ANNOTATION_CONTEXT
        : annotationContext(await readJson(resolve(io.root, contextPath)));
    if (command === 'workflow-export') {
      const result = await exportWorkflowBatch({
        root: io.root,
        dataset,
        split: splitOf(values),
        group: required(values, '--group'),
        models: await readJson(resolve(io.root, required(values, '--models'))),
        context,
        out: required(values, '--out'),
      });
      io.out(
        `batch ${result.batch.batchId}; ${String(result.batch.points.filter((point) => point.binding !== null).length)} independent questions; baseline ${result.baseline}`,
      );
      for (const point of result.batch.points)
        if (point.error !== null)
          io.err(`unresolved ${point.pointId}: ${point.error}`);
    } else if (command === 'workflow-reference') {
      const snapshot = await workflowReferences({
        root: io.root,
        dataset,
        split: splitOf(values),
        group: required(values, '--group'),
        context,
      });
      const out = values.get('--out');
      if (out !== undefined) {
        const destination = resolve(io.root, out);
        assertWorkflowOutput(io.root, dataset, destination);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n', {
          flag: 'wx',
        });
      }
      io.out(JSON.stringify(snapshot));
    } else {
      const baseline = resolve(io.root, required(values, '--batch')),
        write = values.has('--write');
      const result =
        command === 'workflow-import'
          ? await importWorkflowOpinions({
              dataset,
              baseline,
              returned: await readJson(
                resolve(io.root, required(values, '--answers')),
              ),
              write,
              ...(contextPath === undefined ? {} : { context }),
            })
          : await importWorkflowHuman({
              dataset,
              baseline,
              fill: await readJson(
                resolve(io.root, required(values, '--fill')),
              ),
              write,
            });
      io.out(
        `${write ? 'saved' : 'preview'} ${String('responses' in result ? result.responses : result.decisions)} ${command === 'workflow-import' ? 'model responses; no human confirmation' : 'explicit human decisions'}`,
      );
    }
    return 0;
  } catch (error) {
    io.err(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
    return 1;
  }
}
