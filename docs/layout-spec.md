# Hamlets: layout spec

Source: voxell-tech/hamlet (MIT OR Apache-2.0). Constants: `world.layout` in `town.config.json`, multiplied by `scale` (1.2). Geometry: only `public/hamlet-layout.js`.

## Groups

- `main` sits at the centre (site 0). Its hall is the Mayor's home. Founders and owner recruits join `main`.
- A model recruit (`create_cat`) joins the group of its ROOT task. The first recruit is the lead and takes the hall. Later recruits join while the group has a free plot.
- A full group spills into an overflow group for the same root, or for the role when there is no root.
- Name: `oneLiner(root task text, 28)`.
- Persisted: `group.founded {id,name,lead,site,rootTask}`; cats carry `group`; homes carry `plot`.

## Sites

- Groups outside main are called nooks in the UI.
- The Mayor's square (site 0) is `main_plaza` 10.8 in radius, twice a nook's `plaza_radius` 5.4. Its first plot ring, ring street and furniture move out to match. The Mayor's house stands inside the square at its back, a fountain stands in the middle, and the ring street is a closed loop.
- Every house faces its plaza's centre; the Archive board faces it too.
- Rings round the town centre: ring k holds 6k sites at radius k × `site_spacing` 33.5, no jitter. A ring fills in opposite pairs.
- Plot caps: main `main_radius` 22, nooks `plot_radius` 18. A nook's inward plots fall in the Mayor's circle (main's reach) and stay empty; nook homes fill the outward side.
- A new nook takes the lowest free site at least `keep_apart` 24 from every other nook, with its common clear of main's reach and the memorial reserve.
- Spokes: when a square opens, a paved avenue leaves its ring toward each child slot (the next ring's slots nearest it), out to the edge of its homes, before those homes are placed. An avenue to a slot nobody has taken is reserved (homes keep off it) but not drawn or walked. A nook's lane joins its gate to the spoke's end, so every road branches from the Mayor's square. Lanes bow in a seeded, gentle S that fades at both ends.
- Layout upgrades (v3–v5) keep every cat in its group and re-seat the town: homes take their plot's spot round their site, nooks move to the lowest free nearer site, and manual homes stay unless the bigger square covers them.

## Plots

- Hall: local (0, -`hall_out` 5.2), facing the centre.
- Plot k ≥ 1: r = sqrt(`first_ring`² + (k-1)·`plot_area`/τ·2), θ = (k-1)·2.399963 + 0.6, jitter ±0.45 per axis. `first_ring` 10.5, `plot_area` 46, `plots` 37, `plot_radius` 27.
- The lowest free plot wins. Homes never move. A retired cat frees its plot; a returning cat regains it if free.
- Doors face the hall within ±0.3 rad, seeded.
- Plaza radius 5.4: stone-paved, with lamp, bench and notice board. Hall yards are paved too.
- Road lamps every `lamp_spacing` 7.5 (scaled), alternating sides, plus one by each door; never by a house or on a plaza.

## Clearances

- Houses at least 2·`house_radius` apart. `house_radius` is 3.4: measured house and garden art reaches 3.39.
- Houses stay `plaza_radius` + `house_radius` from plaza centres.
- Memorial: a reserved disc.
- Owner moves obey these rules and set `manual=true`.

## Terrain and water

- `public/terrain.js` (+ `.d.ts`), parameters in `world.layout.terrain` (metres, unscaled): seeded value-noise hills, a floor above the water, two meandering rivers flanking the centre (never within `river_clear` 56 of it).
- Dry (Hamlet rule): land stands `dry_margin` 0.7 above `water_y` at the centre and ±`dry_probe` 3 m. Wet plots are not free; owner moves onto wet ground are refused.
- A site is used only when its centre is dry and its whole common (`plot_radius` + `house_radius`) clears the rivers; wet sites are skipped and the next site is taken.
- The client holds each common, plot and the memorial level (`heldGround`) and lays bridge decks where roads cross water (`findBridges`, `roadHeight`).

## Roads

- One network per town, built in journal order (cats order), so adding a home never moves an existing road.
- Each plaza has a ring street at `plaza_radius` + 0.6·`road_clearance`, open where the hall stands and pushed off every potential plot. The ring is paved as part of the common; the hall opens straight onto its plaza.
- A home's stem runs from its door past the garden to the nearest point of any street, which is split there (T-junction, snapped to a vertex within 1.6·`half_width_local`). It bends around the homes and plazas that existed when it was laid.
- A hamlet, when its first home appears, gets one road from its ring gate nearest the centre to the nearest street of the town as it stood.
- A plot is free only if its house clears every existing road by `house_radius`, so later homes never land on roads.
- Half-widths: streets 0.72 cobbled, between hamlets 0.98 earth. Junction caps are drawn where streets of one kind meet.
- Lamps every `lamp_spacing` along every road, alternating sides, plus one by each door; never by a house or on a plaza.

## Walking

Visits walk door to door along the network (shortest path over the road graph).

## Migration

`layoutVersion` becomes 2. Old towns replan once. Styles, looks and manual homes are kept. Other cats move into `main`. Memorial moves into `world.layout`; grid `districts` and `plotSpacing` go.

## Tests

Determinism; spacing; roads outside plazas; no road through a house; no overlapping road ribbons except within 3 m of a junction; every door reachable; adding a home keeps every road point; sites apart; wet sites skipped; no home moves on recruit; root-task grouping; memorial reserve.
