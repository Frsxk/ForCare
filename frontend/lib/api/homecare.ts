import { ApiError, asApiError, prepareWrite, type ApiClient, type ApiPath, type WriteIntent } from "./client";

export const bookingStatuses = ["draft", "submitted", "accepted", "rejected", "cancelled"] as const;
export const priorityStatuses = ["pending", "availability_accepted", "declined"] as const;
export type BookingStatus = typeof bookingStatuses[number];
export type PriorityStatus = typeof priorityStatuses[number];
export type HomecareActor = "patient" | "nurse";
export type HomecareObservation = {
  type: "temperature_c" | "heart_rate_bpm" | "bp_systolic_mmhg" | "bp_diastolic_mmhg" | "weight_kg" | "spo2_pct";
  value: number;
  unit: "c" | "bpm" | "mmhg" | "kg" | "pct";
  observedAt: string;
};
export type BookingIntake = {
  complaint: string;
  otherComplaint: string | null;
  history: string | null;
  consciousness: "alert" | "drowsy" | "confused" | null;
  conditions: ("pale" | "weak" | "cold_sweat" | "none")[];
  observations: HomecareObservation[];
  note: string | null;
  consent: boolean;
};
export type AvailabilitySlot = { id: string; nurseId: string; startsAt: string; endsAt: string; availabilityVersionId: string; availabilityVersion: number };
export type AvailabilityWindow = { weekday: number; startMinute: number; endMinute: number };
export type Availability = {
  nurseId: string;
  version: number;
  current: null | {
    id: string;
    version: number;
    timeZone: string;
    slotMinutes: number;
    bufferMinutes: number;
    effectiveFrom: string;
    effectiveTo: string;
    windows: AvailabilityWindow[];
    slots: { id: string; startsAt: string; endsAt: string }[];
  };
};
export type HomecareBooking = {
  id: string;
  patientId: string;
  nurseId: string;
  nurse: { id: string; displayName: string; staffCode: string };
  slotId: string | null;
  availabilityVersionId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  version: number;
  intake: BookingIntake | null;
  profileSnapshot: {
    fullName: string;
    birthDate: string;
    gender: string;
    phone: string;
    addressLine: string;
    recordNumber: string | null;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
  } | null;
  visitId: string | null;
  priorityRequestId: string | null;
  decisionReason: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: { id: string; action: string; version: number; reason: string | null; data: Record<string, unknown>; createdAt: string }[];
};
export type PriorityRequest = {
  id: string;
  bookingId: string;
  patientId: string;
  nurseId: string;
  startsAt: string;
  endsAt: string;
  statement: string;
  status: PriorityStatus;
  reason: string | null;
  version: number;
  reviewedAt: string | null;
  createdAt: string;
  patient?: { displayName: string; recordNumber: string | null };
};
export type Page<T> = { items: T[]; page: { nextCursor: string | null; hasMore: boolean } };
export type AvailabilitySlots = { nurseId: string; timeZone: string | null; items: AvailabilitySlot[]; page: Page<unknown>["page"] };
export type AvailabilityInput = {
  timeZone: string;
  slotMinutes: number;
  bufferMinutes: number;
  effectiveFrom: string;
  effectiveTo: string;
  windows: AvailabilityWindow[];
  slots: { startsAt: string; endsAt: string }[];
};
export type BookingTimeInput = { slotId: string | null; startsAt: string; endsAt: string };
export type BookingDraftPatch = Partial<BookingTimeInput> & { nurseId?: string; intake?: BookingIntake };
export type BookingDecisionInput = { decision: "accept" | "reject"; reason: string | null };
export type BookingRescheduleInput = BookingTimeInput & { reason: string; patientAgreed: true };
export type PriorityTarget = { startsAt: string; endsAt: string };
export type PriorityReviewInput = { decision: "accept_availability" | "decline"; reason: string; available: boolean };
export type HomecareCareGuide = {
  patientId: string;
  sources: { id: string; kind: "protocol" | "medication" | "wound_care" | "diet" | "activity" | "danger_sign"; title: string; body: string; revisionNumber: number; approvedAt: string | null }[];
  sourceVersions: { sourceDocumentId: string; sourceVersion: number }[];
  orders: {
    id: string;
    kind: "medication" | "followup" | "care";
    revisionNumber: number;
    sourceDocumentId: string;
    sourceVersion: number;
    instructions: string;
    items?: { type: "medication" | "storage" | "wound_care" | "device_care" | "diet" | "activity" | "danger_sign" | "first_aid" | "followup"; text: string }[];
    effectiveFrom: string;
    effectiveTo: string | null;
    status: "active";
    version: number;
  }[];
};

type HomecareOperationKind = "booking-create" | "booking-update" | "booking-submit" | "booking-cancel" | "booking-decision" | "nurse-booking-cancel" | "booking-reschedule" | "availability-put" | "priority-create" | "priority-review";
export type HomecareOperation<T extends HomecareOperationKind = HomecareOperationKind> = Readonly<{
  actor: HomecareActor;
  kind: T;
  targetId?: string;
  patientId?: string; // Client-only retained provenance; never included in the HTTP payload.
  intent: WriteIntent;
}>;
type BookingOperationKind = "booking-create" | "booking-update" | "booking-submit" | "booking-cancel" | "booking-decision" | "nurse-booking-cancel" | "booking-reschedule";
export type HomecareWriteResult = HomecareBooking | Availability | PriorityRequest;

