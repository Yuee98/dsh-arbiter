/** Offline prepare/participant/task/raw operations, dispatched by existing annotation CLI. */
import { prepareWorkflowPack } from './pack-prepare.js';
import { registerPreparedPack } from './pack-register.js';
import { createPackTask } from './pack-task.js';
import { collectPackTask } from './pack-collect.js';
import {
  annotationContext,
  DEFAULT_ANNOTATION_CONTEXT,
} from './workflow-view.js';
import { artifactPath, jsonFile } from './pack-files.js';
const HELP = `workflow-prepare <dataset> --selection points.json --context context.json --out new-pack [--split dev|calibration|holdout]
workflow-register <dataset> --prepared baseline --models models.json --out private/registered/new.json [--write]
workflow-task <dataset> --batch baseline --question UUID [--model registered-key] --attempt id --out new-task [--channel file|web] [--origin neutral-private-receipt]
workflow-collect <dataset> --batch baseline --receipt private-receipt [--error text|--missing] [--write]
  全部离线；先准备无模型题本，再实际登记；回收默认预览，--write前仍先预览。无模型原文不能导入意见。`;
const allowed: Readonly<Record<string, readonly string[]>> = {
  'workflow-prepare': ['--selection', '--context', '--out', '--split'],
  'workflow-register': ['--prepared', '--models', '--out', '--write'],
  'workflow-task': [
    '--batch',
    '--question',
    '--model',
    '--attempt',
    '--out',
    '--channel',
    '--origin',
  ],
  'workflow-collect': [
    '--batch',
    '--receipt',
    '--write',
    '--error',
    '--missing',
  ],
};
export async function runPackCli(
  argv: readonly string[],
  io: {
    readonly root: string;
    out(line: string): void;
    err(line: string): void;
  },
): Promise<number | null> {
  const [command, name, ...rest] = argv;
  if (['help', '--help', '-h'].includes(command ?? '')) {
    io.out(HELP);
    return null;
  }
  if (command === undefined || allowed[command] === undefined) return null;
  try {
    if (name === undefined || name.startsWith('--'))
      throw new Error('dataset is required');
    const values = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 1) {
      const key = rest[index];
      if (
        key === undefined ||
        !allowed[command].includes(key) ||
        values.has(key)
      )
        throw new Error('unknown/duplicate option');
      if (key === '--write' || key === '--missing') {
        values.set(key, 'true');
        continue;
      }
      const value = rest[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error('missing option value');
      values.set(key, value);
    }
    const required = (key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`required ${key}`);
      return value;
    };
    const file = async (key: string) => artifactPath(io.root, required(key));
    const dataset = await artifactPath(io.root, name);
    let result: unknown;
    if (command === 'workflow-prepare') {
      const split = values.get('--split') ?? 'dev';
      if (split !== 'dev' && split !== 'calibration' && split !== 'holdout')
        throw new Error('invalid split');
      result = await prepareWorkflowPack({
        root: io.root,
        dataset,
        split,
        selection: await jsonFile(await file('--selection')),
        context: values.has('--context')
          ? annotationContext(await jsonFile(await file('--context')))
          : DEFAULT_ANNOTATION_CONTEXT,
        out: required('--out'),
      });
    } else if (command === 'workflow-register')
      result = await registerPreparedPack({
        root: io.root,
        dataset,
        prepared: await file('--prepared'),
        models: await jsonFile(await file('--models')),
        out: required('--out'),
        write: values.has('--write'),
      });
    else if (command === 'workflow-task') {
      const channel = values.get('--channel') ?? 'file';
      if (channel !== 'file' && channel !== 'web')
        throw new Error('invalid channel');
      const model = values.get('--model');
      const origin = values.get('--origin');
      result = await createPackTask({
        root: io.root,
        dataset,
        batch: await file('--batch'),
        question: required('--question'),
        ...(model === undefined ? {} : { model }),
        ...(origin === undefined
          ? {}
          : { origin: await artifactPath(io.root, origin) }),
        attempt: required('--attempt'),
        out: required('--out'),
        channel,
      });
    } else {
      const error = values.get('--error');
      result = await collectPackTask({
        dataset,
        batch: await file('--batch'),
        receipt: await file('--receipt'),
        write: values.has('--write'),
        ...(error === undefined ? {} : { error }),
        missing: values.has('--missing'),
      });
    }
    io.out(JSON.stringify(result));
    return 0;
  } catch (error) {
    io.err(`${String(error)}\n${HELP}`);
    return 1;
  }
}
