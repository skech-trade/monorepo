"use client";

import { useSendEvmTransaction } from "@coinbase/cdp-hooks";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { usd } from "@/lib/market";
import { askFaucet, type Chain, type DepositQuote, type NoDeposits, useDepositAddress, useDepositChains, useDepositQuote } from "@/lib/deposit";
import { cn } from "@/lib/utils";
import { CopyAddress } from "./copy";
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

/**
 * Testnet, where there is nothing to deposit into.
 *
 * The old version pointed at Lighter's own site and said to connect a wallet
 * there. That does not work here: the wallet we make is embedded, with no
 * extension and no WalletConnect, so there is nothing to connect with. The
 * faucet turns out to take a plain address, so the button does it, and the
 * screen is a button rather than three paragraphs about testnet.
 */
function Testnet({ address, onDone, amount = 10000, available = true }: { address: string | null; onDone: () => void; amount?: number; available?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [worked, setWorked] = useState(false);

  const ask = async () => {
    if (!address) return;
    setBusy(true);
    setSaid(null);
    const out = await askFaucet(address);
    setBusy(false);
    setWorked(out.ok);
    setSaid(out.ok ? "On the way. It lands in a few seconds." : out.reason);
    /* The venue takes eight seconds or so to show a brand new account, and
       sometimes longer. Asking three times beats asking once and looking
       broken, and the balance polls on its own after that anyway. */
    if (out.ok) for (const ms of [6000, 12000, 20000]) setTimeout(onDone, ms);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-primary/20 bg-primary/5 p-7">
        <span className="rounded-full border border-primary/20 px-2.5 py-1 text-xs font-medium text-primary">TESTNET</span>
        <p className="mt-6 text-4xl font-semibold tracking-tight tabular-nums">${usd(amount)}</p>
        <p className="mt-2 text-sm text-muted-foreground">Practice funds. No real money needed.</p>
      </div>
      <div className="space-y-3"><p className="text-sm font-medium">Get a feel for Skech.</p><p className="text-sm leading-relaxed text-muted-foreground">Draw your first prediction and explore the trading experience with test funds. They have no cash value.</p></div>
      <Button className="h-12 sm:h-12 w-full" disabled={!address || busy || !available} loading={busy} onClick={() => void ask()}>{worked ? "Request again" : `Get $${usd(amount)} in test funds`}</Button>
      {!available ? <p className="text-sm text-muted-foreground">Test funds are temporarily unavailable.</p> : null}
      {said ? <p role="status" className={cn("rounded-xl border p-3 text-sm leading-relaxed", worked ? "text-up" : "text-muted-foreground")}>{said}</p> : null}
      {address ? <div className="flex items-center justify-between gap-2 border-t pt-4"><span className="text-xs text-muted-foreground">Your wallet</span><CopyAddress address={address} className="text-xs"/></div> : null}
    </div>
  );
}

export function DepositSheet({ address, open, onOpenChange, onDone }: { address: string | null; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const chains = useDepositChains();
  const {found, error, retry} = useDepositAddress(address);
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
      <SheetPopup className="sm:max-w-md" side="right" variant="inset">
        <SheetHeader className="px-6 pt-8 sm:px-8">
          <SheetTitle className="text-3xl font-semibold tracking-tight">{off ? "Room to explore." : "Add funds."}</SheetTitle>
          <SheetDescription>{off ? "Your first prediction starts here." : "Choose how you’d like to fund your Lighter account."}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-6 px-6 pb-8 sm:px-8">
          {!found ? error ? <div role="status" className="space-y-4 rounded-2xl border p-5"><p className="text-sm text-muted-foreground">{error}</p>{address ? <Button variant="outline" onClick={retry}>Try again</Button> : null}</div> : <div role="status" className="rounded-2xl border p-8 text-center text-sm text-muted-foreground">Loading your funding options…</div> : null}
          {off ? <Testnet address={address} onDone={onDone} amount={off.amount} available={off.canFaucet !== false}/> : null}
          {deposit && (!bridging || deposit.network !== "mainnet") ? (
            <>
              <DepositAddress address={deposit.address} chains={deposit.chains} minimum={deposit.minimum} network={deposit.network} />
              {deposit.network === "mainnet" ? <Button className="h-12 sm:h-12 w-full" onClick={() => setBridging(true)} variant="outline">
                Send from my Skech wallet
              </Button> : null}
            </>
          ) : null}

          {!deposit || deposit.network !== "mainnet" || off || !bridging ? null : (
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
                <Button
                  aria-pressed={chain?.id === c.id}
                  className={cn("min-w-0 justify-start gap-1.5 px-2 text-xs", chain?.id === c.id && "border-foreground/24 bg-accent")}
                  key={c.id}
                  onClick={() => setChainId(c.id)}
                  size="sm"
                  variant="outline"
                >
                  <ChainMark className="size-4" id={c.id} />
                  <span className="truncate">{c.name}</span>
                </Button>
              ))}
            </div>
          </div>

          <div>
            <p className="pb-2 font-medium text-muted-foreground text-xs">Send</p>
            <div className="flex gap-1.5">
              {[false, true].map((isNative) => (
                <Button
                  aria-pressed={native === isNative}
                  className={cn("flex-1 gap-1.5 px-2 text-xs", native === isNative && "border-foreground/24 bg-accent")}
                  key={String(isNative)}
                  onClick={() => setNative(isNative)}
                  size="sm"
                  variant="outline"
                >
                  <TokenMark chainId={chain?.id ?? 8453} className="size-4" native={isNative} />
                  <span className="truncate">{isNative ? (chain?.nativeSymbol ?? "ETH") : "USDC"}</span>
                </Button>
              ))}
            </div>
          </div>

          <label className="space-y-2 text-sm font-medium">Amount
          <Input
            className="h-16 text-2xl tabular-nums"
            autoComplete="off"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={native ? "0.01" : "25"}
            value={amount}
          />
          </label>

          <Line busy={busy} quote={quote} ready={chains.length > 0} typed={smallest !== null} />

          {problem ? <p className="text-down text-xs">{problem}</p> : null}
          {sent ? <p className="text-muted-foreground text-xs">Sent. It shows up as collateral once it lands.</p> : null}

          <Button className="h-12 sm:h-12 w-full" disabled={!quote || busy || sending} loading={sending} onClick={() => void send()}>
            {quote ? `Add $${usd(Number(quote.outAmount))}` : "Enter an amount"}
          </Button>

          <p className="text-muted-foreground text-xs leading-snug">
            Review the amount above before confirming in your wallet. Funds arrive as USDC collateral on Lighter.
          </p>
          </>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
