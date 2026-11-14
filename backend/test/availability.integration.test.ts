import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../src/auth/password";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request } from "./fixtures/test-app";

const configured = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim());
const integration = configured ? describe : describe.skip;
const PASSWORD = "synthetic-min8-password";

type Nurse = { cookie: string; csrf: string; staffId: string; accountId: string; email: string };
type Patient = { cookie: string; csrf: string; patientId: string; accountId: string };
type AvailabilitySlot = { id?: string; startsAt: string; endsAt: string };
type AvailabilityPublication = {
  id: string;
  version: number;
  timeZone: string;
  slotMinutes: number;
  bufferMinutes: number;
  effectiveFrom: string;
  effectiveTo: string;
  windows: unknown[];
  slots: AvailabilitySlot[];
};
type AvailabilityData = {
  nurseId: string;
  version: number;
  current: AvailabilityPublication | null;
};
type PublicSlotsData = {
  nurseId: string;
  timeZone: string | null;
  items: Array<{
    id: string;
    nurseId: string;
    startsAt: string;
    endsAt: string;
    availabilityVersionId: string;
    availabilityVersion: number;
  }>;
  page: { nextCursor: string | null; hasMore: boolean };
};
type ApiBody<T> = { data: T; error?: { code: string } };

let db: DisposableDatabase;

function readResponseJson<T>(value: unknown): ApiBody<T> {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new Error("response did not contain the standard data envelope");
  }
  return value as ApiBody<T>;
}

function currentPublication(body: ApiBody<AvailabilityData>): AvailabilityPublication {
  if (body.data.current === null) {
    throw new Error("expected a current availability publication");
  }
  return body.data.current;
}

function appFor() {
  return createTestApp(db.sql).app;
}

async function setupNurse(label: string, email: string, staffCode: string): Promise<Nurse> {
  const passwordHash = await hashPassword(PASSWORD);
  const provisioned = await db.sql.begin((tx) =>
    provisionNurseInTransaction(tx, {
      email,
      passwordHash,
      staffCode,
      displayName: label,
      approvalReference: `approval-${staffCode}`,
      operator: "synthetic-operator",
      nurseDomain: "nurse.invalid",
    }),
  );
  const response = await appFor().handle(
    jsonRequest("/api/v1/auth/login", "POST", { email, password: PASSWORD }),
  );
  expect(response.status).toBe(200);
  const body = readResponseJson<{ session: { csrfToken: string } }>(await response.json());
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    staffId: provisioned.staffId,
    accountId: provisioned.accountId,
    email,
  };
}

async function registerPatient(email: string): Promise<Patient> {
  const response = await appFor().handle(
    jsonRequest("/api/v1/auth/register", "POST", {
      fullName: "Availability Patient",
      birthDate: "1991-04-12",
      gender: "female",
      email,
      phone: "+6281234567891",
      password: PASSWORD,
    }),
  );
  expect(response.status).toBe(201);
  const body = readResponseJson<{
    session: { csrfToken: string };
    patientProfile: { id: string };
    account: { id: string };
  }>(await response.json());
  return {
    cookie: cookieFrom(response),
    csrf: body.data.session.csrfToken,
    patientId: body.data.patientProfile.id,
    accountId: body.data.account.id,
  };
}

function authed(method: string, path: string, body: unknown, actor: Pick<Nurse, "cookie" | "csrf">, key = randomUUID()) {
  return jsonRequest(path, method, body, {
    cookie: actor.cookie,
    "x-csrf-token": actor.csrf,
    "idempotency-key": key,
  });
}

async function responseBody<T>(response: Response, status: number): Promise<ApiBody<T>> {
  const text = await response.text();
  expect({ status: response.status, body: text }).toMatchObject({ status });
  return readResponseJson<T>(JSON.parse(text));
}

function atOffset(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function alignedFuture(dayOffset = 1): Date {
  const date = atOffset(dayOffset * 24 * 60);
  // Synthetic contract fixture: Mon–Fri 09:00–17:00 Asia/Jakarta, 60 min,
  // zero buffer. Move forward to the next Monday without using server local time.
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(2, 0, 0, 0); // 09:00 Asia/Jakarta
  if (date.getTime() <= Date.now() + 60_000) date.setUTCDate(date.getUTCDate() + 7);
  return date;
}

function timestamp(date: Date): string {
  return date.toISOString();
}

function publishBody(overrides: Record<string, unknown> = {}) {
  const start = alignedFuture();
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    expectedVersion: 0,
    timeZone: "Asia/Jakarta",
    slotMinutes: 60,
    bufferMinutes: 0,
    effectiveFrom: timestamp(new Date(start.getTime() - 60 * 60_000)),
    effectiveTo: timestamp(new Date(start.getTime() + 8 * 60 * 60_000)),
    windows: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startMinute: 9 * 60,
      endMinute: 17 * 60,
    })),
    slots: [{ startsAt: timestamp(start), endsAt: timestamp(end) }],
    ...overrides,
  };
}

