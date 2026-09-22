import {expect,test} from "bun:test";
import {pnlFromFills,type Fill} from "./pnl";
const fill=(id:number,hash:string,order:string,pnl:string):Fill=>({trade_id:id,tx_hash:hash,timestamp:1,ask_account_id:427,bid_account_id:7,ask_id_str:order,ask_account_pnl:pnl});
test("partial fills with different hashes are included once; unrelated fills are excluded",()=>{
 const fills=[fill(1,"close","a","-1.184355"),fill(2,"other-hash","a","-2.785783"),fill(2,"other-hash","a","-2.785783"),fill(3,"unrelated","b","9000")];
 expect(pnlFromFills(fills,[{hash:"close"}],427).realised).toBeCloseTo(-3.970138,6);
 expect(pnlFromFills(fills,[{hash:"close"}],427).count).toBe(2);
});
test("both trade directions use the account's own P&L",()=>{
 const f={...fill(1,"buy","a","-900"),ask_account_id:7,bid_account_id:427,bid_id_str:"b",bid_account_pnl:"-4.593190"};
 expect(pnlFromFills([f],[{hash:"buy"}],427).realised).toBeCloseTo(-4.59319,6);
});
test("credits and collateral allocations cannot enter fill accounting",()=>{
 const a=pnlFromFills([fill(1,"trade","a","-10.697232")],[{hash:"trade"}],427);
 expect(a.realised).toBeCloseTo(-10.697232,6);
});
