import { asApiError, type ApiError } from "./client";
import type { SessionController } from "./session";

export type ResourceState<T> = { status: "idle" | "loading" } | { status: "ready"; data: T } | { status: "error"; error: ApiError };
export class ScopedResource<T> {
  private state: ResourceState<T> = { status: "idle" };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private epoch = 0;
  constructor(private current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(state: ResourceState<T>) { this.state = state; this.listeners.forEach(fn => fn()); }
  clear() { this.epoch++; this.abort?.abort(); this.set({ status: "idle" }); }
  replace(data: T) { if (!this.current()) return; this.epoch++; this.abort?.abort(); this.set({ status: "ready", data }); }
  async load(loader: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    this.abort?.abort();
    if (!this.current()) return;
    const epoch = ++this.epoch, abort = new AbortController(); this.abort = abort;
    this.set({ status: "loading" });
    try {
      const data = await loader(abort.signal);
      if (!this.current() || abort.signal.aborted || epoch !== this.epoch) return;
      this.set({ status: "ready", data }); return data;
    } catch (error) {
      if (this.current() && !abort.signal.aborted && epoch === this.epoch) this.set({ status: "error", error: asApiError(error) });
    }
  }
}

export class SessionScope {
  private active = true;
  private resources = new Set<{ clear: () => void }>();
  private unsubscribe: (() => void) | null = null;
  readonly session;
  constructor(private controller: SessionController) {
    const state = controller.getSnapshot();
    if (state.status !== "authenticated" || state.loggingOut) throw new Error("Authenticated session required");
    this.session = state.session;
  }
  // Called from the provider effect (not its initializer), so Strict Mode has no leaked subscription.
  connect() {
    this.unsubscribe?.();
    this.unsubscribe = this.controller.subscribe(() => {
      if (!this.controller.ownsSession(this.session)) this.active = false;
      if (!this.isCurrent()) this.clear();
    });
    if (!this.isCurrent()) this.clear();
    return () => { this.unsubscribe?.(); this.unsubscribe = null; this.clear(); };
  }
  isCurrent = () => {
    const state = this.controller.getSnapshot();
    return this.active && this.controller.ownsSession(this.session) && state.status === "authenticated" && !state.loggingOut && !state.logoutError;
  };
  resource<T>(): ScopedResource<T> {
    const resource = new ScopedResource<T>(this.isCurrent);
    this.resources.add(resource);
    return resource;
  }
  release(resource: { clear: () => void }) { resource.clear(); this.resources.delete(resource); }
  suspend() { this.clear(); }
  private clear() { this.resources.forEach(resource => resource.clear()); }
  dispose() { this.active = false; this.unsubscribe?.(); this.unsubscribe = null; this.clear(); this.resources.clear(); }
}
