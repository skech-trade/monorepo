"use client";

import { SignInModal } from "@coinbase/cdp-react";
import { track } from "@/lib/analytics";
import { ArrowUpRightIcon, CheckIcon, SendIcon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { hasAuth } from "@/components/app/auth";
import { useCopy } from "@/components/app/copy";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { shortAddress } from "@/lib/market";
import { money } from "@/lib/money";
import { cn } from "@/lib/utils";
import { MonadMark, UsdcMark } from "@/components/app/marks";
import { MIN_DEPOSIT, useChain } from "./chain-context";
import { feel } from "@/lib/feel";
import { FOUNDER } from "./founders";
import { WithdrawSheet } from "./withdraw-sheet";
import { NETWORK } from "@/lib/chain";

/**
 * The way to money while the game plays on: tap the game without a balance
 * and this opens, signed in or not. Signed out it is Coinbase's sign-in;
 * signed in, the deposit sheet from the design canvas ("Send USDC"): a QR of
 * the player's address, the address to copy, the network, how fast and how
 * little. USDC that lands there moves into the balance by itself, and the
 * sheet closes when it has.
 */

/** `"tap"`: opened because a tap on the game could not be played. Those are counted: see FOUNDERS_AFTER. */
type Gate = { openDeposit: (why?: "tap" | "short") => void; openSignIn: (from?: string) => void; openWithdraw: () => void };
const GateCtx = createContext<Gate>({ openDeposit: () => undefined, openSignIn: () => undefined, openWithdraw: () => undefined });
export const useGate = () => useContext(GateCtx);

/*
  Someone who has tapped the game five times with nothing to play with and still not deposited is stuck, not
  uninterested. From then on the sheet leads with a person: a founder, on Telegram, who will get them in. The
  count lives in this browser across reloads, and resets once there is money to play with.
*/
const FOUNDERS_AFTER = 5;
const TAPS_KEY = "skech:blocked-taps";
const readTaps = () => {
  try {
    return Number(localStorage.getItem(TAPS_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeTaps = (n: number) => {
  try {
    localStorage.setItem(TAPS_KEY, String(n));
  } catch {
    /* private mode: counted for this page only */
  }
};

export function GateProvider({ children }: { children: ReactNode }) {
  const [deposit, setDeposit] = useState(false);
  const [signIn, setSignIn] = useState(false);
  // Read once, at start: on the server there is no storage and it is 0; the sheet is closed there anyway.
  const [taps, setTaps] = useState(readTaps);
  const openDeposit = useCallback((why?: "tap" | "short") => {
    track("deposit_opened", { why: why ?? "button" });
    if (why === "tap") {
      const n = readTaps() + 1;
      writeTaps(n);
      setTaps(n);
    }
    setDeposit(true);
  }, []);
  const openSignIn = useCallback((from = "button") => {
    track("sign_in_opened", { from });
    setSignIn(true);
  }, []);
  const [withdraw, setWithdraw] = useState(false);
  const openWithdraw = useCallback(() => setWithdraw(true), []);
  const gate = useMemo(() => ({ openDeposit, openSignIn, openWithdraw }), [openDeposit, openSignIn, openWithdraw]);
  return (
    <GateCtx.Provider value={gate}>
      {children}
      <DepositModal
        onOpenChange={setDeposit}
        onPlayable={() => {
          writeTaps(0);
          setTaps(0);
        }}
        open={deposit}
        stuck={taps >= FOUNDERS_AFTER}
      />
      <WithdrawSheet onOpenChange={setWithdraw} open={withdraw} />
      {hasAuth ? (
        <SignInModal open={signIn} setIsOpen={setSignIn}>
          <span hidden />
        </SignInModal>
      ) : null}
    </GateCtx.Provider>
  );
}

export function DepositModal({ open, onOpenChange, stuck = false, onPlayable }: { open: boolean; onOpenChange: (open: boolean) => void; stuck?: boolean; onPlayable?: () => void }) {
  const chain = useChain();
  // Money to play with: nobody is stuck any more.
  const playable = chain.account !== null && chain.balance >= MIN_DEPOSIT;
  useEffect(() => {
    if (playable && stuck) onPlayable?.();
  }, [playable, stuck, onPlayable]);
  const address = chain.player;
  const { copied, copy } = useCopy(address);
  // The deposit this sheet is celebrating: the last one to land, of at least the minimum, until it is dismissed.
  const landed = chain.landed;
  const [dismissed, setDismissed] = useState<number | null>(landed?.at ?? null);
  const done = landed && landed.at !== dismissed && landed.amount >= MIN_DEPOSIT ? landed.amount : null;
  useEffect(() => {
    if (done !== null && !open) onOpenChange(true);
  }, [done, open, onOpenChange]);
  /*
    Closing from the celebration marks it seen at once, which would swap the sheet back to "Send USDC" while
    its close animation is still playing: the deposit screen flashing up after "Start playing". So what was on
    screen is held until the sheet has finished closing.
  */
  const [held, setHeld] = useState<number | null>(null);
  const close = (next: boolean) => {
    if (!next && done !== null) setHeld(done);
    onOpenChange(next);
    if (!next && landed) setDismissed(landed.at);
  };
  const celebrating = done ?? held;

  return (
    <Dialog onOpenChange={close} onOpenChangeComplete={() => setHeld(null)} open={open}>
      <DialogPopup
        // Made to fit a phone's screen whole. Only on a very short one does it scroll, within what is visible: dvh,
        // not vh, so the browser's own bars never hide the bottom, less the 3rem the viewport keeps above it.
        className="gap-4 overflow-y-auto overscroll-contain rounded-[28px] border-border bg-raised p-6 sm:max-w-[440px] max-sm:max-h-[calc(100dvh-3rem)] max-sm:gap-3 max-sm:rounded-t-[28px] max-sm:px-5 max-sm:pt-2 max-sm:pb-[max(20px,env(safe-area-inset-bottom))]"
        showCloseButton={false}
      >
        <div aria-hidden="true" className="h-[5px] w-9 self-center rounded-full bg-faint sm:hidden" />
        {celebrating !== null ? (
          <Landed amount={celebrating} balance={chain.balance} onStart={() => close(false)} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="font-semibold text-[24px] leading-[1.15] tracking-[-0.02em]">Send USDC</DialogTitle>
                <DialogDescription className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground leading-snug">
                  <MonadMark className="size-3.5 shrink-0" />
                  <span>{`Only USDC on ${NETWORK.label}`}</span>
                </DialogDescription>
              </div>
              <CloseButton onClick={() => close(false)} />
            </div>
            {stuck && !playable ? <Founders /> : null}
            {address ? (
              <>
                {/* The QR beside the address: scan it from another phone, or copy it on this one. One card, not two. */}
                <div className="flex items-center gap-4 rounded-[20px] bg-foreground/[0.06] p-3">
                  <AddressQR address={address} className="size-[128px]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] text-muted-foreground leading-snug">Your skech address</span>
                      <span className="figures truncate font-medium text-[16px] leading-snug">{shortAddress(address)}</span>
                    </span>
                    <button className="flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-foreground px-4 font-semibold text-[15px] text-background transition-transform active:scale-95" onClick={() => void copy()} type="button">
                      {copied ? <CheckIcon className="size-4" strokeWidth={2.6} /> : null}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
                {/* The terms in one line: what is there, and the least worth sending. The network is named above. */}
                <dl className="flex items-center justify-between rounded-[16px] border border-border px-4 py-2.5 text-[14px]">
                  <Term label="Balance">
                    <span className="figures font-semibold">{money(chain.balance)}</span>
                  </Term>
                  <Term label="Minimum">${MIN_DEPOSIT.toFixed(2)}</Term>
                </dl>
                {NETWORK.faucet ? <Faucet href={NETWORK.faucet} /> : null}
                {chain.adding === null && chain.balance >= MIN_DEPOSIT ? (
                  // Already enough to play: the sheet is for topping up, and says so, with the way back to the game.
                  <button className="flex min-h-12 w-full items-center justify-center rounded-full bg-foreground font-semibold text-[16px] text-background transition-transform active:scale-[.98]" onClick={() => close(false)} type="button">
                    Play with {money(chain.balance)}
                  </button>
                ) : (
                  <p aria-live="polite" className="flex min-h-5 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-3.5" />
                    {chain.adding !== null ? `Adding ${money(chain.adding)} to your balance…` : "Waiting for USDC · lands in a few seconds"}
                  </p>
                )}
              </>
            ) : (
              <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Spinner className="size-4" /> Getting your address…
              </p>
            )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    // 32px to look at, 44px to hit: the invisible ring around it takes the thumb.
    <button aria-label="Close" className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:text-foreground" onClick={onClick} type="button">
      <XIcon className="size-[15px]" strokeWidth={2.4} />
    </button>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 font-medium">{children}</dd>
    </div>
  );
}

/** The deposit landed: how much, what the balance is now, and the way back to the game. */
function Landed({ amount, balance, onStart }: { amount: number; balance: number; onStart: () => void }) {
  // Money in is the best news the app has: a till and a bright chord, felt as well as heard.
  useEffect(() => feel("cash"), []);
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {/*
        The landing page's closing scene: the pen drawing a line up to a winning candle. It is drawn in, left to
        right, as the pen would draw it, then floats; sparkles pop around it.
      */}
      <div aria-hidden="true" className="relative -mx-2 w-[calc(100%+16px)] pt-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- one local illustration, sized by its box */}
        <img
          alt=""
          className="w-full select-none motion-safe:animate-[scene-draw_1100ms_cubic-bezier(.35,.6,.2,1)_both,scene-float_3.2s_ease-in-out_1.2s_infinite]"
          draggable={false}
          height={374}
          src="/illo/skech-scene.png"
          width={900}
        />
        {[
          { left: "8%", top: "22%", delay: 700, size: 10 },
          { left: "62%", top: "4%", delay: 950, size: 14 },
          { left: "88%", top: "30%", delay: 1150, size: 9 },
        ].map((sp) => (
          <span
            className="absolute text-[#f5c451] motion-safe:animate-[sparkle_900ms_cubic-bezier(.2,1.6,.4,1)_both]"
            key={sp.left}
            style={{ left: sp.left, top: sp.top, fontSize: sp.size, animationDelay: `${sp.delay}ms` }}
          >
            ✦
          </span>
        ))}
      </div>
      <span className="figures rounded-full bg-success/15 px-3.5 py-1 font-bold text-[15px] text-success-foreground motion-safe:animate-[landed-pop_560ms_cubic-bezier(.2,1.6,.35,1)_600ms_both]">
        +{money(amount)} added
      </span>
      <div className="flex flex-col gap-1.5 motion-safe:animate-[row-in_420ms_cubic-bezier(.2,.8,.2,1)_750ms_both]">
        <DialogTitle className="font-semibold text-[26px] leading-[1.15] tracking-[-0.02em]">You&rsquo;re in. Now skech the trade.</DialogTitle>
        <DialogDescription className="text-[15px] text-muted-foreground">
          Draw where Bitcoin goes next. Your balance is <span className="figures font-medium text-foreground">{money(balance)}</span>.
        </DialogDescription>
      </div>
      <button
        autoFocus
        className="mt-1 flex min-h-[54px] w-full items-center justify-center rounded-full bg-foreground font-semibold text-[17px] text-background transition-transform active:scale-[.98] motion-safe:animate-[row-in_420ms_cubic-bezier(.2,.8,.2,1)_880ms_both]"
        onClick={onStart}
        type="button"
      >
        Start skeching
      </button>
    </div>
  );
}

/**
 * The address as a QR code, drawn as the canvas draws it: round-cornered dots on white, with USDC's mark in the
 * middle (what to send; the network is named beside it). Error correction is at its highest, so the mark still scans.
 * Always black on white, dark mode or not: that is what cameras read.
 */
function AddressQR({ address, className }: { address: string; className?: string }) {
  const { data, size } = useMemo(() => encode(address, { ecc: "H", border: 0 }), [address]);
  const box = 175;
  const pitch = box / size;
  const dot = pitch * 0.86;
  const mid = box / 2;
  // The clear circle the mark sits in, in the box's units.
  const clearR = 18;
  const clear = (x: number, y: number) => Math.hypot(x - mid, y - mid) < clearR;
  const dots: ReactNode[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y][x]) continue;
      const cx = x * pitch + pitch / 2;
      const cy = y * pitch + pitch / 2;
      if (clear(cx, cy)) continue;
      dots.push(<rect fill="#000" height={dot} key={`${x}:${y}`} rx={dot * 0.33} width={dot} x={cx - dot / 2} y={cy - dot / 2} />);
    }
  }
  return (
    <div className={cn("relative size-[203px] shrink-0", className)}>
      <svg aria-label={`QR code for ${address}`} height="100%" role="img" viewBox={`-14 -14 ${box + 28} ${box + 28}`} width="100%">
        <rect fill="#FFFFFF" height={box + 28} rx={18} width={box + 28} x={-14} y={-14} />
        {dots}
      </svg>
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
        <UsdcMark className="size-[22%] rounded-full ring-[3px] ring-white" />
      </div>
    </div>
  );
}

/**
 * Testnet only: USDC here is free, and this is where it comes from. Circle's faucet asks for the network and
 * the address, so the line says which network to pick; the address is one Copy away, just above.
 */
function Faucet({ href }: { href: string }) {
  return (
    <a
      className="flex items-center gap-3 rounded-[16px] bg-foreground/[0.06] px-4 py-2.5 outline-none transition-colors hover:bg-foreground/[0.1] focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <UsdcMark className="size-6 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-semibold text-[14px] leading-snug">Get free test USDC</span>
        <span className="truncate text-[12.5px] text-muted-foreground leading-snug">Pick Monad Testnet, paste your address</span>
      </span>
      <ArrowUpRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * For someone stuck at the deposit: a person instead of a form. A founder's face, a promise of a few
 * minutes, and one button straight into a Telegram chat with him.
 */
function Founders() {
  return (
    <div className="flex items-center gap-3 rounded-[16px] border border-foreground/10 bg-foreground/[0.04] p-3 motion-safe:animate-[row-in_360ms_cubic-bezier(.2,.8,.2,1)_both]">
      <span className="relative shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- a 19 KB local photo; the optimiser adds nothing here */}
        <img alt={FOUNDER.name} className="size-10 rounded-full object-cover ring-2 ring-background" height={40} src={FOUNDER.photo} width={40} />
        <span aria-hidden="true" className="absolute right-0 bottom-0 size-3 rounded-full bg-success-foreground ring-2 ring-raised" title="Online" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="font-semibold text-[14px] leading-snug">Stuck? Talk to us</p>
        <p className="truncate text-[12.5px] text-muted-foreground leading-snug">{FOUNDER.name} sets you up, fast</p>
      </div>
      <a
        aria-label={`Message @${FOUNDER.handle} on Telegram`}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[#2AABEE] px-3.5 font-semibold text-[14px] text-white outline-none transition-transform hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring active:scale-[.97]"
        href={FOUNDER.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        <SendIcon className="size-4" strokeWidth={2.2} />
        Telegram
      </a>
    </div>
  );
}
