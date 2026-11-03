import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => readonly unknown[];
  };
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
  readonly isConcurrencySafe: () => boolean;
}
export function apply(
  ctx: { readonly tools: { register(tool: Tool): unknown } },
  config: { readonly directory: string },
): void {
  ctx.tools.register({
    name: 'workflow_probe',
    description: '受控宿主连续行为探针',
    parameters: {
      type: 'object',
      properties: { stage: { type: 'string' } },
      required: ['stage'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value),
        },
      ],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const stage = args['stage'];
      if (typeof stage !== 'string' || !/^[a-zA-Z0-9-]+$/u.test(stage))
        throw new Error('invalid probe stage');
      await mkdir(config.directory, { recursive: true });
      await appendFile(
        join(config.directory, 'executions.jsonl'),
        JSON.stringify({ stage, at: Date.now() }) + '\n',
      );
      if (stage === 'failure')
        throw new Error('CW126 controlled actual failure');
      if (stage === 'slow') {
        await writeFile(join(config.directory, 'slow-started'), 'started');
        const deadline = Date.now() + 120000;
        while (
          !(await stat(join(config.directory, 'slow-release')).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() >= deadline)
            throw new Error('slow result barrier timed out');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return readFile(join(config.directory, 'long-source.txt'), 'utf8');
      }
      await writeFile(join(config.directory, `${stage}-effect.txt`), stage, {
        flag: 'wx',
      });
      return readFile(join(config.directory, 'result-marker.txt'), 'utf8');
    },
  });
}
