import { readFile } from 'node:fs/promises';
import { connect, evaluate, shot, waitFor, setCookie } from './cdp.mjs';
const handle = JSON.parse(await readFile('raw/smoke-host.json', 'utf8'));
const cdp = await connect();
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
await new Promise((r) => setTimeout(r, 6000));
const errors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' || e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded');
for (const e of errors) {
  if (e.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(e.params.exceptionDetails).slice(0, 1500));
  else if (e.method === 'Runtime.consoleAPICalled') console.log('CON', e.params.type, (e.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 800));
  else console.log('LOG', JSON.stringify(e.params).slice(0, 800));
}
console.log('--- boot diag ---');
console.log(await evaluate(cdp, `(() => { try { return JSON.stringify(window.__DSH_BOOT__?.diagnostics ?? null).slice(0,2000); } catch (e) { return String(e); } })()`));
await shot(cdp, 'raw/smoke-error.png');
cdp.close();
