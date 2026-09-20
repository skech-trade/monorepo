"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCopy } from "./copy";
import type { SendTo } from "@/lib/deposit";
import { ChainMark, UsdcMark } from "./marks";

/**
 * The address that is the whole deposit.
 *
 * One per person, the same on every chain Lighter watches, and open to
 * anyone: USDC sent from Coinbase, an exchange, another wallet or a friend
 * all land on their account, and make it if there is not one.
 *
 * This is why it leads. Everything else asks somebody to fund a brand new
 * wallet and then bridge out of it, which is two moves and a balance sitting
 * in a place that is neither their own wallet nor their position.
 */
export function DepositAddress({ address, chains, minimum, network }: { address: string; chains: readonly SendTo[]; minimum: number; network: "mainnet" | "testnet" }) {
  const [qr, setQr] = useState<string | null>(null);
  const { copied, copy } = useCopy(address);

  useEffect(() => {
    let live = true;
    // Drawn here, so no image is fetched and nothing about the address leaves
    // the page to be rendered somewhere else.
    QRCode.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: "M", color: { dark: "#000000ff", light: "#ffffffff" } })
      .then((url) => live && setQr(url))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address]);

  /*
    A testnet address looks exactly like a mainnet one, and only one of them
    is somewhere real money survives. So it is said first, in red, and the
    address is not dressed up as somewhere to send anything.
  */
  if (network === "testnet") {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-down/40 bg-destructive/6 p-3">
        <p className="font-medium text-down text-sm">This is a testnet address.</p>
        <p className="text-muted-foreground text-xs leading-snug">
          Real USDC sent here is gone and cannot be recovered. Point the API at mainnet before showing anybody this screen.
        </p>
        <p className="break-all font-mono text-[11px] text-muted-foreground leading-snug">{address}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm leading-snug">
        Send <span className="font-medium text-foreground">USDC</span> here from anywhere: Coinbase, an exchange, another wallet. It arrives as collateral,
        usually within a few minutes.
      </p>

      {/* White whatever the theme, because a dark QR on a dark ground does not scan. */}
      <div className="flex items-center gap-3 rounded-xl border bg-white p-3">
        {/* biome-ignore lint/performance/noImgElement: a data URI made on this page, with nothing to optimise */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qr ? <img alt="" className="size-24 shrink-0" src={qr} /> : <div className="size-24 shrink-0 animate-pulse rounded bg-black/5" />}
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-[11px] text-black leading-snug">{address}</p>
          {/* The card is white whatever the theme, so this button cannot take
              its colours from the theme: in dark mode it came out white on
              white and read as missing. */}
          <Button
            className="mt-2 border-black/15 bg-white text-black hover:border-black/25 hover:bg-black/5"
            onClick={() => void copy()}
            size="xs"
            variant="outline"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy address"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1">
          <UsdcMark className="size-4" /> USDC only
        </span>
        {chains.map((c) => (
          <span className="inline-flex items-center gap-1" key={c.id}>
            <ChainMark className="size-4" id={c.id} /> {c.name}
          </span>
        ))}
      </div>

      <p className="text-muted-foreground text-xs leading-snug">
        At least ${minimum}, and it has to be Circle&rsquo;s own USDC on one of those three chains. Any other token, any other chain, or a bridged
        lookalike will not arrive and cannot be recovered.
      </p>
    </div>
  );
}
