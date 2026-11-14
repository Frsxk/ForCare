import { ApiError, asApiError, prepareWrite, type ApiClient, type ApiPath, type WriteIntent } from "./client";
import { createAnalysisApi } from "./analysis";

// Projections follow backend patients/service.ts, clinical/service.ts and checkins/service.ts.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const result = object(value);
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error("Unknown field");
  return result;
}
function text(value: unknown, max = Infinity): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text");
  return value;
}
function nullableText(value: unknown, max = Infinity) { return value === null ? null : text(value, max); }
function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error("Invalid integer");
  return value as number;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid number");
  return value;
}
function array<T>(value: unknown, decode: (item: unknown) => T, max = Infinity): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid array");
  return value.map(decode);
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error("Invalid enum");
  return value as T;
}
export function patientUuid(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid UUID");
  return id;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace(".000Z", "Z") !== result.replace(".000Z", "Z")) throw new Error("Invalid UTC timestamp");
  return result;
}
function nullableTime(value: unknown) { return value === null ? null : timestamp(value); }
function decodePage(value: unknown) {
  const p = object(value);
  if (typeof p.hasMore !== "boolean") throw new Error("Invalid pagination");
  const nextCursor = p.nextCursor === null ? null : text(p.nextCursor);
  if (p.hasMore !== (nextCursor !== null)) throw new Error("Invalid cursor");
  return { nextCursor, hasMore: p.hasMore };
}
export function decodePageOf<T>(value: unknown, decode: (item: unknown) => T) {
  const p = object(value);
  return { items: array(p.items, decode), page: decodePage(p.page) };
}
function decodeLatestCheckIn(value: unknown) {
  if (value === null) return null;
  const c = object(value);
  return { id: patientUuid(c.id), condition: member(c.condition, ["ok", "complaint"] as const), localDate: nullableText(c.localDate), submittedAt: nullableTime(c.submittedAt) };
}
function decodePatient(value: unknown) {
  const p = object(value);
  if (p.nextVisit !== null) throw new Error("Unsupported visit projection");
  return { id: patientUuid(p.id), displayName: text(p.displayName), recordNumber: nullableText(p.recordNumber), latestCheckIn: decodeLatestCheckIn(p.latestCheckIn), nextVisit: null };
}
export function decodePatients(value: unknown) {
  const p = object(value);
  if (p.scope !== "assigned") throw new Error("Invalid scope");
  return { scope: "assigned" as const, ...decodePageOf(p, decodePatient) };
}
export type PatientList = ReturnType<typeof decodePatients>;
export function decodeSummary(value: unknown) {
  const p = object(value);
  return { ...decodePatient(p), activeOrderCount: integer(p.activeOrderCount) };
}
export function decodeDetail(value: unknown) {
  const p = object(value), access = object(p.access), profile = object(p.profile);
  if (access.scope !== "assigned") throw new Error("Invalid scope");
  const nurse = p.primaryNurse === null ? null : object(p.primaryNurse);
  return {
    id: patientUuid(p.id), displayName: text(p.displayName), recordNumber: nullableText(p.recordNumber), version: integer(p.version),
    access: { scope: "assigned" as const, expiresAt: nullableTime(access.expiresAt) },
    profile: { birthDate: text(profile.birthDate), gender: text(profile.gender) },
    primaryNurse: nurse === null ? null : { id: patientUuid(nurse.id), displayName: typeof nurse.displayName === "string" ? nurse.displayName : text(nurse.displayName) },
    availableSections: array(p.availableSections, item => text(item)),
  };
}
export function decodeNurseProfile(value: unknown) {
  const p = object(value);
  if (p.role !== "nurse") throw new Error("Nurse profile required");
  return { role: "nurse" as const, id: patientUuid(p.id), accountId: patientUuid(p.accountId), staffCode: text(p.staffCode), displayName: text(p.displayName), discipline: text(p.discipline), email: text(p.email), phone: nullableText(p.phone), displayTimeZone: text(p.displayTimeZone), version: integer(p.version) };
}
export type NurseProfile = ReturnType<typeof decodeNurseProfile>;
export type MedicalObservation = { type: string; value?: string | number; unit?: string; observedAt?: string };
export type MedicalSnapshot = {
  primaryDiagnosis: string | null; secondaryDiagnoses: string[]; admittedAt: string | null; dischargedAt: string | null;
  allergies: string[]; procedures: string[]; complaints: string | null; observations: MedicalObservation[]; internalNote: string | null;
};
function medicalText(value: unknown, max: number) { return text(typeof value === "string" ? value.trim() : value, max); }
function nullableMedicalText(value: unknown, max: number) { return value === null ? null : medicalText(value, max); }
export function decodeMedicalSnapshot(value: unknown): MedicalSnapshot {
  const p = exact(value, ["primaryDiagnosis", "secondaryDiagnoses", "admittedAt", "dischargedAt", "allergies", "procedures", "complaints", "observations", "internalNote"]);
  const admittedAt = nullableTime(p.admittedAt), dischargedAt = nullableTime(p.dischargedAt);
  if (admittedAt !== null && dischargedAt !== null && Date.parse(dischargedAt) < Date.parse(admittedAt)) throw new Error("Invalid date order");
  return {
    primaryDiagnosis: nullableMedicalText(p.primaryDiagnosis, 500), secondaryDiagnoses: array(p.secondaryDiagnoses, v => medicalText(v, 300), 50), admittedAt, dischargedAt,
    allergies: array(p.allergies, v => medicalText(v, 200), 50), procedures: array(p.procedures, v => medicalText(v, 300), 50), complaints: nullableMedicalText(p.complaints, 2000),
    observations: array(p.observations, value => {
      const o = exact(value, ["type", "value", "unit", "observedAt"]);
      return { type: medicalText(o.type, 100), ...(o.value === undefined ? {} : { value: typeof o.value === "number" ? number(o.value) : medicalText(o.value, 200) }), ...(o.unit === undefined ? {} : { unit: medicalText(o.unit, 50) }), ...(o.observedAt === undefined ? {} : { observedAt: timestamp(o.observedAt) }) };
    }, 200), internalNote: nullableMedicalText(p.internalNote, 4000),
  };
}
export function decodeMedicalRecord(value: unknown) {
  const r = object(value);
  return { id: patientUuid(r.id), patientId: patientUuid(r.patientId), revisionNumber: integer(r.revisionNumber, 1), supersedesId: r.supersedesId === null ? null : patientUuid(r.supersedesId), sourceReference: text(r.sourceReference, 300), payload: decodeMedicalSnapshot(r.payload), recordedAt: timestamp(r.recordedAt), enteredBy: patientUuid(r.enteredBy), version: integer(r.version) };
}
export type MedicalRecord = ReturnType<typeof decodeMedicalRecord>;
export function prepareMedicalRecord(patientId: string, latest: MedicalRecord | null, sourceReference: string, payload: MedicalSnapshot): WriteIntent {
  if (latest && latest.patientId !== patientId) throw new Error("Patient binding mismatch");
  return prepareWrite(`/api/v1/patients/${patientUuid(patientId)}/medical-record-versions`, "POST", {
    expectedVersion: latest ? integer(latest.revisionNumber, 1) : 0,
    sourceReference: text(sourceReference.trim(), 300), payload: decodeMedicalSnapshot(payload),
    ...(latest ? { supersedesId: patientUuid(latest.id) } : {}),
  });
}
const measurementUnits = { temperature_c: "c", heart_rate_bpm: "bpm", bp_systolic_mmhg: "mmhg", bp_diastolic_mmhg: "mmhg", weight_kg: "kg", spo2_pct: "pct" } as const;
function decodeObservation(value: unknown) {
  const o = object(value), type = member(o.type, Object.keys(measurementUnits) as (keyof typeof measurementUnits)[]);
  if (o.unit !== measurementUnits[type] || o.source !== "patient_check_in") throw new Error("Invalid measurement source/unit");
  return { id: patientUuid(o.id), checkInId: patientUuid(o.checkInId), type, value: number(o.value), unit: measurementUnits[type], observedAt: timestamp(o.observedAt), source: "patient_check_in" as const };
}
export function decodeObservations(value: unknown) {
  const o = object(value), c = o.lastConfirmed === null ? null : object(o.lastConfirmed);
  const trend = object(o.trend);
  if (trend.status !== "unavailable" || trend.reason !== "G02_NOT_APPROVED") throw new Error("Scoring not supported");
  return { latestObservation: o.latestObservation === null ? null : decodeObservation(o.latestObservation), lastConfirmed: c === null ? null : { value: number(c.value), unit: text(c.unit), observedAt: timestamp(c.observedAt), confirmedAt: timestamp(c.confirmedAt), confirmedByStaffId: patientUuid(c.confirmedByStaffId), observationId: patientUuid(c.observationId), checkInId: patientUuid(c.checkInId) }, history: decodePageOf(o.history, decodeObservation), trend: { status: "unavailable" as const, reason: "G02_NOT_APPROVED" } };
}
function decodeCheckIn(value: unknown) {
  const c = object(value);
  if (c.status !== "submitted") throw new Error("Private check-in must not be shown");
  return { id: patientUuid(c.id), patientId: patientUuid(c.patientId), localDate: text(c.localDate), timeZone: text(c.timeZone), status: "submitted" as const, condition: member(c.condition, ["ok", "complaint"] as const), note: nullableText(c.note), medicationAdherence: member(c.medicationAdherence, ["regular", "missed_once", "none"] as const), observations: array(c.observations, decodeObservation), supersedesCheckInId: c.supersedesCheckInId === null ? null : patientUuid(c.supersedesCheckInId), version: integer(c.version), submittedAt: timestamp(c.submittedAt), createdAt: timestamp(c.createdAt), updatedAt: timestamp(c.updatedAt) };
}
export function decodeCareGuide(value: unknown) {
  const g = object(value);
  return { patientId: patientUuid(g.patientId), sources: array(g.sources, value => {
    const s = object(value);
    return { id: patientUuid(s.id), kind: member(s.kind, ["protocol", "medication", "wound_care", "diet", "activity", "danger_sign"] as const), title: text(s.title), body: text(s.body), revisionNumber: integer(s.revisionNumber, 1), approvedAt: nullableTime(s.approvedAt) };
  }), sourceVersions: array(g.sourceVersions, value => { const s = object(value); return { sourceDocumentId: patientUuid(s.sourceDocumentId), sourceVersion: integer(s.sourceVersion, 1) }; }), orders: array(g.orders, value => {
    const o = object(value);
    return { id: patientUuid(o.id), kind: member(o.kind, ["medication", "followup", "care"] as const), revisionNumber: integer(o.revisionNumber, 1), sourceDocumentId: patientUuid(o.sourceDocumentId), sourceVersion: integer(o.sourceVersion, 1), instructions: text(o.instructions), ...(o.items === undefined ? {} : { items: array(o.items, value => { const i = object(value); return { type: member(i.type, ["medication", "storage", "wound_care", "device_care", "diet", "activity", "danger_sign", "first_aid", "followup"] as const), text: text(i.text) }; }) }), effectiveFrom: timestamp(o.effectiveFrom), effectiveTo: nullableTime(o.effectiveTo), status: member(o.status, ["active", "completed", "cancelled"] as const), version: integer(o.version) };
  }) };
}
function patientPath(id: string): ApiPath { return `/api/v1/patients/${patientUuid(id)}`; }
function query(path: ApiPath, values: Record<string, string | null | undefined>): ApiPath {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return `${path}?${params}`;
}
function bound<T extends { patientId: string }>(id: string, decode: (v: unknown) => T) {
  return (v: unknown) => { const result = decode(v); if (result.patientId !== id) throw new Error("Patient mismatch"); return result; };
}
export function createNurseApi(api: ApiClient) {
  const analysis = createAnalysisApi(api);
  return {
    profile: (signal?: AbortSignal) => api.request("/api/v1/me/profile", decodeNurseProfile, { signal }),
    patients: (options: { search?: string; cursor?: string | null } = {}, signal?: AbortSignal) => api.request(query("/api/v1/patients", { scope: "assigned", limit: "20", search: options.search, cursor: options.cursor }), decodePatients, { signal }),
    detail: (id: string, signal?: AbortSignal) => api.request(query(patientPath(id), { scope: "assigned" }), value => { const d = decodeDetail(value); if (d.id !== id) throw new Error("Patient mismatch"); return d; }, { signal }),
    summary: (id: string, signal?: AbortSignal) => api.request(`${patientPath(id)}/summary`, value => { const s = decodeSummary(value); if (s.id !== id) throw new Error("Patient mismatch"); return s; }, { signal }),
    records: (id: string, cursor?: string | null, signal?: AbortSignal) => api.request(query(`${patientPath(id)}/medical-record-versions`, { limit: "20", cursor }), value => decodePageOf(value, bound(id, decodeMedicalRecord)), { signal }),
    record: (id: string, recordId: string, signal?: AbortSignal) => api.request(`${patientPath(id)}/medical-record-versions/${patientUuid(recordId)}`, bound(id, decodeMedicalRecord), { signal }),
    observations: (id: string, signal?: AbortSignal) => api.request(query(`${patientPath(id)}/observations`, { limit: "20" }), decodeObservations, { signal }),
    checkIns: (id: string, cursor?: string | null, signal?: AbortSignal) => api.request(query(`${patientPath(id)}/check-ins`, { limit: "20", cursor }), value => decodePageOf(value, bound(id, decodeCheckIn)), { signal }),
    careGuide: (id: string, signal?: AbortSignal) => api.request(`${patientPath(id)}/care-guide`, bound(id, decodeCareGuide), { signal }),
    analyses: (id: string, cursor?: string | null, signal?: AbortSignal) => analysis.list(id, cursor, signal),
    analysis: (id: string, analysisId: string, signal?: AbortSignal) => analysis.get(id, analysisId, signal),
    analysisJob: (id: string, checkInId: string, jobId: string, signal?: AbortSignal) => analysis.job(id, checkInId, jobId, signal),
    analysisGeneration: (id: string, checkInId: string, intent: WriteIntent, signal?: AbortSignal) => analysis.generate(id, checkInId, intent, signal),
    analysisRevision: (id: string, analysisId: string, intent: WriteIntent, signal?: AbortSignal) => analysis.revise(id, analysisId, intent, signal),
    analysisReview: (id: string, analysisId: string, intent: WriteIntent, signal?: AbortSignal) => analysis.review(id, analysisId, intent, signal),
    analysisPublication: (id: string, analysisId: string, intent: WriteIntent, signal?: AbortSignal) => analysis.publish(id, analysisId, intent, signal),
  };
}

