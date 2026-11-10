import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {writeJsonAtomic} from './atomic-json.ts';
import {OWNER,type Pairing,type Role} from './pairing.ts';

// The people of a shared world (plan 10.3, G1; roles D18). The owner is built in and never stored: people.json holds only the people the owner
// added, so a town without it has the owner alone. A removed person stays listed with removedAt, so work that names them still reads.
// budget (plan 10.9): the member's monthly token budget, owner-set; null or absent is none. Their trees' usage this month counts against it (usage.ts).
export type Person={id:string;name:string;role:Role;createdAt:number;removedAt?:number;budget?:number|null};
const owner:Person={id:OWNER,name:'Owner',role:'owner',createdAt:0};
const fail=(statusCode:number,message:string):never=>{throw Object.assign(new Error(message),{statusCode});};

export class People{
  private people:Person[]=[];
  constructor(private file:string,private pairing:Pairing,private now=Date.now){
    if(existsSync(file)){
      const data=JSON.parse(readFileSync(file,'utf8'));
      if(!Array.isArray(data)||data.some(p=>!p||typeof p.id!=='string'||!p.id||p.id===OWNER||typeof p.name!=='string'||!['member','viewer'].includes(p.role)
        ||!Number.isFinite(p.createdAt)||(p.removedAt!==undefined&&!Number.isFinite(p.removedAt))
        ||(p.budget!=null&&(!Number.isInteger(p.budget)||p.budget<1))))throw new Error('Invalid people store.');
      this.people=data;
    }
    pairing.personActive=id=>this.active(id);
    // Fail closed: a device whose person is removed or unknown (people.json deleted, or edited by hand) is revoked before it is ever asked about.
    for(const d of pairing.list())if(!this.active(d.person))pairing.revoke(d.id);
  }
  active(id:string){return id===OWNER||this.people.some(p=>p.id===id&&p.removedAt===undefined);}
  list():Person[]{return [owner,...this.people.filter(p=>p.removedAt===undefined)];}
  // The member's monthly token budget (plan 10.9); null when none. Read by the engine, which holds their work past it.
  budgetOf(id:string){return this.people.find(p=>p.id===id&&p.removedAt===undefined)?.budget??null;}
  // Owner-only, like the town's cap: the host's routes call it with 'owner'. null removes the budget.
  setBudget(actor:string,id:string,tokens:number|null){
    if(actor!=='owner')fail(403,'Only the owner can set a member’s budget.');
    if(id===OWNER||!this.people.some(p=>p.id===id&&p.removedAt===undefined))fail(404,'No such person.');
    if(tokens!==null&&(!Number.isInteger(tokens)||tokens<1))fail(400,'A budget is a whole number of tokens, or blank for none.');
    this.save(this.people.map(p=>p.id===id?{...p,budget:tokens}:p));
  }
  // A removed person's name too, so their earlier work still reads with it (plan 10.6).
  name(id:string){return id===OWNER?owner.name:this.people.find(p=>p.id===id)?.name;}
  add(name:string,role:'member'|'viewer'){
    if(!name.trim())fail(400,'Name this person.');
    if(!['member','viewer'].includes(role))fail(400,'A person is a member or a viewer.');
    const person:Person={id:randomUUID(),name:name.trim().slice(0,60),role,createdAt:this.now()};
    this.save([...this.people,person]);return person;
  }
  // Their one-time code (plan 10.4), with their role. Slot invite:<person>, so a new code replaces their last one, and the code names its person:
  // one person's code never pairs a device as another. Never the owner's: control is paired from Devices.
  invite(id:string){
    const person=this.people.find(p=>p.id===id&&p.removedAt===undefined);
    if(!person)return fail(404,'No such person.');
    return this.pairing.create(person.role,`invite:${id}`,id);
  }
  // Their devices go first: a crash between the two writes leaves a person with no devices, never a removed person whose devices still work.
  remove(id:string){
    if(id===OWNER)fail(403,'The owner cannot be removed.');
    if(!this.active(id))fail(404,'No such person.');
    this.pairing.revokePerson(id);
    this.save(this.people.map(p=>p.id===id?{...p,removedAt:this.now()}:p));
  }
  private save(people:Person[]){writeJsonAtomic(this.file,people);this.people=people;}
}
