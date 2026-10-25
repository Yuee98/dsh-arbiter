import { readFile } from 'node:fs/promises';
import { connect, evaluate, setCookie } from './cdp.mjs';

const handle = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cdp = await connect(Number(process.argv[3] ?? 57999));
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
await new Promise((r) => setTimeout(r, 8000));
const result = await evaluate(cdp, `(() => {
  const out = { loaderKeys: Object.keys(window.__ModuleLoader__ ?? {}) };
  try {
    const q = window.__ModuleLoader__;
    out.mode = q.mode; out.pending = q.pendingQueue?.length ?? null;
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()`);
console.log('loader:', result);
for (const e of cdp.events) {
  if (e.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(e.params.exceptionDetails).slice(0, 1200));
  if (e.method === 'Network.responseReceived') {
    const u = e.params.response.url;
    if (u.includes('pui-probe')) console.log('RESP', e.params.response.status, u.slice(0, 200));
  }
  if (e.method === 'Network.loadingFailed' && e.params.errorText !== 'net::ERR_ABORTED') console.log('FAIL', e.params.errorText, e.params.requestId);
}
cdp.close();
