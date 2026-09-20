"use client";

import { useSendEvmTransaction } from "@coinbase/cdp-hooks";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { usd } from "@/lib/market";
import { type Chain, type DepositQuote, useDepositChains, useDepositQuote } from "@/lib/deposit";
import { cn } from "@/lib/utils";
import { Segmented } from "./controls";

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

function Line({ quote, busy }: { quote: DepositQuote | null; busy: boolean }) {
  if (busy) return <p className="text-muted-foreground text-sm">Working out the route…</p>;
  if (!quote) return <p className="text-muted-foreground text-sm">Type an amount and we will price it.</p>;
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
          {chains.length > 1 ? (
            <Segmented label="Which chain" onChange={(v) => setChainId(Number(v))} options={chains.map((c) => ({ value: String(c.id), label: c.name }))} size="sm" value={String(chain?.id ?? "")} />
          ) : null}

          <Segmented
            label="Which token"
            onChange={(v) => setNative(v === "native")}
            options={[
              { value: "usdc", label: "USDC" },
              { value: "native", label: chain?.nativeSymbol ?? "ETH" },
            ]}
            size="sm"
            value={native ? "native" : "usdc"}
          />

          <Input
            autoComplete="off"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={native ? "0.01" : "25"}
            value={amount}
          />

          <Line busy={busy} quote={quote} />

          {problem ? <p className="text-down text-xs">{problem}</p> : null}
          {sent ? <p className="text-muted-foreground text-xs">Sent. It shows up as collateral once it lands.</p> : null}

          <Button className={cn("w-full")} disabled={!quote || sending} loading={sending} onClick={() => void send()}>
            {quote ? `Add $${usd(Number(quote.outAmount))}` : "Add money"}
          </Button>

          <p className="text-muted-foreground text-xs leading-snug">
            It goes to an address Lighter gave for your wallet. If you have never used Lighter, the first deposit makes the account.
          </p>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
