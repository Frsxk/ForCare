"use client";
import { useSession } from "@/components/session-provider";
export function SessionActions() {
  const { state, controller } = useSession();
  if (state.status !== "authenticated") return null;
  return <div className="live-session-actions">
    {state.logoutError && <div role="alert"><p>Keluar belum dapat dipastikan. {state.logoutError.message}</p><button className="text-button" onClick={() => void controller.refresh()}>Periksa sesi lagi</button></div>}
    <button className="button button-outline" disabled={state.loggingOut} onClick={() => void controller.logout().catch(() => undefined)}>{state.loggingOut ? "Mengakhiri sesi…" : "Keluar"}</button>
  </div>;
}
