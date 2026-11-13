import type { SQL } from "bun";
import type { AuthConfig } from "../config";
import { writeAuditEvent } from "../http/audit";
import { AppError } from "../http/errors";
import { normalizeEmail } from "../http/request";
import { isoTimestamp } from "../http/time";
import { capabilitySnapshot } from "../capabilities";
import {
  csrfHashFromToken,
  csrfMatches,
  createSessionToken,
  deriveCsrfToken,
  hashIp,
  isSessionToken,
  readSessionCookie,
  SESSION_TTL_MS,
  sessionTokenHash,
} from "./crypto";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password";
import { nurseIdentityValid, scopesForRole, type AuthContext, type PrincipalRow, type Role } from "./policy";
import {
  findLoginAccount,
  findSessionByTokenHash,
  insertAccount,
  insertAccountRole,
  insertPatientProfile,
  insertSession,
  isUniqueViolation,
  listActiveAccessGrants,
  loadPrincipal,
  revokeSession,
  touchSession,
} from "./repository";
import type { LoginInput, LogoutInput, RegistrationInput } from "./schemas";

export type AuthRequestMeta = {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
};

type PreparedSession = {
  token: string;
  csrfToken: string;
  csrfHashHex: string;
  tokenHashHex: string;
  expiresAt: Date;
};

export type AuthService = {
  authenticate(request: Request): Promise<AuthContext>;
  register(input: RegistrationInput, meta: AuthRequestMeta): Promise<{ data: unknown; token: string }>;
  login(input: LoginInput, meta: AuthRequestMeta): Promise<{ data: unknown; token: string }>;
  session(auth: AuthContext): Promise<unknown>;
  logout(auth: AuthContext, body: LogoutInput, requestId: string): Promise<void>;
};

