import { type Pt, SAMPLES, type Shape, shapeOf } from "@skech/core/shape";
import type { Lighter, MarketInfo } from "./lighter";
import type { Trader } from "./round";
import { pnlFromFills } from "./pnl";

export type RoundSpec = { pts: Pt[]; stake: number; leverage: number; seconds: number; exits: {lose:number|null;gain:number|null} };
export type QueuedOrder = { dueAt:number; expiresAt:number; want:number; status:"queued"|"submitting"|"submitted"|"confirmed"|"cancelled"|"failed"; hash?:string };
export function planOrders(shape:Shape,startedAt:number,seconds:number,full:number):QueuedOrder[] {
  return shape.legs.map((leg,i)=>({
    dueAt:startedAt+(i===0?0:leg.from/(SAMPLES-1)*seconds*1000),
    expiresAt:startedAt+(shape.legs[i+1]?.from??SAMPLES-1)/(SAMPLES-1)*seconds*1000,
    want:leg.dir*full,status:"queued",
  }));
}
export type Outcome = "time" | "stop" | "target" | "failed";
export type Round = {
  id:string; status:"running"|"closing"|"done"; outcome:Outcome|null;
  entry:number; chartEntry?:number; stake:number; leverage:number; seconds:number; startedAt:number;
  openedWith:number; accountIndex:number; size:number; unrealised:number; realised:number;
  /** One authoritative live result: booked fills plus the currently open position. */
  net:number|null; pnlReady:boolean; pts:Pt[];
  fills?:{id:string;at:number;buy:boolean;price:number;size:number}[];
  queue?:QueuedOrder[];
  exit?:number;
  untracked?:boolean;
  bars?:{t:number;o:number;h:number;l:number;c:number;v:number}[];
  orders:{at:number;requestedAt?:number;want:number;hash:string;clientOrderIndex?:string}[];
  timing?:{requestedAt:number;readyAt?:number;closeRequestedAt?:number;closedAt?:number};
  problem:string|null;
};
export type Who = {trader:Trader;accountIndex:number};
export function dirAt(shape: Shape, u:number):1|-1 {
  const sample=Math.min(SAMPLES-1,Math.max(0,u*(SAMPLES-1)));
  let dir:1|-1=shape.legs[0]?.dir ?? (shape.long?1:-1);
  for(const leg of shape.legs) {if(leg.from>sample)break;dir=leg.dir;}
  return dir;
}
type Options = {save?:(round:Round)=>Promise<void>;sleep?:(ms:number)=>Promise<unknown>;tickMs?:number;settleMs?:number};

