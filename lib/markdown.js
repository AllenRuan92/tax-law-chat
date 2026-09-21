// Small DOM-based Markdown renderer. Model output is always text, never executable HTML.
function inline(parent, text) {
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0, match;
  while ((match = token.exec(text))) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    const value = match[0];
    let node;
    if (value.startsWith('`')) { node = document.createElement('code'); node.textContent = value.slice(1, -1); }
    else if (value.startsWith('**')) { node = document.createElement('strong'); node.textContent = value.slice(2, -2); }
    else {
      const parts = value.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      node = document.createElement('a'); node.textContent = parts[1]; node.href = parts[2];
      node.target = '_blank'; node.rel = 'noopener noreferrer';
    }
    parent.append(node); offset = token.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
export function renderMarkdown(target, text) {
  const fragment = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const cells = value => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(v => v.trim());
  while (i < lines.length) {
    const current = lines[i];
    if (!current.trim()) { i++; continue; }
    if (/^\s*```/.test(current)) {
      const block = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) block.push(lines[i++]);
      i++;
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = block.join('\n'); pre.append(code); fragment.append(pre); continue;
    }
    if (current.includes('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      const wrap = document.createElement('div'); wrap.className = 'table-wrap';
      const table = document.createElement('table');
      const head = document.createElement('thead'), row = document.createElement('tr');
      for (const value of cells(current)) { const cell = document.createElement('th'); inline(cell, value); row.append(cell); }
      head.append(row); table.append(head); i += 2;
      const body = document.createElement('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = document.createElement('tr');
        for (const value of cells(lines[i++])) { const cell = document.createElement('td'); inline(cell, value); row.append(cell); }
        body.append(row);
      }
      table.append(body); wrap.append(table); fragment.append(wrap); continue;
    }
    const heading = current.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { const el = document.createElement(`h${Math.min(heading[1].length + 1, 4)}`); inline(el, heading[2]); fragment.append(el); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(current)) { fragment.append(document.createElement('hr')); i++; continue; }
    const list = current.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (list) {
      const el = document.createElement(list[1] ? 'ul' : 'ol');
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
        if (!item || Boolean(item[1]) !== Boolean(list[1])) break;
        const li = document.createElement('li'); inline(li, item[2]); el.append(li); i++;
      }
      fragment.append(el); continue;
    }
    if (/^>\s?/.test(current)) { const el = document.createElement('blockquote'); inline(el, current.replace(/^>\s?/, '')); fragment.append(el); i++; continue; }
    const p = document.createElement('p'); inline(p, current); fragment.append(p); i++;
  }
  target.replaceChildren(fragment);
}
