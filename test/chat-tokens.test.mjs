// Plan 8.11 (Tokens): chat CSS sizes its type from the --text-* scale in style.css :root, with at most 8 distinct font sizes, and
// the two pairs chat-ux §5 found failing (the composer placeholder, the decision strip's cat name) clear 4.5:1 from the token hex.
// "Chat CSS" is chat-sheet.css, chat-composer.css, decision-strip.css, command-palette.css, and the immersive.css rules whose
// selectors name .inspector, #chat, #approvals, #chat-form, .thread-*, .chat-*, .decision-* or .quest-notice.
// Files are read with \r\n folded to \n, so a Windows (CRLF) checkout passes too.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CHAT_FILES = ['chat-sheet.css', 'chat-composer.css', 'decision-strip.css', 'command-palette.css'];
const CHAT_SELECTOR = /\.inspector\b|#chat\b|#approvals\b|#chat-form\b|\.thread-|\.chat-|\.decision-|\.quest-notice\b/;

// Style rules as {selector, body}, walking into @media/@supports and skipping @keyframes, @font-face and @import.
function cssRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  (function block() {
    while (i < src.length) {
      const open = src.indexOf('{', i), close = src.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) { i = close + 1; return; }
      if (open === -1) { i = src.length; return; }
      const head = src.slice(i, open).trim().replace(/^(@[^;{]*;\s*)+/, '');
      i = open + 1;
      if (/^@(media|supports|layer|container)\b/.test(head)) { block(); continue; }
      let depth = 1, j = i;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      if (!head.startsWith('@')) out.push({selector: head, body: src.slice(i, j - 1)});
      i = j;
    }
  })();
  return out;
}

// The size each font-size or font declaration sets, as written; font:inherit and its kin set none.
function fontSizes(body) {
  const sizes = [];
  for (const decl of body.split(';')) {
    const m = decl.match(/^\s*(font-size|font)\s*:\s*([\s\S]+?)\s*(?:!important)?\s*$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === 'font-size') { sizes.push(value); continue; }
    if (/^(inherit|initial|unset|revert)$/.test(value)) continue;
    const size = value.match(/(?:^|\s)(\d*\.?\d+(?:px|r?em|%|vw|vh)|var\(--[a-z0-9-]+\)|(?:clamp|calc|min|max)\([^)]*\))(?=\/|\s)/);
    sizes.push(size ? size[1] : `unparsed: ${value}`);
  }
  return sizes;
}

function chatFontSizes() {
  const found = [];
  for (const file of CHAT_FILES) for (const r of cssRules(read(file))) for (const v of fontSizes(r.body)) found.push({v, where: `${file} ${r.selector}`});
  for (const r of cssRules(read('immersive.css'))) {
    if (!r.selector.split(',').some(s => CHAT_SELECTOR.test(s))) continue;
    for (const v of fontSizes(r.body)) found.push({v, where: `immersive.css ${r.selector}`});
  }
  return found;
}

const rootTokens = () => Object.fromEntries([...read('style.css').match(/:root\{([^}]*--paper:[^}]*)\}/)[1].matchAll(/(--[a-z0-9-]+):([^;]+)/g)].map(m => [m[1], m[2].trim()]));

const channel = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => channel(parseInt(hex.slice(i, i + 2), 16))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('the parser finds the chat rules: the four chat files and the chat part of immersive.css all declare sizes', () => {
  const found = chatFontSizes();
  for (const file of [...CHAT_FILES, 'immersive.css']) assert.ok(found.some(f => f.where.startsWith(`${file} `)), `${file} has sized chat rules`);
  assert.ok(found.some(f => f.where.includes('.immersive .inspector .chat-message .text')), 'the message bubble rule is counted');
  const css = read('immersive.css'), rules = cssRules(css);
  const raw = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?:^|[;{])\s*(?:font-size|font)\s*:/g).length;
  assert.equal(rules.reduce((n, r) => n + (r.body.match(/(?:^|;)\s*(?:font-size|font)\s*:/g) ?? []).length, 0), raw, 'the parser sees every font declaration in immersive.css');
  const outside = rules.filter(r => !r.selector.split(',').some(s => CHAT_SELECTOR.test(s))).flatMap(r => fontSizes(r.body));
  assert.ok(outside.some(v => /px$/.test(v)), 'other panels still size in px, and the chat filter keeps them out of the count');
});

test('every font size in chat CSS is a --text-* step from style.css :root, and there are at most 8 of them', () => {
  const tokens = rootTokens(), found = chatFontSizes();
  const stray = found.filter(f => !/^var\(--text-[a-z]+\)$/.test(f.v) || !tokens[f.v.slice(4, -1)]);
  assert.deepEqual(stray, [], 'no pixel, em or unknown-token font sizes in chat CSS');
  const distinct = new Set(found.map(f => f.v));
  assert.ok(distinct.size <= 8, `${distinct.size} distinct font sizes: ${[...distinct].join(', ')}`);
  const px = new Set([...distinct].map(v => tokens[v.slice(4, -1)]));
  assert.ok(px.size <= 8 && [...px].every(v => /^\d+px$/.test(v) && parseInt(v, 10) >= 12), `the steps resolve to 12px or more: ${[...px].join(', ')}`);
});

test('the composer placeholder and the strip’s cat name clear 4.5:1, computed from the token hex', () => {
  const t = rootTokens();
  assert.match(read('style.css'), /#message::placeholder\{color:var\(--ink-3\)\}/, 'the composer placeholder is --ink-3');
  assert.match(read('decision-strip.css'), /\.is-compact \.decision-question strong\{color:var\(--ink-2\);/, 'the strip’s cat name is --ink-2');
  assert.match(read('decision-strip.css'), /\.decision-card\{[^}]*background:var\(--needs\)/, 'the strip sits on --needs');
  const placeholder = contrast(t['--ink-3'], t['--paper']), catName = contrast(t['--ink-2'], t['--needs']);
  assert.ok(placeholder >= 4.5, `--ink-3 ${t['--ink-3']} on --paper ${t['--paper']} is ${placeholder.toFixed(2)}:1`);
  assert.ok(catName >= 4.5, `--ink-2 ${t['--ink-2']} on --needs ${t['--needs']} is ${catName.toFixed(2)}:1`);
  // chat-ux §5's figures for the old pair colours, so the formula is the one that found them failing.
  assert.equal(contrast('#aaa28e', '#fffef9').toFixed(2), '2.52');
  assert.equal(contrast('#a07c45', '#f6efe1').toFixed(2), '3.36');
});
