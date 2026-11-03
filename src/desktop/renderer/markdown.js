'use strict';

(() => {
  function safeUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function inline(text) {
    const fragment = document.createDocumentFragment();
    let buffer = '';
    let index = 0;
    const flush = () => {
      if (buffer) {
        fragment.append(document.createTextNode(buffer));
        buffer = '';
      }
    };
    while (index < text.length) {
      const character = text[index];
      if (character === '\\' && index + 1 < text.length) {
        buffer += text[index + 1];
        index += 2;
        continue;
      }
      if (character === '\n') {
        flush();
        fragment.append(document.createElement('br'));
        index += 1;
        continue;
      }
      if (character === '`') {
        let run = 1;
        while (text[index + run] === '`') run += 1;
        const delimiter = '`'.repeat(run);
        const end = text.indexOf(delimiter, index + run);
        if (end !== -1) {
          flush();
          const code = document.createElement('code');
          code.textContent = text.slice(index + run, end);
          fragment.append(code);
          index = end + run;
          continue;
        }
      }
      if (text.startsWith('**', index)) {
        const end = text.indexOf('**', index + 2);
        if (end !== -1) {
          flush();
          const strong = document.createElement('strong');
          strong.append(inline(text.slice(index + 2, end)));
          fragment.append(strong);
          index = end + 2;
          continue;
        }
      }
      if (text.startsWith('~~', index)) {
        const end = text.indexOf('~~', index + 2);
        if (end !== -1) {
          flush();
          const deleted = document.createElement('del');
          deleted.append(inline(text.slice(index + 2, end)));
          fragment.append(deleted);
          index = end + 2;
          continue;
        }
      }
      if (character === '*') {
        const end = text.indexOf('*', index + 1);
        if (end > index + 1) {
          flush();
          const emphasis = document.createElement('em');
          emphasis.append(inline(text.slice(index + 1, end)));
          fragment.append(emphasis);
          index = end + 1;
          continue;
        }
      }
      if (character === '!' && text[index + 1] === '[') {
        const match = /^!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
        if (match) {
          flush();
          const image = document.createElement('span');
          image.className = 'md-image';
          image.textContent = match[1] ? `[图片：${match[1]}]` : '[图片]';
          fragment.append(image);
          index += match[0].length;
          continue;
        }
      }
      if (character === '[') {
        const match = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
        if (match) {
          const url = safeUrl(match[2]);
          if (url !== null) {
            flush();
            const link = document.createElement('a');
            link.className = 'md-link';
            link.href = url;
            link.dataset.externalUrl = url;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.title = url;
            link.append(inline(match[1]));
            fragment.append(link);
            index += match[0].length;
            continue;
          }
        }
      }
      if (character === '<') {
        const match = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(index));
        if (match) {
          const url = safeUrl(match[1]);
          if (url !== null) {
            flush();
            const link = document.createElement('a');
            link.className = 'md-link';
            link.href = url;
            link.dataset.externalUrl = url;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.title = url;
            link.textContent = match[1];
            fragment.append(link);
            index += match[0].length;
            continue;
          }
        }
      }
      buffer += character;
      index += 1;
    }
    flush();
    return fragment;
  }

  function listLine(line) {
    const match = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match) return null;
    return {indent: match[1].replace(/\t/g, '    ').length, ordered: /^\d/.test(match[2]), content: match[3]};
  }

  function parseList(lines, start) {
    const first = listLine(lines[start]);
    const baseIndent = first.indent;
    const ordered = first.ordered;
    const list = document.createElement(ordered ? 'ol' : 'ul');
    let index = start;
    let lastItem = null;
    while (index < lines.length) {
      const current = listLine(lines[index]);
      if (!current) {
        if (!lines[index].trim()) {
          let nextIndex = index + 1;
          while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
          const next = nextIndex < lines.length ? listLine(lines[nextIndex]) : null;
          if (next && next.indent >= baseIndent) { index = nextIndex; continue; }
        }
        break;
      }
      if (current.indent < baseIndent) break;
      if (current.indent > baseIndent) {
        if (lastItem) {
          const [nested, next] = parseList(lines, index);
          lastItem.append(nested);
          index = next;
          continue;
        }
        break;
      }
      if (current.ordered !== ordered) break;
      const item = document.createElement('li');
      let content = current.content;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        const box = document.createElement('span');
        box.className = 'md-task';
        box.textContent = task[1].toLowerCase() === 'x' ? '☑' : '☐';
        item.append(box, document.createTextNode(' '));
        content = task[2];
      }
      item.append(inline(content));
      list.append(item);
      lastItem = item;
      index += 1;
    }
    return [list, index];
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  }

  function delimiterRow(line) {
    if (!line.includes('|')) return null;
    const cells = splitRow(line);
    if (cells.length === 0 || !cells.every(cell => /^:?-+:?$/.test(cell))) return null;
    return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null);
  }

  function appendCell(row, tag, content, align) {
    const cell = document.createElement(tag);
    if (align) cell.style.textAlign = align;
    cell.append(inline(content));
    row.append(cell);
    return cell;
  }

  function renderTable(lines, start, container) {
    const header = splitRow(lines[start]);
    const aligns = delimiterRow(lines[start + 1]);
    if (aligns === null || aligns.length !== header.length) return start;
    const table = document.createElement('table');
    table.className = 'md-table';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    header.forEach((cell, index) => appendCell(headRow, 'th', cell, aligns[index]));
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    let index = start + 2;
    while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
      const cells = splitRow(lines[index]);
      const row = document.createElement('tr');
      for (let column = 0; column < header.length; column += 1) appendCell(row, 'td', cells[column] ?? '', aligns[column]);
      body.append(row);
      index += 1;
    }
    table.append(body);
    container.append(table);
    return index;
  }

  function isFence(line) {
    return /^\s*(```+|~~~+)\s*[\w+#.-]*\s*$/.test(line);
  }

  function blockStart(lines, index) {
    const line = lines[index];
    if (!line.trim()) return true;
    if (isFence(line)) return true;
    if (/^(#{1,6})\s+/.test(line)) return true;
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) return true;
    if (/^\s{0,3}>/.test(line)) return true;
    if (listLine(line)) return true;
    if (line.includes('|') && index + 1 < lines.length && delimiterRow(lines[index + 1]) !== null) return true;
    return false;
  }

  function renderBlocks(lines, container) {
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const length = fence[1].length;
        const language = fence[2];
        const closing = new RegExp(`^\\s*\\${marker}{${length},}\\s*$`);
        const codeLines = [];
        index += 1;
        while (index < lines.length && !closing.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = document.createElement('pre');
        pre.className = 'md-code';
        const code = document.createElement('code');
        if (language && /^[\w+#.-]+$/.test(language)) code.className = `language-${language}`;
        code.textContent = codeLines.join('\n');
        pre.append(code);
        container.append(pre);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        const element = document.createElement(`h${level}`);
        element.append(inline(heading[2]));
        container.append(element);
        index += 1;
        continue;
      }

      if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        container.append(document.createElement('hr'));
        index += 1;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const inner = [];
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
          inner.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
          index += 1;
        }
        const quote = document.createElement('blockquote');
        renderBlocks(inner, quote);
        container.append(quote);
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length && delimiterRow(lines[index + 1]) !== null) {
        index = renderTable(lines, index, container);
        continue;
      }

      if (listLine(line)) {
        const [list, next] = parseList(lines, index);
        container.append(list);
        index = next;
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && !blockStart(lines, index)) {
        paragraph.push(lines[index]);
        index += 1;
      }
      const element = document.createElement('p');
      element.append(inline(paragraph.join('\n')));
      container.append(element);
    }
  }

  function render(source) {
    const fragment = document.createDocumentFragment();
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    renderBlocks(lines, fragment);
    return fragment;
  }

  window.BitoriMarkdown = {render};
})();
