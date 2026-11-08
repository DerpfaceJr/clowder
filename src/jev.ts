// Optional Jev decision routing. Only the two closed-choice decision actions in season.ts use it.
//
// Verified from the official docs on 2026-10-25:
//   API reference (https://docs.typesafe.ai/api, OpenAPI at https://api.typesafe.ai/openapi.json):
//     POST https://api.typesafe.ai/v1/systemone
//     Header: Authorization: Bearer <API_KEY>
//     Body:   {"model":"jev-latest","state":<string|object|array>,
//              "questions":{"<name>":{"type":"choice","instructions":"...","criteria":{"<choice>":<string|null>}}}}
//             criteria holds 1 to 255 choices; a null description means the name alone is used.
//     200:    {"model":"jev-1.14.0","answers":{"<name>":{"type":"choice","choice":"<name>",
//              "confidence":0..1,"probabilities":{...}}},"usage":{"input_tokens":N,"output_tokens":N}}
//   Models (https://docs.typesafe.ai/models): alias jev-latest -> jev-1.14.0.
//     Price: $42 per Btok = $0.042 per Mtok, billed on input tokens; output tokens are free. Page as of 2026-10-25.
//   Errors (https://docs.typesafe.ai/api/errors): 401 bad key, 422 validation, 429 rate limit (per organization,
//     tokens/s and requests/s; retry with backoff), 529 overloaded. Limits are set in the developer console.
// The Choice answer's `confidence` is returned here as `score`. It is not the Score primitive, and it is not a permission grant.

export type JevDecision={choice:string;score:number|null;usage:any};
export type JevDecide=(question:string,choices:string[],context:object)=>Promise<JevDecision>;

// PUBLISHED: https://docs.typesafe.ai/models ($42 per Btok, input only), checked 2026-10-25.
export const JEV_USD_PER_TOKEN=42/1e9;
export const JEV_DEFAULT_BASE='https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL='jev-latest';

export function jevCost(usage:any):number|null{
  const n=usage?.input_tokens;
  return typeof n==='number'&&Number.isFinite(n)?n*JEV_USD_PER_TOKEN:null;
}

export function jevDecider({base,key,model=JEV_DEFAULT_MODEL,timeoutMs}:{base:string;key:string;model?:string;timeoutMs:number}):JevDecide{
  const url=`${base.replace(/\/$/,'')}/v1/systemone`;
  return async(question,choices,context)=>{
    if(!Array.isArray(choices)||choices.length<1||choices.length>255)throw new Error('Jev needs 1 to 255 choices.');
    if(new Set(choices).size!==choices.length||choices.some(c=>typeof c!=='string'||!c))throw new Error('Jev choices must be unique non-empty strings.');
    const response=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
      body:JSON.stringify({model,state:context,questions:{decision:{type:'choice',instructions:question,criteria:Object.fromEntries(choices.map(c=>[c,null]))}}}),
      signal:AbortSignal.timeout(timeoutMs)
    });
    // Status only: the body and the key are never put into an error.
    if(!response.ok)throw new Error(`Jev request failed (${response.status}).`);
    const body:any=await response.json();
    const answer=body?.answers?.decision;
    if(!answer||answer.type!=='choice')throw new Error('Jev returned no choice answer.');
    if(typeof answer.choice!=='string'||!choices.includes(answer.choice))throw new Error('Jev chose an option that was not offered.');
    const score=typeof answer.confidence==='number'&&Number.isFinite(answer.confidence)?answer.confidence:null;
    return {choice:answer.choice,score,usage:body.usage??null};
  };
}