// In-memory ownership is the authenticated workspace, never a browser-global or persistent store.
export class MedicalWriteRegistry {
  private patients = new Map<string, MedicalWriteController>();
  constructor(private api: ApiClient, private current: () => boolean) {}
  patient(id: string) {
    if (!this.current()) throw new Error("Authenticated session required");
    patientUuid(id);
    let writer = this.patients.get(id);
    if (!writer) { writer = new MedicalWriteController(this.api, this.current, id); this.patients.set(id, writer); }
    return writer;
  }
  suspend() { this.patients.forEach(writer => writer.suspend()); }
  clear(retainBindings = false) {
    this.patients.forEach(writer => writer.dispose());
    if (!retainBindings) this.patients.clear();
  }
}

export type MedicalWriteState = { status: "idle" | "sending" | "uncertain" | "rejected" | "verified"; intent?: WriteIntent; record?: MedicalRecord; error?: ApiError };
export class MedicalWriteController {
  private state: MedicalWriteState = { status: "idle" };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  constructor(private api: ApiClient, private current: () => boolean, private patientId?: string) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(state: MedicalWriteState) { this.state = state; this.listeners.forEach(fn => fn()); }
  reset() {
    if (["sending", "uncertain"].includes(this.state.status)) throw new Error("Reconcile existing intent first");
    this.set({ status: "idle" });
  }
  suspend() {
    this.abort?.abort();
    if (this.state.status === "sending") this.set({ ...this.state, status: "uncertain" });
  }
  dispose() { this.abort?.abort(); this.set({ status: "idle" }); }
  private matches(record: MedicalRecord, intent: WriteIntent) {
    const input = JSON.parse(intent.body);
    return intent.path === `/api/v1/patients/${record.patientId}/medical-record-versions` && record.revisionNumber === input.expectedVersion + 1 && record.supersedesId === (input.supersedesId ?? null) && record.sourceReference === input.sourceReference && JSON.stringify(record.payload) === JSON.stringify(decodeMedicalSnapshot(input.payload));
  }
  async send(intent: WriteIntent) {
    if (!this.current() || this.state.status === "sending") return;
    if (this.patientId && intent.path !== `/api/v1/patients/${this.patientId}/medical-record-versions`) throw new Error("Patient binding mismatch");
    if (this.state.intent && this.state.intent !== intent) throw new Error("Existing write intent must be resolved first");
    const previouslyUncertain = this.state.status === "uncertain";
    const abort = new AbortController(); this.abort = abort;
    this.set({ status: "sending", intent });
    let writeResponded = false;
    try {
      const created = await this.api.write(intent, decodeMedicalRecord, abort.signal);
      writeResponded = true;
      if (!this.current() || abort.signal.aborted) return;
      if (!this.matches(created, intent)) throw new ApiError("INVALID_RESPONSE");
      const record = await createNurseApi(this.api).record(created.patientId, created.id, abort.signal);
      if (!this.matches(record, intent) || record.id !== created.id) throw new ApiError("INVALID_RESPONSE");
      if (this.current() && !abort.signal.aborted) this.set({ status: "verified", intent, record });
    } catch (error) {
      if (!this.current() || abort.signal.aborted) return;
      const failure = asApiError(error);
      const uncertain = previouslyUncertain || writeResponded || failure.status === 408 || failure.status >= 500 || failure.status === 0 || failure.code === "INVALID_RESPONSE";
      this.set({ status: uncertain ? "uncertain" : "rejected", intent, error: failure });
    }
  }
  async reconcile() {
    const intent = this.state.intent;
    if (!intent || this.state.status === "sending" || !this.current()) return;
    const abort = new AbortController(); this.abort = abort;
    this.set({ ...this.state, status: "sending" });
    try {
      let cursor: string | null = null;
      // Explicit read only; never send a replacement write or generate a new key.
      for (let page = 0; page < 10; page++) {
        const result: { items: MedicalRecord[]; page: { nextCursor: string | null; hasMore: boolean } } = await this.api.request(query(intent.path, { limit: "20", cursor }), value => decodePageOf(value, decodeMedicalRecord), { signal: abort.signal });
        if (!this.current() || abort.signal.aborted) return;
        const found = result.items.find(record => this.matches(record, intent));
        if (found) {
          const record = await createNurseApi(this.api).record(found.patientId, found.id, abort.signal);
          if (!this.matches(record, intent) || record.id !== found.id) throw new ApiError("INVALID_RESPONSE");
          if (this.current() && !abort.signal.aborted) this.set({ status: "verified", intent, record });
          return;
        }
        cursor = result.page.nextCursor;
        if (!cursor) break;
      }
      if (this.current() && !abort.signal.aborted) this.set({ status: "uncertain", intent });
    } catch (error) {
      if (this.current() && !abort.signal.aborted) this.set({ status: "uncertain", intent, error: asApiError(error) });
    }
  }
}
