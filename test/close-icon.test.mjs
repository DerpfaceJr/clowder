// dialogs.js: the × text in .close-x and .panel-close buttons becomes the sprite's x icon; other buttons and other text stay as they are.
import test from 'node:test';
import assert from 'node:assert/strict';

// icon() (icons.js) builds the svg from the global document; this stand-in records what it is given. No MutationObserver here,
// so dialogs.js does not run its own pass on import.
globalThis.document = {
  createElementNS: (ns, tag) => ({ns, tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }}),
};
const {upgradeCloseButtons} = await import('../public/dialogs.js');

const button = (className, text) => ({
  className, children: [text], textContent: text, attrs: {'aria-label': 'Close'},
  matches(sel) { return sel.split(',').some(s => className.split(' ').includes(s.trim().slice(1))); },
  replaceChildren(...c) { this.children = c; this.textContent = ''; },
});

test('a close button with × gets the sprite x; its label and other buttons stay', () => {
  const close = button('close-x desk-only', '×'), panel = button('panel-close', ' × '), back = button('close-x', '← Town');
  upgradeCloseButtons({querySelectorAll: () => [close, panel, back]});
  for (const b of [close, panel]) {
    const [svg] = b.children;
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attrs['aria-hidden'], 'true', 'decorative: the button keeps its aria-label');
    assert.equal(svg.children[0].attrs.href, '#i-x');
    assert.equal(b.attrs['aria-label'], 'Close');
  }
  assert.deepEqual(back.children, ['← Town'], 'text that is not × is left alone');
});

test('the root itself is upgraded when it is a close button', () => {
  const close = button('close-x', '×');
  upgradeCloseButtons(Object.assign(close, {querySelectorAll: () => []}));
  assert.equal(close.children[0].tag, 'svg');
});