const units = { temperature_c: "c", heart_rate_bpm: "bpm", bp_systolic_mmhg: "mmhg", bp_diastolic_mmhg: "mmhg", weight_kg: "kg", spo2_pct: "pct" } as const;
const intakeKeys = ["complaint", "otherComplaint", "history", "consciousness", "conditions", "observations", "note", "consent"];
const bookingKeys = ["id", "patientId", "nurseId", "nurse", "slotId", "availabilityVersionId", "startsAt", "endsAt", "status", "version", "intake", "profileSnapshot", "visitId", "priorityRequestId", "decisionReason", "submittedAt", "decidedAt", "cancelledAt", "createdAt", "updatedAt", "events"];
const priorityKeys = ["id", "bookingId", "patientId", "nurseId", "startsAt", "endsAt", "statement", "status", "reason", "version", "reviewedAt", "createdAt", "patient"];
const pageKeys = ["nextCursor", "hasMore"];
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid exact object");
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid UUID");
  return value;
}
function text(value: unknown, max = Infinity, nonblank = true): string {
  if (typeof value !== "string" || value.length > max || (nonblank && !value.trim())) throw new Error("Invalid text");
  return value;
}
function nullableText(value: unknown, max = Infinity, nonblank = true) { return value === null ? null : text(value, max, nonblank); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("Invalid integer");
  return value as number;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace(".000Z", "Z") !== result.replace(".000Z", "Z")) throw new Error("Invalid UTC timestamp");
  return result;
}
function nullableTime(value: unknown) { return value === null ? null : timestamp(value); }
function nullableUuid(value: unknown) { return value === null ? null : uuid(value); }
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
function array<T>(value: unknown, decode: (item: unknown) => T, max = Infinity): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid array");
  return value.map(decode);
}
function range(startsAt: string, endsAt: string, maximum?: number) {
  const from = Date.parse(timestamp(startsAt)), to = Date.parse(timestamp(endsAt));
  if (!(from < to) || (maximum !== undefined && to - from > maximum)) throw new Error("Invalid time range");
  return { startsAt, endsAt };
}
function observation(value: unknown): HomecareObservation {
  const item = exact(value, ["type", "value", "unit", "observedAt"]);
  const type = member(item.type, Object.keys(units) as (keyof typeof units)[]);
  if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value <= 0 || item.value > 99999.999 || Number(item.value.toFixed(3)) !== item.value || item.unit !== units[type]) throw new Error("Invalid observation");
  return { type, value: item.value, unit: units[type], observedAt: timestamp(item.observedAt) };
}
function intake(value: unknown): BookingIntake {
  const item = exact(value, intakeKeys);
  const conditions = array(item.conditions, condition => member(condition, ["pale", "weak", "cold_sweat", "none"] as const), 4);
  if (new Set(conditions).size !== conditions.length || (conditions.includes("none") && conditions.length !== 1)) throw new Error("Invalid conditions");
  const observations = array(item.observations, observation, 6);
  if (new Set(observations.map(item => item.type)).size !== observations.length) throw new Error("Duplicate observation");
  if (typeof item.consent !== "boolean") throw new Error("Invalid consent");
  return {
    complaint: text(item.complaint, 2000), otherComplaint: nullableText(item.otherComplaint, 2000, false), history: nullableText(item.history, 4000, false),
    consciousness: item.consciousness === null ? null : member(item.consciousness, ["alert", "drowsy", "confused"] as const),
    conditions, observations, note: nullableText(item.note, 4000, false), consent: item.consent,
  };
}
function decodeProfileSnapshot(value: unknown): HomecareBooking["profileSnapshot"] {
  if (value === null) return null;
  const item = exact(value, ["fullName", "birthDate", "gender", "phone", "addressLine", "recordNumber", "emergencyContactName", "emergencyContactPhone"]);
  return { fullName: text(item.fullName, 200), birthDate: text(item.birthDate), gender: text(item.gender), phone: text(item.phone, 32), addressLine: text(item.addressLine, 500), recordNumber: nullableText(item.recordNumber, 100), emergencyContactName: nullableText(item.emergencyContactName, 200), emergencyContactPhone: nullableText(item.emergencyContactPhone, 32) };
}
export function decodeHomecareBooking(value: unknown): HomecareBooking {
  const item = exact(value, bookingKeys), nurse = exact(item.nurse, ["id", "displayName", "staffCode"]);
  const booking: HomecareBooking = {
    id: uuid(item.id), patientId: uuid(item.patientId), nurseId: uuid(item.nurseId),
    nurse: { id: uuid(nurse.id), displayName: text(nurse.displayName, 200), staffCode: text(nurse.staffCode, 100) },
    slotId: nullableUuid(item.slotId), availabilityVersionId: nullableUuid(item.availabilityVersionId), ...range(timestamp(item.startsAt), timestamp(item.endsAt)),
    status: member(item.status, bookingStatuses), version: integer(item.version), intake: item.intake === null ? null : intake(item.intake), profileSnapshot: decodeProfileSnapshot(item.profileSnapshot),
    visitId: nullableUuid(item.visitId), priorityRequestId: nullableUuid(item.priorityRequestId), decisionReason: nullableText(item.decisionReason, 4000),
    submittedAt: nullableTime(item.submittedAt), decidedAt: nullableTime(item.decidedAt), cancelledAt: nullableTime(item.cancelledAt), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
    events: array(item.events, value => {
      const event = exact(value, ["id", "action", "version", "reason", "data", "createdAt"]);
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("Invalid event data");
      return { id: uuid(event.id), action: text(event.action, 100), version: integer(event.version), reason: nullableText(event.reason, 4000), data: event.data as Record<string, unknown>, createdAt: timestamp(event.createdAt) };
    }),
  };
  if (booking.nurse.id !== booking.nurseId) throw new Error("Nurse binding mismatch");
  return booking;
}
function decodePage(value: unknown) {
  const item = exact(value, pageKeys), nextCursor = nullableText(item.nextCursor, 8192);
  if (typeof item.hasMore !== "boolean" || item.hasMore !== (nextCursor !== null)) throw new Error("Invalid pagination");
  return { nextCursor, hasMore: item.hasMore };
}
function decodePageOf<T>(value: unknown, decode: (value: unknown) => T): Page<T> {
  const item = exact(value, ["items", "page"]);
  return { items: array(item.items, decode, 100), page: decodePage(item.page) };
}
export function decodeAvailabilitySlots(value: unknown): AvailabilitySlots {
  const item = exact(value, ["nurseId", "timeZone", "items", "page"]), nurseId = uuid(item.nurseId);
  const result = decodePageOf({ items: item.items, page: item.page }, value => {
    const slot = exact(value, ["id", "nurseId", "startsAt", "endsAt", "availabilityVersionId", "availabilityVersion"]);
    return { id: uuid(slot.id), nurseId: uuid(slot.nurseId), ...range(timestamp(slot.startsAt), timestamp(slot.endsAt)), availabilityVersionId: uuid(slot.availabilityVersionId), availabilityVersion: integer(slot.availabilityVersion, 1) };
  });
  if (result.items.some(slot => slot.nurseId !== nurseId)) throw new Error("Nurse binding mismatch");
  const zone = item.timeZone === null ? null : timeZone(item.timeZone);
  if (zone === null && result.items.length !== 0) throw new Error("Time zone required for published slots");
  return { nurseId, timeZone: zone, items: result.items, page: result.page };
}
function timeZone(value: unknown): string {
  const zone = text(value, 100);
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); } catch { throw new Error("Invalid time zone"); }
  return zone;
}
export function decodeAvailability(value: unknown): Availability {
  const item = exact(value, ["nurseId", "version", "current"]), version = integer(item.version), nurseId = uuid(item.nurseId);
  if (item.current === null) {
    if (version !== 0) throw new Error("Published version missing");
    return { nurseId, version, current: null };
  }
  const current = exact(item.current, ["id", "version", "timeZone", "slotMinutes", "bufferMinutes", "effectiveFrom", "effectiveTo", "windows", "slots"]);
  if (integer(current.version, 1) !== version || version === 0) throw new Error("Availability version mismatch");
  const effective = range(timestamp(current.effectiveFrom), timestamp(current.effectiveTo));
  return { nurseId, version, current: {
    id: uuid(current.id), version, timeZone: timeZone(current.timeZone), slotMinutes: integer(current.slotMinutes, 1, 480), bufferMinutes: integer(current.bufferMinutes, 0, 120),
    effectiveFrom: effective.startsAt, effectiveTo: effective.endsAt,
    windows: array(current.windows, value => {
      const window = exact(value, ["weekday", "startMinute", "endMinute"]), startMinute = integer(window.startMinute, 0, 1439), endMinute = integer(window.endMinute, 1, 1440);
      if (startMinute >= endMinute) throw new Error("Invalid availability window");
      return { weekday: integer(window.weekday, 1, 7), startMinute, endMinute };
    }),
    slots: array(current.slots, value => {
      const slot = exact(value, ["id", "startsAt", "endsAt"]);
      return { id: uuid(slot.id), ...range(timestamp(slot.startsAt), timestamp(slot.endsAt)) };
    }, 200),
  } };
}
export function decodePriorityRequest(value: unknown): PriorityRequest {
  const item = exact(value, priorityKeys), result: PriorityRequest = {
    id: uuid(item.id), bookingId: uuid(item.bookingId), patientId: uuid(item.patientId), nurseId: uuid(item.nurseId),
    ...range(timestamp(item.startsAt), timestamp(item.endsAt)), statement: text(item.statement, 4000), status: member(item.status, priorityStatuses),
    reason: nullableText(item.reason, 4000), version: integer(item.version), reviewedAt: nullableTime(item.reviewedAt), createdAt: timestamp(item.createdAt),
    ...(item.patient === undefined ? {} : { patient: (() => { const patient = exact(item.patient, ["displayName", "recordNumber"]); return { displayName: text(patient.displayName, 200), recordNumber: nullableText(patient.recordNumber, 100) }; })() }),
  };
  return result;
}
export function decodeHomecareCareGuide(value: unknown): HomecareCareGuide {
  const item = exact(value, ["patientId", "sources", "sourceVersions", "orders"]);
  return { patientId: uuid(item.patientId),
    sources: array(item.sources, value => {
      const source = exact(value, ["id", "kind", "title", "body", "revisionNumber", "approvedAt"]);
      return { id: uuid(source.id), kind: member(source.kind, ["protocol", "medication", "wound_care", "diet", "activity", "danger_sign"] as const), title: text(source.title, 500), body: text(source.body, 30000), revisionNumber: integer(source.revisionNumber, 1), approvedAt: nullableTime(source.approvedAt) };
    }),
    sourceVersions: array(item.sourceVersions, value => {
      const version = exact(value, ["sourceDocumentId", "sourceVersion"]);
      return { sourceDocumentId: uuid(version.sourceDocumentId), sourceVersion: integer(version.sourceVersion, 1) };
    }),
    orders: array(item.orders, value => {
      const order = exact(value, ["id", "kind", "revisionNumber", "sourceDocumentId", "sourceVersion", "instructions", "items", "effectiveFrom", "effectiveTo", "status", "version"]);
      if (order.status !== "active") throw new Error("Inactive care order");
      return { id: uuid(order.id), kind: member(order.kind, ["medication", "followup", "care"] as const), revisionNumber: integer(order.revisionNumber, 1), sourceDocumentId: uuid(order.sourceDocumentId), sourceVersion: integer(order.sourceVersion, 1), instructions: text(order.instructions, 20000),
        ...(order.items === undefined ? {} : { items: array(order.items, value => {
          const entry = exact(value, ["type", "text"]);
          return { type: member(entry.type, ["medication", "storage", "wound_care", "device_care", "diet", "activity", "danger_sign", "first_aid", "followup"] as const), text: text(entry.text, 4000) };
        }) }),
        effectiveFrom: timestamp(order.effectiveFrom), effectiveTo: nullableTime(order.effectiveTo), status: "active", version: integer(order.version) };
    }),
  };
}
function cursor(value: string | null | undefined) { return value === undefined || value === null ? undefined : text(value, 8192); }
function limit(value: number | undefined) { return String(integer(value ?? 20, 1, 100)); }
function query(path: ApiPath, values: Record<string, string | null | undefined>): ApiPath {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) params.set(key, value);
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}
function targetCheck<T extends { id: string }>(id: string, decode: (value: unknown) => T) {
  return (value: unknown) => { const result = decode(value); if (result.id !== uuid(id)) throw new Error("Target mismatch"); return result; };
}
export type ListOptions = { cursor?: string | null; limit?: number };
export type BookingListOptions = ListOptions & { status?: BookingStatus };
export type NurseBookingListOptions = BookingListOptions & { search?: string };
export type ScheduleListOptions = ListOptions & { from: string; to: string };

