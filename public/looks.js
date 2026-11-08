// Look generators, shared by the server (generateLook in src/world.ts) and the Studio's Surprise me. Pure: the caller passes the
// random source, and every colour comes from the kit's palettes, so any roll is coherent. The draw order is fixed, because a
// seeded look must stay byte-identical (test/fixtures/looks-before.json).
export const mixHex = (a, b, t, shade = 1) => '#' + [1, 3, 5].map(i => Math.round(Math.min(255, (parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t) * shade)).toString(16).padStart(2, '0')).join('');
export const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

/** One part per socket, chosen by chance per socket; never an empty wardrobe. */
export function randomParts(rnd, kit) {
  const bySocket = s => Object.keys(kit.parts).filter(p => kit.parts[p].socket === s), odds = {head: .3, face: .3, neck: .55, back: .3, hip: .55};
  const parts = kit.sockets.flatMap(s => rnd() < (odds[s] ?? .3) ? [pick(rnd, bySocket(s))] : []);
  return parts.length ? parts : [pick(rnd, bySocket('neck'))];
}

// The house core: a roof tinted from the style's roof and the cat's outfit, walls and timber from the palettes.
const houseCore = (rnd, kit, design, outfit) => ({roof: mixHex(design.roof, outfit, .4, .9 + rnd() * .16), wall: pick(rnd, kit.palettes.wall), trim: pick(rnd, kit.palettes.timber)});

/** The generated look: body, markings, costume and palette, then the house tint. costume (the role's parts) draws nothing; absent, a seeded costume. */
export function randomLook(rnd, kit, designs, style, costume) {
  const P = kit.palettes;
  const look = {base: pick(rnd, kit.bases), marking: pick(rnd, kit.markings), parts: costume ? [...costume] : randomParts(rnd, kit), expression: 'neutral',
    fur: pick(rnd, P.fur), patch: pick(rnd, P.patch), cream: pick(rnd, P.cream), outfit: pick(rnd, P.outfit), trim: pick(rnd, P.trim), eyes: pick(rnd, P.eyes)};
  look.house = houseCore(rnd, kit, designs[style] || designs.builder, look.outfit);
  return look;
}

/** A house on its own: the core look, a door from the outfit palette, and each decor piece by chance. */
export function randomHouseLook(rnd, kit, designs, style, houseDecor = []) {
  const core = houseCore(rnd, kit, designs[style] || designs.builder, pick(rnd, kit.palettes.outfit));
  return {...core, door: pick(rnd, kit.palettes.outfit), decor: houseDecor.filter(() => rnd() < .35).map(d => d.id)};
}
