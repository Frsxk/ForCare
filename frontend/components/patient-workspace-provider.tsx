"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSession } from "@/components/session-provider";
import type { ScopedResource } from "@/lib/api/scoped-resource";
import { getPatientWorkspace } from "@/lib/api/workspaces";

type Workspace = ReturnType<typeof getPatientWorkspace>;
const WorkspaceContext = createContext<Workspace | null>(null);
export function PatientWorkspaceProvider({ children }: { children: ReactNode }) {
  const { controller } = useSession();
  const [workspace] = useState(() => getPatientWorkspace(controller));
  useEffect(() => {
    const disconnect = workspace.scope.connect();
    void workspace.profile.load(workspace.api.profile);
    return disconnect;
  }, [workspace, controller]);
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}
export function usePatientWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("PatientWorkspaceProvider required");
  return workspace;
}
export function usePatientResource<T>(resource: ScopedResource<T>) { return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot); }
export function usePatientRead<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const { scope } = usePatientWorkspace();
  const [resource] = useState(() => scope.resource<T>());
  useEffect(() => { void resource.load(loader); return () => { resource.clear(); }; }, [resource, loader]);
  return { state: usePatientResource(resource), reload: () => resource.load(loader) };
}
