// The one list of AI model and effort choices: what each provider accepts, how a value is checked, how the
// effective choice is picked (cat override, then saved default, then town.config.json), and how cat overrides are folded.
import {existsSync, readFileSync} from 'node:fs';

export const AI_PROVIDERS=['local','hosted','claude','chatgpt','anthropic'] as const;
export type AiProvider=typeof AI_PROVIDERS[number];
export type AiChoice={model?:string;effort?:string};
export type CatAi=Partial<Record<AiProvider,AiChoice>>;
// The town's default thinking: one provider, with an optional model and effort. Missing fields use that provider's own default.
export type TownDefault=AiChoice&{provider:AiProvider};

// Effort values per provider.
//   claude:  VERIFIED from `claude --help` (claude 2.1.288): --effort <level> (low, medium, high, xhigh, max).
//   chatgpt: UNVERIFIED. `codex exec --help` does not list reasoning values; sent as -c model_reasoning_effort=<value>.
//   local:   ASSUMED from Ollama's OpenAI-compatible reasoning_effort; the accepted set depends on the model.
//   hosted:  ASSUMED from OpenAI-compatible reasoning_effort; many endpoints reject unknown values.
export const EFFORTS:Record<AiProvider,readonly string[]>={
  claude:['low','medium','high','xhigh','max'],
  chatgpt:['minimal','low','medium','high'],
  local:['none','low','medium','high'],
  hosted:['none','minimal','low','medium','high'],
  // anthropic: the Messages API's output_config.effort (Opus 4.5+ and Sonnet 5.x accept it; older models reject it).
  anthropic:['low','medium','high','xhigh','max'],
};
// Hosted takes its model from its own API form, so it has no default or per-cat model.
export const MODEL_PROVIDERS:readonly AiProvider[]=['local','claude','chatgpt','anthropic'];
// Used when the owner has not picked a model and town.config.json has no anthropicModel. Current-generation IDs from the claude-api model table.
export const ANTHROPIC_DEFAULT_MODEL='claude-sonnet-5-5';
// Suggestions only. Claude accepts aliases (claude --help lists fable, opus, sonnet); haiku is the configured plan model.
// chatgpt: the model names the Codex CLI docs (learn.chatgpt.com/docs/models) give for `codex -m`. Nothing else is offered.
export const MODEL_SUGGESTIONS:Partial<Record<AiProvider,readonly string[]>>={claude:['haiku','sonnet','opus','fable'],anthropic:[ANTHROPIC_DEFAULT_MODEL,'claude-opus-5-5','claude-haiku-5-5']};
// Letters, digits and . _ : / - ; must not start with '-' so a CLI cannot read it as a flag.
export const MODEL_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export const isAiProvider=(value:unknown):value is AiProvider=>AI_PROVIDERS.includes(value as AiProvider);
// The old name "plan" means claude. Saved tasks and older clients still send it.
export const normalizeMode=(mode:string)=>mode==='plan'?'claude':mode;

const blank=(v:unknown)=>v===undefined||v===null||v==='';
/** Validates one provider's choice. Blank values mean "not set". Throws a message the owner can read. */
export function checkAi(provider:AiProvider,choice:{model?:unknown;effort?:unknown}):AiChoice{
  const out:AiChoice={};
  if(!blank(choice.model)){
    if(!MODEL_PROVIDERS.includes(provider))throw new Error('This provider takes its model from its API settings.');
    if(typeof choice.model!=='string'||!MODEL_PATTERN.test(choice.model))throw new Error('Model names use letters, digits, . _ : or / and start with a letter or digit.');
    out.model=choice.model;
  }
  if(!blank(choice.effort)){
    if(typeof choice.effort!=='string'||!EFFORTS[provider].includes(choice.effort))throw new Error(`Effort for ${provider} must be one of: ${EFFORTS[provider].join(', ')}.`);
    out.effort=choice.effort;
  }
  return out;
}

/** Validates the town default. Blank model or effort is dropped; the provider must be a known provider. Throws a message the owner can read. */
export function checkTownDefault(value:{provider?:unknown;model?:unknown;effort?:unknown}):TownDefault{
  if(!isAiProvider(value.provider))throw new Error('Choose a provider for the town default.');
  return {provider:value.provider,...checkAi(value.provider,{model:value.model,effort:value.effort})};
}

/** Cat override first, then the saved default, then the config value. Each field is resolved on its own. */
export function pickAi(cat:AiChoice|undefined,saved:AiChoice|undefined,configured:AiChoice|undefined):AiChoice{
  const model=cat?.model??saved?.model??configured?.model;
  const effort=cat?.effort??saved?.effort??configured?.effort;
  return {...(model?{model}:{}),...(effort?{effort}:{})};
}

/** Folds one cat.ai event into a cat's overrides. Empty values clear that provider's override. */
export function applyCatAi(ai:CatAi|undefined,data:{provider:AiProvider;model?:string;effort?:string}):CatAi{
  const next:CatAi={...ai};
  if(data.model||data.effort)next[data.provider]={...(data.model?{model:data.model}:{}),...(data.effort?{effort:data.effort}:{})};
  else delete next[data.provider];
  return next;
}

/** Reads every cat override from the town journal. Missing file means none; malformed lines are skipped. */
export function catAiFromJournal(file:string):Record<string,CatAi>{
  const out:Record<string,CatAi>={};
  if(!existsSync(file))return out;
  // ponytail: whole-journal scan once per season run; index it if seasons get long.
  for(const line of readFileSync(file,'utf8').split('\n')){
    if(!line.includes('"cat.ai"'))continue;
    try{
      const e=JSON.parse(line);
      if(e?.type!=='cat.ai'||!isAiProvider(e.data?.provider))continue;
      out[e.data.id]=applyCatAi(out[e.data.id],e.data);
    }catch{/* a torn last line is skipped; the engine replay reports damage */}
  }
  return out;
}
