// Writes build-info.json with the commit being packaged, so a packaged app (which has no .git) can show it. Run before electron-builder.
// release: true only under CLOWDER_RELEASE=1, which only .github/workflows/release.yml sets; desktop/main.cjs runs the updater only then (plan 7.10).
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
let commit=null;
try{commit=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||null;}catch{/* no git: the stamp says so and the app shows no commit */}
const release=process.env.CLOWDER_RELEASE==='1';
// A release without a commit would skip the new build's pre-upgrade snapshot (plan 7.1), so it does not build at all.
if(release&&!commit){console.error('build-info.json: a release build needs a git commit.');process.exit(1);}
writeFileSync(join(root,'build-info.json'),JSON.stringify({commit,builtAt:new Date().toISOString(),...(release?{release:true}:{})},null,2)+'\n');
console.log(`build-info.json: ${commit??'no git commit'}${release?', release':''}`);
