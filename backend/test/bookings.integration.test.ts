import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "../src/auth/password";
import { provisionNurseInTransaction } from "../src/staff/provisioning";
import { createDisposableDatabase, type DisposableDatabase } from "./fixtures/disposable-database";
import { cookieFrom, createTestApp, jsonRequest, request as unauthedRequest } from "./fixtures/test-app";

const integration = Boolean(process.env.FORCARE_TEST_DATABASE_URL?.trim()) ? describe : describe.skip;
const PASSWORD = "synthetic-min8-password";
let db: DisposableDatabase;

type TestApp = ReturnType<typeof createTestApp>["app"];
type Actor = { cookie: string; csrf: string };
type Patient = Actor & { patientId: string; email: string };
type Nurse = Actor & { staffId: string; accountId: string; email: string };
type Slot = z.infer<typeof slotSchema>;
type Booking = z.infer<typeof bookingSchema>;
type Priority = z.infer<typeof prioritySchema>;
type Page = z.infer<typeof pageSchema>;

const bookingSchema = z.object({
  id: z.string(), patientId: z.string(), version: z.number(), status: z.string(),
  startsAt: z.string(), endsAt: z.string(),
  visitId: z.string().nullable(), slotId: z.string().nullable(),
  intake: z.unknown(), profileSnapshot: z.object({ phone: z.string() }).passthrough().nullable(),
  events: z.array(z.object({ action: z.string() }).passthrough()),
}).passthrough();
const pageSchema = z.object({
  items: z.array(z.object({
    id: z.string(), startsAt: z.string(), endsAt: z.string(), status: z.string(), version: z.number(),
  }).passthrough()),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});
const dataSchema = z.object({ data: z.unknown() });
const authSchema = z.object({ data: z.object({
  session: z.object({ csrfToken: z.string() }),
  patientProfile: z.object({ id: z.string() }).optional(),
}) });
const slotSchema = z.object({ id: z.string(), startsAt: z.string(), endsAt: z.string() });
const prioritySchema = z.object({ id: z.string(), version: z.number(), status: z.string() }).passthrough();

async function responseData(response: Response): Promise<unknown> {
  return dataSchema.parse(await response.json()).data;
}

async function responseBooking(response: Response): Promise<Booking> {
  return bookingSchema.parse(await responseData(response));
}

async function responsePage(response: Response): Promise<Page> {
  return pageSchema.parse(await responseData(response));
}

function mutationRequest(path: string, method: string, body: unknown, actor: Actor, key?: string) {
  return jsonRequest(path, method, body, {
    cookie: actor.cookie,
    "x-csrf-token": actor.csrf,
    ...(key ? { "idempotency-key": key } : {}),
  });
}

function appFor(): TestApp {
  return createTestApp(db.sql).app;
}

