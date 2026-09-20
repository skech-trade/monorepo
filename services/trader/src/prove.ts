/** A full round against the venue, signed from TypeScript. Run by hand, not in CI. */
import { Lighter } from "./lighter";
import { ACCOUNT, API_KEY_INDEX, BASE, CHAIN_ID, MARKET_ID, NETWORK, PRIVATE_KEY } from "./network";
import { Trader } from "./round";
import { Signer } from "./signer";

const venue = new Lighter(BASE);
const accountIndex = ACCOUNT;
const signer = Signer.open({ url: BASE, privateKey: PRIVATE_KEY, chainId: CHAIN_ID, accountIndex, apiKeyIndex: API_KEY_INDEX });
console.log(`signer: key accepted, on ${NETWORK}, account ${accountIndex}`);

const market = await venue.market(MARKET_ID);
console.log(`market ${market.id} ${market.symbol}  last ${market.last}  min ${market.minBase} BTC / $${market.minQuote}`);

const trader = new Trader(venue, signer, accountIndex);
const want = Math.max(market.minBase, market.minQuote / market.last * 1.2);
console.log(`opening ${want.toFixed(5)} BTC (about $${(want * market.last).toFixed(2)})`);
console.log("open :", (await trader.goTo(market, want, { cap: want }))?.hash.slice(0, 26) ?? "nothing to send");

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
