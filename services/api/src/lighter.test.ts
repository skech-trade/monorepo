import { expect, test } from "bun:test";
import { Lighter } from "./lighter";

test("isolated allocation is not a portfolio loss: use venue total equity", async () => {
  const account = {
    collateral: "19865.257413",
    available_balance: "19865.257413",
    total_asset_value: "19968.117359",
    positions: [{ position: "0.03475", unrealized_pnl: "0.962575", allocated_margin: "101.897371" }],
  };
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ accounts: [account] }) });
  try {
    const b = await new Lighter(`http://localhost:${server.port}`).balanceOf(427);
    expect(b?.equity).toBe(19968.117359);
    expect(b?.collateral).toBe(19865.257413);
    expect(b?.unrealised).toBe(0.962575);
  } finally {
    server.stop(true);
  }
});
