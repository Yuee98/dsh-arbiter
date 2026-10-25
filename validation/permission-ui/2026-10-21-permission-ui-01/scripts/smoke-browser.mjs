import { readFile } from 'node:fs/promises';
import { connect, evaluate, shot, waitFor, setCookie } from './cdp.mjs';

const handle = JSON.parse(await readFile('raw/smoke-host.json', 'utf8'));
const cdp = await connect();
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
const ok = await waitFor(cdp, `document.querySelector('[data-pui-selector="trigger"]') !== null`, 25000);
console.log('selector rendered:', ok);
console.log('body text head:', (await evaluate(cdp, 'document.body.innerText.slice(0,500)')));
console.log('slots:', await evaluate(cdp, `(() => { const f = window.__DSH__; return typeof f; })()`));
await shot(cdp, 'raw/smoke-shot.png');
cdp.close();