function startAt(dayOffset: number, hour: number): Date {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

function intake(complaint = "Synthetic booking request") {
  return {
    complaint,
    otherComplaint: null,
    history: null,
    consciousness: null,
    conditions: [],
    observations: [{ type: "temperature_c", value: 37.2, unit: "c", observedAt: new Date().toISOString() }],
    note: null,
    consent: true,
  };
}

async function login(email: string): Promise<Actor> {
  const response = await appFor().handle(jsonRequest("/api/v1/auth/login", "POST", { email, password: PASSWORD }));
  expect(response.status).toBe(200);
  const body = authSchema.parse(await response.json());
  return { cookie: cookieFrom(response), csrf: body.data.session.csrfToken };
}

async function registerPatient(email: string): Promise<Patient> {
  const response = await appFor().handle(jsonRequest("/api/v1/auth/register", "POST", {
    fullName: "Synthetic Patient", birthDate: "1991-04-12", gender: "female",
    email, phone: "+6281234567890", password: PASSWORD,
  }));
  expect(response.status).toBe(201);
  const body = authSchema.parse(await response.json());
  const actor = {
    cookie: cookieFrom(response), csrf: body.data.session.csrfToken,
    patientId: body.data.patientProfile!.id, email,
  };
  const profile = await appFor().handle(mutationRequest("/api/v1/me/profile", "PATCH", {
    expectedVersion: 0,
    addressLine: "Synthetic Street 1",
  }, actor, randomUUID()));
  expect(profile.status).toBe(200);
  return actor;
}

async function provisionNurse(email: string): Promise<Nurse> {
  const passwordHash = await hashPassword(PASSWORD);
  const provisioned = await db.sql.begin((tx) => provisionNurseInTransaction(tx, {
    email, passwordHash, staffCode: randomUUID().slice(0, 12), displayName: "Synthetic Nurse",
    approvalReference: `approval-${randomUUID()}`, operator: "synthetic-operator", nurseDomain: "nurse.invalid",
  }));
  return { ...await login(email), ...provisioned, email };
}

async function publishAvailability(app: TestApp, nurse: Nurse, startsAt: Date, policyHours: number, bufferMinutes = 0): Promise<void> {
  const currentResponse = await app.handle(unauthedRequest("/api/v1/nurses/me/availability", "GET", { cookie: nurse.cookie }));
  expect(currentResponse.status).toBe(200);
  const current = z.object({ data: z.object({ version: z.number() }) }).parse(await currentResponse.json());
  const response = await app.handle(mutationRequest("/api/v1/nurses/me/availability", "PUT", {
    expectedVersion: current.data.version,
    timeZone: "Asia/Jakarta",
    slotMinutes: 60,
    bufferMinutes,
    effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
    effectiveTo: new Date(startsAt.getTime() + policyHours * 3_600_000).toISOString(),
    windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
    slots: [{ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString() }],
  }, nurse, randomUUID()));
  expect(response.status).toBe(200);
}

async function slots(app: TestApp, patient: Patient, nurseId: string, startsAt: Date): Promise<Slot[]> {
  const from = new Date(startsAt.getTime() - 1_000);
  const to = new Date(startsAt.getTime() + 3_600_000 + 1_000);
  const response = await app.handle(unauthedRequest(`/api/v1/nurses/${nurseId}/slots?from=${from.toISOString()}&to=${to.toISOString()}`, "GET", { cookie: patient.cookie }));
  expect(response.status).toBe(200);
  const data = z.object({ data: z.object({ items: z.array(slotSchema) }) }).parse(await response.json());
  const matches = data.data.items.filter((slot) => slot.startsAt === startsAt.toISOString());
  expect(matches).toHaveLength(1);
  return matches;
}

async function createDraft(app: TestApp, actor: Patient, nurseId: string, slot: Slot | null, startsAt: Date): Promise<Booking> {
  const body = {
    nurseId, slotId: slot?.id ?? null, startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    intake: intake(),
  };
  const response = await app.handle(mutationRequest("/api/v1/me/bookings", "POST", body, actor, randomUUID()));
  expect(response.status).toBe(201);
  return responseBooking(response);
}

async function submit(app: TestApp, actor: Actor, current: Booking): Promise<Booking> {
  const response = await app.handle(mutationRequest(`/api/v1/me/bookings/${current.id}/submit`, "POST", { expectedVersion: current.version }, actor, randomUUID()));
  expect(response.status).toBe(200);
  return responseBooking(response);
}

async function accept(app: TestApp, actor: Actor, current: Booking): Promise<Booking> {
  const response = await app.handle(mutationRequest(`/api/v1/bookings/${current.id}/decisions`, "POST", { expectedVersion: current.version, decision: "accept", reason: null }, actor, randomUUID()));
  expect(response.status).toBe(200);
  return responseBooking(response);
}

async function priorityFor(app: TestApp, owner: Patient, nurse: Nurse, booking: Booking, target: Date): Promise<Priority> {
  const created = await app.handle(mutationRequest("/api/v1/me/priority-requests", "POST", {
    bookingId: booking.id, statement: "Synthetic availability exception request",
    ...(booking.status === "accepted" ? {
      startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 3_600_000).toISOString(),
    } : {}),
  }, owner, randomUUID()));
  expect(created.status).toBe(201);
  const request = prioritySchema.parse(await responseData(created));
  const reviewed = await app.handle(mutationRequest(`/api/v1/priority-requests/${request.id}/review`, "POST", {
    expectedVersion: request.version, decision: "accept_availability", available: true, reason: "Synthetic approval",
  }, nurse, randomUUID()));
  expect(reviewed.status).toBe(200);
  return prioritySchema.parse(await responseData(reviewed));
}