export interface HomecareApi {
  slots(nurseId: string, options: { from: string; to: string; cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<AvailabilitySlots>;
  availability(signal?: AbortSignal): Promise<Availability>;
  myBookings(options?: BookingListOptions, signal?: AbortSignal): Promise<Page<HomecareBooking>>;
  myBooking(id: string, signal?: AbortSignal): Promise<HomecareBooking>;
  bookings(options?: NurseBookingListOptions, signal?: AbortSignal): Promise<Page<HomecareBooking>>;
  booking(id: string, signal?: AbortSignal): Promise<HomecareBooking>;
  schedule(options: ScheduleListOptions, signal?: AbortSignal): Promise<Page<HomecareBooking>>;
  careGuide(id: string, signal?: AbortSignal): Promise<HomecareCareGuide>;
  myPriorityRequests(options?: ListOptions, signal?: AbortSignal): Promise<Page<PriorityRequest>>;
  myPriorityRequest(id: string, signal?: AbortSignal): Promise<PriorityRequest>;
  priorityRequests(options?: ListOptions, signal?: AbortSignal): Promise<Page<PriorityRequest>>;
  priorityRequest(id: string, signal?: AbortSignal): Promise<PriorityRequest>;
  write(operation: HomecareOperation, signal?: AbortSignal): Promise<HomecareWriteResult>;
}

/** Raw HTTP reads. Use HomecareWriteRegistry for writes so uncertain delivery is retained. */
export function createHomecareApi(api: ApiClient, ownerId?: string | (() => string | undefined)): HomecareApi {
  const boundOwnerId = typeof ownerId === "function" ? ownerId : () => ownerId;
  function owns(actor: HomecareActor, id: string) { return boundOwnerId() === undefined || boundOwnerId() === id; }
  function ownActor<T extends HomecareBooking | PriorityRequest>(actor: HomecareActor, result: T): T {
    if (!owns(actor, actor === "patient" ? result.patientId : result.nurseId)) throw new Error("Workspace ownership mismatch");
    return result;
  }
  function ownPage<T extends HomecareBooking | PriorityRequest>(actor: HomecareActor, result: Page<T>): Page<T> {
    result.items.forEach(item => ownActor(actor, item));
    return result;
  }
  function booking(id: string, actor: HomecareActor, signal?: AbortSignal) {
    return api.request(`${actor === "patient" ? "/api/v1/me/bookings" : "/api/v1/bookings"}/${uuid(id)}`, targetCheck(id, value => ownActor(actor, decodeHomecareBooking(value))), { signal });
  }
  function priorityRequest(id: string, actor: HomecareActor, signal?: AbortSignal) {
    return api.request(`${actor === "patient" ? "/api/v1/me/priority-requests" : "/api/v1/priority-requests"}/${uuid(id)}`, targetCheck(id, value => ownActor(actor, decodePriorityRequest(value))), { signal });
  }
  return {
    slots(nurseId: string, options: { from: string; to: string; cursor?: string | null; limit?: number }, signal?: AbortSignal) {
      const id = uuid(nurseId); range(options.from, options.to, 31 * 24 * 60 * 60 * 1000);
      return api.request(query(`/api/v1/nurses/${id}/slots`, { from: timestamp(options.from), to: timestamp(options.to), limit: limit(options.limit), cursor: cursor(options.cursor) }), value => {
        const result = decodeAvailabilitySlots(value);
        if (result.nurseId !== id) throw new Error("Nurse mismatch");
        return result;
      }, { signal });
    },
    availability(signal?: AbortSignal) {
      return api.request("/api/v1/nurses/me/availability", (value: unknown) => {
        const result = decodeAvailability(value);
        if (boundOwnerId() !== undefined && result.nurseId !== uuid(boundOwnerId())) throw new Error("Nurse mismatch");
        return result;
      }, { signal });
    },
    myBookings(options: BookingListOptions = {}, signal?: AbortSignal) {
      return api.request(query("/api/v1/me/bookings", { status: options.status, cursor: cursor(options.cursor), limit: limit(options.limit) }), value => ownPage("patient", decodePageOf(value, decodeHomecareBooking)), { signal });
    },
    myBooking: (id: string, signal?: AbortSignal) => booking(id, "patient", signal),
    bookings(options: NurseBookingListOptions = {}, signal?: AbortSignal) {
      if (options.status === "draft") throw new Error("Private drafts are not listed for nurses");
      return api.request(query("/api/v1/bookings", { status: options.status, search: options.search, cursor: cursor(options.cursor), limit: limit(options.limit) }), value => ownPage("nurse", decodePageOf(value, decodeHomecareBooking)), { signal });
      return api.request(query("/api/v1/bookings", { status: options.status, search: options.search, cursor: cursor(options.cursor), limit: limit(options.limit) }), value => ownPage("nurse", decodePageOf(value, decodeHomecareBooking)), { signal });
    },
    booking: (id: string, signal?: AbortSignal) => booking(id, "nurse", signal),
    schedule(options: ScheduleListOptions, signal?: AbortSignal) {
      range(options.from, options.to, 31 * 24 * 60 * 60 * 1000);
      return api.request(query("/api/v1/schedule", { from: timestamp(options.from), to: timestamp(options.to), cursor: cursor(options.cursor), limit: limit(options.limit) }), value => {
        const result = ownPage("nurse", decodePageOf(value, decodeHomecareBooking));
        if (result.items.some(booking => booking.status !== "accepted" || !booking.visitId)) throw new Error("Accepted visit required");
        return result;
      }, { signal });
    },
    careGuide: (id: string, signal?: AbortSignal) => api.request(`/api/v1/bookings/${uuid(id)}/care-guide`, decodeHomecareCareGuide, { signal }),
    myPriorityRequests(options: ListOptions = {}, signal?: AbortSignal) {
      return api.request(query("/api/v1/me/priority-requests", { cursor: cursor(options.cursor), limit: limit(options.limit) }), value => ownPage("patient", decodePageOf(value, decodePriorityRequest)), { signal });
    },
    myPriorityRequest: (id: string, signal?: AbortSignal) => priorityRequest(id, "patient", signal),
    priorityRequests(options: ListOptions = {}, signal?: AbortSignal) {
      return api.request(query("/api/v1/priority-requests", { cursor: cursor(options.cursor), limit: limit(options.limit) }), value => ownPage("nurse", decodePageOf(value, decodePriorityRequest)), { signal });
    },
    priorityRequest: (id: string, signal?: AbortSignal) => priorityRequest(id, "nurse", signal),
    write(operation: HomecareOperation, signal?: AbortSignal): Promise<HomecareWriteResult> {
      if (operation.kind === "availability-put") return api.write(operation.intent, decodeAvailability, signal);
      if (operation.kind === "priority-create" || operation.kind === "priority-review") return api.write(operation.intent, decodePriorityRequest, signal);
      return api.write(operation.intent, decodeHomecareBooking, signal);
    },
  };
}
function operation<K extends HomecareOperationKind>(actor: HomecareActor, kind: K, intent: WriteIntent, targetId?: string, patientId?: string): HomecareOperation<K> {
  return Object.freeze({ actor, kind, ...(targetId === undefined ? {} : { targetId: uuid(targetId) }), ...(patientId === undefined ? {} : { patientId: uuid(patientId) }), intent: Object.freeze(intent) });
}
function availabilityInput(value: AvailabilityInput): AvailabilityInput {
  const item = exact(value, ["timeZone", "slotMinutes", "bufferMinutes", "effectiveFrom", "effectiveTo", "windows", "slots"]);
  const effective = range(timestamp(item.effectiveFrom), timestamp(item.effectiveTo));
  return { timeZone: timeZone(item.timeZone), slotMinutes: integer(item.slotMinutes, 1, 480), bufferMinutes: integer(item.bufferMinutes, 0, 120),
    effectiveFrom: effective.startsAt, effectiveTo: effective.endsAt,
    windows: array(item.windows, value => {
      const window = exact(value, ["weekday", "startMinute", "endMinute"]), startMinute = integer(window.startMinute, 0, 1439), endMinute = integer(window.endMinute, 1, 1440);
      if (startMinute >= endMinute) throw new Error("Invalid availability window");
      return { weekday: integer(window.weekday, 1, 7), startMinute, endMinute };
    }),
    slots: array(item.slots, value => { const slot = exact(value, ["startsAt", "endsAt"]); return range(timestamp(slot.startsAt), timestamp(slot.endsAt)); }, 200) };
}
function bookingTime(value: unknown): BookingTimeInput {
  const item = exact(value, ["slotId", "startsAt", "endsAt"]);
  return { slotId: nullableUuid(item.slotId), ...range(timestamp(item.startsAt), timestamp(item.endsAt)) };
}
export function prepareAvailabilityWrite(current: Availability, input: AvailabilityInput, key?: string): HomecareOperation<"availability-put"> {
  const availability = decodeAvailability(current);
  return operation("nurse", "availability-put", prepareWrite("/api/v1/nurses/me/availability", "PUT", { expectedVersion: integer(availability.version), ...availabilityInput(input) }, key));
}
export function prepareBookingCreate(nurseId: string, input: BookingTimeInput & { intake: BookingIntake }, key?: string): HomecareOperation<"booking-create"> {
  const item = exact(input, ["slotId", "startsAt", "endsAt", "intake"]), intakeValue = intake(item.intake);
  return operation("patient", "booking-create", prepareWrite("/api/v1/me/bookings", "POST", { nurseId: uuid(nurseId), ...bookingTime({ slotId: item.slotId, startsAt: item.startsAt, endsAt: item.endsAt }), intake: intakeValue }, key));
}
function draft(booking: HomecareBooking) {
  const decoded = decodeHomecareBooking(booking);
  if (decoded.status !== "draft" || !decoded.intake) throw new Error("Own draft with intake required");
  return decoded;
}
export function prepareBookingUpdate(booking: HomecareBooking, patch: BookingDraftPatch, key?: string): HomecareOperation<"booking-update"> {
  const current = draft(booking), item = exact(patch, ["nurseId", "slotId", "startsAt", "endsAt", "intake"]), body: Record<string, unknown> = { expectedVersion: integer(current.version) };
  let fields = 0;
  for (const key of ["nurseId", "slotId", "startsAt", "endsAt", "intake"] as const) {
    if (!Object.hasOwn(item, key)) continue;
    fields++;
    if (key === "nurseId") body[key] = uuid(item[key]);
    else if (key === "slotId") body[key] = nullableUuid(item[key]);
    else if (key === "startsAt" || key === "endsAt") body[key] = timestamp(item[key]);
    else body[key] = intake(item[key]);
  }
  if (!fields) throw new Error("At least one booking change required");
  if (body.startsAt !== undefined || body.endsAt !== undefined || body.slotId !== undefined) range((body.startsAt ?? current.startsAt) as string, (body.endsAt ?? current.endsAt) as string);
  return operation("patient", "booking-update", prepareWrite(`/api/v1/me/bookings/${current.id}`, "PATCH", body, key), current.id, current.patientId);
}
function versionedBooking(booking: HomecareBooking, actor: HomecareActor, versionStatus?: BookingStatus) {
  const current = decodeHomecareBooking(booking);
  if (versionStatus && current.status !== versionStatus) throw new Error("Booking status mismatch");
  return { actor, current, expectedVersion: integer(current.version) };
}
export function prepareBookingSubmit(booking: HomecareBooking, key?: string): HomecareOperation<"booking-submit"> {
  const { current, expectedVersion } = versionedBooking(booking, "patient", "draft");
  return operation("patient", "booking-submit", prepareWrite(`/api/v1/me/bookings/${current.id}/submit`, "POST", { expectedVersion }, key), current.id, current.patientId);
}
export function prepareBookingCancellation(booking: HomecareBooking, reason: string, key?: string): HomecareOperation<"booking-cancel"> {
  const { current, expectedVersion } = versionedBooking(booking, "patient");
  if (current.status === "cancelled" || current.status === "rejected") throw new Error("Active booking required");
  return operation("patient", "booking-cancel", prepareWrite(`/api/v1/me/bookings/${current.id}/cancel`, "POST", { expectedVersion, reason: text(reason, 4000).trim() }, key), current.id, current.patientId);
}
export function prepareNurseBookingDecision(booking: HomecareBooking, input: BookingDecisionInput, key?: string): HomecareOperation<"booking-decision"> {
  const { current, expectedVersion } = versionedBooking(booking, "nurse", "submitted"), decision = exact(input, ["decision", "reason"]), choice = member(decision.decision, ["accept", "reject"] as const);
  const reason = choice === "reject" ? text(decision.reason, 4000).trim() : decision.reason === null ? null : text(decision.reason, 4000).trim();
  if (choice === "reject" && !reason) throw new Error("Rejection reason required");
  return operation("nurse", "booking-decision", prepareWrite(`/api/v1/bookings/${current.id}/decisions`, "POST", { expectedVersion, decision: choice, reason }, key), current.id, current.patientId);
}
export function prepareNurseBookingCancellation(booking: HomecareBooking, reason: string, key?: string): HomecareOperation<"nurse-booking-cancel"> {
  const { current, expectedVersion } = versionedBooking(booking, "nurse");
  if (current.status === "cancelled" || current.status === "rejected") throw new Error("Active booking required");
  return operation("nurse", "nurse-booking-cancel", prepareWrite(`/api/v1/bookings/${current.id}/cancel`, "POST", { expectedVersion, reason: text(reason, 4000).trim() }, key), current.id, current.patientId);
}
export function prepareNurseBookingReschedule(booking: HomecareBooking, input: BookingRescheduleInput, key?: string): HomecareOperation<"booking-reschedule"> {
  const { current, expectedVersion } = versionedBooking(booking, "nurse", "accepted"), item = exact(input, ["slotId", "startsAt", "endsAt", "reason", "patientAgreed"]);
  if (item.patientAgreed !== true) throw new Error("Patient agreement required");
  return operation("nurse", "booking-reschedule", prepareWrite(`/api/v1/bookings/${current.id}/reschedule`, "POST", { expectedVersion, ...bookingTime({ slotId: item.slotId, startsAt: item.startsAt, endsAt: item.endsAt }), reason: text(item.reason, 4000).trim(), patientAgreed: true }, key), current.id, current.patientId);
}
export function preparePriorityRequestCreate(booking: HomecareBooking, statement: string, target?: PriorityTarget, key?: string): HomecareOperation<"priority-create"> {
  const current = decodeHomecareBooking(booking);
  if (current.status !== "draft" && current.status !== "accepted") throw new Error("Draft or accepted booking required");
  if (current.status === "draft" ? target !== undefined : target === undefined) throw new Error("Target interval is required only for accepted bookings");
  if (current.priorityRequestId !== null) throw new Error("Effective priority request already exists");
  const interval = target === undefined ? undefined : (() => { const item = exact(target, ["startsAt", "endsAt"]); return range(timestamp(item.startsAt), timestamp(item.endsAt)); })();
  return operation("patient", "priority-create", prepareWrite("/api/v1/me/priority-requests", "POST", { bookingId: current.id, statement: text(statement, 4000).trim(), ...(interval ? { startsAt: interval.startsAt, endsAt: interval.endsAt } : {}) }, key));
}
export function preparePriorityRequestReview(request: PriorityRequest, input: PriorityReviewInput, key?: string): HomecareOperation<"priority-review"> {
  const current = decodePriorityRequest(request);
  if (current.status !== "pending") throw new Error("Pending priority request required");
  const item = exact(input, ["decision", "reason", "available"]), decision = member(item.decision, ["accept_availability", "decline"] as const);
  if (typeof item.available !== "boolean" || item.available !== (decision === "accept_availability")) throw new Error("Decision and availability mismatch");
  return operation("nurse", "priority-review", prepareWrite(`/api/v1/priority-requests/${current.id}/review`, "POST", { expectedVersion: integer(current.version), decision, reason: text(item.reason, 4000).trim(), available: item.available }, key), current.id);
}

export type HomecareWriteState = { status: "idle" } | { status: "sending" | "uncertain" | "rejected" | "verified"; operation: HomecareOperation; error?: ApiError; result?: HomecareWriteResult };
function equalFields(actual: Record<string, unknown>, expected: Record<string, unknown>, keys: string[]) {
  return keys.every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}
function matchingBookingCreate(input: Record<string, unknown>, actualIntake: BookingIntake | null, ...values: unknown[]) {
  return !!actualIntake && ["nurseId", "slotId", "startsAt", "endsAt"].every((key, index) => JSON.stringify(input[key]) === JSON.stringify(values[index])) && JSON.stringify(actualIntake) === JSON.stringify(intake(input.intake));
}
function bookingMatches(kind: BookingOperationKind, operation: HomecareOperation, result: HomecareBooking): boolean {
  const input = JSON.parse(operation.intent.body) as Record<string, unknown>;
  if (operation.targetId && result.id !== operation.targetId) return false;
  const expectedPatientId = operation.patientId;
  if (operation.targetId && result.patientId !== expectedPatientId) return false;
  switch (kind) {
    case "booking-create": return matchingBookingCreate(input, result.intake, result.nurseId, result.slotId, result.startsAt, result.endsAt);
    case "booking-update": {
      const keys = ["nurseId", "slotId", "startsAt", "endsAt", "intake"].filter(key => Object.hasOwn(input, key));
      return result.status === "draft" && result.version === input.expectedVersion as number + 1 && (!keys.includes("intake") || result.intake !== null) && equalFields(result as unknown as Record<string, unknown>, input, keys);
    }
    case "booking-submit": return result.status === "submitted";
    case "booking-cancel":
    case "nurse-booking-cancel": return result.status === "cancelled";
    case "booking-decision": return result.status === (input.decision === "accept" ? "accepted" : "rejected");
    case "booking-reschedule": return result.status === "accepted" && equalFields(result as unknown as Record<string, unknown>, input, ["slotId", "startsAt", "endsAt"]);
  }
}
function availabilityMatches(operation: HomecareOperation, result: Availability): boolean {
  const input = JSON.parse(operation.intent.body) as Record<string, unknown>;
  if (!result.current || result.version !== input.expectedVersion as number + 1 || result.current.version !== result.version) return false;
  const current = result.current as unknown as Record<string, unknown>;
  return equalFields(current, input, ["timeZone", "slotMinutes", "bufferMinutes", "effectiveFrom", "effectiveTo", "windows"]) && Array.isArray(input.slots) && current.slots instanceof Array && current.slots.length === input.slots.length && input.slots.every((slot, index) => equalFields((current.slots as unknown[])[index] as Record<string, unknown>, slot, ["startsAt", "endsAt"]));
}
function priorityMatches(kind: "priority-create" | "priority-review", operation: HomecareOperation, result: PriorityRequest): boolean {
  const input = JSON.parse(operation.intent.body) as Record<string, unknown>;
  if (operation.targetId && result.id !== operation.targetId) return false;
  if (kind === "priority-create") return result.status === "pending" && equalFields(result as unknown as Record<string, unknown>, input, ["bookingId", "statement", ...(Object.hasOwn(input, "startsAt") ? ["startsAt", "endsAt"] : [])]);
  return result.status === (input.decision === "accept_availability" ? "availability_accepted" : "declined") && result.reason === input.reason && result.reviewedAt !== null;
}

/** One session-scoped writer per role. Do not replace an uncertain operation or its key. */
export class HomecareWriteController {
  private state: HomecareWriteState = { status: "idle" };
  private listeners = new Set<() => void>();
  private retainedOperation: HomecareOperation | null = null;
  private abort: AbortController | null = null;
  private epoch = 0;
  private receipt: HomecareWriteResult | undefined;
  constructor(private client: ApiClient, private actor: HomecareActor, private current: () => boolean, private nurseId?: () => string | undefined) {}
  private api(): HomecareApi { return createHomecareApi(this.client, this.nurseId); }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: HomecareWriteState) { this.state = state; this.listeners.forEach(listener => listener()); }
  clear() { this.epoch++; this.abort?.abort(); this.receipt = undefined; this.retainedOperation = null; this.set({ status: "idle" }); }
  suspend() { this.epoch++; this.abort?.abort(); if (this.state.status === "sending") this.set({ ...this.state, status: "uncertain" }); }
  reset() { if (this.state.status === "sending" || this.state.status === "uncertain") throw new Error("Resolve retained intent first"); this.receipt = undefined; this.retainedOperation = null; this.set({ status: "idle" }); }
  private decode(operation: HomecareOperation, value: unknown): HomecareWriteResult {
    return operation.kind === "availability-put" ? decodeAvailability(value) : operation.kind === "priority-create" || operation.kind === "priority-review" ? decodePriorityRequest(value) : decodeHomecareBooking(value);
  }
  private matches(operation: HomecareOperation, result: HomecareWriteResult): boolean {
    if (operation.kind === "availability-put") return !("patientId" in result) && availabilityMatches(operation, result);
    if (operation.kind === "priority-create" || operation.kind === "priority-review") return "bookingId" in result && priorityMatches(operation.kind, operation, result);
    return "updatedAt" in result && bookingMatches(operation.kind, operation, result);
  }
  private matchesReceipt(operation: HomecareOperation, result: HomecareWriteResult): boolean {
    if (operation.kind === "booking-create" || operation.kind === "booking-decision" || operation.kind === "booking-cancel" || operation.kind === "nurse-booking-cancel") {
      if (!("updatedAt" in result) || !bookingMatches(operation.kind, operation, result)) return false;
      if (operation.kind === "booking-create") return result.status === "draft";
      return operation.targetId === result.id && result.status === (operation.kind === "booking-decision" ? (JSON.parse(operation.intent.body).decision === "accept" ? "accepted" : "rejected") : "cancelled");
    }
    return this.matches(operation, result);
  }
  private verifyFreshRead(operation: HomecareOperation, result: HomecareWriteResult): boolean {
    if (operation.kind === "booking-create") return "updatedAt" in result && result.status === "draft" && bookingMatches(operation.kind, operation, result);
    return this.matches(operation, result);
  }
  private receiptId(kind: "booking-create" | "priority-create"): string | undefined {
    const receipt = this.receipt;
    return kind === "booking-create"
      ? (receipt && "updatedAt" in receipt ? receipt.id : undefined)
      : (receipt && "bookingId" in receipt ? receipt.id : undefined);
  }
  private sameIdentity(receipt: HomecareWriteResult, result: HomecareWriteResult): boolean {
    if ("updatedAt" in receipt || "bookingId" in receipt) return "id" in result && result.id === receipt.id;
    return !("id" in result) && receipt.nurseId === result.nurseId && receipt.current?.id === result.current?.id;
  }
  private async read(operation: HomecareOperation, signal: AbortSignal): Promise<HomecareWriteResult> {
    if (operation.kind === "availability-put") return this.api().availability(signal);
    const id = operation.targetId ?? ((operation.kind === "booking-create" || operation.kind === "priority-create") ? this.receiptId(operation.kind) : undefined);
    if (!id) throw new ApiError("NETWORK_ERROR"); // Unknown create ID: explicit exact-key retry only, never list inference.
    const api = this.api();
    return operation.kind === "priority-create" || operation.kind === "priority-review"
      ? (this.actor === "patient" ? api.myPriorityRequest(id, signal) : api.priorityRequest(id, signal))
      : (this.actor === "patient" ? api.myBooking(id, signal) : api.booking(id, signal));
  }
  private readReceipt(result: HomecareBooking | PriorityRequest, signal: AbortSignal): Promise<HomecareWriteResult> {
    const api = this.api();
    return this.actor === "patient" ? ("bookingId" in result ? api.myPriorityRequest(result.id, signal) : api.myBooking(result.id, signal)) : ("bookingId" in result ? api.priorityRequest(result.id, signal) : api.booking(result.id, signal));
  }
  private ownsResult(operation: HomecareOperation, result: HomecareWriteResult): boolean {
    const ownerId = this.nurseId?.();
    if (ownerId !== undefined) return !("patientId" in result) || (this.actor === "patient" ? result.patientId : result.nurseId) === ownerId;
    // A receipt may identify an exact read, but cannot prove workspace ownership.
    // Known targets still carry their authenticated patient binding in the operation.
    if (operation.kind === "availability-put") return this.receipt === undefined || "nurseId" in result && result.nurseId === this.receipt.nurseId;
    return !this.receipt || !("id" in this.receipt) || !("id" in result) || result.id !== this.receipt.id || (operation.targetId !== undefined && "patientId" in result && result.patientId === operation.patientId);
  }
  async send(operation: HomecareOperation): Promise<void> {
    if (!this.current() || operation.actor !== this.actor) throw new Error("Inactive or mismatched Homecare writer");
    const retained = this.retainedOperation;
    if (this.state.status === "sending" || (retained && (operation.kind !== retained.kind || operation.targetId !== retained.targetId || operation.intent.idempotencyKey !== retained.intent.idempotencyKey || operation.intent.body !== retained.intent.body || operation.intent.path !== retained.intent.path || operation.intent.method !== retained.intent.method))) throw new Error("Resolve retained operation first");
    if (!["idle", "uncertain", "rejected", "verified"].includes(this.state.status)) throw new Error("Resolve retained operation first");
    this.retainedOperation = operation;
    const previousUncertain = this.state.status === "uncertain", epoch = ++this.epoch, abort = new AbortController();
    this.abort = abort;
    if (!previousUncertain) this.receipt = undefined;
    this.set({ status: "sending", operation });
    let wrote = false;
    try {
      const receipt = await this.client.write(operation.intent, value => this.decode(operation, value), abort.signal);
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      wrote = true;
      if (!this.ownsResult(operation, receipt)) throw new ApiError("INVALID_RESPONSE", 200);
      if (!this.matchesReceipt(operation, receipt)) throw new ApiError("INVALID_RESPONSE", 200);
      this.receipt = receipt;
      const result = "updatedAt" in receipt ? await this.readReceipt(receipt as HomecareBooking, abort.signal) : (operation.kind === "availability-put" ? await this.api().availability(abort.signal) : await this.readReceipt(receipt as PriorityRequest, abort.signal));
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      if (!this.ownsResult(operation, result)) throw new ApiError("INVALID_RESPONSE", 200);
      if (!this.verifyFreshRead(operation, result) || !this.sameIdentity(receipt, result)) throw new ApiError("INVALID_RESPONSE", 200);
      this.set({ status: "verified", operation, result });
    } catch (error) {
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      const failure = asApiError(error), rejected = !previousUncertain && !wrote && failure.status >= 400 && failure.status < 500 && failure.status !== 408;
      this.set({ status: rejected ? "rejected" : "uncertain", operation, error: failure });
    }
  }
  /** Fresh exact read only where payload/status can prove delivery, without trusting a pre-read outcome. */
  async reconcile(): Promise<void> {
    if (!this.current() || this.state.status !== "uncertain") return;
    // Reads cannot prove a create or irreversible action before inspection. Same-key retry is the only write retry.
    if (!["booking-update", "availability-put", "priority-review"].includes(this.state.operation.kind)) return;
    const operation = this.state.operation, epoch = ++this.epoch, abort = new AbortController();
    this.abort = abort;
    this.set({ status: "sending", operation });
    try {
      const result = await this.read(operation, abort.signal);
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      if (!this.ownsResult(operation, result)) throw new ApiError("INVALID_RESPONSE", 200);
      if (!this.matches(operation, result)) throw new ApiError("INVALID_RESPONSE", 200);
      if (this.receipt && !this.sameIdentity(this.receipt, result)) throw new ApiError("INVALID_RESPONSE", 200);
      const input = JSON.parse(operation.intent.body) as Record<string, unknown>;
      if (operation.kind !== "availability-put" && ["booking-submit", "booking-decision"].includes(operation.kind) && result.version !== (input.expectedVersion as number) + 1) throw new ApiError("VERSION_CONFLICT", 409);
      this.set({ status: "verified", operation, result });
    } catch (error) {
      if (this.current() && epoch === this.epoch && !abort.signal.aborted) this.set({ status: "uncertain", operation, error: asApiError(error) });
    }
  }
}
export class HomecareWriteRegistry {
  private retained: HomecareWriteController | null = null;
  constructor(private client: ApiClient, readonly actor: HomecareActor, private current: () => boolean, private nurseId?: () => string | undefined) {}
  writer(operation?: HomecareOperation): HomecareWriteController {
    if (!this.current()) throw new Error("Verified session required");
    if (operation && operation.actor !== this.actor) throw new Error("Workspace role mismatch");
    if (!this.retained) this.retained = new HomecareWriteController(this.client, this.actor, this.current, this.nurseId);
    return this.retained;
  }
  suspend() { this.retained?.suspend(); }
  dispose() { this.retained?.clear(); this.retained = null; }
}
