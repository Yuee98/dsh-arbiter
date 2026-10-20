import { appendFileSync } from "node:fs";

/**
 * hostcov-approval-sim: SIMULATED approval answerer.
 *
 * This fixture does NOT represent a human decision. It exists only to show
 * that the native approval seam is a real, separable interface: with an
 * answerer mounted, a tool-level allow + body-internal escalation request can
 * be granted or rejected, and with none mounted the same request fails closed.
 * Every answer it produces is recorded with simulated: true.
 *
 * Mount it ONLY on the validation profile, never in a daily session.
 */
const name = "hostcov-approval-sim";
const inject = ["approval"];

export function apply(ctx, config) {
  const logPath = config.logPath;
  const outcome = config.outcome ?? "allowed-once";
  const write = (entry) => appendFileSync(logPath, JSON.stringify({ ...entry, t: new Date().toISOString() }) + "\n");

  ctx.on("approval/request", (request) => {
    write({
      event: "approval-sim/answer",
      simulated: true,
      outcome,
      toolName: request?.toolName ?? null,
      callId: request?.callId ?? null,
      reason: request?.reason ?? null,
      agentSessionId: request?.agent?.session?.id ?? null
    });
    return outcome;
  });

  write({ event: "approval-sim/mounted", simulated: true, outcome });
}

export { name, inject };
