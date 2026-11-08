<!-- --long-write-ok -->
# Icon map: glyphs in public/ to Lucide

Audit of `public/*.js`, `public/index.html` and `public/*.css` (MEASURED, V0 branch start). Each non-ASCII character counted, every occurrence including comments, so counts are upper bounds. Rows are the glyphs used as icons. Phase V5 replaces them; V0 only adds the sprite (`public/index.html`) and `public/icons.js`.

Sprite names that differ from the requested Lucide name: `music` (Lucide 404) uses the file `audio-lines`; `trash-2` (Lucide 404) uses the file `trash`. Names `flower-2`, `chevron-left`, `chevron-up` and `gauge` are not in the 45-icon sprite; V5 adds them where they are used.

| Glyph | Code point | Lucide name | Where (file:line) | Uses |
|---|---|---|---|---|
| ฅ | U+0E05 | cat | index.html:12 (Cats dock) | 4 |
| ✎ | U+270E | message-circle (Chat dock); pencil (elsewhere) | index.html:12; memory-panel.js:197, 405 | 3 |
| ⚑ | U+2691 | flag (Projects dock); flag for Goal in plain-words | index.html:12; plain-words.js:8 | 2 |
| ✦ | U+2726 | **kept**: Mayor's sparkle (not replaced). Non-Mayor uses: sparkles | index.html:4 (Mayor), index.html:12 (Needs you), autonomy-settings.js:78, hologram.js:65, 76 | 7 |
| ❦ | U+2766 | book-open (Diary dock) | index.html:12 | 1 |
| ▤ | U+25A4 | archive (Archive dock) | index.html:12; town.js:103, 724; gallery-view.css:106 | 6 |
| ◈ | U+25C8 | coins (Coins dock, treasury gem) | index.html:4, 12; town.js:392 | 3 |
| ❀ | U+2740 | star (memorial; flower-2 not in sprite) | index.html:12; town.js:98 | 2 |
| ✚ | U+271A | plus (setup) | settings-menu.js:70 | 1 |
| ◐ | U+25D0 | palette (appearance) | settings-menu.js:61 | 1 |
| ◔ | U+25D4 | gauge (usage meter; cpu in sprite) | usage-panel.js:283 | 1 |
| ⌂ | U+2302 | house | settings-menu.js:62; studio.js:121 | 2 |
| ↻ | U+21BB | refresh-cw | routines-panel.js:326, 516 | 2 |
| ♪ | U+266A | music (file audio-lines) | notify.js:263 | 1 |
| ▣ | U+25A3 | image (images); smartphone (devices) | models-panel.js:167; gallery-view.js:6; settings-menu.js:63 | 3 |
| ⛶ | U+26F6 | maximize | index.html:5; settings-menu.js:64 | 2 |
| ☾ | U+263E | moon (memorial) | settings-menu.js:71 | 1 |
| ◎ | U+25CE | cpu (Local AI); globe (worlds) | models-panel.js:157; settings-menu.js:72 | 2 |
| ❖ | U+2756 | bot (ChatGPT plan) | models-panel.js:159 | 1 |
| ⬡ | U+2B21 | key-round (API key) | models-panel.js:160 | 1 |
| ✺ | U+273A | star (Anthropic) | models-panel.js:161 | 1 |
| ✧ | U+2727 | sparkles (Jev) | models-panel.js:162 | 1 |
| ☿ | U+263F | globe (Hermes) | models-panel.js:164 | 1 |
| ⚙ | U+2699 | wrench (Workshop, hologram work) | models-panel.js:165; hologram.js:65 | 2 |
| ☰ | U+2630 | menu | index.html:4 (menu button); remaining uses mostly comments | 58 |
| × | U+00D7 | x | accounts-panel.js:192; cat-settings-flyout.js:40 | 30 |
| ✗ | U+2717 | x (failed status) | season-panel.js:73 | 1 |
| ✓ | U+2713 | check | accounts-panel.js:481; ai-settings.js:37, 45 | 14 |
| ← | U+2190 | arrow-left | accounts-panel.js:191; cat-settings-flyout.js:40; connectors-panel.js:600 | 21 |
| ↗ | U+2197 | external-link | accounts-panel.js:397; connect-flow.js:81 | 19 |
| ＋ | U+FF0B | plus (recruit) | index.html:8 | 1 |
| − | U+2212 | minus (zoom out) | gallery-view.js:216 | 1 |
| ↑ | U+2191 | send (send message) | index.html:10 | 1 |
| ▾ | U+25BE | chevron-down | index.html:10; models-panel.css:38; projects-panel.css:37 | 3 |
| ▸ | U+25B8 | chevron-right | immersive.css:619; projects-panel.css:36 | 2 |
| ▴ | U+25B4 | chevron-up (not in sprite) | models-panel.css:39 | 1 |
| › | U+203A | chevron-right | settings-menu.js:256; studio.js:84; app.js:397 (badge text) | 3 |
| ‹ | U+2039 | chevron-left (not in sprite) | studio.js:84 | 1 |
| ☐ | U+2610 | list-checks (To-do) | plain-words.js:8 | 1 |
| ▶ | U+25B6 | play | gallery-view.js:6 | 1 |
| ⌗ | U+2317 | globe (html kind) | gallery-view.js:6 | 1 |
| ¶ | U+00B6 | book-open (markdown kind) | gallery-view.js:6 | 1 |
| ≡ | U+2261 | pencil (text kind) | gallery-view.js:6 | 1 |
| ◇ | U+25C7 | palette (svg kind); ellipsis (settings fallback); globe (worlds) | gallery-view.js:6; settings-menu.js:253; worlds-panel.js:360 | 3 |
| ⚄ | U+2684 | sparkles (Surprise me) | studio.js:63 | 1 |
| ✉ | U+2709 | inbox (mail, hologram); send (Request, plain-words) | hologram.js:65; plain-words.js:8 | 2 |
| ● | U+25CF | none: status dot, stays a CSS dot | style.css:2; index.html:12 | 2 |

## Not icons, left as text

`·` (middle dot, 149), `…` (ellipsis, 100), `’ “ ” — – •` (typography), `→` (arrow inside sentences such as "from → to", 4), and `••••` masked key digits (model-extras.js:20). `●` stays a CSS dot. Cat-ear avatars and the Mayor's `✦` are kept.

## Decisions for V5

- ✦ stays for the Mayor. Its other uses (Needs you, the idea glyph) are candidates for sparkles.
- Provider marks in models-panel.js (❖ ⬡ ✺ ✧ ☿) are brand-like; V5 decides whether they become icons or stay as marks.
- ◎ and ◇ are reused for different things, so each use needs its own icon, not one glyph-to-icon rule.
