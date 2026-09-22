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
  const [image, setImage] = useState<{address: string; url: string} | null>(null);
  const qr = image?.address === address ? image.url : null;
  const { copied, copy } = useCopy(address);

  useEffect(() => {
    let live = true;
    // Drawn here, so no image is fetched and nothing about the address leaves
    // the page to be rendered somewhere else.
    QRCode.toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: "M", color: { dark: "#000000ff", light: "#ffffffff" } })
      .then((url) => live && setImage({address,url}))
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
    <div className="space-y-5">
      <div className="rounded-3xl border bg-muted/20 p-5 text-center">
        <div className="mb-4 flex items-center justify-center gap-2 text-sm font-medium"><UsdcMark className="size-5"/> Receive USDC</div>
        <div className="mx-auto flex size-44 items-center justify-center rounded-2xl bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {qr ? <img alt="Deposit address QR code" className="size-full" src={qr}/> : <div role="status" aria-label="Preparing QR code" className="size-full animate-pulse rounded bg-black/5"/>}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Scan from another wallet</p>
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Your deposit address</p>
        <p className="break-all rounded-xl border bg-muted/20 p-4 font-mono text-xs leading-relaxed">{address}</p>
        <Button className="h-12 sm:h-12 w-full" onClick={() => void copy()}>{copied ? <CheckIcon/> : <CopyIcon/>}{copied ? "Address copied" : "Copy deposit address"}</Button>
      </div>
      <div className="space-y-3"><p className="text-xs font-medium text-muted-foreground">Supported networks</p><div className="flex flex-wrap gap-2">{chains.map(c => <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs"><ChainMark className="size-4" id={c.id}/>{c.name}</span>)}</div></div>
      <div className="rounded-2xl border p-4 text-xs leading-relaxed text-muted-foreground"><p className="mb-1 font-medium text-foreground">Minimum deposit · ${minimum}</p>Send only native USDC issued by Circle on a supported network. Other tokens and bridged USDC may be lost. Funds usually arrive within a few minutes.</div>
    </div>
  );
}
