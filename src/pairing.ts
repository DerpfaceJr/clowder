import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {ALGORITHMS,type Passkey} from './webauthn.ts';

export type RemoteConfig={pairingTtlMs:number;deviceTtlMs:number;maxDevices:number;attemptWindowMs:number;maxPairAttempts:number;pollMs:number;tunnelTimeoutMs:number};
export type Role='owner'|'viewer';
// passkey: the owner device's step-up passkey (plan 5.5), bound to the stable address it was added on.
export type Device={id:string;name:string;permission:Role;tokenHash:string;createdAt:number;expiresAt:number;followAt?:number;passkey?:Passkey};
export type Listed=Omit<Device,'tokenHash'|'passkey'>&{passkey?:{rpId:string;createdAt:number}};
const DAY_MS=24*60*60*1000,HOUR_MS=60*60*1000;
// The slots of the chat channels (chat-channel.ts): their codes pair only through that channel.
const CHAT_SLOTS=new Set(['telegram','discord']);
// v1 role names. Renamed on load with the token hash kept, so paired phones and the Android app need no re-pair.
const LEGACY=new Map<unknown,Role>([['control','owner'],['view','viewer']]);
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const codeKey=(code:string)=>hash(code.replace(/[\s-]/g,'').toUpperCase());
// A saved passkey: its public key, never a secret. A bad one is dropped on load (that device loses its step-up), so the store still loads.
const passkeyOk=(k:any)=>!!k&&typeof k==='object'&&typeof k.id==='string'&&/^[A-Za-z0-9_-]{16,1400}$/.test(k.id)&&typeof k.rpId==='string'&&!!k.rpId
  &&(ALGORITHMS as readonly number[]).includes(k.alg)&&!!k.jwk&&typeof k.jwk==='object'&&Number.isSafeInteger(k.signCount)&&k.signCount>=0&&Number.isFinite(k.createdAt);
