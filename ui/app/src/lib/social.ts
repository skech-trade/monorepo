"use client";
import { useCallback, useEffect, useState } from "react";
import type { Pt } from "@/lib/sketch";
const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export type Player = { username: string; buddy: "blue" | "mint" | "coral"; points: number; level: number; nextLevelAt: number | null; achievements: string[]; completed: number; dailyRemaining: number };
function readToken(address: string | null) { try { return address ? localStorage.getItem(`skech.player.${address.toLowerCase()}`) : null; } catch { return null; } }
async function request(path: string, token: string | null, body?: unknown) {
  if (!API) throw Error("Player profiles need the API connection.");
  const res = await fetch(`${API}/social/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(Error(data.error ?? "Please try again."), { status: res.status });
  return data;
}
export function usePlayer(address: string | null, signMessage: (message: string) => Promise<string | null>) {
  const [state, setState] = useState<{address: string; player: Player} | null>(null);
  const [loadedAddress, setLoadedAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const player = state?.address === address ? state.player : null;
  const refresh = useCallback(async () => {
    if (!address) return;
    if (!readToken(address)) { setLoadedAddress(address); return; }
    try { const player = await request("me",readToken(address)); setState({address,player}); }
    catch (error) {
      if ((error as {status?: number}).status === 401) {
        try { localStorage.removeItem(`skech.player.${address.toLowerCase()}`); } catch {}
        setState(null);
      }
    } finally { setLoadedAddress(address); }
  }, [address]);
  // Hydrate the account from its external session token, then subscribe to updates.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); const timer=setInterval(()=>void refresh(),10000); const sync = () => void refresh(); window.addEventListener("skech-player", sync); return ()=>{ clearInterval(timer); window.removeEventListener("skech-player", sync); }; },[refresh]);
  const claim = async (username: string) => {
    if (!address) {setNote("Sign in from the top bar to claim your player name."); return;}
    setBusy(true);setNote(null);
    try {
      const challenge = await request("challenge",null,{address,username});
      const signature = await signMessage(challenge.message);
      if (!signature) throw Error("Signature cancelled. No username was claimed.");
      const result = await request("claim",null,{id:challenge.id,signature});
      try { localStorage.setItem(`skech.player.${address.toLowerCase()}`,result.token); } catch {throw Error("Enable browser storage to keep your player signed in.");}
      setState({address,player:result.profile});window.dispatchEvent(new Event("skech-player"));setNote("Your player is ready. Points are saved to your account.");
    } catch(e) {setNote((e as Error).message);} finally {setBusy(false);}
  };
  const saveBuddy = async (buddy: Player["buddy"]) => {
    if (!address) return;
    setBusy(true);
    try {const updated=await request("buddy",readToken(address),{buddy});setState({address,player:updated});window.dispatchEvent(new Event("skech-player"));return true;}
    catch(e){setNote((e as Error).message);return false;}finally{setBusy(false);}
  };
  const startPrediction = async (pts: Pt[], seconds: number) => {
    if (!address || !player) return;
    try {await request("predictions",readToken(address),{pts,seconds});setNote("Prediction registered for points. Your original line is scored when its full window ends.");void refresh();}
    catch(e){setNote(`Points: ${(e as Error).message}`);}
  };
  return {player,ready: !address || loadedAddress === address,busy,note,claim,saveBuddy,startPrediction};
}
export type PlayerState = ReturnType<typeof usePlayer>;
