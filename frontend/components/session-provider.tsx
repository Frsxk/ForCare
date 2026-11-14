"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SessionController } from "@/lib/api/session";

const SessionContext = createContext<{ controller: SessionController; getServerSnapshot: SessionController["getSnapshot"] } | null>(null);

export function SessionProvider({ children, controller }: { children: ReactNode; controller?: SessionController }) {
  // One in-memory controller per mounted app, not a server/shared module singleton.
  const [session] = useState(() => controller ?? new SessionController());
  const [context] = useState(() => {
    const initialSnapshot = session.getSnapshot();
    return { controller: session, getServerSnapshot: () => initialSnapshot };
  });
  useEffect(() => {
    const abort = new AbortController();
    void session.refresh(abort.signal);
    return () => abort.abort();
  }, [session]);
  return <SessionContext.Provider value={context}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession requires SessionProvider");
  const { controller, getServerSnapshot } = context;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, getServerSnapshot);
  return { state, controller };
}
