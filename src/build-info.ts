import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// Git's short HEAD, or null when there is no git (a packaged app has no .git) or no repository.
export const gitHead=(root:string):string|null=>{
  try{return execFileSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim()||null;}catch{return null;}
};

export type Build={commit:string|null;builtAt:string|null;startedAt:string;stale:boolean};

// The running build. Git at startup comes first, because a dev checkout keeps the build-info.json of its last desktop
// build. A packaged app has no .git, so it reads the stamp written before electron-builder ran.
// builtAt comes only with the stamp's commit: in a dev checkout the stamp belongs to an older build, so there it is null.
// stale turns true once git's HEAD moves past it. git runs at most once a minute, and not at all when git is missing.
export function buildStamp(root:string,head:(root:string)=>string|null=gitHead,now:()=>number=Date.now){
  let commit:string|null=head(root),builtAt:string|null=null;
  if(!commit)try{const info=JSON.parse(readFileSync(join(root,'build-info.json'),'utf8'));commit=info.commit||null;builtAt=commit&&info.builtAt||null;}catch{/* no git and no stamp: no commit */}
  const startedAt=new Date(now()).toISOString();
  let checkedAt=-Infinity,stale=false;
  return {
    get():Build{
      if(now()-checkedAt>=60_000){checkedAt=now();const current=head(root);stale=current!==null&&commit!==null&&current!==commit;}
      return {commit,builtAt,startedAt,stale};
    },
  };
}
