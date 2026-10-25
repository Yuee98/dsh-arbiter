/** Small shared UI driver helpers (real browser via CDP). */
export const composerText = `(() => {
  const el = document.querySelector('[contenteditable="true"]');
  return el ? el.innerText : null;
})()`;

/** Type into the composer via CDP input events (real keystrokes). */
export async function type(cdp, text) {
  await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[contenteditable="true"]')?.focus()` });
  await cdp.send('Input.insertText', { text });
}

export async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

export async function clickSelector(cdp, value) {
  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const select = document.querySelector('[data-pui-selector="trigger"]');
      if (!select) return 'missing';
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`,
    returnByValue: true,
    userGesture: true,
    awaitPromise: true,
  });
}

/** Dismiss the preview/onboarding overlay if present (real click). */
export async function dismissOverlays(cdp) {
  return cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const labels = ['继续', '知道了', '关闭', '跳过', 'Continue', 'Got it', 'Close'];
      let clicked = 0;
      for (const button of document.querySelectorAll('button')) {
        const text = (button.innerText ?? '').trim();
        const aria = button.getAttribute('aria-label') ?? '';
        if (labels.includes(text) || labels.includes(aria)) { button.click(); clicked += 1; }
      }
      return clicked;
    })()`,
    returnByValue: true,
    userGesture: true,
  });
}
