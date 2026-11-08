// A hand-written MCP server for test/mcp-client.test.ts. Plain Node, no dependencies: newline-delimited JSON on stdio.
import {createInterface} from 'node:readline';

const send=m=>process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',...m})}\n`);
const schema={type:'object',properties:{text:{type:'string'}}};
const PAGE_1=[
  {name:'echo',description:'Returns its text argument.',inputSchema:schema,annotations:{readOnlyHint:true}},
  {name:'fail',description:'Always reports an error.',inputSchema:{type:'object'}},
  {name:'picture',description:'Returns a 300-byte PNG part.',inputSchema:{type:'object'}},
  {name:'slow',description:'Answers after five seconds.',inputSchema:{type:'object'}},
];
const PAGE_2=[
  {name:'change',description:'Announces a tool list change, then answers.',inputSchema:{type:'object'}},
  {name:'pinged',description:'Reports whether the client answered our ping.',inputSchema:{type:'object'}},
];
let pinged; // undefined until the client answers the ping

// Waits (up to 2 s) for the client's answer to our ping, then reports it.
function reportPing(id){
  const started=Date.now();
  const check=()=>{if(pinged===undefined&&Date.now()-started<2000)return setTimeout(check,20);send({id,result:{content:[{type:'text',text:String(pinged===true)}]}});};
  check();
}

function handle(m){
  const reply=result=>send({id:m.id,result});
  const text=t=>reply({content:[{type:'text',text:t}]});
  if(m.method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:String(process.pid)},instructions:'Fixture for the client tests.'});
  if(m.method==='tools/list')return reply(m.params?.cursor?{tools:PAGE_2}:{tools:PAGE_1,nextCursor:'page-2'});
  if(m.method!=='tools/call')return send({id:m.id,error:{code:-32601,message:'Method not found'}});
  const {name,arguments:args={}}=m.params;
  switch(name){
    case 'echo':return text(String(args.text??''));
    case 'fail':return reply({content:[{type:'text',text:'Something broke.'}],isError:true});
    case 'picture':return reply({content:[{type:'image',data:Buffer.alloc(300).toString('base64'),mimeType:'image/png'}]});
    case 'slow':return setTimeout(()=>text('late'),5000);
    case 'change':send({method:'notifications/tools/list_changed'});return text('changed');
    case 'pinged':return reportPing(m.id);
    default:return send({id:m.id,error:{code:-32602,message:`Unknown tool: ${name}`}});
  }
}

createInterface({input:process.stdin}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.method===undefined){if(m.id==='ping-1')pinged='result' in m;return;} // the client's answer to our ping
  if(m.method==='notifications/initialized')return send({id:'ping-1',method:'ping'});
  if(m.id===undefined)return; // other notifications, such as cancelled
  handle(m);
});
