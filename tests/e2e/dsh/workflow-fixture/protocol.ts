/** Small, explicit offline trajectories; advancement requires host results. */
export interface Message {
  readonly role?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly source?: unknown;
  readonly content?: unknown;
}
export interface Call {
  readonly stage: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
export interface Config {
  readonly scenario: 'ask' | 'approval' | 'timed' | 'continuity' | 'parent';
  readonly directory: string;
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}
export function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => record(block)['text'])
    .filter((value: unknown): value is string => typeof value === 'string')
    .join('\n');
}
export function result(messages: readonly Message[], stage: string) {
  return messages.findLast(
    (message) =>
      message.role === 'tool' &&
      message.toolCallId?.startsWith(`cw126-${stage}-`) === true,
  );
}
export function resultValue(message: Message | undefined) {
  try {
    const value: unknown = JSON.parse(text(message?.content));
    return record(value);
  } catch {
    return {};
  }
}
export function authorized(value: Record<string, unknown>): boolean {
  const answers = value['answers'];
  return (
    Array.isArray(answers) &&
    answers.some((answer: unknown) => {
      const item = record(answer);
      return (
        item['id'] === 'sample-only' &&
        Array.isArray(item['selected']) &&
        item['selected'].includes('允许 sample 文件')
      );
    })
  );
}
export function probe(stage: string): Call {
  return { stage, name: 'workflow_probe', arguments: { stage } };
}
