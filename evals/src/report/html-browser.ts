/** Fixed offline DOM behavior. No report value is interpolated into this script. */
export const HTML_BROWSER_SCRIPT = String.raw`
(() => {
  const root = document.getElementById('example-browser');
  if (!root) return;
  const controls = root.querySelector('[data-controls]');
  const search = root.querySelector('[data-search]');
  const reset = root.querySelector('[data-reset]');
  const count = root.querySelector('[data-count]');
  const empty = root.querySelector('[data-empty]');
  const selects = Array.from(root.querySelectorAll('select[data-filter]'));
  const rows = Array.from(root.querySelectorAll('tr[data-example]'));
  if (!controls || !search || !reset || !count || !empty) return;
  const entries = rows.map(row => ({
    row,
    text: row.textContent.toLocaleLowerCase('zh-CN'),
  }));
  const update = () => {
    const query = search.value.trim().toLocaleLowerCase('zh-CN');
    let visible = 0;
    for (const entry of entries) {
      const matches = (!query || entry.text.includes(query)) && selects.every(
        select => !select.value || entry.row.getAttribute('data-' + select.dataset.filter) === select.value
      );
      entry.row.hidden = !matches;
      if (matches) visible += 1;
    }
    count.textContent = '当前可见 ' + visible + ' / 全计划 ' + rows.length + ' 格';
    empty.hidden = visible !== 0;
  };
  search.addEventListener('input', update);
  for (const select of selects) select.addEventListener('change', update);
  reset.addEventListener('click', () => {
    search.value = '';
    for (const select of selects) select.value = '';
    update();
  });
  update();
  controls.hidden = false;
})();
`;
