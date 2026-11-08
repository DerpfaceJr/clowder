// One path spelled the ways a client can bend it (security pass H1), for the route matrices in device-roles.test.ts and lan-control.test.ts.
// refused: an encoded letter in the first segment, an encoded letter (upper-case hex) in the last; every listener answers 400.
// other: an encoded slash, a double-encoded letter, an upper-case first segment; the router matches none of them to the route, so each may
// succeed only where the plain path does. Dot segments are not here: inject resolves them, so device-roles.test.ts sends them over a socket.
export function variants(url:string){
  const enc=(c:string,upper:boolean)=>{const h=c.charCodeAt(0).toString(16);return '%'+(upper?h.toUpperCase():h);};
  const segs=url.split('/').slice(1),out:{refused:boolean;url:string}[]=[];
  if(!segs[0])return out;
  const last=segs.at(-1)!,lead=last.search(/[A-Za-z0-9]/);
  out.push({refused:true,url:'/'+enc(url[1]!,false)+url.slice(2)});
  if(lead>=0)out.push({refused:true,url:'/'+[...segs.slice(0,-1),last.slice(0,lead)+enc(last[lead]!,true)+last.slice(lead+1)].join('/')});
  if(segs.length>1)out.push({refused:false,url:'/'+segs[0]+'%2f'+segs.slice(1).join('/')});
  out.push({refused:false,url:'/%25'+url.charCodeAt(1).toString(16)+url.slice(2)});
  out.push({refused:false,url:'/'+segs[0]!.toUpperCase()+url.slice(1+segs[0]!.length)});
  return out;
}
