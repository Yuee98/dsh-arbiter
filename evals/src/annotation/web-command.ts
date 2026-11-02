import { resolve } from 'node:path';
import { startAnnotationServer } from './web-server.js';
import {
  annotationContext,
  DEFAULT_ANNOTATION_CONTEXT,
} from './workflow-view.js';
import { readJson } from './workflow-store.js';
import type { Split } from '../data/types.js';

const USAGE =
  'annotate <dataset> [--split dev|calibration|holdout] [--group group] [--mode blind|assisted] [--port 0] [--context context.json] [--reviewer name]\n  启动本机工作流标注页，默认独立盲标。自动保存草稿；逐点显式确认才写入标签。';
export async function runAnnotationWebCli(
  argv: readonly string[],
  io: {
    readonly root: string;
    readonly signal: AbortSignal;
    out(line: string): void;
    err(line: string): void;
  },
): Promise<number | null> {
  if (['help', '-h', '--help'].includes(argv[0] ?? '')) {
    io.out(USAGE);
    return null;
  }
  if (argv[0] !== 'annotate') return null;
  try {
    const name = argv[1];
    if (name === undefined || name.startsWith('--'))
      throw new Error('dataset is required');
    const values = new Map<string, string>();
    for (let index = 2; index < argv.length; index += 2) {
      const key = argv[index],
        value = argv[index + 1];
      if (
        key === undefined ||
        ![
          '--split',
          '--group',
          '--mode',
          '--port',
          '--context',
          '--reviewer',
        ].includes(key) ||
        values.has(key) ||
        value === undefined ||
        value.startsWith('--')
      )
        throw new Error('unknown, duplicate or incomplete option');
      values.set(key, value);
    }
    const split = values.get('--split') ?? 'dev',
      mode = values.get('--mode') ?? 'blind';
    if (
      !['dev', 'calibration', 'holdout'].includes(split) ||
      (mode !== 'blind' && mode !== 'assisted')
    )
      throw new Error('invalid split or mode');
    const selectedSplit: Split =
      split === 'calibration'
        ? 'calibration'
        : split === 'holdout'
          ? 'holdout'
          : 'dev';
    const context = values.get('--context');
    const group = values.get('--group'),
      reviewer = values.get('--reviewer');
    const service = await startAnnotationServer(
      {
        root: io.root,
        dataset: resolve(io.root, name),
        split: selectedSplit,
        mode,
        context:
          context === undefined
            ? DEFAULT_ANNOTATION_CONTEXT
            : annotationContext(await readJson(resolve(io.root, context))),
        ...(group === undefined ? {} : { group }),
        ...(reviewer === undefined ? {} : { reviewer }),
      },
      Number(values.get('--port') ?? 0),
    );
    io.out(`工作流标注：${service.url}`);
    io.out('使用同一启动参数可恢复本地批次。按 Ctrl+C 关闭。');
    try {
      if (!io.signal.aborted)
        await new Promise<void>((done) => {
          const aborted = () => {
            io.signal.removeEventListener('abort', aborted);
            done();
          };
          io.signal.addEventListener('abort', aborted, { once: true });
          if (io.signal.aborted) aborted();
        });
    } finally {
      await service.close();
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
