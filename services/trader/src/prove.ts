/** A full round against the venue, signed from TypeScript. Run by hand, not in CI. */
import { Lighter } from "./lighter";
import { Trader } from "./round";
import { Signer } from "./signer";

const base = process.env.LIGHTER_BASE_URL!;
const venue = new Lighter(base);
const accountIndex = Number(process.env.LIGHTER_ACCOUNT_INDEX!);
const signer = Signer.open({
  url: base,
  privateKey: process.env.LIGHTER_PRIVATE_KEY!,
  chainId: Number(process.env.LIGHTER_CHAIN_ID ?? 300),
  accountIndex,
  apiKeyIndex: Number(process.env.LIGHTER_API_KEY_INDEX!),
});
console.log("signer: key accepted");

const market = await venue.market(Number(process.env.LIGHTER_MARKET_ID ?? 4096));
console.log(`market ${market.id} ${market.symbol}  last ${market.last}  min ${market.minBase} BTC / $${market.minQuote}`);

const trader = new Trader(venue, signer, accountIndex);
const want = Math.max(market.minBase, market.minQuote / market.last * 1.2);
console.log(`opening ${want.toFixed(5)} BTC (about $${(want * market.last).toFixed(2)})`);
console.log("open :", (await trader.goTo(market, want))?.hash.slice(0, 26) ?? "nothing to send");

for (let i = 0; i < 12; i++) {
  await Bun.sleep(1000);
  const p = await venue.positionIn(accountIndex, market.id);
  if (p) { console.log(`filled: ${p.size} BTC @ ${p.avgEntry}  value $${p.value}  unrealised ${p.unrealised}`); break; }
}

console.log("close:", (await trader.flatten(market))?.hash.slice(0, 26) ?? "nothing to send");
for (let i = 0; i < 12; i++) {
  await Bun.sleep(1000);
  if (!(await venue.positionIn(accountIndex, market.id))) { console.log("flat again"); break; }
}
