// The release workflow's first step (plan 7.9): the pushed tag must be v plus package.json's version, or the build stops here.
// A tag that disagrees would publish a latest.yml whose version the updater never sees as new.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const tagMatches=(tag,version)=>typeof tag==='string'&&typeof version==='string'&&version!==''&&tag===`v${version}`;

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const {version}=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const tag=process.env.GITHUB_REF_NAME;
  if(!tagMatches(tag,version)){console.error(`Tag ${tag??'(none)'} does not match package.json version ${version}: expected v${version}.`);process.exit(1);}
  console.log(`Tag ${tag} matches package.json ${version}.`);
}
