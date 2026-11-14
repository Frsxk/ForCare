import { ApiError, asApiError, createApiClient, type ApiClient, type Transport } from "./client";
import { decodeLogin, decodeRegistration, decodeSession, type LoginInput, type RegistrationInput, type SessionResponse } from "./contracts";

export type SessionState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "error"; error: ApiError }
  | { status: "authenticated"; session: SessionResponse; loggingOut: boolean; logoutError: ApiError | null };

export class SessionController {
  private state: SessionState = { status: "checking" };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private owner: string | null = null;
  private retained = new Map<string, { suspend: () => void; dispose: () => void }>();
  private identity(session: SessionResponse) { return JSON.stringify([session.account.id, session.session.csrfToken, session.account.roles, session.access.scopes]); }
  ownsSession = (session: SessionResponse) => this.owner === this.identity(session);
  retain<T extends { suspend: () => void; dispose: () => void }>(key: string, create: () => T): T {
    if (this.state.status !== "authenticated" || this.state.loggingOut || this.state.logoutError) throw new Error("Verified session required");
    const existing = this.retained.get(key);
    if (existing) return existing as T;
    const store = create(); this.retained.set(key, store); return store;
  }
  private registrationUncertain = false;
  private registering = false;
  readonly api: ApiClient;

  constructor(options: { fetch?: Transport } = {}) {
    this.api = createApiClient({ ...options, onUnauthorized: () => {
      this.epoch++;
      this.setState({ status: "anonymous" });
    } });
  }
  getSnapshot = (): SessionState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private setState(state: SessionState) {
    const nextOwner = state.status === "authenticated" ? this.identity(state.session) : state.status === "anonymous" ? null : this.owner;
    if (nextOwner !== this.owner) {
      this.retained.forEach(store => store.dispose()); this.retained.clear();
      this.owner = nextOwner;
    }
    this.state = state;
    if (state.status !== "authenticated" || state.loggingOut || state.logoutError) this.retained.forEach(store => store.suspend());
    this.listeners.forEach((listener) => listener());
  }
  private accept(session: SessionResponse) {
    this.registrationUncertain = false;
    this.api.setCsrfToken(session.session.csrfToken);
    this.setState({ status: "authenticated", session, loggingOut: false, logoutError: null });
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const epoch = ++this.epoch;
    this.api.setCsrfToken(null);
    this.setState({ status: "checking" });
    try {
      const session = await this.api.request("/api/v1/auth/session", decodeSession, { signal });
      if (epoch === this.epoch) this.accept(session);
    } catch (error) {
      if (epoch !== this.epoch || signal?.aborted) return;
      const failure = asApiError(error);
      this.setState(failure.status === 401 ? { status: "anonymous" } : { status: "error", error: failure });
    }
  }

  async login(input: LoginInput, signal?: AbortSignal): Promise<void> {
    const epoch = ++this.epoch;
    this.api.setCsrfToken(null);
    try {
      // Select exactly these fields, even if a JS caller supplies extra properties.
      const login = await this.api.request("/api/v1/auth/login", decodeLogin, {
        method: "POST", authenticated: false, json: { email: input.email, password: input.password }, signal,
      });
      if (epoch !== this.epoch) return;
      this.api.setCsrfToken(login.session.csrfToken);
      // Login's JSON is not proof that the browser retained the Secure cookie.
      const session = await this.api.request("/api/v1/auth/session", decodeSession, { signal });
      if (epoch === this.epoch) this.accept(session);
    } catch (error) {
      const failure = asApiError(error);
      if (epoch === this.epoch) {
        this.api.setCsrfToken(null);
        this.setState(failure.status === 401 ? { status: "anonymous" } : { status: "error", error: failure });
      }
      throw failure;
    }
  }

  isRegistrationUncertain = () => this.registrationUncertain;

  async register(input: RegistrationInput, signal?: AbortSignal): Promise<void> {
    if (this.registering || this.registrationUncertain || this.state.status === "authenticated") throw new ApiError("CLIENT_CONFIG_ERROR");
    if (signal?.aborted) throw new ApiError("REQUEST_ABORTED");
    const epoch = ++this.epoch;
    this.registering = true;
    this.registrationUncertain = true;
    this.api.setCsrfToken(null);
    let created = false;
    try {
      const registered = await this.api.request("/api/v1/auth/register", decodeRegistration, {
        method: "POST", authenticated: false,
        json: { fullName: input.fullName, birthDate: input.birthDate, gender: input.gender, email: input.email, phone: input.phone, password: input.password }, signal,
      });
      created = true;
      if (epoch !== this.epoch) throw new ApiError("REQUEST_ABORTED");
      this.api.setCsrfToken(registered.session.csrfToken);
      // The backend creates a session; only a matching cookie-backed read grants access.
      const session = await this.api.request("/api/v1/auth/session", decodeSession, { signal });
      if (session.account.id !== registered.account.id || session.account.roles[0] !== "patient" || !session.access.scopes.includes("patient:self")) throw new ApiError("INVALID_RESPONSE");
      if (epoch !== this.epoch) throw new ApiError("REQUEST_ABORTED");
      this.accept(session);
    } catch (error) {
      const failure = asApiError(error);
      // A 4xx rejection before creation is definitive; transport/5xx/verification failures are not.
      if (!created && failure.status >= 400 && failure.status < 500) this.registrationUncertain = false;
      if (epoch === this.epoch) this.api.setCsrfToken(null);
      throw failure;
    } finally {
      this.registering = false;
    }
  }

  async logout(signal?: AbortSignal): Promise<void> {
    const previous = this.state;
    if (previous.status !== "authenticated" || previous.loggingOut) throw new ApiError("CLIENT_CONFIG_ERROR");
    const epoch = ++this.epoch;
    this.setState({ ...previous, loggingOut: true, logoutError: null });
    try {
      await this.api.request("/api/v1/auth/logout", () => undefined, { method: "POST", json: {}, empty: true, signal });
      if (epoch !== this.epoch) return;
      this.api.setCsrfToken(null);
      this.setState({ status: "anonymous" });
    } catch (error) {
      const failure = asApiError(error);
      if (failure.status === 401) return; // Already invalid on the server; the 401 handler cleared state.
      if (epoch === this.epoch) this.setState({ ...previous, loggingOut: false, logoutError: failure });
      throw failure; // Do not pretend that a lost response proves server-side revocation.
    }
  }
}
