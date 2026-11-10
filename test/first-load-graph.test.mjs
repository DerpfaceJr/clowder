import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(file, 'utf8');
// Static imports and re-exports only: "import x from", "import 'x'", "export ... from". Dynamic import(...) is left out on purpose.
const specs = src => [...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]|^\s*(?:import|export)\b[^'"`;(]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(m => m[1] ?? m[2]);

test('the first page load (public/app.js and its static imports) never reaches three.js', () => {
  const start = join(root, 'public', 'app.js');
  const parent = new Map([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    for (const spec of specs(read(file))) {
      if (spec === 'three' || spec.startsWith('three/')) {
        const chain = [];
        for (let f = file; f; f = parent.get(f)) chain.unshift(relative(root, f));
        assert.fail(`${chain.join(' -> ')} imports ${spec}`);
      }
      if (!spec.startsWith('.')) continue;
      const next = resolve(dirname(file), spec);
      if (!parent.has(next)) { parent.set(next, file); queue.push(next); }
    }
  }
});

test('no server module (src/*.ts) imports the hologram or memorial browser code', () => {
  const srcDir = join(root, 'src');
  for (const name of readdirSync(srcDir).filter(n => n.endsWith('.ts'))) {
    const bad = specs(read(join(srcDir, name))).filter(s => /public\/(hologram|memorial)\.js$/.test(s));
    assert.deepEqual(bad, [], `src/${name} imports ${bad.join(', ')}`);
  }
});
