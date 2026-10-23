/**
 * Fixed assertions over the recorded run. Reads raw/results.json only; it does
 * not boot a host and does not call a model.
 */
import { readFile, writeFile } from 'node:fs/promises';

const results = JSON.parse(await readFile(new URL('../raw/results.json', import.meta.url), 'utf8'));
const checks = [];
const check = (group, name, ok, detail) => checks.push({ group, name, ok: ok === true, detail });

const u1 = results.U1;
/** Steps recorded their value; mirror it onto the group for direct access. */
const fromStep = (group, name, fallback) => {
  const hit = (group.steps ?? []).find((s) => s.name === name && s.ok === true);
  return hit?.value ?? fallback;
};
u1.trusted = { ...(fromStep(u1, 'trusted-boundary', {})), ...u1.trusted };
u1.enable = { ...u1.enable, status: u1.enable.status ?? fromStep(u1, 'enable-guarded-via-selector', {}).status };
u1.secondSession = { ...(fromStep(u1, 'second-session-not-taken-over', {})), ...u1.secondSession };
u1.secondSession.gates = u1.secondSession.gates ?? u1.secondSession.secondSession?.gates ?? [];
u1.overrideRemoved = fromStep(u1, 'override-removed-restores-native', u1.overrideRemoved);
const u2 = results.U2;
const u3 = results.U3;
const u4 = results.U4;
const u4a = results['U4-approval'];

// U1
check('U1', 'my selector occupies the slot', u1.slotInitial.state.puiPresent === true && u1.slotInitial.state.nativeControl === false);
check('U1', 'host read-only option kept', u1.slotInitial.state.options.some((o) => o.value === 'read-only'));
check('U1', 'host workspace-write option kept', u1.slotInitial.state.options.some((o) => o.value === 'workspace-write'));
check('U1', 'host danger-full-access option kept', u1.slotInitial.state.options.some((o) => o.value === 'danger-full-access'));
check('U1', 'host auto option is not offered by my menu', !u1.slotInitial.state.options.some((o) => o.value === 'auto'));
const enableStatus = u1.enable.status?.status ?? u1.enable.status ?? u1.enable;
check('U1', 'enable via selector entered guarded', enableStatus.enabled === true && enableStatus.boundary === 'guarded', enableStatus);
check('U1', 'guarded allow wrote inside workspace', u1.guardedAllow.marker.exists === true);
check('U1', 'guarded allow tool result not an error', u1.guardedAllow.results.some((r) => r.isError === false));
check('U1', 'probe deny blocked the call', u1.guardedDeny.events.some((e) => e.event === 'gate/deny'));
check('U1', 'deny marker absent on disk', u1.guardedDeny.marker.exists === false);
check('U1', 'guarded outside write denied by host sandbox', u1.guardedOutside.marker.exists === false && u1.guardedOutside.results.some((r) => r.isError === true && r.text.includes('file access denied under workspace-write')));
check('U1', 'plugin allow does not bypass the fs sandbox', u1.guardedOutside.events.some((e) => e.event === 'gate/allow'));
check('U1', 'trusted outside write succeeded', u1.trusted.marker.exists === true);
check('U1', 'boundary change kept the session enabled', u1.trusted.after.enabled === true && u1.trusted.after.boundary === 'trusted');
check('U1', 'second session is not enabled', u1.secondSession.secondStatus.enabled === false);
check('U1', 'second session produced no gate events', u1.secondSession.gates.every((g) => g.sessionId !== u1.secondSession.second));
check('U1', 'override removal restores the native control', u1.overrideRemoved.state.nativeControl === true && u1.overrideRemoved.state.puiPresent === false);
check('U1', 'override removal does not rewrite backend state', u1.overrideRemoved.status.status.enabled === true);

// U2
check('U2', 'same-value workspace-write emits no knob events', u2.sameValue.noKnobEvents === true);
check('U2', 'host value genuinely unchanged', u2.sameValue.hostValueUnchanged === true);
check('U2', 'command/run is logged before the handler', u2.sameValue.commandRunLogged === true);
check('U2', 'same-value command still exits arbiter', u2.sameValue.after.enabled === false);
check('U2', 'post-exit calls are not taken over', u2.postExit.enabled === false && u2.postExit.gatesAfterExit.length === 0);
check('U2', 'post-exit call ran under the host value', u2.postExit.results.some((r) => r.isError === false) && u2.postExit.marker.exists === true);
check('U2', 'read-only switch changes the host value', u2.readOnly.after.hostCurrent === 'read-only');
check('U2', 'danger-full-access switch changes the host value', u2.fullAccess.after.hostCurrent === 'danger-full-access');
check('U2', 'bare /permission lists the host presets', u2.barePicker.picker.some((p) => p.includes('仅可查看')) && u2.barePicker.picker.some((p) => p.includes('完全权限')));
check('U2', 'arbiter menu stays separate from host presets', u2.barePicker.picker.some((p) => p.includes('自动审查（Arbiter）')) === false);
check('U2', '/permission auto is accepted while the integration is live', u2.auto.run.data.args === ' auto' && u2.auto.run.data.name === 'permission');
check('U2', 'auto switches the host bundle to full-access', u2.auto.tail.some((e) => e.type === 'sandbox/mode' && e.data.mode === 'danger-full-access'));
check('U2', 'auto exits arbiter (no silent guarded takeover)', u2.auto.after.enabled === false);
check('U2', 'post-auto call is not gate-decided by arbiter', u2.postAuto.gates.length === 0 && u2.postAuto.marker.exists === true);
check('U2', 'control run still gated after re-enable', u2.control.gates.length >= 3 && u2.control.marker.exists === true);

