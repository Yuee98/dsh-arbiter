import { readFile } from 'node:fs/promises';
import { connect, evaluate, setCookie, shot } from './cdp.mjs';
const handle = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cdp = await connect();
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
await new Promise((r) => setTimeout(r, 7000));
console.log(await evaluate(cdp, `(() => {
  const probe = (el) => el ? (el.tagName + ':' + (el.innerText ?? '').slice(0,40).replace(/\\n/g,'/')) : null;
  const nodes = [...document.querySelectorAll('[data-slot], [data-slot-error], [data-pui-selector]')].map((el) => ({
    tag: el.tagName, slot: el.getAttribute('data-slot'), err: el.getAttribute('data-slot-error'), pui: el.getAttribute('data-pui-selector'), text: (el.innerText ?? '').slice(0, 60),
  }));
  return JSON.stringify(nodes.slice(0, 60));
})()`));
await shot(cdp, 'raw/smoke-slots.png');
cdp.close();