export class Pairing {
  private devices:Device[]=[];
  // One open code per slot: a new remote code replaces the last remote one, and the LAN viewing link has its own slot.
  private invites=new Map<string,{hash:string;permission:Role;expiresAt:number}>();
  private attempts:number[]=[];
  // Revoking a device also removes what it owns elsewhere (its push endpoints, server.ts).
  readonly revoked=new Set<(id:string)=>void>();
  constructor(private file:string,readonly config:RemoteConfig,private now=Date.now){
    const keys:(keyof RemoteConfig)[]=['pairingTtlMs','deviceTtlMs','maxDevices','attemptWindowMs','maxPairAttempts','pollMs','tunnelTimeoutMs'];
    if(!config||keys.some(key=>!Number.isSafeInteger(config[key])||config[key]<=0))throw new Error('Remote access requires positive integer limits in town.config.json.');
    if(existsSync(file)){
      const data=JSON.parse(readFileSync(file,'utf8'));
      const legacy=Array.isArray(data)?data.filter(d=>LEGACY.has(d?.permission)):[];
      for(const d of legacy)d.permission=LEGACY.get(d.permission);
      if(!Array.isArray(data)||data.some(d=>!d||typeof d.id!=='string'||typeof d.name!=='string'||!['owner','viewer'].includes(d.permission)||!/^[a-f0-9]{64}$/.test(d.tokenHash)||!Number.isFinite(d.createdAt)||!Number.isFinite(d.expiresAt)||(d.followAt!==undefined&&!Number.isFinite(d.followAt))))throw new Error('Invalid paired-device store.');
      const dropped=data.filter(d=>d.passkey!==undefined&&(d.permission!=='owner'||!passkeyOk(d.passkey)));
      for(const d of dropped)delete d.passkey;
      this.devices=data;
      // Saved only when something was renamed or dropped, so a second load writes nothing.
      if(legacy.length||dropped.length)this.save(data);
    }
  }
  private save(devices:Device[]){
    mkdirSync(dirname(this.file),{recursive:true});
    writeFileSync(this.file+'.tmp',JSON.stringify(devices),{mode:0o600,flush:true});
    renameSync(this.file+'.tmp',this.file);this.devices=devices;
  }
  // A passkey is listed by where it works and when it was added; its key stays in the store.
  list():Listed[]{return this.devices.filter(d=>d.expiresAt>this.now()).map(({tokenHash,passkey,...d})=>passkey?{...d,passkey:{rpId:passkey.rpId,createdAt:passkey.createdAt}}:d);}
  create(permission:Role,slot='remote'){
    if(this.list().length>=this.config.maxDevices)throw new Error('Remove an old device before pairing another.');
    const code=randomBytes(8).toString('hex').toUpperCase();
    const expiresAt=this.now()+this.config.pairingTtlMs;
    this.invites.set(slot,{hash:codeKey(code),permission,expiresAt});
    return {code:code.match(/.{4}/g)!.join('-'),permission,expiresAt};
  }
  // Stopping the tunnel ends its open code; the LAN viewing link is not the tunnel's.
  cancel(){this.invites.delete('remote');}
  // only: that slot's code alone pairs. A chat channel (Telegram, Discord) pairs with its own code, and a phone or viewer never with a chat's code.
  // name: a function names the device by the code's permission (the LAN link pairs viewers and owners alike).
  pair(code:string,name:string|((permission:Role)=>string),only?:string){
    const now=this.now();this.attempts=this.attempts.filter(at=>at>now-this.config.attemptWindowMs);
    if(this.attempts.length>=this.config.maxPairAttempts)throw Object.assign(new Error('Too many attempts. Wait and try again.'),{statusCode:429});
    this.attempts.push(now);
    const open=[...this.invites].find(([s,i])=>(only===undefined?!CHAT_SLOTS.has(s):s===only)&&i.expiresAt>now&&i.hash===codeKey(code));
    if(!open)throw Object.assign(new Error('Pairing code expired, used or incorrect.'),{statusCode:401});
    const [slot,invite]=open;
    if(typeof name==='function')name=name(invite.permission);
    if(!name.trim())throw new Error('Name this device.');
    if(this.list().length>=this.config.maxDevices)throw new Error('Device limit reached.');
    const token=randomBytes(32).toString('hex');
    const device:Device={id:randomUUID(),name:name.trim().slice(0,60),permission:invite.permission,tokenHash:hash(token),createdAt:now,expiresAt:now+this.config.deviceTtlMs};
    this.save([...this.devices.filter(d=>d.expiresAt>now),device]);this.invites.delete(slot);
    return {token,device};
  }
  // A device in use stays paired: a day or more after its last renewal, its next request gets a full TTL again (at most one write a day).
  // The copy returned with renewed:true is what the gate answers with a fresh cookie; the flag is never saved.
  authenticate(token:string):(Device&{renewed?:true})|undefined{
    if(!/^[a-f0-9]{64}$/.test(token))return undefined;
    const now=this.now(),device=this.devices.find(d=>d.tokenHash===hash(token)&&d.expiresAt>now);if(!device)return undefined;
    if(device.expiresAt-now<this.config.deviceTtlMs-DAY_MS){device.expiresAt=now+this.config.deviceTtlMs;this.save(this.devices);return {...device,renewed:true};}
    return device;
  }
  // The app fetched the relay details, so this device can find the town after a restart. Saved at most once an hour per device.
  markFollow(id:string){
    const now=this.now(),device=this.devices.find(d=>d.id===id&&d.expiresAt>now);
    if(!device||(device.followAt!==undefined&&now-device.followAt<HOUR_MS))return;
    device.followAt=now;this.save(this.devices);
  }
  revoke(id:string){this.save(this.devices.filter(d=>d.id!==id));for(const removed of this.revoked)removed(id);}
  // The step-up passkey (plan 5.5): owner devices only. The counter is saved after each confirm, so a copied key shows as a counter going back.
  passkey(id:string){return this.devices.find(d=>d.id===id&&d.expiresAt>this.now())?.passkey;}
  setPasskey(id:string,passkey:Passkey|undefined){
    const device=this.devices.find(d=>d.id===id&&d.expiresAt>this.now());
    if(!device)throw Object.assign(new Error('That device is no longer paired.'),{statusCode:404});
    if(passkey&&device.permission!=='owner')throw Object.assign(new Error('Only a device paired with control can have a passkey.'),{statusCode:403});
    if(passkey)device.passkey=passkey;else delete device.passkey;
    this.save(this.devices);
  }
}
