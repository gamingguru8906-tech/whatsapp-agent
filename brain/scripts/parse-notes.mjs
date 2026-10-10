// Reads a book-notes markdown file and returns every table row under its section heading, with named columns.
import { readFileSync } from 'node:fs';
export function parseNotes(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  let h2 = '', h3 = '', h4 = '', header = null;
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(x => x.trim());
  for (const l of lines) {
    if (l.startsWith('## ')) { h2 = l.slice(3); h3 = h4 = ''; header = null; continue; }
    if (l.startsWith('### ')) { h3 = l.slice(4); h4 = ''; header = null; continue; }
    if (l.startsWith('#### ')) { h4 = l.slice(5); header = null; continue; }
    if (!l.trim().startsWith('|')) { header = null; continue; }
    const c = cells(l);
    if (!header) { header = c.map(x => x.toLowerCase()); continue; }
    if (c.every(x => /^:?-+:?$/.test(x))) continue;
    const row = { section: h3, sub: h4, h2 };
    header.forEach((k, i) => { row[k] = c[i] ?? ''; });
    out.push(row);
  }
  return out;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[2]) {
  const rows = parseNotes(process.argv[2]);
  const by = {};
  for (const r of rows) (by[r.section] ??= []).push(r);
  for (const [s, rs] of Object.entries(by)) console.log(rs.length.toString().padStart(4), s, '|', Object.keys(rs[0]).filter(k => !['section','sub','h2'].includes(k)).join(','));
}
