// Builds an owner-only preview of the site as one self-contained HTML file (preview/index.html):
// the engine runs in the page and nothing is saved. Run: npm run preview:build
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, VITE_LOCAL_ENGINE: '1' }
});

const out = join(root, 'dist-preview');
const html = readFileSync(join(out, 'index.html'), 'utf8');
const jsPath = html.match(/<script type="module" crossorigin src="\/([^"]+)"><\/script>/)[1];
const cssPath = html.match(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/)[1];
const title = html.match(/<title>.*?<\/title>/)[0];
// The artifact host adds its own doctype, charset and viewport; keep the title first, then fonts, styles and the app.
const fonts = [...html.matchAll(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts[^>]*>/g)].map(m => m[0]).join('\n');
const icon = html.match(/<link rel="icon"[^>]*>/)?.[0] ?? '';
const css = readFileSync(join(out, cssPath), 'utf8');
const js = readFileSync(join(out, jsPath), 'utf8').replace(/<\/script/gi, '<\\/script');
const page = `${title}\n${icon}\n${fonts}\n<style>${css}</style>\n<div id="root"></div>\n<script type="module">${js}</script>\n`;

mkdirSync(join(root, 'preview'), { recursive: true });
writeFileSync(join(root, 'preview/index.html'), page);
console.log(`Wrote preview/index.html (${Math.round(page.length / 1024)} KB)`);
