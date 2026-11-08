// Lucide icons from the inline sprite in index.html (symbols named i-<name>). Returns an SVG element.
// Decorative when there is no label; otherwise an image with that label.
const NS = 'http://www.w3.org/2000/svg';

export function icon(name, {size = 20, label} = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
