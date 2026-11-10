# Third-party notices

Cat Town itself is released under the MIT licence (see [LICENSE](LICENSE)). The components below are used by, or were adapted into, this project. Licences were read from each package's own `package.json` and `LICENSE` file in `node_modules/`, or from the upstream repository for Hamlet.

## Hamlet (layout and terrain reimplemented)

- Source: https://github.com/voxell-tech/hamlet (tag v0.0.1)
- Licence: MIT OR Apache-2.0 (`workspace.package.license` in its `Cargo.toml`; the repository provides `LICENSE-MIT` and `LICENSE-APACHE`).
- Use: `public/hamlet-layout.js` and `public/terrain.js` are JavaScript reimplementations of Hamlet's layout and terrain algorithms, and reuse its constants through `world.layout` in `town.config.json`. See [docs/layout-spec.md](docs/layout-spec.md).
- Copyright holder: UNRESOLVED. The `LICENSE-MIT` file at v0.0.1 contains no copyright line.

## three.js

- Version 0.186.1, MIT.
- Copyright © 2010-2026 three.js authors.

## Fastify and @fastify/static

- `fastify` 5.12.7, MIT. Copyright (c) 2016-present The Fastify team.
- `@fastify/static` 10.1.10, MIT. Copyright (c) 2017-present The Fastify team.

## tsx

- Version 4.23.15, MIT.
- Copyright (c) Hiroki Osame.

## croner

- Version 10.0.1, MIT. Used by the routines engine for schedules.
- Copyright (c) 2015-2021 Hexagon <github.com/Hexagon>.

## qrcode-generator

- Version 1.4.4, MIT. Draws the pairing link's QR code (`src/setup-routes.ts`).
- Copyright (c) 2009 Kazuhiko Arase.

## Preact, @preact/signals and htm

- `preact` 11.0.2, MIT. Copyright (c) 2015-present Jason Miller. Draws the chat's thread view (`public/chat-thread.js`, plan 8.6).
- `@preact/signals` 2.11.3 and `@preact/signals-core` 1.14.4, MIT. Copyright (c) 2022-present Preact Team. The working line's clock in the thread view.
- `htm` 3.1.1, Apache-2.0. Copyright 2018 Google Inc. The thread view's markup as tagged templates, so there is no build step.
- Vendored as plain ES modules in `public/vendor/preact/`, each package's licence text beside them. `public/vendor/preact/README.md` lists the source files with their sha256 and the two edits made to them (import paths, source map comment).

## @playwright/mcp

- Version 0.0.83, Apache-2.0. Used by the cats' browser, which runs it as a child process.
- Copyright (c) Microsoft Corporation. The licence text is in its `LICENSE` file.

## Electron

- Version 45.0.0, MIT. Shipped inside the Clowder desktop installer, built with electron-builder.
- Copyright (c) Electron contributors. Chromium and the other components Electron bundles carry their own licences, listed in `LICENSES.chromium.html` in the Electron package.

## Adobe Mixamo animation data

- `public/assets/cat-motions.json` holds joint-angle curves baked by `scripts/bake-mixamo.mjs` from Adobe Mixamo animations. It is derived data, not the source files. The raw Mixamo FBX files are not included in this repository. Sources are listed in [public/assets/ANIMATION-SOURCES.md](public/assets/ANIMATION-SOURCES.md).
- Mixamo is an Adobe service and its terms govern the source animations. Our understanding, which is not legal advice, is that the terms allow use of the animations in projects but do not allow the raw files to be redistributed on their own. Check Adobe's current terms before redistributing this data or any derivative: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
- Cat Town is not affiliated with or endorsed by Adobe.

## Fraunces (display font)

- `public/fonts/fraunces-latin-full-normal.woff2`: the Latin subset of Fraunces, variable, all axes including SOFT. Source: `@fontsource-variable/fraunces` 5.3.0 (Google Fonts, Fraunces Project Authors).
- Licence: SIL Open Font License 1.1. The licence text is in [public/fonts/OFL-Fraunces.txt](public/fonts/OFL-Fraunces.txt).
- Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces).

## Figtree (interface font)

- `public/fonts/figtree-latin-wght-normal.woff2`: the Latin subset of Figtree, variable (weight axis). Source: `@fontsource-variable/figtree` 5.3.0 (Google Fonts, Figtree Project Authors).
- Licence: SIL Open Font License 1.1. The licence text is in [public/fonts/OFL-Figtree.txt](public/fonts/OFL-Figtree.txt).
- Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree).

## Lucide (icon sprite)

- The 45 icons in the `<symbol>` sprite at the top of `public/index.html`, drawn by `public/icons.js` through `icon()`. Source: https://github.com/lucide-icons/lucide, fetched from the `main` branch. `music` is taken from the file `audio-lines` and `trash-2` from `trash`, because those Lucide names no longer resolve.
- Licence: ISC, Copyright (c) 2026 Lucide Icons and Contributors. Icons derived from the Feather project (for example `arrow-left`, `check`, `chevron-right`, `external-link`, `maximize`, `minus`, `moon`, `plus`, `search`, `smartphone`, `trash`, `x`) are also under the MIT licence, Copyright (c) 2013-present Cole Bemis. The licence text is in the Lucide repository's `LICENSE` file.