export class Rounds {
  private readonly live=new Map<string,Round>();
  private readonly whose=new Map<string,Who>();
  private readonly accounts=new Set<number>();
  private readonly closing=new Map<string,Promise<void>>();
  private readonly marketInfo=new Map<string,MarketInfo>();
  private readonly confirmedOrders=new Map<string,string>();
  private readonly sending=new Map<string,Promise<unknown>>();
  private sequence=0;
  private listeners=new Map<string,Set<(round:Round)=>void>>();
  subscribe(id:string,listener:(round:Round)=>void){
    const set=this.listeners.get(id)??new Set();set.add(listener);this.listeners.set(id,set);
    const round=this.get(id);if(round)listener(round);
    return()=>{set.delete(listener);if(!set.size)this.listeners.delete(id);};
  }
  private publish(round:Round){for(const listener of this.listeners.get(round.id)??[])listener(round);}
  constructor(private readonly venue:Lighter,private readonly marketId:number,private readonly options:Options={}){}
  get(id:string){return this.live.get(id)??null;}
  attach(id:string,who:Who){this.whose.set(id,who);}
  all(){return [...this.live.values()].sort((a,b)=>b.startedAt-a.startedAt);}
  restore(round:Round,who?:Who){
    this.live.set(round.id,round);
    if(who)this.whose.set(round.id,who);
    if(round.status!=="done") {
      round.status="closing";
      this.cancelQueued(round);
      round.problem="Service restarted. Close the remaining position to reconcile this round.";
      this.accounts.add(round.accountIndex);
    }
  }
  private sleep(ms:number){return this.options.sleep?.(ms)??Bun.sleep(ms);}
  private save(round:Round){this.publish(round);return this.options.save?.(round)??Promise.resolve();}
  private orderIndex(){return BigInt(Date.now())*100n+BigInt((this.sequence++)%100);}
  async open(spec:RoundSpec,who:Who):Promise<Round>{
    // Reserve synchronously: concurrent requests must not both observe a free account.
    if(this.accounts.has(who.accountIndex))throw Error("Finish the existing round before starting another.");
    this.accounts.add(who.accountIndex);
    const requestedAt=Date.now();
    try {
      const [market, account] = await Promise.all([
        this.venue.market(this.marketId),
        this.venue.account(who.accountIndex),
        this.venue.fills(who.accountIndex,this.marketId,who.trader.readToken(),Date.now()-60000),
      ]);
      if(account.positions.some(p=>p.size!==0))throw Error("Close existing positions before starting a Skech round.");
      const chartEntry=spec.pts[0]?.price;
      const shape=shapeOf(spec.pts,chartEntry);
      if(!shape||shape.flat)throw Error("Draw a clear prediction before trading.");
      const round:Round={id:crypto.randomUUID(),status:"running",outcome:null,entry:market.last,chartEntry,timing:{requestedAt},stake:spec.stake,leverage:spec.leverage,seconds:spec.seconds,startedAt:Date.now(),openedWith:account.collateral,accountIndex:who.accountIndex,size:0,unrealised:0,realised:0,net:null,pnlReady:false,pts:spec.pts,orders:[],problem:null};
      // Refuse to trade if the venue cannot supply the P&L source.
      await who.trader.setLeverage(this.marketId,spec.leverage);
      round.startedAt=Date.now();
      round.timing!.readyAt=round.startedAt;
      round.queue=planOrders(shape,round.startedAt,spec.seconds,spec.stake*spec.leverage/round.entry);
      await this.save(round);
      this.live.set(round.id,round);this.whose.set(round.id,who);this.marketInfo.set(round.id,market);
      void this.run(round,shape,market,spec,who);
      return round;
    }catch(error){this.accounts.delete(who.accountIndex);throw error;}
  }
  async close(id:string){
    const round=this.live.get(id),who=this.whose.get(id);
    if(!round||round.status==="done")return round??null;
    if(!who)throw Error("Trading key unavailable; cannot close this round.");
    round.status="closing";
    this.cancelQueued(round);
    if(round.timing)round.timing.closeRequestedAt??=Date.now();
    await this.save(round);
    await this.finish(round,this.marketInfo.get(round.id)??await this.venue.market(this.marketId),who);
    return round;
  }
  /** Explicit recovery for an open position whose original process/history was lost. */
  async closeExisting(who:Who){
    const existing=this.all().find(r=>r.accountIndex===who.accountIndex&&r.status!=="done");
    if(existing){this.attach(existing.id,who);return this.close(existing.id);}
    const account=await this.venue.account(who.accountIndex);
    const held=account.positions.find(p=>p.marketId===this.marketId);
    if(!held)throw Error("No open position to close.");
    const round:Round={id:crypto.randomUUID(),status:"closing",outcome:null,entry:held.avgEntry,stake:0,leverage:0,seconds:0,startedAt:Date.now(),openedWith:account.collateral,accountIndex:who.accountIndex,size:held.size,unrealised:held.unrealised,realised:0,net:null,pnlReady:false,pts:[],orders:[],problem:null,untracked:true};
    this.accounts.add(who.accountIndex);this.live.set(round.id,round);this.whose.set(round.id,who);await this.save(round);
    await this.finish(round,this.marketInfo.get(round.id)??await this.venue.market(this.marketId),who);return round;
  }
  private async mark(round:Round,who:Who){
    const [account, fills] = await Promise.all([
      this.venue.account(who.accountIndex),
      this.venue.fills(who.accountIndex,this.marketId,who.trader.readToken(),round.startedAt-60000),
    ]);
    const held=account.positions.find(p=>p.marketId===this.marketId);
    const pnl=pnlFromFills(fills,round.orders,who.accountIndex);
    round.size=held?.size??0;round.unrealised=held?.unrealised??0;round.realised=pnl.realised;
    round.fills=pnl.matched.map(f=>({id:String(f.trade_id_str??f.trade_id),at:f.timestamp,buy:f.bid_account_id===who.accountIndex,price:Number(f.price),size:Number(f.size)}));
    const lastOrder=round.orders.at(-1);
    const lastSeen=!lastOrder || pnl.matched.some(f=>f.tx_hash===lastOrder.hash || String(f.ask_account_id===who.accountIndex?f.ask_client_id_str??f.ask_client_id:f.bid_client_id_str??f.bid_client_id)===lastOrder.clientOrderIndex);
    round.pnlReady=!round.untracked && lastSeen && (round.orders.length===0||pnl.count>0);
    if(lastOrder?.want===0){const closing=pnl.matched.filter(f=>f.tx_hash===lastOrder.hash || String(f.ask_account_id===who.accountIndex?f.ask_client_id_str??f.ask_client_id:f.bid_client_id_str??f.bid_client_id)===lastOrder.clientOrderIndex);const size=closing.reduce((n,f)=>n+Number(f.size??0),0);if(size>0)round.exit=closing.reduce((n,f)=>n+Number(f.size)*Number(f.price),0)/size;}
    round.net=round.pnlReady?round.realised+round.unrealised:null;
    this.publish(round);
  }
  private async confirmOrder(round:Round,market:MarketInfo,who:Who) {
    const order=round.orders.at(-1);
    if(!order || order.want===0 || this.confirmedOrders.get(round.id)===order.hash)return;
    for(let i=0;i<10;i++) {
      await this.mark(round,who);
      if(round.pnlReady && Math.abs(round.size-order.want)<Math.pow(10,-market.sizeDecimals)){this.confirmedOrders.set(round.id,order.hash);return;}
      if(i<9)await this.sleep(this.options.tickMs??1000);
    }
    throw Error("Order settlement is still pending on Lighter. Retry closing once confirmed.");
  }
  private cancelQueued(round:Round){for(const order of round.queue??[])if(order.status==="queued")order.status="cancelled";}
  private finish(round:Round,market:MarketInfo,who:Who):Promise<void>{
    const existing=this.closing.get(round.id);if(existing)return existing;
    if(round.status==="done")return Promise.resolve();
    // Stop the runner BEFORE awaiting any network operation.
    round.status="closing";
    this.cancelQueued(round);
    const task=this.complete(round,market,who).finally(()=>this.closing.delete(round.id));
    this.closing.set(round.id,task);return task;
  }
  private async complete(round:Round,market:MarketInfo,who:Who){
    try{
      await this.sending.get(round.id)?.catch(()=>undefined);
      // Observe the accepted opening/reversal before flattening; elapsed time is not confirmation.
      await this.confirmOrder(round, market, who);
      const clientOrderIndex=this.orderIndex();
      const requestedAt=Date.now();
      const flat=await who.trader.flatten(market,undefined,clientOrderIndex);
      if(flat)round.orders.push({at:Date.now(),requestedAt,want:0,hash:flat.hash,clientOrderIndex:String(clientOrderIndex)});
      let stable=0;
      for(let i=0;i<10;i++){
        if (i > 0) await this.sleep(this.options.tickMs??1000);
        await this.mark(round,who);
        stable=round.size===0&&(round.pnlReady||round.untracked)?stable+1:0;
        if(stable>=2){if(round.timing)round.timing.closedAt=Date.now();round.status="done";round.net=round.pnlReady?round.realised:null;round.outcome??="time";round.problem=null;break;}
      }
      if(round.status!=="done")round.problem="Still confirming the close with Lighter. Retry Close trade; no new round can start yet.";
    }catch(error){round.problem=`Close not confirmed: ${(error as Error).message.slice(0,140)}`;round.net=null;round.pnlReady=false;}
    if(round.status==="done" && !round.untracked && !this.options.sleep) {
      try {
        const response=await fetch(`${process.env.TRADE_FEED_URL??"http://localhost:3210"}/bars?n=1200`,{signal:AbortSignal.timeout(3000)});
        const data=await response.json() as {intervalMs:number;bars:{t:number;o:number;h:number;l:number;c:number;v:number}[]};
        if(response.ok&&data.intervalMs===500&&Array.isArray(data.bars))round.bars=data.bars.filter(b=>b.t*1000>=round.startedAt&&b.t*1000<=Date.now()).map(b=>({...b,t:b.t*1000}));
      }catch{/* A missing replay must never become a generated chart. */}
    }
    await this.save(round);
    if(round.status === "done") {this.accounts.delete(who.accountIndex);this.marketInfo.delete(round.id);this.confirmedOrders.delete(round.id);}
  }
  private async run(round:Round,shape:Shape,market:MarketInfo,spec:RoundSpec,who:Who){
    const full=spec.stake*spec.leverage/round.entry;
    try{
      while(Date.now()<round.startedAt+spec.seconds*1000&&round.status==="running"){
        const queued=round.queue?.find(order=>order.status==="queued");
        if(queued && Date.now()>=queued.dueAt){
          if(Date.now()>=queued.expiresAt)throw Error("A scheduled turn expired before settlement. Closing instead of replaying late orders.");
          queued.status="submitting";
          await this.save(round);
          if(round.status!=="running"){queued.status="cancelled";return;}
          const clientOrderIndex=this.orderIndex();
          const requestedAt=Date.now();
          const task=who.trader.goTo(market,queued.want,{cap:full,clientOrderIndex}).then(sent=>{
            if(sent){queued.hash=sent.hash;queued.status="submitted";round.orders.push({at:Date.now(),requestedAt,want:queued.want,hash:sent.hash,clientOrderIndex:String(clientOrderIndex)});}
            else queued.status="confirmed";
          }).catch(error=>{queued.status="failed";throw error;});
          this.sending.set(round.id,task);
          await task;this.sending.delete(round.id);
          await this.save(round);
          // Never reverse against an eventually consistent position read.
          if (round.status === "running") {await this.confirmOrder(round, market, who);queued.status="confirmed";await this.save(round);}
        }
        if(round.status!=="running")return;
        await this.mark(round,who);
        if(Math.abs(round.size)>full*2+market.minBase)throw Error("Position exceeds this round’s target size.");
        if(round.net!==null&&spec.exits.lose!==null&&round.net<=-Math.abs(spec.exits.lose)){round.outcome="stop";break;}
        if(round.net!==null&&spec.exits.gain!==null&&round.net>=Math.abs(spec.exits.gain)){round.outcome="target";break;}
        const now=Date.now();
        const end=round.startedAt+spec.seconds*1000;
        const nextTurn=round.queue?.find(order=>order.status==="queued")?.dueAt;
        // Wake at the actual turn/end instead of adding a full polling tick.
        await this.sleep(Math.max(0,Math.min(this.options.tickMs??1000,(nextTurn??end)-now,end-now)));
      }
      if(round.status==="running")await this.finish(round,market,who);
    }catch(error){round.problem=(error as Error).message.slice(0,160);round.outcome="failed";await this.finish(round,market,who);}
  }
}
