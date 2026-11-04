/** Only wiring; the agent, reviewer and tool retain separate responsibilities. */
import { apply as agent } from './agent.ts';
import { apply as reviewer } from './reviewer.ts';
import { apply as tools } from './tools.ts';

export const name = 'arbiter-workflow-fixture';
export const inject = ['llm', 'tools'];
export function apply(
  ctx: Parameters<typeof agent>[0] & Parameters<typeof tools>[0],
  config: Parameters<typeof agent>[1] & Parameters<typeof reviewer>[1],
): void {
  agent(ctx, config);
  reviewer(ctx, config);
  tools(ctx, config);
}
