import { ApiError, asApiError, prepareWrite, type ApiClient, type WriteIntent } from "./client";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid text"); return value; }
function nullable(value: unknown) { return value === null ? null : text(value); }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid version"); return value as number; }
function member<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) throw new Error("Invalid enum"); return value as T; }
export function patientId(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid identifier");
  return id;
}
function timestamp(value: unknown) { const result = text(value); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace(".000Z", "Z") !== result.replace(".000Z", "Z")) throw new Error("Invalid timestamp"); return result; }
function array<T>(value: unknown, decode: (value: unknown) => T): T[] { if (!Array.isArray(value)) throw new Error("Invalid list"); return value.map(decode); }
export type NurseDirectory = { id: string; displayName: string; staffCode: string };
export function decodeNurseDirectory(value: unknown): { items: NurseDirectory[]; page: { nextCursor: string | null; hasMore: boolean } } {
  const data = object(value), page = object(data.page), nextCursor = page.nextCursor === null ? null : text(page.nextCursor);
  if (typeof page.hasMore !== "boolean" || page.hasMore !== (nextCursor !== null)) throw new Error("Invalid nurse directory pagination");
  if (!Array.isArray(data.items)) throw new Error("Invalid nurse directory");
  return { items: data.items.map(value => {
    const nurse = object(value);
    if (Object.keys(nurse).some(key => !["id", "displayName", "staffCode", "active", "workingWindowSummary"].includes(key)) || nurse.active !== true || ("workingWindowSummary" in nurse && nurse.workingWindowSummary !== null)) throw new Error("Inactive or invalid nurse");
    return { id: text(nurse.id), displayName: text(nurse.displayName), staffCode: text(nurse.staffCode) };
  }), page: { nextCursor, hasMore: page.hasMore } };
}

