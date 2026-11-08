# Cat kit (`public/assets/cat-kit.glb`)

Style target: `mayor.glb` (see `mayor-match.png`).

## Building and checking

1. Measure: `blender -b --factory-startup --python scripts/blender/measure_mayor.py` writes `mayor-measure.json` (the Mayor's shape, paint, limbs, face, materials).
2. Build and render: `blender -b --factory-startup --python scripts/blender/build_cat_kit.py -- --render docs/cat-kit`
3. Check: `node scripts/blender/validate_kit.mjs`

## Bases
- **Bean** is the Mayor's body.
- **Puff** is the Mayor's body 1.1× wider, with cheek fluff.
- **Sprout** is the Mayor's body 1.2× taller, pear-shaped.

Modelled at the Mayor's native size; the game shows every cat at 1.75/1.915, like the Mayor, never bbox-normalised.

## Nodes
- `cat_rig__<base>`: one rig per base, the Mayor's bone names, joints placed for that base. It holds `base_<base>`, `face__<base>` and `socket_head|face|neck|back|hip`.
- `part_<name>__<base>`: at the scene root; origin = its socket.

GLTFLoader numbers repeated names; `cloneBase()` in `public/world-art.js` strips them from bones and sockets, so `bindMayor` and the clips work unchanged.

## Parts and sockets
| Socket | Parts |
|---|---|
| head | wizard_hat, crown, flower_crown, knit_beanie, straw_hat, chef_hat |
| face | spectacles, sunglasses, monocle |
| neck | cape, neck_bow, knit_scarf, bell_collar, bandana |
| back | satchel, backpack, fairy_wings |
| hip | apron, waistcoat, tutu |

A cat wears at most one part per socket. Ids and labels live in `world-catalog.json` → `kit.parts`.

- Head parts sit inside the ears: anything hugging the head stays above crown−0.035; brims reach the wizard hat's 0.37 at most.
- The build prints a `FIT` line per part and base: vertices buried in the torso, and the gap to the nearest ear vertex.
- `parts.png` shows every part; `outfits.png` and `outfits-back.png` show the second wardrobe on all three bases.
- `--only parts` renders just those three sheets.
- After a rebuild, bump `?v=` on the kit URL in `public/town.js`. The service worker serves `/assets` stale-while-revalidate, and a part missing from a cached kit is skipped.

## Morphs
`Blink_L`, `Blink_R`, `MouthOpen`, `Happy`, `Curious`, `Sleepy`.

## Markings
- `_mask`:
  - R: tuxedo patch.
  - G: the Mayor's tabby ovals.
  - B: the Mayor's cream muzzle and belly.
  - A: pink pads and inner ear.
- `_spot`: calico spots.

`furMaterial()` mixes them with per-cat uniforms (one shader program).

## Materials
- Body: `fur`.
- Face: `eye`, `eye_highlight`, `mouth`, `pink`, `nose`, `blush`, `line`.
- Parts: `cloth`, `trim`, `metal`, `leather`. In game, `cloth` takes the outfit colour (or the look key named by the part's catalog `cloth`) and `trim` the trim colour. `metal` and `leather` keep the colours set in `PARTS`.

## Allowed values
`world-catalog.json` → `kit`: allowed values, role looks, palettes.
