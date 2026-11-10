// Types for test/*.ts: public/state-delta.js stays plain JavaScript for the page.
export function applyFrame(state:any,frame:any):any;
export function applyLive(state:any,frame:any):any;
export function chatMessages(page:any[]|undefined,messages:any[],cat:string):any[];
export function catTasks(page:any[]|undefined,tasks:any[],cat:string):any[];
export type GateState={open:boolean;lastSeenAt:number|null};
export function createGate(o:{every:number;now?:()=>number;schedule?:(fn:()=>void,ms:number)=>unknown;onChange?:(s:GateState)=>void}):{gateState():GateState;seen():void;watch(source:{addEventListener(type:string,fn:()=>void):void}):void};
