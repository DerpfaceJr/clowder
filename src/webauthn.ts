// WebAuthn, the small part a passkey step-up needs (plan 5.5): one passkey per owner device, bound to the stable address's host name
// (the RP ID). node:crypto only, no dependency. Registration asks for attestation "none", so nothing vouches for the authenticator itself:
// what makes a registration trusted is the gate around it (a paired owner device, over HTTPS, inside a window the host opened).
// Every check WebAuthn Level 2 §7 lists for this use is made: the type, the challenge, the origin, the RP ID hash, user present and
// user verified, the signature over authenticatorData + SHA-256(clientDataJSON), and a sign counter that only grows. Nothing else is believed.
import {constants,createHash,createPublicKey,verify,type JsonWebKey} from 'node:crypto';

export type Passkey={id:string;jwk:JsonWebKey;alg:number;rpId:string;signCount:number;createdAt:number};
// ES256, EdDSA and RS256: what platform authenticators and security keys use.
export const ALGORITHMS=[-7,-8,-257] as const;
const FLAG_UP=0x01,FLAG_UV=0x04,FLAG_AT=0x40;

const fail=(message:string):never=>{throw Object.assign(new Error(message),{statusCode:400});};
const sha256=(data:Buffer|string)=>createHash('sha256').update(data).digest();
const bytes=(value:unknown,what:string)=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))fail(`The passkey answer's ${what} is unreadable.`);
  return Buffer.from(value as string,'base64url');
};

/** One CBOR item at `at` (RFC 8949), definite lengths only: what WebAuthn sends. Returns it and where the next item starts. */
export function readCbor(buf:Buffer,at=0,depth=0):{value:unknown;end:number}{
  if(depth>8)fail('The passkey data is nested too deeply.');
  const need=(n:number)=>{if(n>buf.length-at)fail('The passkey data is cut short.');};
  need(1);
  const head=buf[at++]!,major=head>>5,info=head&31;
  if(major===7){
    if(info===20)return {value:false,end:at};
    if(info===21)return {value:true,end:at};
    if(info===22)return {value:null,end:at};
    fail('The passkey data holds a value Clowder does not read.');
  }
  let n:number;
  if(info<24)n=info;
  else if(info===24){need(1);n=buf[at]!;at+=1;}
  else if(info===25){need(2);n=buf.readUInt16BE(at);at+=2;}
  else if(info===26){need(4);n=buf.readUInt32BE(at);at+=4;}
  else if(info===27){need(8);const big=buf.readBigUInt64BE(at);at+=8;if(big>BigInt(Number.MAX_SAFE_INTEGER))fail('The passkey data holds a number too large.');n=Number(big);}
  else return fail('The passkey data uses a length Clowder does not read.');
  if(major===0)return {value:n,end:at};
  if(major===1)return {value:-1-n,end:at};
  // A string takes n bytes and every array or map item at least one, so a count past the bytes left is refused before any loop.
  if(major>=2&&major<=5)need(n);
  if(major===2)return {value:Buffer.from(buf.subarray(at,at+n)),end:at+n};
  if(major===3)return {value:buf.toString('utf8',at,at+n),end:at+n};
  if(major===4){const list:unknown[]=[];for(let i=0;i<n;i++){const item=readCbor(buf,at,depth+1);list.push(item.value);at=item.end;}return {value:list,end:at};}
  if(major===5){
    const map=new Map<unknown,unknown>();
    for(let i=0;i<n;i++){const key=readCbor(buf,at,depth+1),item=readCbor(buf,key.end,depth+1);map.set(key.value,item.value);at=item.end;}
    return {value:map,end:at};
  }
  // Tags (major 6) are not part of what WebAuthn sends here.
  return fail('The passkey data holds a value Clowder does not read.');
}

type AuthData={rpIdHash:Buffer;flags:number;signCount:number;credential?:{id:Buffer;key:unknown}};
export function parseAuthData(data:Buffer):AuthData{
  if(data.length<37)fail('The passkey data is cut short.');
  const flags=data[32]!,out:AuthData={rpIdHash:data.subarray(0,32),flags,signCount:data.readUInt32BE(33)};
  if(flags&FLAG_AT){
    if(data.length<55)fail('The passkey data is cut short.');
    const length=data.readUInt16BE(53);
    if(55+length>data.length)fail('The passkey data is cut short.');
    out.credential={id:data.subarray(55,55+length),key:readCbor(data,55+length).value};
  }
  return out;
}

/** A COSE public key (RFC 9053) as a JWK node:crypto can load. Only the three algorithms above, each with its own key type. */
export function coseToJwk(key:unknown):{jwk:JsonWebKey;alg:number}{
  if(!(key instanceof Map))return fail('The passkey key is unreadable.');
  const bin=(label:number,length?:number)=>{
    const value=key.get(label);
    if(!Buffer.isBuffer(value)||(length!==undefined&&value.length!==length))fail('The passkey key is unreadable.');
    return (value as Buffer).toString('base64url');
  };
  const kty=key.get(1),alg=key.get(3);
  if(alg===-7&&kty===2&&key.get(-1)===1)return {jwk:{kty:'EC',crv:'P-256',x:bin(-2,32),y:bin(-3,32)},alg};
  if(alg===-8&&kty===1&&key.get(-1)===6)return {jwk:{kty:'OKP',crv:'Ed25519',x:bin(-2,32)},alg};
  if(alg===-257&&kty===3){
    const n=key.get(-1);
    if(!Buffer.isBuffer(n)||n.length<256)fail('This passkey\'s key is too short.');
    return {jwk:{kty:'RSA',n:bin(-1),e:bin(-2)},alg};
  }
  return fail('This passkey uses a kind of key Clowder does not accept.');
}

