// Pure helpers for the AI model and effort controls. The allowed values come from the owner-only status route
// (ai.efforts), and the server checks every save against the same rules in src/ai-options.ts.

export const MODEL_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

// One draft from a model or effort form. Blank means "not set" and is sent as null.
export function aiDraft(provider,input,block){
  const model=String(input?.model??'').trim(),effort=String(input?.effort??'').trim();
  if(model&&!MODEL_PATTERN.test(model))return {error:'Model names use letters, digits, . _ : or / and start with a letter or digit.'};
  if(effort&&!(block?.efforts??[]).includes(effort))return {error:`Choose an effort from the list for ${provider}.`};
  return {body:{model:model||null,effort:effort||null}};
}

// Effort options: a blank first choice, then only the values this provider accepts.
export function effortChoices(efforts,blankLabel){
  return [{value:'',label:blankLabel},...(efforts??[]).map(value=>({value,label:value}))];
}

// "Mayor suggests sonnet · high: reason". Model and effort are each optional; the reason is always shown.
export function suggestionText(s){
  if(!s)return '';
  const choice=[s.model,s.effort].filter(Boolean).join(' · ');
  return s.applied?`Mayor chose ${choice||'the town default'}: ${s.reason}`:`Mayor suggests ${choice||'no change'}: ${s.reason}`;
}

// The effective values a provider uses right now, for the owner to read.
export function usingText(block){
  const model=block?.default?.model,effort=block?.default?.effort;
  return `Now using ${model??'no model set'} · effort ${effort??'not set'}`;
}

// Providers the owner can pick for a cat: every model provider the status route describes, never demo.
export function providerChoices(models,catalog){
  return (models??[]).filter(m=>m.id!=='demo'&&catalog?.[m.id]?.ai).map(m=>({id:m.id,name:m.name}));
}

// Every Save in the AI settings runs through here: "Saving…", then "Saved ✓" with a green flash, or an inline error.
// Resolves true once the save worked and the flash has shown, so the caller can close its disclosure. Validation stays with the caller.
export const SAVED_FLASH_MS=1500;
export async function savingButton(button,work,{errorNode=null,flashMs=SAVED_FLASH_MS}={}){
  const idle=button.textContent;
  button.disabled=true;button.dataset.state='saving';button.textContent='Saving…';
  try{
    await work;
    button.dataset.state='saved';button.textContent='Saved ✓';
    if(errorNode)errorNode.textContent='';
    await new Promise(done=>setTimeout(done,flashMs));
    return true;
  }catch(err){
    if(errorNode)errorNode.textContent=err?.message||String(err);
    return false;
  }finally{
    button.disabled=false;button.textContent=idle;delete button.dataset.state;
  }
}

// ---- Model pickers and the chat Reasoning menu. One list per provider comes from the status (models.ts modelList and status).
// The sentinel value of the "Other…" option. Its text field carries the name the owner typed.
export const OTHER_MODEL='__other__';

// Fills a model select: a blank first choice, every listed model, then Other…. Duplicates are dropped.
export function modelOptions(models,blankLabel){
  const names=[...new Set((models??[]).filter(m=>typeof m==='string'&&m))];
  return [{value:'',label:blankLabel},...names.map(m=>({value:m,label:m})),{value:OTHER_MODEL,label:'Other…'}];
}

// Shows a saved value: listed models pick their option; anything else shows as Other… with its text filled in.
export function paintModelPicker(select,other,{models=[],value='',blankLabel='Not set'}={}){
  const listed=!value||(models??[]).includes(value);
  select.replaceChildren(...modelOptions(models,blankLabel).map(o=>new Option(o.label,o.value)));
  select.value=!value?'':listed?value:OTHER_MODEL;
  other.value=value&&!listed?value:'';
  other.hidden=select.value!==OTHER_MODEL;
}

// Wires the Other… text field to its select. Call once when the controls are built.
export function wireModelPicker(select,other){
  select.addEventListener('change',()=>{other.hidden=select.value!==OTHER_MODEL;if(!other.hidden)other.focus();});
}

// The model the owner picked: the select value, or the typed text under Other…. Blank means not set.
export function readModelPicker(select,other){
  return select.value===OTHER_MODEL?String(other.value??'').trim():select.value;
}

// Reasoning values are "provider|model", or "demo". The model is empty for providers with one fixed model.
export const reasoningValue=(mode,model)=>mode==='demo'||!mode?'demo':`${mode}|${model??''}`;
export function parseReasoning(value){
  const v=String(value??'demo');
  if(v==='demo')return {mode:'demo'};
  const at=v.indexOf('|');
  const mode=at<0?v:v.slice(0,at),model=at<0?'':v.slice(at+1);
  return model?{mode,model}:{mode};
}

// Pure: the Reasoning menu groups, built from the usable providers (the server leaves disabled ones out).
// A group with label null is a plain option (the demonstration). A provider with no model list and a single label (Hermes,
// model-extras.js withHermes) offers that one option, whose value carries no model.
export function reasoningGroups(models){
  const groups=[];
  for(const m of models??[]){
    if(m.id==='demo'){groups.push({label:null,options:[{value:'demo',label:m.label??'Demonstration'}]});continue;}
    const options=(m.models??[]).map(model=>({value:reasoningValue(m.id,model),label:model}));
    if(!options.length&&m.single)options.push({value:reasoningValue(m.id,''),label:m.single});
    if(options.length)groups.push({label:m.label,options});
  }
  return groups;
}

// Pure: the value the Reasoning menu starts on when nothing is remembered: the town default, else the demonstration.
// The default's model is always listed (models.ts adds it), so the value matches an option; otherwise demo.
export function defaultReasoning(models,townDefault){
  if(!townDefault?.usable)return 'demo';
  return providerValue(models,townDefault.provider,townDefault.model)??'demo';
}

// The Reasoning value for one provider and model, or null when that provider is not offered. An unlisted model falls back to the first listed one.
function providerValue(models,provider,model){
  const entry=(models??[]).find(m=>m.id===provider&&m.id!=='demo');
  if(!entry?.models?.length)return null;
  return reasoningValue(provider,entry.models.includes(model)?model:entry.models[0]);
}

// Pure: where a cat's chat starts. Order: the owner's remembered pick for this cat (a real, offered provider only), the cat's own
// AI setting, the town default, then the first offered real provider. Demonstration is only the last resort, when no real provider
// is set up. A stored "demo" is never a starting point, so an old remembered demonstration cannot pin a chat to it.
export function startingReasoning(models,townDefault,catAi,remembered){
  const offered=new Set(reasoningGroups(models).flatMap(g=>g.options.map(o=>o.value)));
  if(remembered&&remembered!=='demo'&&offered.has(remembered))return remembered;
  for(const [provider,choice] of Object.entries(catAi??{})){
    const value=providerValue(models,provider,choice?.model);
    if(value)return value;
  }
  if(townDefault?.usable){
    const value=providerValue(models,townDefault.provider,townDefault.model);
    if(value)return value;
  }
  for(const m of models??[]){
    const value=providerValue(models,m.id,undefined);
    if(value)return value;
  }
  return 'demo';
}