beforeAll(async () => {
  db = await createDisposableDatabase("bookings");
}, 180_000);
afterAll(async () => { await db?.close(); });

integration("Stop4 booking consumers", () => {
  test("draft submission freezes identity and competitive acceptance creates one visit", async () => {
    const app = appFor();
    const first = await registerPatient(`${randomUUID()}@example.invalid`);
    const second = await registerPatient(`${randomUUID()}@example.invalid`);
    const selected = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const unrelated = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const start = startAt(10, 9);
    await publishAvailability(app, selected, start, 2);
    const slot = (await slots(app, first, selected.staffId, start))[0]!;
    const a = await createDraft(app, first, selected.staffId, slot, new Date(slot.startsAt));
    const b = await createDraft(app, second, selected.staffId, slot, new Date(slot.startsAt));
    await db.sql`UPDATE public.patients SET phone = '+6289999999' WHERE id = ${first.patientId}`;
    const submittedA = await submit(app, first, a);
    expect(submittedA.version).toBe(a.version + 1);
    const submittedB = await submit(app, second, b);
    expect(submittedB.version).toBe(b.version + 1);
    expect(submittedA.profileSnapshot?.phone).toBe("+6289999999");
    expect(submittedA.status).toBe("submitted");
    const denied = await app.handle(mutationRequest(`/api/v1/bookings/${a.id}/decisions`, "POST", { expectedVersion: submittedA.version, decision: "accept", reason: null }, unrelated, randomUUID()));
    expect(denied.status).toBe(404);
    const stale = await app.handle(mutationRequest(`/api/v1/bookings/${a.id}/decisions`, "POST", { expectedVersion: a.version, decision: "accept", reason: null }, selected, randomUUID()));
    expect(stale.status).toBe(409);
    const [won, lost] = await Promise.all([
      app.handle(mutationRequest(`/api/v1/bookings/${a.id}/decisions`, "POST", { expectedVersion: submittedA.version, decision: "accept", reason: null }, selected, randomUUID())),
      app.handle(mutationRequest(`/api/v1/bookings/${b.id}/decisions`, "POST", { expectedVersion: submittedB.version, decision: "accept", reason: null }, selected, randomUUID())),
    ]);
    expect([won.status, lost.status].sort()).toEqual([200, 409]);
    const acceptedId = won.status === 200 ? a.id : b.id;
    const conflict = won.status === 409 ? won : lost;
    expect(await db.sql`SELECT status FROM public.visits WHERE booking_id = ${acceptedId}`).toEqual([{ status: "scheduled" }]);
    expect(await db.sql`SELECT count(*)::int AS count FROM public.visits WHERE booking_id IN (${a.id}, ${b.id})`).toEqual([{ count: 1 }]);
    const text = await conflict.text();
    expect(text).not.toContain(first.patientId);
    expect(text).not.toContain(second.patientId);
  }, 120_000);

  test("one patient cannot overlap accepted future visits with different nurses", async () => {
    const app = appFor();
    const owner = await registerPatient(`${randomUUID()}@example.invalid`);
    const firstNurse = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const secondNurse = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const start = startAt(11, 9);
    await publishAvailability(app, firstNurse, start, 2);
    await publishAvailability(app, secondNurse, start, 2);
    const first = await submit(app, owner, await createDraft(app, owner, firstNurse.staffId, (await slots(app, owner, firstNurse.staffId, start))[0]!, start));
    const second = await submit(app, owner, await createDraft(app, owner, secondNurse.staffId, (await slots(app, owner, secondNurse.staffId, start))[0]!, start));
    await accept(app, firstNurse, first);
    const response = await app.handle(mutationRequest(`/api/v1/bookings/${second.id}/decisions`, "POST", { expectedVersion: second.version, decision: "accept", reason: null }, secondNurse, randomUUID()));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("SCHEDULE_CONFLICT");
    expect(text).not.toContain(first.id);
    expect(text).not.toContain(owner.patientId);
  }, 120_000);

  test("submission receipt replays only in its original session and fresh reads remain authorized", async () => {
    const app = appFor();
    const owner = await registerPatient(`${randomUUID()}@example.invalid`);
    const selected = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const start = startAt(12, 9);
    await publishAvailability(app, selected, start, 2);
    const current = await createDraft(app, owner, selected.staffId, (await slots(app, owner, selected.staffId, start))[0]!, start);
    const key = randomUUID();
    const first = await app.handle(mutationRequest(`/api/v1/me/bookings/${current.id}/submit`, "POST", { expectedVersion: 0 }, owner, key));
    expect(first.status).toBe(200);
    const original = await responseData(first);
    const sameSessionReplay = await app.handle(mutationRequest(`/api/v1/me/bookings/${current.id}/submit`, "POST", { expectedVersion: 0 }, owner, key));
    expect(sameSessionReplay.status).toBe(200);
    expect(await responseData(sameSessionReplay)).toEqual(original);
    const fresh = await login(owner.email);
    const newSession = await app.handle(mutationRequest(`/api/v1/me/bookings/${current.id}/submit`, "POST", { expectedVersion: 0 }, fresh, key));
    expect(newSession.status).toBe(409);
    const accepted = await accept(app, selected, bookingSchema.parse(original));
    expect(accepted.version).toBe(2);
    const live = await app.handle(unauthedRequest(`/api/v1/me/bookings/${current.id}`, "GET", { cookie: fresh.cookie }));
    expect(live.status).toBe(200);
    expect((await responseBooking(live)).events.map((event) => event.action)).toContain("booking.accepted");
  }, 120_000);

  test("accepted visit requires approved exception and both actors atomically cancel visits", async () => {
    const app = appFor();
    const owner = await registerPatient(`${randomUUID()}@example.invalid`);
    const selected = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const outsider = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const start = startAt(13, 9);
    await publishAvailability(app, selected, start, 24);
    const pendingSlot = (await slots(app, owner, selected.staffId, start))[0]!;
    for (const actor of [owner, selected] as const) {
      const pending = await submit(app, owner, await createDraft(app, owner, selected.staffId, pendingSlot, start));
      const path = actor === owner ? `/api/v1/me/bookings/${pending.id}/cancel` : `/api/v1/bookings/${pending.id}/cancel`;
      const response = await app.handle(mutationRequest(path, "POST", {
        expectedVersion: pending.version, reason: "Synthetic pending cancellation",
      }, actor, randomUUID()));
      expect(response.status).toBe(200);
      const [cancelled] = await db.sql`SELECT status, decided_at, decision_by FROM public.bookings WHERE id = ${pending.id}`;
      expect(cancelled).toMatchObject({ status: "cancelled", decided_at: null, decision_by: null });
      const [event] = await db.sql`SELECT actor_account_id, reason FROM public.booking_events WHERE booking_id = ${pending.id} AND action = 'booking.cancelled'`;
      expect(event.reason).toBe("Synthetic pending cancellation");
      const [account] = actor === owner
        ? await db.sql`SELECT account_id FROM public.patients WHERE id = ${owner.patientId}`
        : await db.sql`SELECT account_id FROM public.staff WHERE id = ${selected.staffId}`;
      expect(event.actor_account_id).toBe(account.account_id);
    }
    const editedDraft = await createDraft(app, owner, selected.staffId, pendingSlot, start);
    const patch = await app.handle(mutationRequest(`/api/v1/me/bookings/${editedDraft.id}`, "PATCH", {
      expectedVersion: editedDraft.version, intake: intake("Edited synthetic request"),
    }, owner, randomUUID()));
    expect(patch.status).toBe(200);
    const patchedDraft = await responseBooking(patch);
    expect(patchedDraft.version).toBe(1);
    const sameSlotBooking = await accept(app, selected, await submit(app, owner, patchedDraft));
    expect(sameSlotBooking.version).toBe(3);
    expect(await db.sql`SELECT version FROM public.visits WHERE booking_id = ${sameSlotBooking.id}`).toEqual([{ version: 0 }]);
    const sameSlot = await app.handle(mutationRequest(`/api/v1/bookings/${sameSlotBooking.id}/reschedule`, "POST", {
      expectedVersion: sameSlotBooking.version, slotId: sameSlotBooking.slotId,
      startsAt: sameSlotBooking.startsAt, endsAt: sameSlotBooking.endsAt,
      reason: "Synthetic same-slot patient agreement", patientAgreed: true,
    }, selected, randomUUID()));
    expect(sameSlot.status).toBe(200);
    const sameSlotBookingRescheduled = await responseBooking(sameSlot);
    const [sameIntervalEvent] = await db.sql`
      SELECT reason, data FROM public.booking_events
      WHERE booking_id = ${sameSlotBooking.id} AND action = 'booking.rescheduled'
    `;
    expect(sameIntervalEvent.reason).toBe("Synthetic same-slot patient agreement");
    expect(sameIntervalEvent.data).toMatchObject({
      patientAgreed: true, previousVersion: sameSlotBooking.version,
      version: sameSlotBookingRescheduled.version,
      startsAt: sameSlotBooking.startsAt, endsAt: sameSlotBooking.endsAt,
      previousStartsAt: sameSlotBooking.startsAt, previousEndsAt: sameSlotBooking.endsAt,
    });

    const target = new Date(start.getTime() + 7_200_000);
    const beforeException = await app.handle(mutationRequest(`/api/v1/bookings/${sameSlotBooking.id}/reschedule`, "POST", {
      expectedVersion: sameSlotBookingRescheduled.version, slotId: null, startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 3_600_000).toISOString(),
      reason: "Synthetic reschedule request", patientAgreed: true,
    }, selected, randomUUID()));
    expect(beforeException.status).toBe(422);
    const exception = await priorityFor(app, owner, selected, sameSlotBookingRescheduled, target);
    expect(exception.status).toBe("availability_accepted");
    expect(bookingSchema.parse(await responseData(await app.handle(unauthedRequest(`/api/v1/me/bookings/${sameSlotBooking.id}`, "GET", { cookie: owner.cookie })))).status).toBe("accepted");
    const denied = await app.handle(mutationRequest(`/api/v1/bookings/${sameSlotBooking.id}/reschedule`, "POST", {
      expectedVersion: sameSlotBookingRescheduled.version, slotId: null, startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 3_600_000).toISOString(),
      reason: "Synthetic reschedule request", patientAgreed: true,
    }, outsider, randomUUID()));
    expect(denied.status).toBe(404);
    const rescheduled = await app.handle(mutationRequest(`/api/v1/bookings/${sameSlotBooking.id}/reschedule`, "POST", {
      expectedVersion: sameSlotBookingRescheduled.version, slotId: null, startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 3_600_000).toISOString(),
      reason: "Synthetic approved patient agreement", patientAgreed: true,
    }, selected, randomUUID()));
    expect(rescheduled.status).toBe(200);
    const moved = await responseBooking(rescheduled);
    const visits = await db.sql`SELECT starts_at, ends_at, status, version FROM public.visits WHERE booking_id = ${sameSlotBooking.id}`;
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ status: "scheduled", version: 2 });
    expect(new Date(visits[0].starts_at).toISOString()).toBe(target.toISOString());

    const otherStart = startAt(14, 9);
    await publishAvailability(app, selected, otherStart, 24);
    const nurseCancelled = await accept(app, selected, await submit(app, owner, await createDraft(app, owner, selected.staffId, (await slots(app, owner, selected.staffId, otherStart))[0]!, otherStart)));
    const [nurseAcceptanceDecision] = await db.sql`SELECT decision_by, decided_at FROM public.bookings WHERE id = ${nurseCancelled.id}`;
    const cancellation = await app.handle(mutationRequest(`/api/v1/bookings/${nurseCancelled.id}/cancel`, "POST", { expectedVersion: nurseCancelled.version, reason: "Synthetic nurse cancellation" }, selected, randomUUID()));
    expect(cancellation.status).toBe(200);
    expect(await db.sql`SELECT status FROM public.visits WHERE booking_id = ${nurseCancelled.id}`).toEqual([{ status: "cancelled" }]);
    expect((await db.sql`SELECT decision_by, decided_at FROM public.bookings WHERE id = ${nurseCancelled.id}`)[0]).toEqual(nurseAcceptanceDecision);
    const [movedAcceptanceDecision] = await db.sql`SELECT decision_by, decided_at FROM public.bookings WHERE id = ${moved.id}`;
    const ownCancellation = await app.handle(mutationRequest(`/api/v1/me/bookings/${moved.id}/cancel`, "POST", { expectedVersion: moved.version, reason: "Synthetic patient cancellation" }, owner, randomUUID()));
    expect(ownCancellation.status).toBe(200);
    expect(await db.sql`SELECT status FROM public.visits WHERE booking_id = ${moved.id}`).toEqual([{ status: "cancelled" }]);
    expect((await db.sql`SELECT decision_by, decided_at FROM public.bookings WHERE id = ${moved.id}`)[0]).toEqual(movedAcceptanceDecision);
    expect(await db.sql`SELECT count(*)::int AS count FROM public.patient_access_grants WHERE source_booking_id IN (${moved.id}, ${nurseCancelled.id}) AND revoked_at IS NULL`).toEqual([{ count: 0 }]);
  }, 120_000);

  test("list and schedule cursors are scoped and care disclosure follows live grants", async () => {
    const app = appFor();
    const owner = await registerPatient(`${randomUUID()}@example.invalid`);
    const other = await registerPatient(`${randomUUID()}@example.invalid`);
    const selected = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const unrelated = await provisionNurse(`${randomUUID()}@nurse.invalid`);
    const start = startAt(15, 9);
    await publishAvailability(app, selected, start, 24, 30);
    const ordinary = await accept(app, selected, await submit(app, owner, await createDraft(app, owner, selected.staffId, (await slots(app, owner, selected.staffId, start))[0]!, start)));
    await publishAvailability(app, selected, start, 24, 30);
    const exceptionStart = new Date(start.getTime() + 8 * 3_600_000);
    const exempt = await createDraft(app, owner, selected.staffId, null, exceptionStart);
    await priorityFor(app, owner, selected, exempt, exceptionStart);
    await accept(app, selected, await submit(app, owner, exempt));
    const periods = (await db.sql`SELECT id, starts_at, ends_at, reserved_until FROM public.bookings WHERE id IN (${ordinary.id}, ${exempt.id})`) as unknown as Array<{ id: string; starts_at: Date; ends_at: Date; reserved_until: Date }>;
    const ordinaryPeriod = periods.find((period) => period.id === ordinary.id)!;
    const exemptPeriod = periods.find((period) => period.id === exempt.id)!;
    expect(ordinaryPeriod.reserved_until.getTime() - ordinaryPeriod.ends_at.getTime()).toBe(30 * 60_000);
    expect(exemptPeriod.reserved_until.getTime() - exemptPeriod.ends_at.getTime()).toBe(30 * 60_000);
    expect(exemptPeriod.starts_at.getTime()).toBeGreaterThanOrEqual(ordinaryPeriod.reserved_until.getTime());
    expect(new Date(ordinary.startsAt).getTime()).toBeLessThan(new Date(ordinary.endsAt).getTime());
    const exemptOnly = await responsePage(await app.handle(unauthedRequest(`/api/v1/schedule?from=${exemptPeriod.starts_at.toISOString()}&to=${new Date(exemptPeriod.ends_at.getTime() + 1).toISOString()}`, "GET", { cookie: selected.cookie })));
    expect(exemptOnly.items.map((item) => item.id)).toEqual([exempt.id]);
    const first = await responsePage(await app.handle(unauthedRequest("/api/v1/bookings?limit=1", "GET", { cookie: selected.cookie })));
    expect(first.page.hasMore).toBe(true);
    expect(first.items).toHaveLength(1);
    if (first.page.nextCursor) {
      const second = await responsePage(await app.handle(unauthedRequest(`/api/v1/bookings?limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`, "GET", { cookie: selected.cookie })));
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    }
    const scheduleFrom = ordinaryPeriod.starts_at;
    const scheduleTo = new Date(scheduleFrom.getTime() + 10 * 3_600_000);
    const schedule = await responsePage(await app.handle(unauthedRequest(`/api/v1/schedule?from=${scheduleFrom.toISOString()}&to=${scheduleTo.toISOString()}&limit=1`, "GET", { cookie: selected.cookie })));
    expect(schedule.items).toHaveLength(1);
    expect(schedule.page.nextCursor).toBeTruthy();
    const otherList = await responsePage(await app.handle(unauthedRequest("/api/v1/bookings", "GET", { cookie: unrelated.cookie })));
    expect(otherList.items).toHaveLength(0);
    const hidden = await app.handle(unauthedRequest(`/api/v1/me/bookings/${ordinary.id}`, "GET", { cookie: other.cookie }));
    expect(hidden.status).toBe(404);
    const medicalRecordId = randomUUID();
    const sourceId = randomUUID();
    const orderId = randomUUID();
    const publishedAt = new Date().toISOString();
    const effectiveFrom = new Date(Date.now() - 3_600_000).toISOString();
    const orderItems = [{ type: "wound_care", text: "Synthetic patient-facing care item" }];
    await db.sql`
      INSERT INTO public.medical_record_versions (id, patient_id, revision_number, entered_by, source_reference, payload)
      VALUES (${medicalRecordId}, ${owner.patientId}, 1, ${selected.staffId}, 'Synthetic private source reference',
        (${JSON.stringify({
          primaryDiagnosis: null, secondaryDiagnoses: [], admittedAt: null, dischargedAt: null,
          allergies: [], procedures: [], complaints: null, observations: [],
          internalNote: "Synthetic staff-only medical note",
        })}::text)::jsonb)
    `;
    await db.sql`
      INSERT INTO public.clinical_source_documents (
        id, lineage_id, revision_number, patient_id, medical_record_version_id, kind, title, body, checksum, created_by
      ) VALUES (
        ${sourceId}, ${randomUUID()}, 1, ${owner.patientId}, ${medicalRecordId}, 'wound_care',
        'Synthetic approved source', 'Synthetic patient-facing source body', ${"a".repeat(64)}, ${selected.staffId}
      )
    `;
    await db.sql`
      UPDATE public.clinical_source_documents
      SET status = 'approved', approved_by = ${selected.staffId}, approved_at = ${publishedAt}::timestamptz, version = 1
      WHERE id = ${sourceId}
    `;
    await db.sql`
      INSERT INTO public.care_orders (
        id, lineage_id, revision_number, patient_id, medical_record_version_id, kind,
        source_document_id, source_version, payload, effective_from, entered_by
      ) VALUES (
        ${orderId}, ${randomUUID()}, 1, ${owner.patientId}, ${medicalRecordId}, 'care', ${sourceId}, 1,
        (${JSON.stringify({ instructions: "Synthetic patient-facing instructions", items: orderItems })}::text)::jsonb,
        ${effectiveFrom}::timestamptz, ${selected.staffId}
      )
    `;
    await db.sql`
      UPDATE public.care_orders
      SET status = 'active', published_by = ${selected.staffId}, published_at = ${publishedAt}::timestamptz, version = 1
      WHERE id = ${orderId}
    `;
    expect((await app.handle(unauthedRequest(`/api/v1/bookings/${ordinary.id}/care-guide`, "GET", { cookie: unrelated.cookie }))).status).toBe(404);
    const guide = await app.handle(unauthedRequest(`/api/v1/bookings/${ordinary.id}/care-guide`, "GET", { cookie: selected.cookie }));
    expect(guide.status).toBe(200);
    const guideProjection = z.object({ patientId: z.string(), sources: z.array(z.unknown()), sourceVersions: z.array(z.unknown()), orders: z.array(z.unknown()) }).strict().parse(await responseData(guide));
    expect(guideProjection).toEqual({
      patientId: owner.patientId,
      sources: [{
        id: sourceId, kind: "wound_care", title: "Synthetic approved source", body: "Synthetic patient-facing source body",
        revisionNumber: 1, approvedAt: publishedAt,
      }],
      sourceVersions: [{ sourceDocumentId: sourceId, sourceVersion: 1 }],
      orders: [{
        id: orderId, kind: "care", revisionNumber: 1, sourceDocumentId: sourceId, sourceVersion: 1,
        instructions: "Synthetic patient-facing instructions", items: orderItems,
        effectiveFrom, effectiveTo: null, status: "active", version: 1,
      }],
    });
    const guideJson = JSON.stringify(guideProjection);
    for (const forbidden of [
      "internalNote", "Synthetic staff-only medical note", "Synthetic private source reference",
      "payload", "medicalRecordVersionId", "createdBy", "approvedBy", "enteredBy", "publishedBy",
      "publishedAt", "checksum", medicalRecordId, selected.staffId, selected.accountId,
    ]) expect(guideJson).not.toContain(forbidden);
    await db.sql`
      UPDATE public.patient_access_grants
      SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      WHERE source_visit_id IN (SELECT id FROM public.visits WHERE booking_id = ${exempt.id}) AND basis = 'visit'
    `;
    const expiredSummary = await responseBooking(await app.handle(unauthedRequest(`/api/v1/bookings/${exempt.id}`, "GET", { cookie: selected.cookie })));
    expect(expiredSummary.intake).toBeNull();
    expect(expiredSummary.profileSnapshot).toBeNull();
    expect((await app.handle(unauthedRequest(`/api/v1/bookings/${exempt.id}/care-guide`, "GET", { cookie: selected.cookie }))).status).toBe(404);
    await db.sql`UPDATE public.patient_access_grants SET revoked_at = now() WHERE source_booking_id IN (${ordinary.id}, ${exempt.id}) OR source_visit_id IN (SELECT id FROM public.visits WHERE booking_id IN (${ordinary.id}, ${exempt.id}))`;
    const summary = await responseBooking(await app.handle(unauthedRequest(`/api/v1/bookings/${ordinary.id}`, "GET", { cookie: selected.cookie })));
    expect(summary.intake).toBeNull();
    expect(summary.profileSnapshot).toBeNull();
    expect((await app.handle(unauthedRequest(`/api/v1/bookings/${ordinary.id}/care-guide`, "GET", { cookie: selected.cookie }))).status).toBe(404);
    expect((await app.handle(mutationRequest(`/api/v1/bookings/${ordinary.id}/reschedule`, "POST", {
      expectedVersion: ordinary.version, slotId: ordinary.slotId, startsAt: ordinary.startsAt, endsAt: ordinary.endsAt,
      reason: "Synthetic same-slot patient agreement", patientAgreed: true,
    }, selected, randomUUID()))).status).toBe(403);
  }, 120_000);
});
