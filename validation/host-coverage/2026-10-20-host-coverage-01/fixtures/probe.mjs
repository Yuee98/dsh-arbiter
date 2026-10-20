import { appendFileSync } from "node:fs";

/**
 * hostcov-probe: minimal tools/pre-execute + tools/result recorder for the
 * DSH host-coverage validation run. TEST FIXTURE, not a product plugin.
 *
 * - Records every tools/pre-execute decision point and every tools/result.
 * - Decides ONLY calls matching an explicit rule. Everything else goes through
 *   next() so the rest of the host chain (native guards, approval seam,
 *   sandbox) behaves exactly as without the probe.
 *
 * Rule shape: { id, tool, contains, action: "allow" | "deny", reason? }
 */
const name = "hostcov-probe";
const inject = ["tools"];

function matchRule(rules, exec) {
  const haystack = JSON.stringify(exec.arguments ?? {});
  for (const rule of rules ?? []) {
    if (rule.tool !== exec.name) continue;
    if (typeof rule.contains === "string" && !haystack.includes(rule.contains)) continue;
    return rule;
  }
  return undefined;
}

function describeExec(exec) {
  return {
    callId: String(exec.callId ?? ""),
    rootCallId: String(exec.rootCallId ?? ""),
    name: exec.name,
    parentToken: exec.parent === undefined ? null : String(exec.parent),
    hasAgent: exec.agent !== undefined,
    agentSessionId: exec.agent?.session?.id ?? null,
    sessionParent: exec.agent?.session?.header?.parentSession ?? null,
    sessionOrigin: exec.agent?.session?.header?.origin ?? null,
    delegationDepth: exec.agent?.session?.header?.delegationDepth ?? null
  };
}

