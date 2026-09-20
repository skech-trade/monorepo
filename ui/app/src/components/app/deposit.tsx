"use client";

import { useSendEvmTransaction } from "@coinbase/cdp-hooks";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { usd } from "@/lib/market";
import { type Chain, type DepositQuote, type NoDeposits, useDepositAddress, useDepositChains, useDepositQuote } from "@/lib/deposit";
import { cn } from "@/lib/utils";
import { DepositAddress } from "./deposit-address";
import { ChainMark, TokenMark } from "./marks";

/**
 * Putting money on the venue.
 *
 * Hold anything, anywhere, end up with collateral on Lighter. Lighter hands
 * out an address that credits your perp account, making one if you have none;
 * Relay turns whatever you are holding into USDC on a chain Lighter watches
 * and sends it there. Neither needs a key, and the wallet signs one
 * transaction.
 *
 * The figures come from Relay before anything is signed, so what lands is a
 * number you saw rather than one you find out afterwards.
 */

/** Whole tokens to the smallest unit, without floating point eating the end. */
function units(amount: string, decimals: number): string | null {
  if (!/^\d*\.?\d*$/.test(amount) || amount === "" || amount === ".") return null;
  const [whole = "0", part = ""] = amount.split(".");
  const padded = (part + "0".repeat(decimals)).slice(0, decimals);
  const out = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return /^\d+$/.test(out) && BigInt(out) > 0n ? out : null;
}

function Line({ quote, busy, typed, ready }: { quote: DepositQuote | null; busy: boolean; typed: boolean; ready: boolean }) {
  // Each of these used to read "type an amount", including when an amount had
  // been typed and the reason was that nothing was configured.
  if (!ready) return <p className="text-muted-foreground text-sm">No route service configured, so nothing can be priced.</p>;
  if (busy) return <p className="text-muted-foreground text-sm">Working out the route…</p>;
  if (!typed) return <p className="text-muted-foreground text-sm">Type an amount and we will price it.</p>;
  if (!quote) return <p className="text-muted-foreground text-sm">No route for that amount. Try a little more.</p>;
  const cost = Math.abs(quote.impactUsd);
  return (
    <p className="text-muted-foreground text-sm leading-snug">
      <span className="figures font-medium text-foreground">
        {quote.inAmount} {quote.inSymbol}
      </span>{" "}
      becomes{" "}
      <span className="figures font-medium text-up">${usd(Number(quote.outAmount))}</span> on Lighter
      {cost >= 0.01 ? (
        <>
          , costing <span className="figures">${usd(cost)}</span>
        </>
      ) : null}
      {quote.seconds > 0 ? `, in about ${quote.seconds} second${quote.seconds === 1 ? "" : "s"}` : ", more or less at once"}.
    </p>
  );
}

