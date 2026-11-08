// Stages what the installer ships for Hermes (plan 4.13): uv.exe, checksum-verified, and the Hermes source at a pinned tag whose commit is
// verified, with tests and docs pruned. Output: hermes-runtime/ at the repo root (gitignored), packaged with the app; src/hermes-bootstrap.ts
// copies the source into the data folder and builds Python and the venv there on first enable. Run by desktop:build before electron-builder.
// A finished hermes-runtime/ whose runtime.json matches the pins is kept, so a rebuild needs no network.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

// uv 0.12.24 (published 2026-10-08). The hash is the release's .sha256 file and GitHub's asset digest, which agree.
export const UV={version:'0.12.24',url:'https://github.com/astral-sh/uv/releases/download/0.12.24/uv-x86_64-pc-windows-msvc.zip',sha256:'7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019'};
// The spike's pin (docs/research/hermes-spike.md S1): tag v0.22.5 is this commit.
export const HERMES={repo:'https://github.com/NousResearch/hermes-agent.git',tag:'v0.22.5',commit:'bf0203a794a07aac3ff764972ab9087baa4e4f4e'};
// Tests, docs and Hermes's own desktop app and installer sources (apps/: 46 MB, 4,361 files; only its desktop and update commands read it) go.
// The rest stays: Hermes resolves locales, skills, plugins and web assets from the checkout layout at runtime (its setup.py).
export const PRUNE=['.git','.github','tests','tests-js','website','apps'];

const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
/** Throws, and deletes the file, unless its sha256 is the pinned one. */
export function verifySha256(file,expected){
  const got=sha256(file);
  if(got!==expected.toLowerCase()){rmSync(file,{force:true});throw new Error(`${basename(file)} has sha256 ${got}, expected ${expected}: refused and deleted.`);}
}
/** Throws unless the checkout is the pinned commit. */
export function verifyCommit(dir,expected){
  const got=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(got!==expected)throw new Error(`Hermes ${HERMES.tag} is commit ${got}, expected ${expected}: refused.`);
}

export async function stage(out){
  // A change to any pin restages, and the bootstrap redoes its setup for the new stamp.
  const stamp={uv:UV.version,uvSha256:UV.sha256,hermes:HERMES.tag,commit:HERMES.commit,prune:PRUNE};
  const file=join(out,'runtime.json');
  try{if(JSON.stringify(JSON.parse(readFileSync(file,'utf8')))===JSON.stringify(stamp)&&existsSync(join(out,'uv.exe'))&&existsSync(join(out,'src','uv.lock'))){console.log(`hermes-runtime: kept (uv ${UV.version}, Hermes ${HERMES.tag})`);return;}}catch{/* stage it */}
  // Next to the output, so the final rename never crosses volumes.
  const work=mkdtempSync(join(dirname(out),'.hermes-runtime-'));
  try{
    const zip=join(work,'uv.zip');
    const r=await fetch(UV.url);if(!r.ok)throw new Error(`uv download: HTTP ${r.status}`);
    writeFileSync(zip,Buffer.from(await r.arrayBuffer()));
    verifySha256(zip,UV.sha256);
    mkdirSync(join(work,'uv'));
    // Windows' own bsdtar reads zip; Git's tar on PATH does not.
    execFileSync(join(process.env.SystemRoot??'C:\\Windows','System32','tar.exe'),['-xf',zip,'-C',join(work,'uv')],{stdio:'inherit'});
    execFileSync('git',['-c','advice.detachedHead=false','-c','core.autocrlf=false','-c','core.longpaths=true','clone','--quiet','--depth','1','--branch',HERMES.tag,HERMES.repo,join(work,'src')],{stdio:'inherit'});
    verifyCommit(join(work,'src'),HERMES.commit);
    for(const p of PRUNE)rmSync(join(work,'src',p),{recursive:true,force:true});
    rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
    copyFileSync(join(work,'uv','uv.exe'),join(out,'uv.exe'));
    renameSync(join(work,'src'),join(out,'src'));
    writeFileSync(file,JSON.stringify(stamp)+'\n');
    console.log(`hermes-runtime: staged uv ${UV.version} and Hermes ${HERMES.tag} (${HERMES.commit.slice(0,7)})`);
  }finally{rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await stage(fileURLToPath(new URL('../hermes-runtime/',import.meta.url)));
