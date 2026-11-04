/** Deterministic outputs on the REAL ToolRuntime pipeline; no product debug route. */
export const name = 'arbiter-result-probe';
export const inject = ['tools'];
const text = (value: string, channel?: string) => ({
  type: 'text',
  text: value,
  ...(channel === undefined ? {} : { channel }),
});
function content(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [text(JSON.stringify(value))];
}
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
export function apply(ctx: {
  readonly tools: { register(tool: Tool): unknown };
}): void {
  ctx.tools.register({
    name: 'result_probe',
    description: 'Return a controlled result for isolated tests',
    parameters: {
      type: 'object',
      properties: { case: { type: 'string' } },
      required: ['case'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => content(value) },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const kind = args['case'];
      await Promise.resolve();
      if (kind === 'failure') throw new Error('controlled tool failure');
      if (kind === 'empty') return [];
      if (kind === 'media')
        return [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'CW122_MEDIA_SENTINEL',
          },
        ];
      if (kind === 'multi')
        return [text('CW122_STDOUT', 'stdout'), text('CW122_STDERR', 'stderr')];
      if (kind === 'credential')
        return {
          token: 'opaque-workflow-secret-42',
          business: 'CW122_BUSINESS',
        };
      if (kind === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return [text('CW122_LATE_RESULT')];
      }
      return [text('CW122_PROBE_SUCCESS')];
    },
  });
}
