import { type Address, getAddress, isAddress } from "viem";

/*
  Where a withdrawal goes, from whatever the player pasted or scanned.

  People paste an address, and wallets put one of these in their "receive" QR codes:
    0xabc…                                            the address alone
    ethereum:0xabc…  or  ethereum:0xabc…@10143         EIP-681, native transfer to it
    ethereum:0xUSDC…@10143/transfer?address=0xabc…&uint256=5e6
                                                      EIP-681, a token transfer: the recipient is `address`
  plus stray spaces, a trailing newline, and "pay-" prefixes some wallets add. What comes back is the
  recipient, checksummed, and whatever else the code said: an amount of USDC, a chain, a token.
*/

export type Destination = { address: Address; amount?: number; chainId?: number; token?: Address };

export function parseDestination(raw: string, usdc?: string): Destination | { error: string } {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return { error: "Paste or scan an address" };
  if (isAddress(text, { strict: false })) return { address: getAddress(text) };

  const m = /^(?:ethereum:)?(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/(\w+))?(?:\?(.*))?$/.exec(text);
  if (!m) return { error: "That isn't an address" };
  const [, target, chain, fn, query] = m;
  const params = new URLSearchParams(query ?? "");
  const chainId = chain ? Number(chain) : undefined;

  if (fn === "transfer") {
    const to = params.get("address");
    if (!to || !isAddress(to, { strict: false })) return { error: "That code has no address to send to" };
    const token = getAddress(target);
    if (usdc && token.toLowerCase() !== usdc.toLowerCase()) return { error: "That code is for a different token, not USDC" };
    const units = params.get("uint256");
    const amount = units !== null && Number.isFinite(Number(units)) && Number(units) > 0 ? Number(units) / 1e6 : undefined;
    return { address: getAddress(to), token, chainId, amount: amount === undefined ? undefined : Math.floor(amount * 100) / 100 };
  }
  if (fn) return { error: "That code asks for something other than a transfer" };
  // A plain address in URI form. `amount` is what a few wallets use for a human amount; `value` is wei of the
  // chain's own coin, which says nothing about USDC and is ignored.
  const human = params.get("amount");
  const amount = human !== null && Number.isFinite(Number(human)) && Number(human) > 0 ? Math.floor(Number(human) * 100) / 100 : undefined;
  return { address: getAddress(target), chainId, amount };
}