export function decodePatientProfile(value: unknown) {
  const p = object(value);
  if (p.role !== "patient") throw new Error("Patient profile required");
  const nurse = p.primaryNurse === null ? null : object(p.primaryNurse);
  return { role: "patient" as const, id: patientId(p.id), accountId: patientId(p.accountId), fullName: text(p.fullName), birthDate: text(p.birthDate), gender: text(p.gender), phone: text(p.phone), addressLine: nullable(p.addressLine), emergencyContactName: nullable(p.emergencyContactName), emergencyContactPhone: nullable(p.emergencyContactPhone), recordNumber: nullable(p.recordNumber), primaryNurse: nurse ? { id: patientId(nurse.id), displayName: text(nurse.displayName) } : null, version: integer(p.version) };
}
export type PatientProfile = ReturnType<typeof decodePatientProfile>;
export const measurementUnits = { temperature_c: "c", heart_rate_bpm: "bpm", bp_systolic_mmhg: "mmhg", bp_diastolic_mmhg: "mmhg", weight_kg: "kg", spo2_pct: "pct" } as const;
export type MeasurementType = keyof typeof measurementUnits;
export type ObservationInput = { type: MeasurementType; value: number; unit: string; observedAt: string };
function observation(value: unknown): ObservationInput {
  const o = object(value), type = member(o.type, Object.keys(measurementUnits) as MeasurementType[]);
  if (typeof o.value !== "number" || !Number.isFinite(o.value) || o.value <= 0 || o.value > 99999.999 || Number(o.value.toFixed(3)) !== o.value || o.unit !== measurementUnits[type]) throw new Error("Invalid measurement");
  return { type, value: o.value, unit: measurementUnits[type], observedAt: new Date(timestamp(o.observedAt)).toISOString() };
}
export type CheckInInput = { condition: "ok" | "complaint"; note: string | null; medicationAdherence: "regular" | "missed_once" | "none"; observations: ObservationInput[] };
function checkInInput(value: unknown): CheckInInput {
  const c = object(value), note = c.note === null ? null : text(c.note).trim();
  if (note !== null && (!note || note.length > 4000)) throw new Error("Invalid note");
  const observations = array(c.observations, observation).sort((a, b) => a.type.localeCompare(b.type));
  if (observations.length > 20 || new Set(observations.map(o => o.type)).size !== observations.length) throw new Error("Duplicate measurement");
  return { condition: member(c.condition, ["ok", "complaint"]), note, medicationAdherence: member(c.medicationAdherence, ["regular", "missed_once", "none"]), observations };
}
export function decodeCheckIn(value: unknown) {
  const c = object(value);
  return { ...checkInInput(c), id: patientId(c.id), patientId: patientId(c.patientId), status: member(c.status, ["draft", "submitted"]), version: integer(c.version), localDate: text(c.localDate), timeZone: text(c.timeZone), createdAt: timestamp(c.createdAt), updatedAt: timestamp(c.updatedAt), submittedAt: c.submittedAt === null ? null : timestamp(c.submittedAt), supersedesCheckInId: c.supersedesCheckInId === null ? null : patientId(c.supersedesCheckInId) };
}
export type CheckIn = ReturnType<typeof decodeCheckIn>;
export function checkInValuesEqual(a: CheckInInput, b: CheckInInput) { return JSON.stringify(checkInInput(a)) === JSON.stringify(checkInInput(b)); }
function boundCheckIn(value: unknown, ownId: string) { const c = decodeCheckIn(value); if (c.patientId !== ownId) throw new Error("Patient mismatch"); return c; }
function page<T>(value: unknown, decode: (v: unknown) => T) {
  const p = object(value), meta = object(p.page);
  const nextCursor = nullable(meta.nextCursor);
  if (typeof meta.hasMore !== "boolean" || meta.hasMore !== (nextCursor !== null)) throw new Error("Invalid pagination");
  return { items: array(p.items, decode), page: { nextCursor, hasMore: meta.hasMore } };
}
export function decodePatientGuide(value: unknown, ownId: string) {
  const g = object(value);
  if (patientId(g.patientId) !== ownId) throw new Error("Patient mismatch");
  return { patientId: ownId, sources: array(g.sources, value => { const s = object(value); return { id: patientId(s.id), kind: member(s.kind, ["protocol", "medication", "wound_care", "diet", "activity", "danger_sign"]), title: text(s.title), body: text(s.body), revisionNumber: integer(s.revisionNumber), approvedAt: s.approvedAt === null ? null : timestamp(s.approvedAt) }; }), orders: array(g.orders, value => { const o = object(value); if (o.status !== "active") throw new Error("Inactive order"); return { id: patientId(o.id), sourceDocumentId: patientId(o.sourceDocumentId), kind: member(o.kind, ["medication", "followup", "care"]), instructions: text(o.instructions), items: o.items === undefined ? [] : array(o.items, item => { const i = object(item); return { type: member(i.type, ["medication", "storage", "wound_care", "device_care", "diet", "activity", "danger_sign", "first_aid", "followup"]), text: text(i.text) }; }), effectiveFrom: timestamp(o.effectiveFrom), effectiveTo: o.effectiveTo === null ? null : timestamp(o.effectiveTo) }; }) };
}
export type PatientGuide = ReturnType<typeof decodePatientGuide>;
export function decodePublishedAnalysis(value: unknown, ownId: string) {
  const a = object(value), publication = object(a.publication);
  if (a.status !== "published" || patientId(a.patientId) !== ownId || !Array.isArray(a.reviews) || a.reviews.length || publication.analysisId !== a.id || publication.revisionNumber !== a.revisionNumber) throw new Error("Published patient projection required");
  return { id: patientId(a.id), checkInId: patientId(a.checkInId), publishedAt: timestamp(publication.publishedAt), claims: array(a.claims, value => { const c = object(value); return { id: patientId(c.claimId), text: text(c.text) }; }) };
}
export type PublishedAnalysis = ReturnType<typeof decodePublishedAnalysis>;
export function createPatientApi(api: ApiClient) {
  return {
    profile: (signal?: AbortSignal) => api.request("/api/v1/me/profile", decodePatientProfile, { signal }),
    nurses: (cursor?: string | null, signal?: AbortSignal) => { const query = new URLSearchParams({ limit: "100" }); if (cursor) query.set("cursor", cursor); return api.request(`/api/v1/nurses?${query}`, decodeNurseDirectory, { signal }); },
    checkIns: (ownId: string, cursor?: string | null, signal?: AbortSignal) => { patientId(ownId); const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor", cursor); return api.request(`/api/v1/check-ins?${query}`, v => page(v, c => boundCheckIn(c, ownId)), { signal }); },
    checkIn: (ownId: string, id: string, signal?: AbortSignal) => api.request(`/api/v1/check-ins/${patientId(id)}`, v => { const c = boundCheckIn(v, ownId); if (c.id !== id) throw new Error("Target mismatch"); return c; }, { signal }),
    guide: (ownId: string, signal?: AbortSignal) => api.request(`/api/v1/patients/${patientId(ownId)}/care-guide`, v => decodePatientGuide(v, ownId), { signal }),
    published: (ownId: string, cursor?: string | null, signal?: AbortSignal) => { const query = new URLSearchParams({ patientId: patientId(ownId), status: "published" }); if (cursor) query.set("cursor", cursor); return api.request(`/api/v1/analyses?${query}`, v => page(v, item => { const a = object(item); if (a.status !== "published" || a.patientId !== ownId) throw new Error("Invalid published summary"); return { id: patientId(a.id) }; }), { signal }); },
    analysis: (ownId: string, id: string, signal?: AbortSignal) => api.request(`/api/v1/analyses/${patientId(id)}`, v => { const a = decodePublishedAnalysis(v, ownId); if (a.id !== id) throw new Error("Target mismatch"); return a; }, { signal }),
  };
}
export type PatientOperation = Readonly<{ patientId: string; kind: "create" | "edit" | "submit" | "profile"; targetId?: string; intent: WriteIntent }>;
export function prepareCheckIn(ownId: string, input: CheckInInput, draft?: CheckIn, key?: string): PatientOperation {
  patientId(ownId);
  if (draft && (draft.patientId !== ownId || draft.status !== "draft")) throw new Error("Own draft required");
  return Object.freeze({ patientId: ownId, kind: draft ? "edit" : "create", ...(draft ? { targetId: draft.id } : {}), intent: prepareWrite(draft ? `/api/v1/check-ins/${patientId(draft.id)}` : "/api/v1/check-ins", draft ? "PUT" : "POST", { ...(draft ? { expectedVersion: integer(draft.version) } : {}), ...checkInInput(input) }, key) });
}
export function prepareCheckInSubmit(ownId: string, draft: CheckIn, key?: string): PatientOperation {
  if (draft.patientId !== ownId || draft.status !== "draft") throw new Error("Own draft required");
  return Object.freeze({ patientId: patientId(ownId), kind: "submit", targetId: draft.id, intent: prepareWrite(`/api/v1/check-ins/${patientId(draft.id)}/submit`, "POST", { expectedVersion: integer(draft.version) }, key) });
}
export type ContactInput = Pick<PatientProfile, "phone" | "addressLine" | "emergencyContactName" | "emergencyContactPhone">;
export function preparePatientContact(profile: PatientProfile, input: ContactInput, key?: string): PatientOperation {
  const phone = input.phone.trim(), emergencyPhone = input.emergencyContactPhone?.trim() || null;
  const validPhone = (value: string) => value.length >= 3 && value.length <= 32 && /^\+?[0-9][0-9 ()-]*$/.test(value);
  if (!validPhone(phone) || (emergencyPhone !== null && !validPhone(emergencyPhone)) || (input.addressLine?.trim().length ?? 0) > 500 || (input.emergencyContactName?.trim().length ?? 0) > 200) throw new Error("Invalid contact");
  return Object.freeze({ patientId: patientId(profile.id), kind: "profile", intent: prepareWrite("/api/v1/me/profile", "PATCH", { expectedVersion: integer(profile.version), phone, addressLine: input.addressLine?.trim() || null, emergencyContactName: input.emergencyContactName?.trim() || null, emergencyContactPhone: emergencyPhone }, key) });
}
export type PatientWriteState = { status: "idle" } | { status: "sending" | "uncertain" | "rejected" | "verified"; operation: PatientOperation; error?: ApiError; result?: CheckIn | PatientProfile };
export class PatientWriteController {
  private state: PatientWriteState = { status: "idle" };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private epoch = 0;
  private receipt: CheckIn | PatientProfile | undefined;
  constructor(private api: ApiClient, readonly ownId: string, private current: () => boolean, private verifiedProfile?: (profile: PatientProfile) => void) { patientId(ownId); }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(state: PatientWriteState) { this.state = state; this.listeners.forEach(fn => fn()); }
  clear() { this.epoch++; this.abort?.abort(); this.receipt = undefined; this.set({ status: "idle" }); }
  suspend() {
    this.epoch++; this.abort?.abort();
    if (this.state.status === "sending") this.set({ ...this.state, status: "uncertain" });
  }
  private verified(operation: PatientOperation, result: CheckIn | PatientProfile) {
    if (operation.kind === "profile") this.verifiedProfile?.(result as PatientProfile);
    this.set({ status: "verified", operation, result });
  }
  reset() { if (this.state.status === "sending" || this.state.status === "uncertain") throw new Error("Reconcile retained intent first"); this.receipt = undefined; this.set({ status: "idle" }); }
  private decode = (operation: PatientOperation, value: unknown): CheckIn | PatientProfile => {
    const result = operation.kind === "profile" ? decodePatientProfile(value) : boundCheckIn(value, this.ownId);
    if (operation.kind === "profile" && result.id !== this.ownId) throw new Error("Patient mismatch");
    if (operation.targetId && result.id !== operation.targetId) throw new Error("Target mismatch");
    return result;
  };
  private matches(operation: PatientOperation, result: CheckIn | PatientProfile): boolean {
    const input = JSON.parse(operation.intent.body);
    if (operation.kind === "profile") return result.version === input.expectedVersion + 1 && ["phone", "addressLine", "emergencyContactName", "emergencyContactPhone"].every(key => (result as unknown as Record<string, unknown>)[key] === input[key]);
    const c = result as CheckIn;
    if (operation.kind === "submit") return c.status === "submitted" && c.version === input.expectedVersion + 1;
    return c.status === "draft" && c.version === (operation.kind === "create" ? 0 : input.expectedVersion + 1) && JSON.stringify(checkInInput(c)) === JSON.stringify(checkInInput(input));
  }
  private async read(operation: PatientOperation, signal: AbortSignal) {
    const target = operation.kind === "profile" ? this.ownId : operation.targetId ?? this.receipt?.id;
    if (!target) throw new ApiError("NETWORK_ERROR"); // Unknown create: only an exact-key retry can recover its ID safely.
    return this.api.request(operation.kind === "profile" ? "/api/v1/me/profile" : `/api/v1/check-ins/${patientId(target)}`, v => this.decode(operation, v), { signal });
  }
  async send(operation: PatientOperation): Promise<void> {
    if (!this.current() || operation.patientId !== this.ownId || this.state.status === "sending") throw new Error("Inactive patient writer");
    if (this.state.status === "uncertain" && this.state.operation !== operation) throw new Error("Retain exact uncertain intent");
    const previousUncertain = this.state.status === "uncertain", epoch = ++this.epoch, abort = new AbortController(); this.abort = abort;
    if (!previousUncertain) this.receipt = undefined;
    this.set({ status: "sending", operation });
    let wrote = false;
    try {
      const receipt = await this.api.write(operation.intent, v => this.decode(operation, v), abort.signal);
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      wrote = true; this.receipt = receipt;
      if (!this.matches(operation, receipt)) throw new ApiError("INVALID_RESPONSE", 200);
      const result = await this.read(operation, abort.signal);
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      if (result.id !== receipt.id || !this.matches(operation, result)) throw new ApiError("INVALID_RESPONSE", 200);
      this.verified(operation, result);
    } catch (error) {
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      const failure = asApiError(error), rejected = !previousUncertain && !wrote && failure.status >= 400 && failure.status < 500 && failure.status !== 408;
      this.set({ status: rejected ? "rejected" : "uncertain", operation, error: failure });
    }
  }
  async reconcile(): Promise<void> {
    if (!this.current() || this.state.status !== "uncertain") return;
    const operation = this.state.operation, epoch = ++this.epoch, abort = new AbortController(); this.abort = abort;
    this.set({ status: "sending", operation });
    try {
      const result = await this.read(operation, abort.signal);
      if (!this.current() || epoch !== this.epoch || abort.signal.aborted) return;
      if (!this.matches(operation, result)) throw new ApiError("INVALID_RESPONSE", 200);
      this.verified(operation, result);
    } catch (error) {
      if (this.current() && epoch === this.epoch && !abort.signal.aborted) this.set({ status: "uncertain", operation, error: asApiError(error) });
    }
  }
}
