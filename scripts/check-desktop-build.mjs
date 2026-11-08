// Checks what electron-builder left in dist-desktop (plans 7.9 and 7.10). latest.yml must name the installer that was built, its .blockmap must
// exist, and build-info.json must carry the commit (the new build's pre-upgrade snapshot keys on it, plan 7.1).
//   --release: the update marker and app-update.yml's publisherName must be there (the release workflow)
//   default:   the update marker must not be there (a local build never checks for updates)
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=join(root,'dist-desktop'),release=process.argv.includes('--release');
const {version}=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const fail=msg=>{console.error(`check-desktop-build: ${msg}`);process.exit(1);};

const installer=`Clowder-Setup-${version}.exe`;
const exes=readdirSync(out).filter(f=>f.endsWith('.exe'));
if(!exes.includes(installer))fail(`no ${installer} in dist-desktop (found ${exes.join(', ')||'none'})`);
const latest=readFileSync(join(out,'latest.yml'),'utf8');
const named=[...latest.matchAll(/^\s*(?:-\s*url|path):\s*(.+?)\s*$/gm)].map(m=>m[1]);
if(!named.length||named.some(n=>n!==installer))fail(`latest.yml names ${named.join(', ')||'nothing'}, the installer is ${installer}`);
if(!new RegExp(`^version: ${version.replace(/\./g,'\\.')}\\s*$`,'m').test(latest))fail(`latest.yml is not version ${version}`);
if(!existsSync(join(out,`${installer}.blockmap`)))fail(`no ${installer}.blockmap`);

const resources=join(out,'win-unpacked','resources');
const info=JSON.parse(readFileSync(join(resources,'app','build-info.json'),'utf8'));
if(!info.commit)fail('build-info.json has no commit');
const updateYml=join(resources,'app-update.yml');
const publisher=existsSync(updateYml)&&/^publisherName:/m.test(readFileSync(updateYml,'utf8'));
if(release&&info.release!==true)fail('build-info.json has no release marker');
if(release&&!publisher)fail('app-update.yml names no publisherName, so the updater could not check a signature');
if(!release&&'release' in info)fail('a local build carries the release marker');

const size=f=>statSync(join(out,f)).size;
console.log(`${installer} ${size(installer)} B, .blockmap ${size(`${installer}.blockmap`)} B, latest.yml ${size('latest.yml')} B; commit ${info.commit}; `
  +`release marker ${info.release===true?'yes':'no'}; app-update.yml ${existsSync(updateYml)?(publisher?'with publisherName':'without publisherName'):'absent'}`);