function prepareSession(ttlMs: number): PreparedSession {
  const token = createSessionToken();
  const csrfToken = deriveCsrfToken(token);
  return {
    token,
    csrfToken,
    csrfHashHex: csrfHashFromToken(csrfToken),
    tokenHashHex: sessionTokenHash(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

function accountView(accountId: string, email: string, role: Role) {
  return { id: accountId, email, status: "active", roles: [role] };
}

function displayNameFor(principal: PrincipalRow, role: Role): string {
  return role === "patient" ? (principal.patient_full_name ?? "") : (principal.staff_display_name ?? "");
}

export function createAuthService(options: {
  sql: SQL;
  config: AuthConfig;
  sessionTtlMs?: number;
}): AuthService {
  const { sql, config } = options;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;

  async function accessFor(auth: Pick<AuthContext, "role" | "staffId">) {
    const grants = auth.staffId ? await listActiveAccessGrants(sql, auth.staffId) : [];
    return {
      scopes: scopesForRole(
        auth.role,
        grants.map((grant) => grant.basis),
      ),
      accessContexts: grants.map((grant) => ({
        basis: grant.basis,
        patientId: grant.patient_id,
        expiresAt: grant.expires_at === null ? null : isoTimestamp(grant.expires_at),
      })),
    };
  }

  async function authenticate(request: Request): Promise<AuthContext> {
    const token = readSessionCookie(request);
    if (!token || !isSessionToken(token)) {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    const session = await findSessionByTokenHash(sql, sessionTokenHash(token));
    if (!session) throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    if (session.revoked_at !== null) {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AppError("SESSION_EXPIRED", "Session has expired", 401);
    }

    const principal = await loadPrincipal(sql, session.account_id);
    if (!principal || principal.status !== "active") {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    const role = principal.role;
    if (role !== "patient" && role !== "nurse") {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    if (role === "patient" && !principal.patient_id) {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    if (role === "nurse" && !nurseIdentityValid(principal, config)) {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }

    const csrfToken = deriveCsrfToken(token);
    if (!csrfMatches(session.csrf_hash_hex, csrfToken)) {
      throw new AppError("UNAUTHENTICATED", "Authentication is required", 401);
    }
    await touchSession(sql, session.id).catch(() => {});

    return {
      sessionId: session.id,
      accountId: principal.account_id,
      role,
      email: principal.email_normalized,
      displayName: displayNameFor(principal, role),
      displayTimeZone: principal.display_time_zone,
      patientId: principal.patient_id,
      staffId: principal.staff_id,
      staffCode: principal.staff_code,
      csrfToken,
      csrfHashHex: session.csrf_hash_hex,
      expiresAt: isoTimestamp(session.expires_at),
    };
  }

  async function register(input: RegistrationInput, meta: AuthRequestMeta) {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const session = prepareSession(sessionTtlMs);
    const expiresAt = new Date(Date.now() + sessionTtlMs);

    try {
      const result = await sql.begin(async (tx) => {
        const accountId = await insertAccount(tx, { email, passwordHash });
        await insertAccountRole(tx, accountId, "patient");
        const patientId = await insertPatientProfile(tx, {
          accountId,
          fullName: input.fullName,
          birthDate: input.birthDate,
          gender: input.gender,
          phone: input.phone,
        });
        const inserted = await insertSession(tx, {
          accountId,
          tokenHashHex: session.tokenHashHex,
          csrfHashHex: session.csrfHashHex,
          expiresAt,
          ipHash: hashIp(meta.ip, config.sessionSecret),
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
        });
        await writeAuditEvent(tx, {
          actorAccountId: accountId,
          action: "account.registered",
          subjectType: "account",
          subjectId: accountId,
          requestId: meta.requestId,
          after: { role: "patient" },
        });
        return {
          accountId,
          patientId,
          expiresAt: inserted.expiresAt,
        };
      });

      return {
        data: {
          account: accountView(result.accountId, email, "patient"),
          patientProfile: {
            id: result.patientId,
            fullName: input.fullName,
            recordNumber: null,
          },
          session: { csrfToken: session.csrfToken, expiresAt: result.expiresAt },
        },
        token: session.token,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("REGISTRATION_UNAVAILABLE", "Registration is unavailable", 409);
      }
      throw error;
    }
  }

  async function login(input: LoginInput, meta: AuthRequestMeta) {
    const email = normalizeEmail(input.email);
    const row = await findLoginAccount(sql, email);
    const hash = row?.password_hash ?? (await dummyPasswordHash());
    const passwordValid = await verifyPassword(input.password, hash);
    if (!row || !passwordValid || row.status !== "active") {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    const principal = await loadPrincipal(sql, row.account_id);
    if (!principal) {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }
    const role = principal.role;
    if (role !== "patient" && role !== "nurse") {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }
    if (role === "nurse" && !nurseIdentityValid(principal, config)) {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }
    if (role === "patient" && !principal.patient_id) {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    const session = prepareSession(sessionTtlMs);
    const expiresAt = new Date(Date.now() + sessionTtlMs);
    const inserted = await sql.begin(async (tx) => {
      const created = await insertSession(tx, {
        accountId: principal.account_id,
        tokenHashHex: session.tokenHashHex,
        csrfHashHex: session.csrfHashHex,
        expiresAt,
        ipHash: hashIp(meta.ip, config.sessionSecret),
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      });
      await writeAuditEvent(tx, {
        actorAccountId: principal.account_id,
        action: "session.login",
        subjectType: "account",
        subjectId: principal.account_id,
        requestId: meta.requestId,
      });
      return created;
    });

    const access = await accessFor({ role, staffId: principal.staff_id });
    return {
      data: {
        account: accountView(principal.account_id, principal.email_normalized, role),
        session: { csrfToken: session.csrfToken, expiresAt: inserted.expiresAt },
        access,
      },
      token: session.token,
    };
  }

  async function session(auth: AuthContext) {
    return {
      account: accountView(auth.accountId, auth.email, auth.role),
      session: { csrfToken: auth.csrfToken, expiresAt: auth.expiresAt },
      access: await accessFor(auth),
      displayTimeZone: auth.displayTimeZone,
      expiresAt: auth.expiresAt,
      capabilities: capabilitySnapshot(),
    };
  }

  async function logout(auth: AuthContext, body: LogoutInput, requestId: string) {
    // Stop 1 has no push subscription resources (G05 is gated and no push table
    // exists), so an optional pushSubscriptionId can never match a stored
    // subscription. Session revocation must not depend on that absent resource.
    void body.pushSubscriptionId;
    await sql.begin(async (tx) => {
      await revokeSession(tx, auth.sessionId, auth.accountId);
      await writeAuditEvent(tx, {
        actorAccountId: auth.accountId,
        action: "session.logout",
        subjectType: "account",
        subjectId: auth.accountId,
        requestId,
      });
    });
  }

  return { authenticate, register, login, session, logout };
}