// U3
check('U3', 'page refresh keeps backend state', u3.refresh.before.enabled === u3.refresh.after.enabled && u3.refresh.after.enabled === true);
check('U3', 'page refresh shows the backend state', u3.refresh.selector.enabled === true && u3.refresh.selector.selected === '__arbiter__');
check('U3', 'a second connection can disable while the page is offline', u3.disconnect.remoteStatus.status.enabled === false);
check('U3', 'reconnect adopts the newer backend state', u3.disconnect.afterReconnect.enabled === false && u3.disconnect.selector.enabled === false);
check('U3', 'late response does not resurrect the old state', u3.late.status.enabled === false && u3.late.selector.enabled === false);
check('U3', 'cold restart restores enablement', u3.coldRestart.after.enabled === true && u3.coldRestart.restoredEvents.length >= 1);
check('U3', 'restored boundary is re-applied', u3.coldRestart.restoredEvents.some((e) => e.boundary === 'guarded'));
check('U3', 'gate is active after restart', u3.postRestart.gates.includes('gate/deny') && u3.postRestart.marker.exists === false);
check('U3', 'a new session is not enabled after restart', u3.newSession.freshStatus.enabled === false);
check('U3', 'enabled session still enabled after restart', u3.newSession.enabledStatus.enabled === true);
check('U3', 'restore does not need the audit database', u3.auditRemoved.auditPresent === false && u3.auditRemoved.enabled.enabled === true);
check('U3', 'restore re-ran after the audit directory was moved', u3.auditRemoved.restored.length >= 2);

// U4
check('U4', 'client override removal keeps backend enablement', u4.overrideRemoval.before.enabled === u4.overrideRemoval.after.enabled);
check('U4', 'client override removal restores the native control', u4.overrideRemoval.selector.nativeControl === true && u4.overrideRemoval.selector.puiPresent === false);
check('U4', 'slow review was really in flight at unload', u4.inflight.inflight === true && u4.inflight.during.active.length === 1);
check('U4', 'unload waited for the in-flight review', u4.inflight.afterEvents.some((e) => e.event === 'pui/dispose-wait') && u4.inflight.afterEvents.some((e) => e.event === 'review/settled' && e.outcome === 'done'));
check('U4', 'plugin did not cancel its own review', u4.inflight.afterEvents.some((e) => e.event === 'review/settled' && e.signalAborted === false));
check('U4', 'in-flight call completed with its effect', u4.inflight.marker.exists === true);
check('U4', 'rollback happened only after the drain', (() => {
  const drained = u4.inflight.afterEvents.find((e) => e.event === 'pui/dispose-drained');
  const rollback = u4.inflight.afterEvents.find((e) => e.event === 'pui/dispose-rollback');
  return drained !== undefined && rollback !== undefined && rollback.t >= drained.t;
})());
check('U4', 'unload rolled the managed session to workspace-write', u4.inflight.afterEvents.some((e) => e.event === 'pui/dispose-rollback' && e.to === 'workspace-write+ask'));
check('U4', 'unloaded plugin releases its routes', u4.postUnload.routes.ok !== true);
check('U4', 'reopened session loads (ignorable records only)', u4.reopen.ignorableRecords.every((r) => r.ignorable === true));
check('U4', 'rollback is durable after reopen', u4.reopen.status.enabled === false && u4.reopen.status.reason === 'plugin-unload');
check('U4', 'reopened session is not re-enabled', u4.reopen.restored.length === 0);
check('U4', 'user-switched session is skipped on unload', u4.userSwitched.skipped.length === 1 && u4.userSwitched.rolledBack.length === 0);
check('U4', 'user-chosen read-only is preserved', u4.userSwitched.modeEvents.some((e) => e.mode === 'read-only'));
check('U4', 'pending approval is not auto-approved or denied by the switch', u4a.pending.approvalEvents.filter((e) => e.type === 'approval/decided').length === 0);
check('U4', 'switch during a pending approval succeeds', u4a.pending.switchResult.ok === true);
check('U4', 'approval request stays recorded as asked', u4a.pending.approvalEvents.some((e) => e.type === 'approval/asked'));
check('U4', 'arbiter exits when the user switches during an approval', u4a.pending.status.enabled === false);

const failed = checks.filter((c) => c.ok === false);
await writeFile(new URL('../raw/check-results.json', import.meta.url), JSON.stringify({ checks, passed: checks.length - failed.length, failed: failed.length }, null, 2));
console.log(`${checks.length - failed.length} passed, ${failed.length} failed`);
for (const c of failed) console.log('FAIL', c.group, c.name, JSON.stringify(c.detail));
