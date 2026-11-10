# Preact, signals and htm, vendored for the thread-view trial (plan 8.6, decision D5)

Plain ES modules with no build step. Each file is the package's published ES module build with two edits:

1. The bare import specifiers point at the sibling files: `"preact"` → `"./preact.js"`, `"preact/hooks"` → `"./hooks.js"`, `"@preact/signals-core"` → `"./signals-core.js"`.
2. The trailing `//# sourceMappingURL=…` comment is dropped, because the source maps are not vendored.

| File here | Package and version (published) | File in the package | sha256 of that file before the edits |
|---|---|---|---|
| `preact.js` | preact 11.0.2 (2026-10-23) | `dist/preact.mjs` | `4d2617f3f082550223d37f781114b5f723362fc4a337459715a7083664dc10c1` |
| `hooks.js` | preact 11.0.2 | `hooks/dist/hooks.mjs` | `6cb79fe9959ad185b8b86134aff47c12fd20216b24837597b19be59a133d9947` |
| `signals-core.js` | @preact/signals-core 1.14.4 (2026-07-07) | `dist/signals-core.mjs` | `0676238240715faeb4eb8b0a329837dc06ef7f37e7103601e13af3ed309c042c` |
| `signals.js` | @preact/signals 2.11.3 (2026-09-30) | `dist/signals.mjs` | `19c5ca080f54f3b36d1b687555dc82c0c8ce29eaedc0ca42b237012892861841` |
| `htm.js` | htm 3.1.1 (2022-04-26) | `dist/htm.mjs` | `ab33dd3f38059b9be4d5f5350128eefb2356639c4e0bbe9d9e8b3ba75847e9e4` |

Every version was published at least two weeks before it was vendored (2026-11-08). @preact/signals 2.11.3 declares `preact >= 10.25.0 || >=11.0.0-0` and `@preact/signals-core ^1.14.4`.

To check a file: `npm pack preact@11.0.2` (and the others), extract the tarball, compare the sha256 above, apply the two edits and diff against this folder.

Licences: `LICENSE-preact` (MIT), `LICENSE-signals` and `LICENSE-signals-core` (MIT), `LICENSE-htm` (Apache-2.0), each copied from its package. See `THIRD_PARTY_NOTICES.md`.