export function DepositSheet({ address, open, onOpenChange, onDone }: { address: string | null; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const chains = useDepositChains();
  const found = useDepositAddress(address);
  const off = found && "canDeposit" in found && found.canDeposit === false ? (found as NoDeposits) : null;
  const deposit = off ? null : (found as Exclude<typeof found, NoDeposits> | null);
  /* Sending from the skech wallet is the second way, not the first: a wallet
     made a minute ago has nothing in it, so leading with it asks somebody to
     fund it and then bridge out of it, which is two moves for one deposit. */
  const [bridging, setBridging] = useState(false);
  const [chainId, setChainId] = useState<number | null>(null);
  const [native, setNative] = useState(false);
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const { sendEvmTransaction } = useSendEvmTransaction();

  /* Whichever was picked, else the first one the API listed. Derived rather
     than copied into state, so there is no effect to keep the two in step. */
  const chain: Chain | null = chains.find((c) => c.id === chainId) ?? chains[0] ?? null;

  const decimals = native ? 18 : 6;
  const smallest = units(amount, decimals);
  const { quote, busy } = useDepositQuote(address, chain, native, smallest);

  const send = async () => {
    if (!quote || !address || !chain) return;
    setSending(true);
    setProblem(null);
    try {
      // Relay hands back what to sign. Every step is a plain transaction, and
      // the wallet is the only thing that can sign one.
      let last: string | null = null;
      for (const tx of quote.transactions) {
        const { transactionHash } = await sendEvmTransaction({
          evmAccount: address as `0x${string}`,
          network: chain.network,
          transaction: { to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value ?? "0"), chainId: chain.id, type: "eip1559" },
        });
        last = transactionHash;
      }
      setSent(last);
      onDone();
    } catch (e) {
      setProblem((e as Error).message.slice(0, 160));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="sm:max-w-sm" side="right" variant="inset">
        <SheetHeader>
          <SheetTitle>Add money</SheetTitle>
          <SheetDescription>Whatever you are holding, wherever it is. It lands as collateral on Lighter.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {off ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <p className="font-medium text-sm">Nothing to deposit into on testnet.</p>
              <p className="text-muted-foreground text-xs leading-snug">
                {off.reason} Ask Lighter for test funds, then come back and draw. Everything else on this screen is the real thing:
                the orders are signed and settled exactly as they will be.
              </p>
            </div>
          ) : null}
          {deposit && !bridging ? (
            <>
              <DepositAddress address={deposit.address} chains={deposit.chains} minimum={deposit.minimum} network={deposit.network} />
              <Button className="w-full" onClick={() => setBridging(true)} variant="outline">
                Or send from this wallet
              </Button>
            </>
          ) : null}

          {off || (deposit && !bridging) ? null : (
          <>
          {deposit ? (
            <Button className="-mt-1 self-start" onClick={() => setBridging(false)} size="xs" variant="ghost">
              Back to the address
            </Button>
          ) : null}
          {/* A grid, not a strip: six chains will not sit in one row, and a
              mark is quicker to find than a word. */}
          <div>
            <p className="pb-2 font-medium text-muted-foreground text-xs">From</p>
            <div className="grid grid-cols-3 gap-1.5" role="group">
              {chains.map((c) => (
                <button
                  aria-pressed={chain?.id === c.id}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    chain?.id === c.id && "border-foreground/24 bg-accent",
                  )}
                  key={c.id}
                  onClick={() => setChainId(c.id)}
                  type="button"
                >
                  <ChainMark className="size-4" id={c.id} />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="pb-2 font-medium text-muted-foreground text-xs">Send</p>
            <div className="flex gap-1.5">
              {[false, true].map((isNative) => (
                <button
                  aria-pressed={native === isNative}
                  className={cn(
                    "flex flex-1 cursor-pointer items-center gap-1.5 rounded-xl border px-2 py-1.5 text-xs transition-colors hover:bg-accent",
                    native === isNative && "border-foreground/24 bg-accent",
                  )}
                  key={String(isNative)}
                  onClick={() => setNative(isNative)}
                  type="button"
                >
                  <TokenMark chainId={chain?.id ?? 8453} className="size-4" native={isNative} />
                  <span className="truncate">{isNative ? (chain?.nativeSymbol ?? "ETH") : "USDC"}</span>
                </button>
              ))}
            </div>
          </div>

          <Input
            autoComplete="off"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={native ? "0.01" : "25"}
            value={amount}
          />

          <Line busy={busy} quote={quote} ready={chains.length > 0} typed={smallest !== null} />

          {problem ? <p className="text-down text-xs">{problem}</p> : null}
          {sent ? <p className="text-muted-foreground text-xs">Sent. It shows up as collateral once it lands.</p> : null}

          <Button className={cn("w-full")} disabled={!quote || sending} loading={sending} onClick={() => void send()}>
            {quote ? `Add $${usd(Number(quote.outAmount))}` : "Add money"}
          </Button>

          <p className="text-muted-foreground text-xs leading-snug">
            Whatever is in this wallet, turned into collateral in one go. If you have never used Lighter, this makes the account.
          </p>
          </>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
