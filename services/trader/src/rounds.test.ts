import {expect,test} from "bun:test";
import {Rounds,dirAt,planOrders,type RoundSpec,type Round} from "./rounds";
import type {Lighter} from "./lighter";
import type {Trader} from "./round";
const market={id:1,last:100,symbol:"BTC",minBase:.001,minQuote:1,sizeDecimals:3,priceDecimals:2};
const spec:RoundSpec={pts:[{t:0,price:100},{t:1,price:105}],stake:100,leverage:1,seconds:1,exits:{lose:null,gain:null}};
function fixture(staleReads=0){
 let held=0;let opens=0,closes=0;const waits:number[]=[];const wants:number[]=[];const fills:any[]=[];
 const venue={market:async()=>market,account:async()=>({collateral:10000,positions:held && !(staleReads>0 && staleReads--)?[{marketId:1,size:held,unrealised:-1,avgEntry:100}]:[]}),fills:async()=>fills};
 const trader={readToken:()=>"test",setLeverage:async()=>{},goTo:async(_:unknown,want:number,options:any)=>{opens++;wants.push(want);await Bun.sleep(20);held=want;fills.push({trade_id:1,tx_hash:"open",timestamp:Date.now(),ask_account_id:7,bid_account_id:1,bid_id_str:"1",bid_client_id_str:String(options.clientOrderIndex),price:"100",size:"1"});return{hash:"open"};},flatten:async(_:unknown,_cap:unknown,client:bigint)=>{closes++;held=0;fills.push({trade_id:2,tx_hash:"close",timestamp:Date.now(),ask_account_id:1,bid_account_id:7,ask_id_str:"2",ask_client_id_str:String(client),ask_account_pnl:"-4",price:"96",size:"1"});return{hash:"close"};}};
 const rounds=new Rounds(venue as unknown as Lighter,1,{tickMs:1,sleep:async(ms)=>{waits.push(ms);await Bun.sleep(ms);}});
 return{rounds,waits,wants,who:{accountIndex:1,trader:trader as unknown as Trader},counts:()=>({opens,closes})};
}
test("close waits for an in-flight open, runs once, and cannot reopen",async()=>{
 const f=fixture();const r=await f.rounds.open(spec,f.who);
 await Promise.all([f.rounds.close(r.id),f.rounds.close(r.id)]);
 await Bun.sleep(30);
 expect(f.counts()).toEqual({opens:1,closes:1});expect(r.status).toBe("done");expect(r.net).toBe(-4);expect(r.realised).toBe(-4);expect(r.size).toBe(0);
});
test("concurrent requests cannot run two strategies on the same account",async()=>{
 const f=fixture();const results=await Promise.allSettled([f.rounds.open(spec,f.who),f.rounds.open(spec,f.who)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 const round=f.rounds.all()[0];await f.rounds.close(round.id);
});
test("restored unfinished round blocks new orders until explicitly closed",async()=>{
 const f=fixture();const r=await f.rounds.open(spec,f.who);await f.rounds.close(r.id);
 const restored:Round={...r,id:"restored",status:"running" as const};f.rounds.restore(restored,f.who);
 expect(restored.status).toBe("closing");await expect(f.rounds.open(spec,f.who)).rejects.toThrow("existing round");
});

test("settlement checks tolerate lagging account reads without a fixed three-second sleep",async()=>{
 const f=fixture(3);const r=await f.rounds.open(spec,f.who);await f.rounds.close(r.id);
 expect(r.status).toBe("done");expect(f.counts()).toEqual({opens:1,closes:1});
 expect(f.waits.every(ms=>ms<=1)).toBe(true);
});
test("reference chart direction is independent of execution price",async()=>{
 const f=fixture();const r=await f.rounds.open({...spec,pts:[{t:0,price:200},{t:1,price:190}]},f.who);
 await f.rounds.close(r.id);
 expect(r.entry).toBe(100);expect(r.chartEntry).toBe(200);expect(f.wants[0]).toBeLessThan(0);
});

test("turn changes at the boundary instead of one sampled interval later",()=>{
 const shape={legs:[{from:0,to:10,dir:1},{from:10,to:31,dir:-1}],long:true} as Parameters<typeof dirAt>[0];
 expect(dirAt(shape,10/31-0.000001)).toBe(1);
 expect(dirAt(shape,10/31)).toBe(-1);
 expect(dirAt(shape,10/31+0.000001)).toBe(-1);
});

test("queue is ordered at exact turn deadlines and expires before the following turn",()=>{
 const shape={legs:[{from:0,to:10,dir:1},{from:10,to:20,dir:-1},{from:20,to:31,dir:1}]} as Parameters<typeof planOrders>[0];
 const q=planOrders(shape,1000,31,2);
 expect(q.map(x=>[x.dueAt,x.expiresAt,x.want,x.status])).toEqual([[1000,11000,2,"queued"],[11000,21000,-2,"queued"],[21000,32000,2,"queued"]]);
});
test("manual close cancels future queued turns and does not submit them",async()=>{
 const f=fixture();const r=await f.rounds.open({...spec,seconds:31,pts:[{t:0,price:100},{t:.5,price:110},{t:1,price:90}]},f.who);
 await f.rounds.close(r.id);
 expect(r.queue?.some(order=>order.status==="cancelled")).toBe(true);
 expect(r.queue?.some(order=>order.status==="queued")).toBe(false);
 expect(f.counts().opens).toBeLessThanOrEqual(1);
 expect(r.status).toBe("done");
});

test("subscribers immediately receive closing and confirmed results without polling",async()=>{
 const f=fixture();const r=await f.rounds.open(spec,f.who);const states:string[]=[];
 const unsubscribe=f.rounds.subscribe(r.id,round=>states.push(round.status));
 expect(states).toHaveLength(1);
 const closing=f.rounds.close(r.id);
 expect(states).toContain("closing");
 await closing;
 expect(states.at(-1)).toBe("done");
 unsubscribe();
});