type Expected={challenge:string;origin:string;rpId:string};
// The client data: what the browser says it was asked, from which page. Returns its hash, which the signature covers.
function checkClientData(encoded:unknown,type:'webauthn.create'|'webauthn.get',expected:Expected):Buffer{
  const raw=bytes(encoded,'client data');
  let data:any;
  try{data=JSON.parse(raw.toString('utf8'));}catch{return fail('The passkey answer\'s client data is unreadable.');}
  if(data?.type!==type)fail('The passkey answer is for another kind of request.');
  if(typeof data.challenge!=='string'||data.challenge!==expected.challenge)fail('The passkey answer is for another request. Try again.');
  if(data.origin!==expected.origin)fail('The passkey answer came from another address.');
  if(data.crossOrigin===true)fail('The passkey answer came from inside another page.');
  return sha256(raw);
}
function checkAuthData(auth:AuthData,rpId:string){
  if(!auth.rpIdHash.equals(sha256(rpId)))fail('This passkey belongs to another address.');
  if(!(auth.flags&FLAG_UP)||!(auth.flags&FLAG_UV))fail('The passkey did not confirm it was you. Try again and unlock it.');
}
const record=(value:unknown)=>value&&typeof value==='object'?value as Record<string,any>:fail('The passkey answer is incomplete.');

/** Options for navigator.credentials.create(), binary fields as base64url. userId: the device id, which the passkey keeps. */
export const creationOptions=(o:{challenge:string;rpId:string;userId:string;name:string})=>({
  challenge:o.challenge,rp:{id:o.rpId,name:'Clowder'},user:{id:Buffer.from(o.userId).toString('base64url'),name:o.name,displayName:o.name},
  pubKeyCredParams:ALGORITHMS.map(alg=>({type:'public-key',alg})),timeout:120_000,attestation:'none',
  authenticatorSelection:{residentKey:'discouraged',userVerification:'required'},
});
/** Options for navigator.credentials.get(): this device's one passkey only. */
export const requestOptions=(o:{challenge:string;rpId:string;id:string})=>({challenge:o.challenge,rpId:o.rpId,allowCredentials:[{type:'public-key',id:o.id}],userVerification:'required',timeout:120_000});

/** A new passkey from navigator.credentials.create()'s answer, or a 400 that says why not. */
export function verifyRegistration(body:unknown,expected:Expected,now:number):Passkey{
  const answer=record(body),response=record(answer.response);
  if(answer.type!=='public-key'||typeof answer.id!=='string')fail('The passkey answer is incomplete.');
  checkClientData(response.clientDataJSON,'webauthn.create',expected);
  const attestation=readCbor(bytes(response.attestationObject,'attestation')).value;
  if(!(attestation instanceof Map)||!Buffer.isBuffer(attestation.get('authData')))fail('The passkey answer is incomplete.');
  const auth=parseAuthData((attestation as Map<string,Buffer>).get('authData')!);
  checkAuthData(auth,expected.rpId);
  if(!auth.credential)return fail('The passkey answer holds no key.');
  // WebAuthn credential IDs are 16 to 1023 bytes, and the store (pairing.ts) drops a passkey whose id is shorter, so one is never saved.
  if(auth.credential.id.length<16||auth.credential.id.length>1023)fail('The passkey answer holds a key id of the wrong length.');
  const id=auth.credential.id.toString('base64url');
  if(!id||id!==answer.id)fail('The passkey answer does not match its key.');
  const {jwk,alg}=coseToJwk(auth.credential.key);
  try{createPublicKey({key:jwk,format:'jwk'});}catch{fail('The passkey key is unreadable.');}
  return {id,jwk,alg,rpId:expected.rpId,signCount:auth.signCount,createdAt:now};
}

function signatureMatches(passkey:Passkey,data:Buffer,signature:Buffer){
  try{
    const key=createPublicKey({key:passkey.jwk,format:'jwk'});
    if(passkey.alg===-8)return verify(null,data,key,signature);
    if(passkey.alg===-257)return verify('sha256',data,{key,padding:constants.RSA_PKCS1_PADDING},signature);
    return verify('sha256',data,{key,dsaEncoding:'der'},signature);
  }catch{return false;}
}

/** Checks navigator.credentials.get()'s answer against the device's passkey. Returns the new sign counter, or a 400 that says why not. */
export function verifyAssertion(body:unknown,passkey:Passkey,expected:Expected):number{
  const answer=record(body),response=record(answer.response);
  if(answer.type!=='public-key'||answer.id!==passkey.id)fail('That is not this phone\'s passkey.');
  if(passkey.rpId!==expected.rpId)fail('This passkey belongs to another address.');
  const clientHash=checkClientData(response.clientDataJSON,'webauthn.get',expected);
  const authData=bytes(response.authenticatorData,'authenticator data');
  const auth=parseAuthData(authData);
  checkAuthData(auth,expected.rpId);
  if(!signatureMatches(passkey,Buffer.concat([authData,clientHash]),bytes(response.signature,'signature')))fail('The passkey signature does not match.');
  // A counter of 0 means the authenticator keeps none (most synced passkeys). Otherwise it must grow, or a copy of the key is in use.
  if((auth.signCount!==0||passkey.signCount!==0)&&auth.signCount<=passkey.signCount)fail('This passkey\'s counter went back, so it may have been copied. Remove it in Devices on your computer and add it again.');
  return auth.signCount;
}