export function apply(ctx, config) {
  const logPath = config.logPath;
  const rules = config.rules ?? [];
  const prepend = config.prepend === true;
  const sequence = { value: 0 };
  let snapshotTaken = false;

  const myOptions = new Set();

  const write = (entry) => {
    appendFileSync(logPath, JSON.stringify({ ...entry, probeSeq: ++sequence.value, t: new Date().toISOString() }) + "\n");
  };

  const services = () => {
    let policy = null;
    let approval = null;
    try {
      policy = ctx.get("sandboxPolicy")?.defaultMode ?? null;
    } catch (error) {
      policy = "get-error:" + String(error);
    }
    try {
      approval = ctx.get("approval")?.config?.policy ?? null;
    } catch (error) {
      approval = "get-error:" + String(error);
    }
    return {
      toolsMode: ctx.get("tools")?.defaultMode ?? null,
      sandboxDefaultMode: policy,
      approvalPolicy: approval,
      approvalPresent: ctx.get("approval") !== undefined
    };
  };

  const orderSnapshot = () => {
    try {
      // Cordis keeps one listener array per event name on the EventsService
      // instance itself (not on ctx). Dispatch order is that array's order.
      const events = ctx.root?.events ?? ctx.events;
      const hooks = events?._hooks?.["tools/pre-execute"] ?? [];
      write({
        event: "probe/order-snapshot",
        note: "array order of live tools/pre-execute listeners; the probe's own listener is identified by the registration log lines",
        order: hooks.map((hook, index) => ({
          index,
          prepend: hook.prepend === true,
          global: hook.global === true,
          // Extra listener options are spread into the stored hook record, so a
          // label written here identifies THIS listener in the live array.
          label: hook.hostcovLabel ?? null
        }))
      });
    } catch (error) {
      write({ event: "probe/order-snapshot-error", message: String(error) });
    }
  };

  const guardRules = config.guardRules ?? [];
  if (guardRules.length > 0) {
    // Registered through the host's tools.guard() seam: monotonic, runs AFTER
    // the pre-execute waterfall, and cannot be overridden by a plugin allow.
    ctx.tools.guard((exec) => {
      const haystack = JSON.stringify(exec.arguments ?? {});
      for (const rule of guardRules) {
        if (rule.tool !== undefined && rule.tool !== exec.name) continue;
        if (typeof rule.contains === "string" && !haystack.includes(rule.contains)) continue;
        write({ event: "probe/guard", ruleId: rule.id, decision: "deny", callId: String(exec.callId ?? ""), rootCallId: String(exec.rootCallId ?? ""), name: exec.name });
        return rule.reason ?? "hostcov-probe guard: denied by fixture guard " + rule.id;
      }
      write({ event: "probe/guard", ruleId: null, decision: "allow", callId: String(exec.callId ?? ""), rootCallId: String(exec.rootCallId ?? ""), name: exec.name });
      return undefined;
    });
  }

  write({ event: "probe/mounted", plugin: name, prepend, ruleCount: rules.length, guardRuleCount: guardRules.length, rules, guardRules, fiberId: ctx.fiber?.entry?.options?.id ?? null });
  write({ event: "probe/services", at: "mount", ...services() });
  orderSnapshot();

  ctx.on(
    "internal/listener",
    (eventName, _listener, options) => {
      if (eventName !== "tools/pre-execute") return;
      write({
        event: "probe/listener-registered",
        eventName,
        label: options?.hostcovLabel ?? null,
        isProbe: options?.hostcovLabel !== undefined,
        prepend: options?.prepend === true,
        byGlobal: options?.global === true
      });
    },
    { global: true }
  );

  const preExecuteOptions = { ...(prepend ? { prepend: true } : {}), hostcovLabel: "decide" };
  myOptions.add(preExecuteOptions);

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!snapshotTaken) {
      snapshotTaken = true;
      write({ event: "probe/services", at: "first-tool", ...services() });
      orderSnapshot();
    }
    const rule = matchRule(rules, exec);
    const base = { event: "probe/pre-execute", ruleId: rule?.id ?? null, action: rule?.action ?? "pass", ...describeExec(exec) };
    write(base);
    if (rule?.action === "deny") {
      write({ event: "probe/decision", ruleId: rule.id, action: "deny", callId: base.callId, rootCallId: base.rootCallId, name: base.name });
      return { kind: "deny", reason: rule.reason ?? "hostcov-probe: denied by fixture rule " + rule.id };
    }
    if (rule?.action === "allow") {
      write({ event: "probe/decision", ruleId: rule.id, action: "allow", callId: base.callId, rootCallId: base.rootCallId, name: base.name });
      return { kind: "allow" };
    }
    if (rule?.action === "ask") {
      // Hands the call to the host approval seam: this is how the validation
      // observes the native never/ask policy without any model involvement.
      write({ event: "probe/decision", ruleId: rule.id, action: "ask", callId: base.callId, rootCallId: base.rootCallId, name: base.name });
      return { kind: "ask", reason: rule.reason ?? "hostcov-probe: ask by fixture rule " + rule.id };
    }
    const decision = await next();
    write({
      event: "probe/next-result",
      callId: base.callId,
      rootCallId: base.rootCallId,
      name: base.name,
      downstream: decision?.kind ?? null,
      downstreamReason: decision?.reason ?? null
    });
    return decision;
  }, preExecuteOptions);

  const sentinelOptions = { hostcovLabel: "sentinel" };
  myOptions.add(sentinelOptions);
  ctx.on("tools/pre-execute", async (exec, next) => {
    write({ event: "probe/sentinel-pre-execute", callId: String(exec.callId ?? ""), name: exec.name });
    return next();
  }, sentinelOptions);

  ctx.on("tools/execute", (exec, next) => {
    const rule = matchRule(rules, exec);
    write({ event: "probe/execute", ruleId: rule?.id ?? null, action: rule?.action ?? "pass", ...describeExec(exec) });
    return next();
  });

  ctx.on("tools/result", (exec, result) => {
    const rule = matchRule(rules, exec);
    const text = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    write({
      event: "probe/result",
      ruleId: rule?.id ?? null,
      ...describeExec(exec),
      isError: result.isError === true,
      errorMessage: result.error?.message ?? null,
      contentHead: text.slice(0, 4000)
    });
  });

}

export { name, inject };
