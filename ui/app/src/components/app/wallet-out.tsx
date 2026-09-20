"use client";

import { useExportEvmAccount } from "@coinbase/cdp-hooks";
import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyAddress, useCopy } from "./copy";

/**
 * Getting out of the skech wallet.
 *
 * Money can end up sitting here rather than on Lighter: a deposit that was
 * sent to the wallet instead of the deposit address, a bridge that half
 * finished, a token nobody meant to send. It is the reader's wallet and not
 * ours, so there has to be a way out that does not depend on us existing.
 *
 * Exporting the key is that way. It is the strongest possible answer, because
 * it works whatever happens to this app: paste it into any wallet and
 * everything on every chain is reachable, including whatever we never thought
 * to support. It is also the most dangerous thing on the screen, so it is
 * behind a press and says plainly what it is.
 */
export function WalletOut({ address }: { address: string }) {
  const { exportEvmAccount } = useExportEvmAccount();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { copied, copy } = useCopy(key, 1800);

  const reveal = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { privateKey } = await exportEvmAccount({ evmAccount: address as `0x${string}` });
      setKey(privateKey);
    } catch (e) {
      setProblem((e as Error).message.slice(0, 140));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <CopyAddress address={address} className="self-start text-muted-foreground text-xs" />
      <p className="text-muted-foreground text-xs leading-snug">
        Made for you the moment you signed in, and nobody else holds it. Anything sent here by mistake is still yours: take the key into any wallet and it
        is all reachable, on every chain.
      </p>

      {key ? (
        <div className="flex flex-col gap-2 rounded-xl border border-down/40 bg-destructive/6 p-3">
          <p className="font-medium text-down text-xs">Anyone with this can spend everything in the wallet. Never paste it into a website or send it to anybody.</p>
          <p className="break-all font-mono text-[11px] leading-snug">{key}</p>
          <div className="flex gap-2">
            <Button onClick={() => void copy()} size="xs" variant="outline">
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button onClick={() => setKey(null)} size="xs" variant="ghost">
              Hide
            </Button>
          </div>
        </div>
      ) : (
        <Button className="self-start" loading={busy} onClick={() => void reveal()} size="sm" variant="outline">
          <KeyRoundIcon />
          Show the key
        </Button>
      )}

      {problem ? <p className="text-down text-xs">{problem}</p> : null}
    </div>
  );
}
