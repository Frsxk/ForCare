export type Role = "patient" | "nurse";
export type AccessScope = "patient:self" | "nurse:directory" | "nurse:assigned" | "nurse:request_intake" | "nurse:visit";
export type GrantBasis = "primary" | "request_intake" | "visit";
export type CapabilityState = "enabled" | "disabled" | "missing" | "optional" | "gated";
export type Capability = { state: CapabilityState; reason?: string; gate?: string };
export type LoginInput = { email: string; password: string };
export type RegistrationInput = {
  fullName: string;
  birthDate: string;
  gender: "male" | "female" | "other" | "undisclosed";
  email: string;
  phone: string;
  password: string;
};
export type RegistrationResponse = {
  account: { id: string; email: string; status: "active"; roles: ["patient"] };
  patientProfile: { id: string; fullName: string; recordNumber: null };
  session: { csrfToken: string; expiresAt: string };
};
export type LoginResponse = {
  account: { id: string; email: string; status: "active"; roles: Role[] };
  session: { csrfToken: string; expiresAt: string };
  access: {
    scopes: AccessScope[];
    accessContexts: { basis: GrantBasis; patientId: string; expiresAt: string | null }[];
  };
};
export type SessionResponse = LoginResponse & {
  displayTimeZone: string;
  expiresAt: string;
  capabilities: Record<string, Capability>;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid string");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid array");
  return value;
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error("Invalid timestamp");
  return result;
}

// Source: backend auth/service.ts and auth/policy.ts; login is not the session DTO.
export function decodeRegistration(value: unknown): RegistrationResponse {
  const data = object(value);
  const account = object(data.account);
  const profile = object(data.patientProfile);
  const session = object(data.session);
  const roles = list(account.roles);
  if (account.status !== "active" || roles.length !== 1 || roles[0] !== "patient" || profile.recordNumber !== null) throw new Error("Invalid registration");
  return {
    account: { id: text(account.id), email: text(account.email), status: "active", roles: ["patient"] },
    patientProfile: { id: text(profile.id), fullName: text(profile.fullName), recordNumber: null },
    session: { csrfToken: text(session.csrfToken), expiresAt: timestamp(session.expiresAt) },
  };
}

export function decodeLogin(value: unknown): LoginResponse {
  const data = object(value);
  const account = object(data.account);
  const session = object(data.session);
  const access = object(data.access);
  const roles = list(account.roles).map((role) => member(role, ["patient", "nurse"] as const));
  if (roles.length !== 1 || account.status !== "active") throw new Error("Invalid account");
  return {
    account: { id: text(account.id), email: text(account.email), status: "active", roles },
    session: { csrfToken: text(session.csrfToken), expiresAt: timestamp(session.expiresAt) },
    access: {
      scopes: list(access.scopes).map((scope) => member(scope, ["patient:self", "nurse:directory", "nurse:assigned", "nurse:request_intake", "nurse:visit"] as const)),
      accessContexts: list(access.accessContexts).map((item) => {
        const context = object(item);
        return {
          basis: member(context.basis, ["primary", "request_intake", "visit"] as const),
          patientId: text(context.patientId),
          expiresAt: context.expiresAt === null ? null : timestamp(context.expiresAt),
        };
      }),
    },
  };
}

export function decodeSession(value: unknown): SessionResponse {
  const data = object(value);
  const capabilities = Object.fromEntries(Object.entries(object(data.capabilities)).map(([key, value]) => {
    const capability = object(value);
    return [key, {
      state: member(capability.state, ["enabled", "disabled", "missing", "optional", "gated"] as const),
      ...(capability.reason === undefined ? {} : { reason: text(capability.reason) }),
      ...(capability.gate === undefined ? {} : { gate: text(capability.gate) }),
    }];
  }));
  return {
    ...decodeLogin(data),
    displayTimeZone: text(data.displayTimeZone),
    expiresAt: timestamp(data.expiresAt),
    capabilities,
  };
}

// A UI gate, not a replacement for the backend's resource-level authorization.
export function canUseNurseWorkspace(session: LoginResponse): boolean {
  return session.account.roles.length === 1 && session.account.roles[0] === "nurse" && session.access.scopes.includes("nurse:directory");
}