async function publish(actor: Nurse, body: Record<string, unknown>, key = randomUUID()) {
  return appFor().handle(
    authed("PUT", "/api/v1/nurses/me/availability", body, actor, key),
  );
}

integration("Stop4 availability", () => {
  beforeAll(async () => {
    db = await createDisposableDatabase("availability");
  }, 90_000);

  afterAll(async () => {
    await db?.close();
  });

  test("self-only publishing is strictly validated, immutable, versioned and idempotent", async () => {
    const nurse = await setupNurse("Availability Nurse", "availability.one@nurse.invalid", "AVAIL-001");
    const patient = await registerPatient("availability-patient@example.com");
    const app = appFor();

    const initial = await responseBody<AvailabilityData>(
      await app.handle(request("/api/v1/nurses/me/availability", "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(initial.data).toEqual({ nurseId: nurse.staffId, version: 0, current: null });

    const patientPublish = await app.handle(
      jsonRequest("/api/v1/nurses/me/availability", "PUT", publishBody(), {
        cookie: patient.cookie,
        "x-csrf-token": patient.csrf,
        "idempotency-key": randomUUID(),
      }),
    );
    expect(patientPublish.status).toBe(403);

    const body = publishBody();
    const key = randomUUID();
    const created = await responseBody<AvailabilityData>(await publish(nurse, body, key), 200);
    expect(created.data).toMatchObject({ nurseId: nurse.staffId, version: 1 });
    const publication = currentPublication(created);
    expect(publication).toMatchObject({
      version: 1,
      timeZone: "Asia/Jakarta",
      slotMinutes: 60,
      bufferMinutes: 0,
      windows: body.windows,
    });
    expect(publication.slots).toHaveLength(1);
    expect(publication.slots[0]).toMatchObject(body.slots[0]);

    const replay = await responseBody<AvailabilityData>(await publish(nurse, body, key), 200);
    expect(replay.data).toEqual(created.data);
    const conflict = await publish(nurse, publishBody({ expectedVersion: 0 }), randomUUID());
    expect(conflict.status).toBe(409);
    const idempotencyConflict = await publish(nurse, publishBody({ expectedVersion: 1 }), key);
    expect(idempotencyConflict.status).toBe(409);

    const missingCsrf = await app.handle(
      jsonRequest("/api/v1/nurses/me/availability", "PUT", publishBody({ expectedVersion: 1 }), {
        cookie: nurse.cookie,
        "idempotency-key": randomUUID(),
      }),
    );
    expect(missingCsrf.status).toBe(403);

    const unknown = await publish(nurse, publishBody({ expectedVersion: 1, workHours: "09-17" }));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNKNOWN_FIELD" } });
    const noIdempotency = await app.handle(
      jsonRequest("/api/v1/nurses/me/availability", "PUT", publishBody({ expectedVersion: 1 }), {
        cookie: nurse.cookie,
        "x-csrf-token": nurse.csrf,
      }),
    );
    expect(noIdempotency.status).toBe(400);
  });

  test("rejects past/non-UTC/invalid zones, overlap, horizon, duration and full-window violations", async () => {
    const nurse = await setupNurse("Validation Nurse", "availability.validation@nurse.invalid", "AVAIL-002");
    const valid = publishBody();
    const startsAt = new Date(valid.slots[0].startsAt);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["past", publishBody({ effectiveFrom: timestamp(atOffset(-60)) })],
      ["offset timestamp", publishBody({ effectiveFrom: "2027-01-04T08:00:00+07:00" })],
      ["zone", publishBody({ timeZone: "Not/A_Zone" })],
      ["90 day horizon", publishBody({ effectiveTo: timestamp(new Date(startsAt.getTime() + 91 * 24 * 60 * 60_000)) })],
      ["overlapping windows", publishBody({ windows: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 600, endMinute: 780 }] })],
      ["duration", publishBody({ slots: [{ startsAt: timestamp(startsAt), endsAt: timestamp(new Date(startsAt.getTime() + 30 * 60_000)) }] })],
      ["outside window", publishBody({ slots: [{ startsAt: timestamp(new Date(startsAt.getTime() - 60 * 60_000)), endsAt: timestamp(startsAt) }] })],
      ["overlapping slots", publishBody({ slots: [{ startsAt: timestamp(startsAt), endsAt: timestamp(new Date(startsAt.getTime() + 60 * 60_000)) }, { startsAt: timestamp(new Date(startsAt.getTime() + 30 * 60_000)), endsAt: timestamp(new Date(startsAt.getTime() + 90 * 60_000)) }] })],
      ["too many slots", publishBody({ slots: Array.from({ length: 201 }, () => ({ startsAt: timestamp(startsAt), endsAt: timestamp(new Date(startsAt.getTime() + 60 * 60_000)) })) })],
    ];
    for (const [label, body] of cases) {
      const response = await publish(nurse, body);
      expect({ label, status: response.status }).toMatchObject({ label, status: 422 });
    }
  });

  test("future public reads use highest applicable versions and preserve accepted intervals", async () => {
    const nurse = await setupNurse("Version Nurse", "availability.versions@nurse.invalid", "AVAIL-003");
    const patient = await registerPatient("availability-version-patient@example.com");
    const app = appFor();
    const start = alignedFuture();
    const firstSlot = { startsAt: timestamp(start), endsAt: timestamp(new Date(start.getTime() + 60 * 60_000)) };
    const first = await responseBody<AvailabilityData>(
      await publish(nurse, publishBody({ slots: [firstSlot] })),
      200,
    );
    const firstPublication = currentPublication(first);
    const firstVersionId = firstPublication.id;
    const firstId = firstPublication.slots[0].id;
    if (!firstId) throw new Error("published slot must have an id");

    const profile = await responseBody<{ version: number }>(
      await app.handle(request("/api/v1/me/profile", "GET", { cookie: patient.cookie })), 200,
    );
    await responseBody(await app.handle(authed("PATCH", "/api/v1/me/profile", {
      expectedVersion: profile.data.version, addressLine: "Synthetic availability test address",
    }, patient)), 200);
    const draft = await responseBody<{ id: string; version: number }>(
      await app.handle(authed("POST", "/api/v1/me/bookings", {
        nurseId: nurse.staffId, slotId: firstId,
        startsAt: firstSlot.startsAt, endsAt: firstSlot.endsAt,
        intake: {
          complaint: "Synthetic availability reservation", otherComplaint: null,
          history: null, consciousness: null, conditions: [], observations: [],
          note: null, consent: true,
        },
      }, patient)), 201,
    );
    const submitted = await responseBody<{ version: number }>(
      await app.handle(authed("POST", `/api/v1/me/bookings/${draft.data.id}/submit`, {
        expectedVersion: draft.data.version,
      }, patient)), 200,
    );
    await responseBody(await app.handle(authed("POST", `/api/v1/bookings/${draft.data.id}/decisions`, {
      expectedVersion: submitted.data.version, decision: "accept", reason: null,
    }, nurse)), 200);
    const secondSlot = {
      startsAt: timestamp(new Date(start.getTime() + 2 * 60 * 60_000)),
      endsAt: timestamp(new Date(start.getTime() + 3 * 60 * 60_000)),
    };
    const replacementBody = publishBody({
      expectedVersion: 1,
      effectiveFrom: firstSlot.startsAt,
      slots: [
        { startsAt: timestamp(new Date(start.getTime() + 7 * 60 * 60_000)), endsAt: timestamp(new Date(start.getTime() + 8 * 60 * 60_000)) },
        secondSlot,
      ],
    });
    const replacement = await responseBody<AvailabilityData>(await publish(nurse, replacementBody), 200);
    expect(replacement.data.version).toBe(2);
    const replacementPublication = currentPublication(replacement);
    expect(replacementPublication.slots).toHaveLength(2);
    const history = await responseBody<AvailabilityData>(
      await app.handle(request("/api/v1/nurses/me/availability", "GET", { cookie: nurse.cookie })),
      200,
    );
    expect(currentPublication(history).id).toBe(replacementPublication.id);

    const from = encodeURIComponent(new Date(start.getTime() - 60_000).toISOString());
    const to = encodeURIComponent(new Date(start.getTime() + 8 * 60 * 60_000).toISOString());
    const slots = await responseBody<PublicSlotsData>(
      await app.handle(
        request(`/api/v1/nurses/${nurse.staffId}/slots?from=${from}&to=${to}`, "GET", {
          cookie: patient.cookie,
        }),
      ),
      200,
    );
    expect(slots.data.items).toHaveLength(2);
    expect(slots.data.items[0]).toMatchObject({
      nurseId: nurse.staffId,
      availabilityVersion: 2,
      ...secondSlot,
    });
    expect(JSON.stringify(slots.data)).not.toContain("patientId");
    expect(JSON.stringify(slots.data)).not.toContain("intake");
    const accepted = await db.sql`
      SELECT starts_at, ends_at, status FROM public.bookings WHERE id = (
        SELECT id FROM public.bookings WHERE slot_id = ${firstId} LIMIT 1
      )
    `;
    expect(accepted).toHaveLength(1);
    expect(accepted[0].status).toBe("accepted");
  });

  test("no availability is empty, pagination is scope/filter-bound and inactive nurses disappear", async () => {
    const nurse = await setupNurse("Paging Nurse", "availability.paging@nurse.invalid", "AVAIL-004");
    const nurseWithoutAvailability = await setupNurse(
      "Empty Nurse",
      "availability.empty@nurse.invalid",
      "AVAIL-005",
    );
    const patient = await registerPatient("availability-paging-patient@example.com");
    const other = await registerPatient("availability-other-patient@example.com");
    const app = appFor();
    const start = alignedFuture();
    const body = publishBody({
      slots: [0, 1, 2].map((offset) => ({
        startsAt: timestamp(new Date(start.getTime() + offset * 60 * 60_000)),
        endsAt: timestamp(new Date(start.getTime() + (offset + 1) * 60 * 60_000)),
      })),
    });
    await responseBody<AvailabilityData>(await publish(nurse, body), 200);
    const from = encodeURIComponent(new Date(start.getTime() - 60_000).toISOString());
    const to = encodeURIComponent(new Date(start.getTime() + 8 * 60 * 60_000).toISOString());
    const path = `/api/v1/nurses/${nurse.staffId}/slots?from=${from}&to=${to}`;
    const emptyPath = `/api/v1/nurses/${nurseWithoutAvailability.staffId}/slots?from=${from}&to=${to}`;
    const empty = await responseBody<PublicSlotsData>(
      await app.handle(request(emptyPath, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(empty.data).toMatchObject({ nurseId: nurseWithoutAvailability.staffId, timeZone: null, items: [], page: { hasMore: false, nextCursor: null } });

    const page1 = await responseBody<PublicSlotsData>(
      await app.handle(request(`${path}&limit=2`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(page1.data.items).toHaveLength(2);
    expect(page1.data.page).toMatchObject({ hasMore: true });
    expect(page1.data.page.nextCursor).toBeString();
    const page2 = await responseBody<PublicSlotsData>(
      await app.handle(request(`${path}&limit=2&cursor=${encodeURIComponent(page1.data.page.nextCursor ?? "")}`, "GET", { cookie: patient.cookie })),
      200,
    );
    expect(page2.data.items).toHaveLength(1);
    expect(page2.data.items[0]).toMatchObject(body.slots[2]);
    expect(page2.data.page).toEqual({ hasMore: false, nextCursor: null });
    const wrongSession = await app.handle(
      request(`${path}&cursor=${encodeURIComponent(page1.data.page.nextCursor ?? "")}`, "GET", { cookie: other.cookie }),
    );
    expect(wrongSession.status).toBe(422);
    const wrongFilter = await app.handle(
      request(`${path}&cursor=${encodeURIComponent(page1.data.page.nextCursor ?? "")}&limit=100`, "GET", { cookie: patient.cookie }),
    );
    // Limit is pagination, not filter scope; only an actually changed interval is rejected.
    expect(wrongFilter.status).toBe(200);
    const changedTo = encodeURIComponent(new Date(start.getTime() + 7 * 60 * 60_000).toISOString());
    const wrongInterval = await app.handle(
      request(`/api/v1/nurses/${nurse.staffId}/slots?from=${from}&to=${changedTo}&cursor=${encodeURIComponent(page1.data.page.nextCursor ?? "")}`, "GET", { cookie: patient.cookie }),
    );
    expect(wrongInterval.status).toBe(422);
    const tooWide = await app.handle(
      request(`/api/v1/nurses/${nurse.staffId}/slots?from=${from}&to=${encodeURIComponent(new Date(start.getTime() + 32 * 24 * 60 * 60_000).toISOString())}`, "GET", { cookie: patient.cookie }),
    );
    expect(tooWide.status).toBe(422);

    await db.sql`UPDATE public.staff SET active = false WHERE id = ${nurseWithoutAvailability.staffId}`;
    const disabled = await app.handle(request(emptyPath, "GET", { cookie: patient.cookie }));
    expect(disabled.status).toBe(404);
  });
});
