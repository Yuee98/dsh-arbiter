/**
 * SIMULATED approval answerer for dsh-arbiter integration cases.
 *
 * This is not a human decision. It exists only to exercise the plugin's
 * human-allow / human-deny / human-abort mapping through the real approval
 * seam. Every record is marked simulated.
 */
import { appendFileSync } from 'node:fs';

const name = 'arbiter-approval-sim';
const inject = ['approval'];

export function apply(ctx, config) {
  const logPath = config.logPath;
  const outcome = config.outcome ?? 'allowed-once';
  const write = (entry) => {
    appendFileSync(logPath, JSON.stringify({ ...entry, simulated: true, at: new Date().toISOString() }) + '\n');
  };
  ctx.on('approval/request', (request) => {
    write({
      event: 'approval-sim/answer',
      outcome,
      toolName: request?.toolName ?? null,
      callId: request?.callId ?? null,
      reason: request?.reason ?? null,
      agentSessionId: request?.agent?.session?.id ?? null,
    });
    return outcome;
  });
  write({ event: 'approval-sim/mounted', outcome });
}

export { name, inject };
