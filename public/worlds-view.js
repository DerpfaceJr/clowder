// Pure helpers for the Worlds dialog. No DOM here, so test/worlds-ui.test.mjs can import them.

// FNV-1a over the id: the same id always gives the same colours and house layout.
export function hashId(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const HOUSES_PER_ROW = 10;
const MAX_HOUSES = 30;

// The colours a world wears wherever it is drawn (its card thumbnail, its planet in world-travel.js), all from the id.
// The sun is always a warm gold, whatever the hue, so every card has the same late-afternoon light.
export function worldPalette(id) {
  const h = hashId(id), hue = h % 360;
  return {
    hash: h,
    sky: `hsl(${hue} 45% 92%)`,
    sun: `hsl(${32 + (h >>> 16) % 18} 90% 80%)`,
    hills: `hsl(${(hue + 80) % 360} 30% 78%)`,
    ground: `hsl(${(hue + 120) % 360} 28% 70%)`,
    walls: `hsl(${(hue + 40) % 360} 35% 92%)`,
    roof: `hsl(${(hue + 20) % 360} 45% 45%)`,
  };
}

// What a card is painted over when the town's own colours are not at hand: the meadow and water the planet falls back to
// (world-travel.js) and the clear-day sky (weather.js). A town's palette() ({terrain, water, sky} as hex) can stand in for them.
export const TOWN_COLOURS = {terrain: '#93b672', water: '#7fb6c9', sky: '#cbdcc0'};

// A small illustrated card in the planet's recipe: the town's meadow, water and sky under the world's tint, a warm sky gradient
// with the sun's glow, a soft far hill, and one little house with a lit window per cat, in rows on the near meadow.
// The SVG holds only numbers derived from the id and the cat count, never the name, so it is safe as an <img> source.
export function worldThumbnail(id, cats, town = TOWN_COLOURS) {
  const p = worldPalette(id), h = p.hash, t = {...TOWN_COLOURS, ...town};
  const count = Math.max(0, Math.floor(Number(cats) || 0));
  const shown = Math.min(count, MAX_HOUSES);
  const [sx, sy] = [44 + (h % 150), 30 + ((h >>> 8) % 14)];
  // Rows of up to ten, centred; row 0 is the front. The back row is drawn first so nearer roofs overlap farther ones.
  const houses = [];
  for (let row = Math.ceil(shown / HOUSES_PER_ROW) - 1; row >= 0; row--) {
    const inRow = Math.min(HOUSES_PER_ROW, shown - row * HOUSES_PER_ROW);
    for (let col = 0; col < inRow; col++) {
      const i = row * HOUSES_PER_ROW + col;
      const jitter = ((h >>> ((i % 8) * 3)) & 3) - 1;
      const x = 124.5 - inRow * 10.5 + col * 21 + (row % 2) * 5;
      const y = 131 - row * 12 + jitter;
      houses.push(
        `<rect x="${x}" y="${y - 9}" width="12" height="9" fill="${p.walls}"/>` +
        `<polygon points="${x - 2},${y - 9} ${x + 6},${y - 16} ${x + 14},${y - 9}" fill="${p.roof}"/>` +
        `<rect x="${x + 4.5}" y="${y - 6.5}" width="3" height="3" fill="${p.sun}"/>`,
      );
    }
  }
  const more = count > shown ? `<text x="234" y="18" text-anchor="end" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#4b473d">+${count - shown}</text>` : '';
  const meadow = 'M0 108 C46 96 92 98 130 104 S200 100 240 106 V150 H0Z';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 150">',
    '<defs>',
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.sky}"/><stop offset="1" stop-color="${p.sun}"/></linearGradient>`,
    `<radialGradient id="glow"><stop offset="0" stop-color="${p.sun}"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/></radialGradient>`,
    '</defs>',
    '<rect width="240" height="150" fill="url(#sky)"/>',
    `<rect width="240" height="110" fill="${p.sky}" opacity=".35"/>`,
    `<circle cx="${sx}" cy="${sy}" r="30" fill="url(#glow)"/>`,
    `<circle cx="${sx}" cy="${sy}" r="10" fill="${p.sun}"/>`,
    `<path d="M0 86 C34 70 70 70 104 80 S168 66 240 76 V150 H0Z" fill="${p.hills}"/>`,
    `<path d="${meadow}" fill="${t.terrain}"/>`,
    `<path d="${meadow}" fill="${p.ground}" opacity=".25"/>`,
    `<ellipse cx="${200 - (h >>> 4) % 40}" cy="141" rx="24" ry="4.5" fill="${t.water}"/>`,
    ...houses,
    more,
    '</svg>',
  ].join('');
}

export function thumbnailUrl(id, cats, town) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(worldThumbnail(id, cats, town))}`;
}

// The delete button unlocks only when the owner types the world's exact name. Both sides are NFC-normalised and trimmed; the match is case-sensitive.
export function canDelete(typed, name) {
  if (typeof typed !== 'string' || typeof name !== 'string' || !name) return false;
  return typed.normalize('NFC').trim() === name.normalize('NFC').trim();
}

export function catLabel(cats) {
  if (cats === undefined) return '';
  return cats === 1 ? '1 cat' : `${cats} cats`;
}
