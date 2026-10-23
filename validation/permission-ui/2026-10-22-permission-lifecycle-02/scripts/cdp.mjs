/** Minimal CDP client over Node's global WebSocket (no dependencies). */
import { writeFile } from 'node:fs/promises';

export async function connect(port = 57999) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    } else if (data.method) events.push(data);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  return { ws, send, events, close: () => ws.close() };
}

export async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

export async function shot(cdp, path) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}

export async function waitFor(cdp, expression, timeoutMs = 30000, interval = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(cdp, expression) === true) return true; } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export async function setCookie(cdp, url, cookieString) {
  const [pair] = cookieString.split('; ');
  const index = pair.indexOf('=');
  await cdp.send('Network.setCookie', {
    name: pair.slice(0, index),
    value: pair.slice(index + 1),
    domain: new URL(url).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}
