/**
 * Browser driving helpers shared by this run's drivers.
 *
 * Commands are typed into the real composer with real key events. The composer
 * offers completions, so every submission is verified against the session log
 * afterwards; a polluted argument list is retried rather than trusted.
 */
import { evaluate } from './cdp.mjs';
import { dismissOverlays } from './ui.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dismiss any blocking overlay and focus the composer with a real click.
 *
 * A programmatic `.focus()` on the contenteditable does not attach the
 * composer's editing handlers in this build; a synthetic mouse click at the
 * element's centre does, so every submission starts from a real click.
 */
export async function focusComposer(cdp) {
  await dismissOverlays(cdp);
  await sleep(200);
  const box = await evaluate(cdp, `(() => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (box === null) throw new Error('composer is not rendered');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}

export async function clearComposer(cdp) {
  await focusComposer(cdp);
  await evaluate(cdp, `(() => {
    const el = document.querySelector('[contenteditable="true"]');
    if (!el) return false;
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(120);
}

export async function typeText(cdp, text, { settle = 0 } = {}) {
  await focusComposer(cdp);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  const seen = await evaluate(cdp, `document.querySelector('[contenteditable="true"]')?.innerText ?? ''`);
  if (!seen.includes(text.slice(0, Math.min(6, text.length)))) {
    throw new Error('composer did not receive the text: ' + JSON.stringify(seen));
  }
  if (settle > 0) await sleep(settle);
}

export async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

/** Send a chat message (not a slash command). */
export async function sendMessage(cdp, text) {
  await clearComposer(cdp);
  await typeText(cdp, text);
  await sleep(200);
  await pressEnter(cdp);
}

/**
 * Submit a slash command, verifying the argument text the host logged.
 *
 * @returns `{ ok, attempts, args }` where `args` is what actually reached the
 *   command handler, or `undefined` when no `command/run` was recorded.
 */
export async function submitCommand(cdp, line, readCommands) {
  const expected = line.slice('/permission'.length);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clearComposer(cdp);
    await typeText(cdp, line);
    // A short settle lets the completion popup appear; Enter then accepts the
    // literal text in the composer rather than a rewritten completion.
    await pressEnter(cdp);
    await sleep(900);
    const commands = await readCommands();
    const last = commands[commands.length - 1];
    if (last !== undefined && last.args.trim() === expected.trim()) {
      return { ok: true, attempts: attempt, args: last.args, command: last };
    }
  }
  const commands = await readCommands();
  return { ok: false, attempts: 3, args: commands[commands.length - 1]?.args ?? null };
}

/** Open the native permission control and choose one option by visible label. */
export async function chooseNativePermission(cdp, label) {
  return evaluate(cdp, `(() => {
    const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter((el) => el.isConnected);
    const cell = cells[0];
    const button = cell?.querySelector('button');
    if (!button) return { ok: false, error: 'no native control' };
    button.click();
    return { ok: true, opened: true };
  })()`).then(async (r) => {
    if (r.ok !== true) return r;
    await sleep(500);
    const picked = await evaluate(cdp, `(() => {
      const wanted = ${JSON.stringify(label)};
      const nodes = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, li')];
      const hit = nodes.find((el) => (el.innerText ?? '').trim().includes(wanted) && el.isConnected);
      if (!hit) return { ok: false, error: 'option not found', seen: nodes.map((n) => (n.innerText ?? '').trim()).filter((t) => t.length > 0 && t.length < 30).slice(0, 12) };
      hit.click();
      return { ok: true, clicked: wanted };
    })()`);
    await sleep(400);
    // `auto` opens a confirmation dialog in the native control.
    const confirmed = await evaluate(cdp, `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const ack = buttons.find((b) => {
        const t = (b.innerText ?? '').trim();
        return t === '我已了解' || t === '继续' || t === '启用' || t === '确认';
      });
      if (!ack) return { ok: true, confirmation: false };
      ack.click();
      return { ok: true, confirmation: true };
    })()`);
    await sleep(900);
    return { ...picked, ...confirmed };
  });
}

/** Read the visible state of the permission control. */
export async function permissionControl(cdp) {
  return evaluate(cdp, `(() => {
    const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter((el) => el.isConnected);
    const cell = cells[0];
    return { present: cell !== undefined, text: cell?.innerText ?? null };
  })()`);
}
