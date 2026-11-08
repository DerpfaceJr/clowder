// The empty-state grammar (premium visual plan §6): a 48px picture, one plain sentence and at most one action.
// The picture is the cat-ear tile of the avatars (style.css .avatar) with one Lucide icon from the sprite (icons.js) on it.
import {icon} from './icons.js';
import {ensureStyles} from './owner-dialog.js';

const NS = 'http://www.w3.org/2000/svg';
// Two ears, then the rounded tile over their bases: the avatar's shape at 48px.
const TILE = [
  ['path', {class: 'empty-ear', d: 'M9 19 11.5 6 21 14Z'}],
  ['path', {class: 'empty-ear', d: 'M39 19 36.5 6 27 14Z'}],
  ['rect', {class: 'empty-tile', x: 6, y: 11, width: 36, height: 33, rx: 11}],
];

/** {icon, text, action}: icon is a sprite name, action an optional button the panel wires itself. */
export function emptyState(doc, {icon: name, text, action = null}) {
  ensureStyles(doc, 'empty-state.css', 'empty-state');
  const art = doc.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({class: 'empty-art', viewBox: '0 0 48 48', width: 48, height: 48, 'aria-hidden': 'true', focusable: 'false'})) art.setAttribute(k, String(v));
  for (const [tag, attrs] of TILE) {
    const part = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) part.setAttribute(k, String(v));
    art.append(part);
  }
  const glyph = icon(name, {size: 22});
  glyph.setAttribute('x', '13');
  glyph.setAttribute('y', '17');
  glyph.setAttribute('class', 'empty-icon');
  art.append(glyph);
  const box = doc.createElement('div');
  box.className = 'empty-state';
  const line = doc.createElement('p');
  line.textContent = text;
  box.append(art, line);
  if (action) box.append(action);
  return box;
}
