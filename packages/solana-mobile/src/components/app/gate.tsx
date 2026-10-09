import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { DeleteAccountSheet } from "./sheets/delete-account-sheet";
import { DepositSheet } from "./sheets/deposit-sheet";
import { ScoreboardSheet } from "./sheets/scoreboard-sheet";
import { SignInSheet } from "./sheets/sign-in-sheet";
import { TransactionsSheet } from "./sheets/transactions-sheet";
import { WithdrawSheet } from "./sheets/withdraw-sheet";

/**
 * The sheets money and sign-in happen in, opened from anywhere: the bar, the balance, a tap on the game from
 * someone who cannot play yet. The web's `useGate` (deposit-modal.tsx), with the phone's own sheets, and deleting
 * the account, which leads to withdrawing first.
 */
type Open = "signin" | "deposit" | "withdraw" | "transactions" | "scoreboard" | "delete" | null;
type Gate = { openSignIn: (from?: string) => void; openDeposit: (from?: string) => void; openWithdraw: () => void; openTransactions: () => void; openScoreboard: () => void; openDeleteAccount: () => void; close: () => void; open: Open };

const Ctx = createContext<Gate | null>(null);

export function GateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open>(null);
  const gate = useMemo<Gate>(
    () => ({
      open,
      openSignIn: () => setOpen("signin"),
      openDeposit: () => setOpen("deposit"),
      openWithdraw: () => setOpen("withdraw"),
      openTransactions: () => setOpen("transactions"),
      openScoreboard: () => setOpen("scoreboard"),
      openDeleteAccount: () => setOpen("delete"),
      close: () => setOpen(null),
    }),
    [open],
  );
  const close = () => setOpen(null);
  return (
    <Ctx.Provider value={gate}>
      {children}
      <SignInSheet onClose={close} open={open === "signin"} />
      <DepositSheet onClose={close} open={open === "deposit"} />
      <WithdrawSheet onClose={close} open={open === "withdraw"} />
      <TransactionsSheet onClose={close} open={open === "transactions"} />
      <ScoreboardSheet onClose={close} open={open === "scoreboard"} />
      <DeleteAccountSheet onClose={close} onWithdraw={() => setOpen("withdraw")} open={open === "delete"} />
    </Ctx.Provider>
  );
}

export function useGate(): Gate {
  const g = useContext(Ctx);
  if (!g) throw new Error("useGate outside GateProvider");
  return g;
}
