// One rule for fencing outside text before a model reads it: the text sits between <<< and >>> markers, and any markers inside it
// are defused, so the text cannot close its own fence and speak as instructions. Used by engine.ts, routines.ts and artifacts.ts.
export const defuse=(s:string)=>s.replace(/<<</g,'‹‹‹').replace(/>>>/g,'›››');
