"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSession } from "@/components/session-provider";
import type { ScopedResource } from "@/lib/api/scoped-resource";
import { getNurseWorkspace } from "@/lib/api/workspaces";

type Workspace = ReturnType<typeof getNurseWorkspace>;
const WorkspaceContext = createContext<Workspace | null>(null);
export function NurseWorkspaceProvider({ children }: { children: ReactNode }) {
  const { controller } = useSession();
  const [workspace] = useState(() => getNurseWorkspace(controller));
  useEffect(() => {
    const disconnect = workspace.scope.connect();
    void workspace.profile.load(workspace.api.profile);
    return disconnect;
  }, [workspace, controller]);
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}
export function useNurseWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Nurse workspace required");
  return workspace;
}
export function useResource<T>(resource: ScopedResource<T>) {
  return useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
}
export function useNurseProfile() {
  const { profile } = useNurseWorkspace();
  return useResource(profile);
}
export function useNurseRead<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const { scope } = useNurseWorkspace();
  const [resource] = useState(() => scope.resource<T>());
  useEffect(() => {
    void resource.load(loader);
    return () => resource.clear();
  }, [resource, loader]);
  return { resource, state: useResource(resource), reload: () => resource.load(loader) };
}
