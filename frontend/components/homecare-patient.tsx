"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Plus } from "lucide-react";
import { useCallback, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { usePatientRead, usePatientWorkspace } from "./patient-workspace-provider";
import { measurementUnits, type MeasurementType, type PatientProfile, type NurseDirectory } from "@/lib/api/patient";
import { prepareBookingCancellation, prepareBookingCreate, prepareBookingSubmit, prepareBookingUpdate, preparePriorityRequestCreate, type AvailabilitySlot, type BookingIntake, type BookingStatus, type HomecareBooking, type HomecareWriteController, type HomecareWriteState, type PriorityRequest } from "@/lib/api/homecare";
import "./patient-homecare-page.css";
import "./homecare-booking-flow.css";

type Nurse = NurseDirectory;
export type PatientHomecareWriterState = HomecareWriteState;
function latestOperation(state: PatientHomecareWriterState) {
  if (state.status === "idle") return null;
  try {
    const body = JSON.parse(state.operation.intent.body) as { nurseId?: string; slotId?: string | null; startsAt?: string; endsAt?: string; intake?: BookingIntake };
    return { operation: state.operation, result: state.result, body, consent: body.intake?.consent ?? false, form: body.intake ? formFor(body.intake) : null, interval: body.nurseId && body.startsAt && body.endsAt ? { nurseId: body.nurseId, slotId: body.slotId ?? null, startsAt: body.startsAt, endsAt: body.endsAt } : null, status: state.status };
  } catch { return { operation: state.operation, result: state.result, body: null, consent: false, form: null, interval: null, status: state.status }; }
}
export function initialBookingFlow(state: PatientHomecareWriterState, requested: string | null) {
  const pending = latestOperation(state);
  const retainedForm = pending?.form && pending.interval && (pending.operation.kind === "booking-create" || pending.operation.kind === "booking-update") ? pending : null;
  const knownTarget = pending?.operation.targetId || (pending?.operation.kind === "booking-create" && pending.result && "patientId" in pending.result ? pending.result.id : "");
  const conflict = !!(requested && knownTarget && requested !== knownTarget);
  const target = conflict ? knownTarget : requested || knownTarget;
  return {
    retainedForm,
    step: conflict ? 4 : 1,
    error: conflict ? "Pemulihan permintaan tertahan harus diselesaikan sebelum membuka draf lain." : "",
    target: target || null,
  };
}
export function retainedHomecareDecision(state: PatientHomecareWriterState, draft: HomecareBooking | null, now: number) {
  const latest = latestOperation(state);
  if (latest?.operation.kind === "booking-create" && latest.form && latest.interval) return { ...latest, draft: null as HomecareBooking | null, blocking: state.status === "sending" || state.status === "uncertain", identity: "pending" as const, eligible: true, parity: false };
  if ((latest?.operation.kind === "booking-update" || latest?.operation.kind === "booking-submit") && latest.operation.targetId) {
    if (!draft || draft.id !== latest.operation.targetId || state.status === "sending" || state.status === "uncertain") return { ...latest, draft: null as HomecareBooking | null, blocking: true, identity: "pending" as const, eligible: false, parity: false };
  }
  const eligible = !!draft && draft.status === "draft" && Date.parse(draft.startsAt) > now && !!draft.intake;
  const parity = eligible && draft && latest?.operation.targetId === draft.id ? state.status === "verified" && JSON.parse(latest.operation.intent.body).expectedVersion === draft.version - 1 : false;
  return { ...latest, draft, blocking: state.status === "sending" || state.status === "uncertain", identity: "known" as const, eligible, parity };
}
function bookingIntakeMatches(a: BookingIntake, b: BookingIntake) {
  return a.complaint === b.complaint && a.otherComplaint === b.otherComplaint && a.history === b.history && a.consciousness === b.consciousness && a.note === b.note && a.consent === b.consent && JSON.stringify([...a.conditions].sort()) === JSON.stringify([...b.conditions].sort()) && JSON.stringify([...a.observations].sort((left, right) => left.type.localeCompare(right.type))) === JSON.stringify([...b.observations].sort((left, right) => left.type.localeCompare(right.type)));
}
export function bookingReviewParity(draft: HomecareBooking | null, form: PatientHomecareForm, interval: Interval | null, consent = draft?.intake?.consent ?? false) {
  if (!draft?.intake || draft.status !== "draft" || !interval) return false;
  try { return draft.nurseId === interval.nurseId && draft.slotId === interval.slotId && draft.startsAt === interval.startsAt && draft.endsAt === interval.endsAt && bookingIntakeMatches(draft.intake, intakeFor(form, consent, draft)); } catch { return false; }
}
function draftCandidate(base: HomecareBooking | null, interval: Interval | null, form: PatientHomecareForm, consent: boolean): HomecareBooking | null {
  if (!base || !interval) return null;
  return { ...base, nurseId: interval.nurseId, slotId: interval.slotId, startsAt: interval.startsAt, endsAt: interval.endsAt, intake: intakeFor(form, consent, base) };
}
export function HomecareReviewScreening({ intake, changed = false, onEdit }: { intake: BookingIntake | null; changed?: boolean; onEdit?: () => void }) {
  if (!intake) return <ReviewSection title="Screening" onEdit={onEdit}><ReviewItem label="Keluhan utama">Belum dicatat</ReviewItem></ReviewSection>;
  return <ReviewSection title="Screening" onEdit={onEdit}>
    {changed && <div className="review-unsaved-warning" role="status">Isian berbeda dari draf server. Perubahan keluhan, catatan, atau pengukuran yang sedang diedit belum tersimpan.</div>}
    <ReviewItem label="Keluhan utama">{intake.complaint}</ReviewItem><ReviewItem label="Keluhan tambahan">{value(intake.otherComplaint)}</ReviewItem><ReviewItem label="Riwayat kondisi harian">{value(intake.history)}</ReviewItem>
    <ReviewItem label="Kesadaran">{intake.consciousness ? consciousnessNames[intake.consciousness] : "Belum dicatat"}</ReviewItem><ReviewItem label="Kondisi fisik">{intake.conditions.length ? intake.conditions.map(item => conditionNames[item]).join(", ") : "Belum dicatat"}</ReviewItem>
    {intake.observations.map(item => <ReviewItem key={item.type} label={measurementNames[item.type]}>{item.value} {measurementDisplayUnits[item.type]} · {item.observedAt} (UTC)</ReviewItem>)}
    <ReviewItem label="Catatan untuk perawat">{value(intake.note)}</ReviewItem>
  </ReviewSection>;
}
export function validatePatientBooking(draft: HomecareBooking | null, interval: Interval | null, manual: boolean, priority: PriorityRequest | null, now: number, requireApproval = true) {
  if (!interval) throw new Error("Pilih slot dari server atau isi interval UTC manual.");
  if (Date.parse(interval.startsAt) <= now) throw new Error("Pilih waktu kunjungan di masa depan.");
  if (!Number.isFinite(Date.parse(interval.startsAt)) || !Number.isFinite(Date.parse(interval.endsAt)) || Date.parse(interval.endsAt) <= Date.parse(interval.startsAt)) throw new Error("Isi interval UTC yang valid.");
  if (!manual && (!interval.slotId || (requireApproval && (!draft || draft.slotId === null || draft.status !== "draft" || draft.slotId !== interval.slotId || draft.nurseId !== interval.nurseId || draft.startsAt !== interval.startsAt || draft.endsAt !== interval.endsAt)))) throw new Error("Simpan pilihan slot server sebagai draf terbaru sebelum mengirim.");
  if (manual && interval.slotId !== null) throw new Error("Jalur manual harus menggunakan interval UTC, tanpa slot server.");
  if (manual && requireApproval && (!draft || draft.slotId !== null || draft.status !== "draft")) throw new Error("Simpan draf interval manual sebelum meminta ketersediaan.");
  if (manual && requireApproval && (!draft || !priority || priority.status !== "availability_accepted" || priority.bookingId !== draft.id || priority.nurseId !== draft.nurseId || priority.startsAt !== draft.startsAt || priority.endsAt !== draft.endsAt || priority.startsAt !== interval.startsAt || priority.endsAt !== interval.endsAt)) throw new Error("Persetujuan perawat harus cocok dengan draf, perawat, dan interval UTC yang persis sama.");
}
export type PatientHomecareForm = {
  complaint: string; otherComplaint: string; history: string; consciousness: BookingIntake["consciousness"];
  conditions: BookingIntake["conditions"]; values: Partial<Record<MeasurementType, string>>; observationTimes: Partial<Record<MeasurementType, string>>; note: string;
};
type Interval = { nurseId: string; slotId: string | null; startsAt: string; endsAt: string };
const steps = ["Identitas", "Screening", "Jadwal", "Tinjau"];
const measurementNames: Record<MeasurementType, string> = { temperature_c: "Suhu tubuh", heart_rate_bpm: "Detak jantung", bp_systolic_mmhg: "Tekanan sistolik", bp_diastolic_mmhg: "Tekanan diastolik", weight_kg: "Berat badan", spo2_pct: "Saturasi oksigen" };
const measurementDisplayUnits: Record<MeasurementType, string> = { temperature_c: "°C", heart_rate_bpm: "bpm", bp_systolic_mmhg: "mmHg", bp_diastolic_mmhg: "mmHg", weight_kg: "kg", spo2_pct: "%" };
const conditionNames = { pale: "Tampak pucat", weak: "Lemas", cold_sweat: "Berkeringat dingin", none: "Tidak ada keluhan fisik" } as const;
const consciousnessNames = { alert: "Sadar penuh", drowsy: "Mengantuk / kurang waspada", confused: "Bingung" } as const;
const statusNames: Record<BookingStatus, string> = { draft: "Draf", submitted: "Menunggu konfirmasi", accepted: "Diterima", rejected: "Ditolak", cancelled: "Dibatalkan" };
const tabs: { value: BookingStatus | "all"; label: string }[] = [{ value: "all", label: "Semua" }, { value: "draft", label: "Draf" }, { value: "submitted", label: "Menunggu" }, { value: "accepted", label: "Diterima" }, { value: "rejected", label: "Ditolak" }, { value: "cancelled", label: "Dibatalkan" }];
const emptyForm = (): PatientHomecareForm => ({ complaint: "", otherComplaint: "", history: "", consciousness: null, conditions: [], values: {}, observationTimes: {}, note: "" });
export const formFor = (intake: BookingIntake | null): PatientHomecareForm => intake ? ({ complaint: intake.complaint, otherComplaint: intake.otherComplaint ?? "", history: intake.history ?? "", consciousness: intake.consciousness, conditions: intake.conditions, values: Object.fromEntries(intake.observations.map(item => [item.type, String(item.value)])), observationTimes: Object.fromEntries(intake.observations.map(item => [item.type, item.observedAt.slice(0, 16)])), note: intake.note ?? "" }) : emptyForm();
export function intakeFor(form: PatientHomecareForm, consent: boolean, old?: HomecareBooking): BookingIntake {
  const complaint = form.complaint.trim();
  if (!complaint) throw new Error("Isi keluhan utama.");
  const observations = (Object.keys(measurementUnits) as MeasurementType[]).filter(type => form.values[type]?.trim()).map(type => {
    const raw = form.values[type]!.trim().replace(",", "."), value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 99999.999) throw new Error(`Nilai ${measurementNames[type]} tidak valid.`);
    const previous = old?.intake?.observations.find(item => item.type === type);
    const rawTime = form.observationTimes[type], observedAt = rawTime ? `${rawTime}:00.000Z` : previous?.observedAt;
    if (!observedAt) throw new Error("Isi waktu UTC untuk setiap pengukuran baru.");
    return { type, value, unit: measurementUnits[type], observedAt };
  });
  return { complaint, otherComplaint: form.otherComplaint.trim() || null, history: form.history.trim() || null, consciousness: form.consciousness, conditions: form.conditions, observations, note: form.note.trim() || null, consent };
}
function value(value: string | null | undefined) { return value?.trim() || "Belum dicatat"; }
function time(value: string | null) { return value ? `${value} (UTC)` : "Belum tersedia"; }
function displayGender(gender: string) { return gender === "male" ? "Laki-laki" : gender === "female" ? "Perempuan" : gender; }
function Field({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) { return <label className={`booking-field ${className}`}><strong>{label}</strong>{children}</label>; }
function Detail({ label, children }: { label: string; children: ReactNode }) { return <div className="homecare-detail-item"><small>{label}</small><strong>{children}</strong></div>; }
function ReviewSection({ title, onEdit, children }: { title: string; onEdit?: () => void; children: ReactNode }) { return <section className="review-section"><header><h3>{title}</h3>{onEdit && <button type="button" aria-label={`Ubah ${title.toLowerCase()}`} onClick={onEdit}>Ubah</button>}</header><dl className="review-grid">{children}</dl></section>; }
function ReviewItem({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function ReadState({ state, retry, empty }: { state: { status: string; error?: { message: string } }; retry: () => unknown; empty?: boolean }) {
  if (state.status === "error") return <div className="patient-live-message" role="alert"><p>{state.error?.message}</p><button type="button" onClick={() => void retry()}>Muat ulang</button></div>;
  if (state.status !== "ready") return <p className="patient-live-message" role="status">Memuat data dari server…</p>;
  return empty ? <p className="homecare-empty">Belum ada data untuk pilihan ini.</p> : null;
}
function useWriter(writer: HomecareWriteController) { return useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot); }
export function HomecareWriteNotice({ writer, reload }: { writer: HomecareWriteController; reload: () => unknown }) {
  const state = useWriter(writer), [error, setError] = useState("");
  const attempt = (work: Promise<unknown>) => {
    setError("");
    void work.then(reload).catch(reason => { if (!(reason instanceof Error && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Belum dapat membaca status server terbaru."); });
  };
  if (state.status === "idle") return null;
  if (state.status === "sending") return <p className="patient-live-message" role="status">Menunggu konfirmasi server…</p>;
  if (state.status === "verified") return <div className="patient-live-message" role="status"><p>Perubahan telah diverifikasi dengan membaca kembali server.</p><button type="button" onClick={() => { writer.reset(); attempt(Promise.resolve()); }}>Muat data terbaru</button>{error && <p role="alert">{error}</p>}</div>;
  return <div className="patient-live-message" role="alert"><p>{state.status === "uncertain" ? "Hasil pengiriman belum pasti. Jangan membuat pengganti; isian dan identitas permintaan tetap disimpan selama sesi ini, termasuk setelah berpindah halaman." : "Permintaan ditolak. Muat ulang data dan periksa versi sebelum memperbaiki isian."}</p>{state.error && <p>{state.error.message}</p>}<div className="patient-live-actions">{state.status === "uncertain" ? <><button type="button" onClick={() => attempt(writer.reconcile())}>Periksa hasil (tanpa mengirim)</button><button type="button" onClick={() => attempt(writer.send(state.operation))}>Kirim ulang permintaan yang sama</button></> : <button type="button" onClick={() => { writer.reset(); attempt(Promise.resolve()); }}>Muat ulang data</button>}</div>{error && <p role="alert">{error}</p>}<p><small>Muat ulang tidak mengganti operasi yang tertahan. Pencarian daftar tidak digunakan untuk menebak ID entitas baru.</small></p></div>;
}

export function HomecareHistory({ profile }: { profile: PatientProfile }) {
  const { homecare, homecareWrites, scope } = usePatientWorkspace();
  const writer = homecareWrites.writer();
  const [filter, setFilter] = useState<BookingStatus | "all">("all"), [cursor, setCursor] = useState<string | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState(""), [error, setError] = useState("");
  const [now] = useState(() => Date.now());
  const mutation = useWriter(writer), locked = mutation.status === "sending" || mutation.status === "uncertain";
  const loader = useCallback(async (signal: AbortSignal) => {
    const list = await homecare.myBookings({ ...(filter === "all" ? {} : { status: filter }), cursor, limit: 20 }, signal);
    if (list.items.some(item => item.patientId !== profile.id)) throw new Error("Patient mismatch");
    return list;
  }, [homecare, profile.id, filter, cursor]);
  const verifiedDetail = mutation.status === "verified" && mutation.operation.kind !== "priority-create" && mutation.result && "status" in mutation.result ? mutation.result as HomecareBooking : null;
  const { state, reload } = usePatientRead(loader);
  const selectedBookingId = selectedId ?? (state.status === "ready" ? state.data.items[0]?.id ?? null : null);
  const detailLoader = useCallback(async (signal: AbortSignal) => {
    if (!selectedBookingId) return null;
    const item = await homecare.myBooking(selectedBookingId, signal);
    if (item.patientId !== profile.id) throw new Error("Patient mismatch");
    return item;
  }, [homecare, selectedBookingId, profile.id]);
  const detailRead = usePatientRead(detailLoader);
  const detail = detailRead.state.status === "ready" ? detailRead.state.data : null;
  const selected = verifiedDetail?.id === selectedBookingId ? verifiedDetail : detail?.id === selectedBookingId ? detail : null;
  const cancel = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (!selected || locked || Date.parse(selected.startsAt) <= now) return;
    try {
      const fresh = await homecare.myBooking(selected.id);
      if (!scope.isCurrent()) return;
      if (fresh.patientId !== profile.id || fresh.id !== selected.id) throw new Error("Patient mismatch");
      if (!["draft", "submitted", "accepted"].includes(fresh.status) || Date.parse(fresh.startsAt) <= Date.now()) throw new Error("Pengajuan sudah tidak dapat dibatalkan.");
      if (writer.getSnapshot().status === "verified") writer.reset();
      await writer.send(prepareBookingCancellation(fresh, reason));
      const result = writer.getSnapshot();
      await detailRead.reload();
      if (result.status !== "verified") throw new Error("Hasil pembatalan belum diverifikasi server.");
      setReason(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Pembatalan belum terkirim. Periksa alasan dan hasil pengiriman."); }
  };
  return <div className="patient-homecare-main homecare-live-content">
    <section className="patient-homecare-heading"><div><h1>Homecare</h1><p>Pantau status pengajuan dan jadwal kunjungan Anda</p></div><Link className="patient-primary-button" href="/pasien/homecare/pesan"><Plus size={17} />Pesan homecare</Link></section>
    <HomecareWriteNotice writer={writer} reload={reload} />
    <div className="homecare-tabs" role="tablist" aria-label="Filter status pengajuan">{tabs.map(tab => <button key={tab.value} type="button" role="tab" aria-selected={filter === tab.value} className={filter === tab.value ? "active" : ""} onClick={() => { setFilter(tab.value); setCursor(null); setSelectedId(null); }}>{tab.label}</button>)}</div>
    {state.status !== "ready" ? <ReadState state={state} retry={reload} /> : <div className="patient-homecare-layout">
      <section className="homecare-request-list" aria-label="Daftar pengajuan homecare">{!state.data.items.length && <p className="homecare-empty">Belum ada pengajuan pada kategori ini.</p>}{state.data.items.map(item => <button key={item.id} type="button" aria-pressed={selectedBookingId === item.id} className={`homecare-request-row${selectedBookingId === item.id ? " selected" : ""}`} onClick={() => { setSelectedId(item.id); setError(""); }}><span><strong>{item.status === "draft" ? "Draf pengajuan" : `${item.id} · Kunjungan homecare`}</strong><small>{item.startsAt} – {item.endsAt} (UTC) · {item.nurse.displayName}</small></span><b className={`homecare-status-label ${item.status}`}>{statusNames[item.status]}</b></button>)}</section>
      {selected && <aside className="homecare-detail-card"><div className="homecare-detail-heading"><h2>Detail pengajuan</h2><span className={`homecare-status-label ${selected.status}`}>{statusNames[selected.status]}</span></div><div className="homecare-detail-content">
        <Detail label="Jadwal yang diminta">{selected.startsAt} – {selected.endsAt} (UTC)</Detail><Detail label="Perawat">{selected.nurse.displayName} ({selected.nurse.staffCode})</Detail><Detail label="Versi">{selected.version}</Detail><Detail label="Alasan keputusan / pembatalan">{value(selected.decisionReason)}</Detail>
        {selected.priorityRequestId && <HomecarePriorityStatus requestId={selected.priorityRequestId} />}<BookingIntakeView intake={selected.intake} />
        <h3>Linimasa dan keputusan</h3><ol className="request-timeline">{selected.events.map(event => <li key={event.id} className="complete"><span /><div><strong>{event.action} · versi {event.version}</strong><small>{time(event.createdAt)}</small>{event.reason && <small>{event.reason}</small>}</div></li>)}{!selected.events.length && <li className="current"><span /><div><strong>Belum ada peristiwa tercatat</strong></div></li>}</ol>
        {selected.status === "draft" && <Link className="patient-primary-button" href={`/pasien/homecare/pesan?draft=${selected.id}`}>Lanjutkan draf</Link>}
        {["draft", "submitted", "accepted"].includes(selected.status) && Date.parse(selected.startsAt) > now && <form className="homecare-cancel-form" onSubmit={cancel}><label>Alasan pembatalan<textarea required maxLength={4000} value={reason} onChange={event => setReason(event.target.value)} /></label><button disabled={locked} type="submit">Batalkan pengajuan sebelum kunjungan</button></form>}
      </div></aside>}
      {selectedBookingId && !selected && <aside className="homecare-detail-card"><div className="homecare-detail-heading"><h2>Detail pengajuan</h2></div><div className="homecare-detail-content"><ReadState state={detailRead.state} retry={detailRead.reload} /></div></aside>}
    </div>}
    {error && <p role="alert">{error}</p>}<div className="patient-live-actions"><button type="button" disabled={locked} onClick={() => void reload()}>Muat ulang riwayat</button>{cursor && <button type="button" onClick={() => { setCursor(null); setSelectedId(null); }}>Kembali ke terbaru</button>}{state.status === "ready" && state.data.page.hasMore && <button type="button" onClick={() => { setCursor(state.data.page.nextCursor); setSelectedId(null); }}>Pengajuan berikutnya</button>}</div>
    <p className="homecare-help">ForCare is not an emergency-response service. If you need urgent help, contact local emergency services.</p>
  </div>;
}
function BookingIntakeView({ intake }: { intake: BookingIntake | null }) {
  if (!intake) return <p>Detail intake tidak tersedia pada status atau akses saat ini.</p>;
  return <details><summary>Lihat isi intake</summary><dl className="homecare-intake-details"><ReviewItem label="Keluhan utama">{intake.complaint}</ReviewItem><ReviewItem label="Keluhan tambahan">{value(intake.otherComplaint)}</ReviewItem><ReviewItem label="Riwayat kondisi harian">{value(intake.history)}</ReviewItem><ReviewItem label="Kesadaran">{intake.consciousness ? consciousnessNames[intake.consciousness] : "Belum dicatat"}</ReviewItem><ReviewItem label="Kondisi fisik">{intake.conditions.length ? intake.conditions.map(item => conditionNames[item]).join(", ") : "Belum dicatat"}</ReviewItem><ReviewItem label="Catatan untuk perawat">{value(intake.note)}</ReviewItem><ReviewItem label="Persetujuan">{intake.consent ? "Diberikan" : "Belum diberikan"}</ReviewItem>{intake.observations.map(item => <ReviewItem key={item.type} label={measurementNames[item.type]}>{item.value} {measurementDisplayUnits[item.type]} · {time(item.observedAt)}</ReviewItem>)}</dl></details>;
}
export function HomecareBookingFlow({ profile }: { profile: PatientProfile }) {
  const { api, homecare, homecareWrites, scope } = usePatientWorkspace();
  const writer = homecareWrites.writer();
  const requestedDraft = useSearchParams().get("draft");
  const [initial] = useState(() => initialBookingFlow(writer.getSnapshot(), requestedDraft));
  const [initialRestored, setInitialRestored] = useState(false);
  const restoreForm = initial.retainedForm;
  const [step, setStep] = useState(initial.step), [form, setForm] = useState<PatientHomecareForm>(() => initial.retainedForm?.form ?? emptyForm()), [consent, setConsent] = useState(initial.retainedForm?.consent ?? false);
  const [draft, setDraft] = useState<HomecareBooking | null>(null), [quota, setQuota] = useState<HomecareBooking[]>([]);
  const [interval, setInterval] = useState<Interval | null>(initial.retainedForm?.interval ?? null), [manual, setManual] = useState(initial.retainedForm?.interval?.slotId === null), [statement, setStatement] = useState("");
  const [priority, setPriority] = useState<PriorityRequest | null>(null), [slotCursor, setSlotCursor] = useState<string | null>(null);
  const [slotDate, setSlotDate] = useState("");
  const [error, setError] = useState(initial.error);
  const [from, setFrom] = useState(""), [to, setTo] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
  const [refreshing, setRefreshing] = useState(false), [quotaBusy, setQuotaBusy] = useState(false);
  const mutation = useWriter(writer), livelyLocked = mutation.status === "sending" || mutation.status === "uncertain", retained = latestOperation(mutation);
  const readonly = !!draft && (draft.status !== "draft" || !draft.intake);
  const retainedResult = retained?.result && "patientId" in retained.result ? retained.result : null;
  const retainedTarget = retained?.operation.targetId ?? (retained?.body && "bookingId" in retained.body && typeof retained.body.bookingId === "string" ? retained.body.bookingId : undefined) ?? retainedResult?.id;
  const readRevision = useRef(0), quotaRevision = useRef(0);
  const nurseLoader = useCallback(async (signal: AbortSignal) => {
    const all: Nurse[] = [];
    let cursor: string | null = null;
    do {
      const page = await api.nurses(cursor, signal);
      all.push(...page.items);
      cursor = page.page.nextCursor;
    } while (cursor);
    return all;
  }, [api]);
  const nurses = usePatientRead(nurseLoader);
  const slotsLoader = useCallback((signal: AbortSignal) => {
    if (!interval || manual || from.length !== 16 || to.length !== 16) return Promise.resolve(null);
    const startsAt = `${from}:00.000Z`, endsAt = `${to}:00.000Z`;
    if (Date.parse(startsAt) >= Date.parse(endsAt)) return Promise.reject(new Error("Rentang tanggal tidak valid."));
    return homecare.slots(interval.nurseId, { from: startsAt, to: endsAt, cursor: slotCursor, limit: 100 }, signal);
  }, [homecare, interval, manual, from, to, slotCursor]);
  const slots = usePatientRead(slotsLoader);
  const draftId = initial.target ?? draft?.id;
  const draftRead = usePatientRead(useCallback(async (signal: AbortSignal) => {
    if (!draftId) return null;
    const current = await homecare.myBooking(draftId, signal);
    if (current.patientId !== profile.id || current.nurseId !== current.nurse.id) throw new Error("Patient or nurse mismatch");
    const currentWriter = writer.getSnapshot();
    if (currentWriter.status !== "idle" && currentWriter.operation.targetId && currentWriter.operation.targetId !== current.id) throw new Error("Permintaan tertahan pada pengajuan lain.");
    const latest = latestOperation(currentWriter);
    const priority = current.priorityRequestId ? await homecare.myPriorityRequest(current.priorityRequestId, signal) : null;
    if (priority && (priority.id !== current.priorityRequestId || priority.bookingId !== current.id || priority.patientId !== profile.id)) throw new Error("Priority request mismatch");
    return { current, priority, retainedForm: latest?.operation.kind === "booking-create" || latest?.operation.kind === "booking-update" ? latest?.form : null, retainedInterval: latest?.interval, retainedConsent: latest?.consent ?? false };
  }, [homecare, draftId, profile.id, writer]));
  const restored = initial.target && !initialRestored && draftRead.state.status === "ready" ? draftRead.state.data : null;
  const resolving = !!initial.target && !initialRestored && draftRead.state.status !== "ready" && draftRead.state.status !== "error";
  const restoreFailed = !!initial.target && !initialRestored && draftRead.state.status === "error";
  const locked = livelyLocked || readonly || refreshing || resolving || restoreFailed || quotaBusy || !!(draft && retainedTarget && retainedTarget !== draft.id);
  if (restored) {
    setInitialRestored(true);
    setDraft(restored.current);
    setFrom(restored.current.startsAt.slice(0, 16));
    setTo(restored.current.endsAt.slice(0, 16));
    setForm(restoreForm?.form ?? formFor(restored.current.intake));
    setConsent(restoreForm?.consent ?? restored.current.intake?.consent ?? false);
    setInterval(restoreForm?.interval ?? { nurseId: restored.current.nurseId, slotId: restored.current.slotId, startsAt: restored.current.startsAt, endsAt: restored.current.endsAt });
    setManual(restoreForm?.interval ? restoreForm.interval.slotId === null : restored.current.slotId === null);
    setPriority(restored.priority);
    if (restored.priority) setStatement(restored.priority.statement);
    setError(initial.error);
  }
  const refreshQuota = async (): Promise<number> => {
    const revision = ++quotaRevision.current; setQuotaBusy(true);
    try {
      const own = new Set<HomecareBooking>(); let cursor: string | null = null;
      do {
        const listed = await homecare.myBookings({ limit: 100, ...(cursor ? { cursor } : {}) });
        if (!scope.isCurrent() || revision !== quotaRevision.current) throw new Error("Read superseded");
        for (const item of listed.items) {
          if (item.patientId !== profile.id) throw new Error("Patient mismatch");
          if ((item.status === "submitted" || item.status === "accepted") && Date.parse(item.endsAt) > Date.now()) own.add(item);
          if (own.size >= 3) break;
        }
        if (own.size >= 3) break;
        cursor = listed.page.nextCursor;
      } while (cursor);
      setQuota(Array.from(own));
      return own.size;
    } finally { if (revision === quotaRevision.current && scope.isCurrent()) setQuotaBusy(false); }
  };
  const reloadDraft = async (id = draft?.id, strict = true): Promise<HomecareBooking | null> => {
    if (!id || !scope.isCurrent()) throw new Error("Draf belum tersedia.");
    const revision = ++readRevision.current; setRefreshing(true);
    try {
      const current = await homecare.myBooking(id);
      if (!scope.isCurrent() || revision !== readRevision.current) throw new Error("Read superseded");
      const currentWriter = writer.getSnapshot();
      const staleEvent = currentWriter.status !== "idle" && currentWriter.operation.targetId && currentWriter.operation.targetId !== id;
      if (staleEvent) throw new Error("Permintaan tertahan pada pengajuan lain.");
      if (current.patientId !== profile.id || current.nurseId !== current.nurse.id) throw new Error("Patient or nurse mismatch");
      if (strict && (current.status !== "draft" || !current.intake)) throw new Error("Pengajuan bukan draf yang dapat diubah.");
      if (draft && draft.id === current.id && draft.version !== current.version && currentWriter.status !== "idle" && currentWriter.operation.kind !== "priority-create" && currentWriter.operation.targetId === current.id) throw new Error("Versi draf berubah selama konfirmasi. Muat ulang sebelum mencoba lagi.");
      setDraft(current);
      const latestBody = currentWriter.status !== "idle" ? JSON.parse(currentWriter.operation.intent.body) : null;
      const isCurrentTarget = currentWriter.status !== "idle" && currentWriter.operation.targetId === current.id;
      const isCommitted = isCurrentTarget && currentWriter.status === "verified" && currentWriter.operation.kind !== "priority-create" && "nurseId" in (currentWriter.result ?? {});
      if (isCommitted && (currentWriter.operation.kind !== "booking-update" || current.version > (latestBody.expectedVersion ?? -1))) {
        setForm(formFor(current.intake)); setConsent(current.intake?.consent ?? false); setInterval({ nurseId: current.nurseId, slotId: current.slotId, startsAt: current.startsAt, endsAt: current.endsAt }); setManual(current.slotId === null);
      } else if (currentWriter.status === "idle" || !isCurrentTarget) {
        setForm(formFor(current.intake)); setConsent(current.intake?.consent ?? false); setInterval({ nurseId: current.nurseId, slotId: current.slotId, startsAt: current.startsAt, endsAt: current.endsAt }); setManual(current.slotId === null);
      }
      if (current.priorityRequestId) {
        const approval = await homecare.myPriorityRequest(current.priorityRequestId);
        if (approval.id !== current.priorityRequestId || approval.bookingId !== current.id || approval.patientId !== profile.id) throw new Error("Priority request mismatch");
        if (scope.isCurrent() && revision === readRevision.current) { setPriority(approval); setStatement(approval.statement); }
      } else setPriority(null);
      setError("");
      return current;
    } catch (reason) { if (scope.isCurrent() && revision === readRevision.current) setError(reason instanceof Error ? reason.message : "Gagal memuat ulang data server."); throw reason; }
    finally { if (scope.isCurrent() && revision === readRevision.current) setRefreshing(false); }
  };
  const update = <K extends keyof PatientHomecareForm>(key: K, value: PatientHomecareForm[K]) => setForm(old => ({ ...old, [key]: value }));
  const updateObservationTime = (type: MeasurementType, value: string) => setForm(old => ({ ...old, observationTimes: { ...old.observationTimes, [type]: value } }));
  const changeNurse = (id: string) => { setFrom(""); setTo(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)); setSlotCursor(null); setManual(false); setPriority(null); setStatement(""); setInterval(id ? { nurseId: id, slotId: null, startsAt: "", endsAt: "" } : null); };
  const changeManual = (checked: boolean) => {
    if (checked && draft?.slotId !== null && draft) { setError("Draf slot server tidak dapat dialihkan ke jalur manual. Kirim pengajuan tersebut atau kembali ke riwayat."); return; }
    setManual(checked); setInterval(current => current ? { ...current, slotId: null } : null); setPriority(null); setSlotCursor(null); setStatement("");
  };
  const chooseSlot = (slot: AvailabilitySlot) => { setInterval({ nurseId: slot.nurseId, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt }); setPriority(null); };
  const next = async () => {
    setError("");
    try {
      if (step === 1 && (!profile.phone.trim() || !profile.addressLine?.trim())) throw new Error("Lengkapi telepon dan alamat melalui Ubah kontak sebelum melanjutkan.");
      if (step === 2) { intakeFor(form, false, draft ?? undefined); await refreshQuota(); }
      if (step === 3) {
        if (await refreshQuota() >= 3) throw new Error("Batas tiga pengajuan aktif telah tercapai. Batalkan atau tunggu keputusan.");
        const fresh = draft ? await reloadDraft(draft.id) : null;
        let approval = priority;
        if (fresh?.priorityRequestId) {
          approval = await homecare.myPriorityRequest(fresh.priorityRequestId);
          if (approval.patientId !== profile.id || approval.bookingId !== fresh.id) throw new Error("Priority request mismatch");
          if (scope.isCurrent()) { setPriority(approval); setStatement(approval.statement); }
        }
        validatePatientBooking(fresh, interval, manual, approval, Date.now());
      }
      setStep(current => Math.min(4, current + 1));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Periksa isian."); }
  };
  const save = async (): Promise<HomecareBooking | null> => {
    setError("");
    if (locked) return null;
    try {
      if (!interval) throw new Error("Pilih jadwal sebelum menyimpan draf.");
      if (manual && draft?.slotId !== null && draft) throw new Error("Jalur manual tidak dapat digunakan untuk draf yang memiliki slot server.");
      if (!manual && draft?.slotId === null) throw new Error("Pengajuan manual harus melalui persetujuan ketersediaan; jangan memilih slot server.");
      validatePatientBooking(draft, interval, manual, null, Date.now(), false);
      if (!manual && !interval.slotId) throw new Error("Pilih slot yang dikembalikan server untuk pengajuan normal.");
      if (await refreshQuota() >= 3) throw new Error("Batas tiga pengajuan aktif telah tercapai.");
      const intake = intakeFor(form, consent, draft ?? undefined);
      if (!interval || !intake) return null;
      const operation = draft ? prepareBookingUpdate(draft, { nurseId: interval.nurseId, slotId: interval.slotId, startsAt: interval.startsAt, endsAt: interval.endsAt, intake }) : prepareBookingCreate(interval.nurseId, { slotId: interval.slotId, startsAt: interval.startsAt, endsAt: interval.endsAt, intake });
      if (writer.getSnapshot().status === "verified") writer.reset();
      await writer.send(operation);
      const result = writer.getSnapshot();
      if (result.status === "verified" && result.result && "patientId" in result.result && !("bookingId" in result.result)) { const item = result.result; setDraft(item); setFrom(item.startsAt.slice(0, 16)); setTo(item.endsAt.slice(0, 16)); setForm(formFor(item.intake)); setConsent(item.intake?.consent ?? false); setInterval({ nurseId: item.nurseId, slotId: item.slotId, startsAt: item.startsAt, endsAt: item.endsAt }); setManual(item.slotId === null); setPriority(null); return item; }
      return null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Draf belum dapat disimpan."); return null; }
  };
  const requestAvailability = async () => {
    if (locked) return;
    if (draft?.priorityRequestId || priority?.status === "pending" || priority?.status === "availability_accepted") { setError("Permintaan ketersediaan sudah ada. Buka statusnya; keputusan manual tidak menerima kunjungan secara otomatis."); return; }
    if (!statement.trim()) { setError("Isi alasan kebutuhan waktu di luar slot server."); return; }
    const item = await save();
    if (!item) return;
    try {
      if (item.slotId !== null || interval?.slotId !== null || !interval || item.startsAt !== interval.startsAt || item.endsAt !== interval.endsAt || item.nurseId !== interval.nurseId) throw new Error("Interval manual harus tersimpan persis sebelum permintaan ketersediaan.");
      if (writer.getSnapshot().status === "verified") writer.reset();
      await writer.send(preparePriorityRequestCreate(item, statement));
      const result = writer.getSnapshot();
      if (result.status === "verified" && result.result && "statement" in result.result) {
        const fresh = await reloadDraft(item.id);
        if (fresh?.priorityRequestId !== result.result.id) throw new Error("Pengajuan manual belum terhubung pada draf.");
        const approval = await homecare.myPriorityRequest(result.result.id);
        if (approval.bookingId !== fresh.id || approval.patientId !== profile.id) throw new Error("Priority request mismatch");
        setPriority(approval);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Permintaan ketersediaan belum terkirim."); }
  };
  const submit = async () => {
    setError("");
    if (locked) return;
    try {
      if (!draft || draft.status !== "draft" || !consent) throw new Error("Simpan draf terbaru dan berikan persetujuan sebelum mengirim.");
      if (!bookingReviewParity(draft, form, interval, true)) throw new Error("Simpan perubahan sebagai draf sebelum mengirim.");
      const fresh = await reloadDraft(draft.id);
      if (!fresh || !fresh.intake?.consent || fresh.status !== "draft") throw new Error("Status atau persetujuan draf berubah. Tinjau ulang sebelum mengirim.");
      if (!bookingReviewParity(fresh, form, interval, true)) throw new Error("Draf berubah. Periksa data terbaru lalu tinjau ulang.");
      if (await refreshQuota() >= 3) throw new Error("Batas tiga pengajuan aktif telah tercapai.");
      let approval = priority;
      if (fresh.priorityRequestId) approval = await homecare.myPriorityRequest(fresh.priorityRequestId);
      validatePatientBooking(fresh, interval, manual, approval, Date.now());
      if (!manual && interval) {
        const visible = await homecare.slots(interval.nurseId, { from: interval.startsAt, to: interval.endsAt, limit: 100 });
        if (visible.nurseId !== interval.nurseId || !visible.items.some(slot => slot.id === interval.slotId && slot.nurseId === interval.nurseId && slot.startsAt === interval.startsAt && slot.endsAt === interval.endsAt)) throw new Error("Slot berubah. Muat ulang jadwal dan pilih kembali.");
      }
      if (writer.getSnapshot().status === "verified") writer.reset();
      await writer.send(prepareBookingSubmit(fresh));
      const result = writer.getSnapshot();
      if (result.status === "verified" && result.result && "patientId" in result.result && !("bookingId" in result.result)) { setDraft(result.result); setStep(4); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Pengajuan belum dapat dikirim."); }
  };
  const activeNurses = nurses.state.status === "ready" ? nurses.state.data : [], nurse = activeNurses.find(item => item.id === interval?.nurseId) ?? draft?.nurse;
  const changed = !bookingReviewParity(draft, form, interval, consent);
  const availableSlots = slots.state.status === "ready" ? slots.state.data?.items.filter(slot => slot.nurseId === interval?.nurseId) ?? [] : [];
  const slotDates = [...new Set(availableSlots.map(slot => slot.startsAt.slice(0, 10)))];
  const selectedSlotDate = slotDates.includes(slotDate) ? slotDate : slotDates.includes(interval?.startsAt.slice(0, 10) ?? "") ? interval!.startsAt.slice(0, 10) : slotDates[0];
  const reviewCandidate = (() => { try { return draftCandidate(draft, interval, form, consent); } catch { return null; } })();
  const reviewIntake = reviewCandidate?.intake ?? draft?.intake ?? null;
  const submitDisabled = locked || readonly || changed || !draft || !consent || !draft.intake?.consent || quota.length >= 3;
  if (resolving && mutation.status === "idle") return <p role="status" className="patient-live-message">Memuat draf dari server…</p>;
  return <div className="booking-main homecare-live-content">
    <Link className="booking-back" href="/pasien/homecare"><ArrowLeft size={16} />Kembali ke Homecare</Link>
    <div className="booking-title"><h1>Pesan Homecare</h1><p>Lengkapi data berikut. Perawat akan meninjau pengajuan Anda</p></div>
    {resolving && <p className="patient-live-message" role="status">Memuat draf dari server…</p>}
    {restoreFailed && <ReadState state={draftRead.state} retry={draftRead.reload} />}
    {(refreshing || quotaBusy) && <p className="patient-live-message" role="status">Memeriksa data terbaru dari server…</p>}
    <ol className="booking-stepper" aria-label={`Langkah ${step} dari 4`}>{steps.map((label, index) => <li key={label} className={index + 1 < step ? "done" : index + 1 === step ? "active" : ""} aria-current={index + 1 === step ? "step" : undefined}><span>{index + 1 < step ? <Check size={16} /> : index + 1}</span><strong>{label}</strong></li>)}</ol>
    <HomecareWriteNotice writer={writer} reload={() => reloadDraft(retainedTarget ?? draft?.id ?? undefined)} />
    {draft && <HomecareStatusNotice status={draft.status} />}{step === 4 && <HomecareQuotaStatus count={quotaBusy ? null : quota.length} />}
    <div className="booking-layout"><form id="booking-flow" className="booking-form" onSubmit={event => { event.preventDefault(); if (step === 4) void submit(); else void next(); }}><fieldset disabled={locked} className="booking-flow-fieldset">
      {step === 1 && <section className="booking-panel"><div className="booking-panel-title"><h2>Identitas pasien</h2><small>Langkah 1 dari 4</small></div><div className="booking-panel-body identity-fields"><ReadOnly label="Nama pasien" value={profile.fullName} /><ReadOnly label="Nomor telepon" value={value(profile.phone)} /><ReadOnly label="Alamat" value={value(profile.addressLine)} full /><ReadOnly label="Tanggal lahir" value={profile.birthDate} /><ReadOnly label="Jenis kelamin" value={displayGender(profile.gender)} /><ReadOnly label="Nomor rekam medis" value={value(profile.recordNumber)} full /><p className="booking-field full">Identitas mengikuti profil Anda. <Link href="/pasien/profil/kontak">Ubah kontak dan alamat</Link></p>{!profile.addressLine && <p role="alert" className="booking-field full">Alamat wajib dilengkapi sebelum pengajuan.</p>}</div></section>}
      {step === 2 && <Screening form={form} update={update} updateObservationTime={updateObservationTime} />}
      {step === 3 && <section className="booking-panel"><div className="booking-panel-title"><h2>Pilih jadwal kunjungan</h2><small>Langkah 3 dari 4</small></div><div className="booking-panel-body schedule-fields">
        <Field label="Perawat"><select aria-label="Perawat" required value={interval?.nurseId ?? ""} onChange={event => changeNurse(event.target.value)}><option value="">Pilih perawat aktif</option>{activeNurses.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.staffCode}</option>)}</select></Field><ReadState state={nurses.state} retry={nurses.reload} empty={!activeNurses.length} />
        <label className="booking-secondary-mode"><input type="checkbox" checked={manual} onChange={event => changeManual(event.target.checked)} />Waktu manual di luar slot yang dipublikasikan</label>
        <div className="date-range-fields"><Field label="Cari slot dari (UTC)"><input required={!manual} disabled={!interval || manual} type="datetime-local" value={from} onChange={event => { setFrom(event.target.value); setSlotCursor(null); }} /></Field><Field label="Sampai (UTC)"><input required={!manual} disabled={!interval || manual} type="datetime-local" value={to} onChange={event => { setTo(event.target.value); setSlotCursor(null); }} /></Field></div>
        {!manual && <><ReadState state={slots.state} retry={slots.reload} empty={slots.state.status === "ready" && !availableSlots.length} />{!!availableSlots.length && <><div><strong className="field-label">Tanggal <em>(UTC)</em></strong><div className="date-choices">{slotDates.map(date => <button key={date} type="button" className={selectedSlotDate === date ? "selected" : ""} aria-pressed={selectedSlotDate === date} aria-label={date} onClick={() => setSlotDate(date)}><small>{new Date(`${date}T00:00:00Z`).toLocaleDateString("id-ID", { weekday: "short", timeZone: "UTC" })}</small><strong>{date.slice(8)}</strong><small>{new Date(`${date}T00:00:00Z`).toLocaleDateString("id-ID", { month: "short", year: "numeric", timeZone: "UTC" })}</small></button>)}</div></div><div><strong className="field-label">Jam <em>(UTC)</em></strong><div className="time-choices" role="group" aria-label="Slot tersedia dari server">{availableSlots.filter(slot => slot.startsAt.slice(0, 10) === selectedSlotDate).map(slot => <button type="button" key={slot.id} className={interval?.slotId === slot.id ? "selected" : ""} aria-pressed={interval?.slotId === slot.id} aria-label={`${slot.startsAt} – ${slot.endsAt} UTC`} onClick={() => chooseSlot(slot)}>{slot.startsAt.slice(11, 16)}</button>)}</div><small className="availability-note">{interval?.slotId ? `${interval.startsAt} – ${interval.endsAt} (UTC)` : "Pilih waktu dari ketersediaan yang dipublikasikan perawat."}</small></div></>}<div className="patient-live-actions">{slotCursor && <button type="button" onClick={() => { setSlotCursor(null); setSlotDate(""); }}>Slot terbaru</button>}{slots.state.status === "ready" && slots.state.data?.page.hasMore && <button type="button" onClick={() => { setSlotCursor(slots.state.status === "ready" ? slots.state.data?.page.nextCursor ?? null : null); setSlotDate(""); }}>Slot berikutnya</button>}</div></>}
        {manual && <section className="manual-request"><p>Minta ketersediaan kepada perawat untuk interval UTC yang tepat. Permintaan ini bukan pengiriman atau penerimaan kunjungan dan bukan jalur darurat.</p><div className="date-range-fields"><Field label="Mulai kunjungan (UTC)"><input required type="datetime-local" step="1" value={interval?.startsAt ? interval.startsAt.slice(0, 16) : ""} onChange={event => { setPriority(null); setInterval(current => current ? { ...current, slotId: null, startsAt: `${event.target.value}:00.000Z` } : current); }} /></Field><Field label="Selesai kunjungan (UTC)"><input required type="datetime-local" step="1" value={interval?.endsAt ? interval.endsAt.slice(0, 16) : ""} onChange={event => { setPriority(null); setInterval(current => current ? { ...current, slotId: null, endsAt: `${event.target.value}:00.000Z` } : current); }} /></Field></div><Field label="Pernyataan kebutuhan waktu"><textarea required maxLength={4000} value={statement} onChange={event => setStatement(event.target.value)} /></Field><button type="button" disabled={locked || !interval || !statement.trim() || priority?.status === "pending"} onClick={() => { try { void requestAvailability(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Permintaan ketersediaan belum terkirim."); } }}>Simpan draf dan minta ketersediaan</button>{priority && <p role="status">Status: {priority.status === "pending" ? "Menunggu tinjauan" : priority.status === "availability_accepted" ? "Ketersediaan disetujui; kirim pengajuan secara terpisah" : "Ditolak"}. {value(priority.reason)}</p>}</section>}
        <Field label={<>Catatan untuk perawat <em>(opsional)</em></>}><textarea maxLength={4000} value={form.note} onChange={event => update("note", event.target.value)} /></Field>
      </div></section>}
      {step === 4 && <section className="booking-panel"><div className="booking-panel-title"><h2>Tinjau</h2><small>Langkah 4 dari 4</small></div><div className="booking-panel-body review-sections"><ReviewSection title="Identitas pasien" onEdit={() => setStep(1)}><ReviewItem label="Nama">{profile.fullName}</ReviewItem><ReviewItem label="Telepon">{profile.phone}</ReviewItem><ReviewItem label="Tanggal lahir">{profile.birthDate}</ReviewItem><ReviewItem label="No. rekam medis">{value(profile.recordNumber)}</ReviewItem><ReviewItem label="Alamat">{value(profile.addressLine)}</ReviewItem></ReviewSection><HomecareReviewScreening intake={reviewIntake} changed={changed} onEdit={() => setStep(2)} /><ReviewSection title="Jadwal dan perawat" onEdit={() => setStep(3)}><ReviewItem label="Perawat">{nurse ? `${nurse.displayName} (${nurse.staffCode})` : "Belum dipilih"}</ReviewItem><ReviewItem label="Waktu yang diminta">{interval ? `${interval.startsAt} – ${interval.endsAt} (UTC)` : "Belum dipilih"}</ReviewItem><ReviewItem label="Catatan untuk perawat">{value(form.note)}</ReviewItem><ReviewItem label="Persetujuan manual">{manual ? priority?.status === "availability_accepted" ? "Ketersediaan disetujui" : "Belum disetujui" : "Tidak diperlukan"}</ReviewItem></ReviewSection><label className="consent-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span><strong>Saya menyetujui data intake ini digunakan perawat untuk menilai kebutuhan kunjungan</strong><small>Persetujuan ini disimpan hanya saat Anda memilih Simpan draf.</small></span></label></div></section>}
    </fieldset>{error && <p className="booking-error" role="alert">{error}</p>}<div className="booking-mobile-actions">{step > 1 && <button type="button" className="booking-secondary" disabled={locked} onClick={() => setStep(step - 1)}>Kembali</button>}<button className="booking-secondary" disabled={locked} type="button" onClick={() => void save()}>Simpan draf</button><button className="booking-primary" disabled={step === 4 ? submitDisabled : locked} type="submit">{step === 4 ? "Kirim pengajuan" : "Lanjut"}</button></div></form>
    <aside className="booking-summary"><div className="booking-panel-title"><h2>Ringkasan</h2></div><div className="booking-summary-body"><div className="summary-grid"><Summary label="Pasien" value={profile.fullName} /><Summary label="RM" value={value(profile.recordNumber)} /><Summary label="Perawat" value={nurse?.displayName ?? "Belum dipilih"} /><Summary label="Jadwal (UTC)" value={interval?.startsAt && interval.endsAt ? `${interval.startsAt} – ${interval.endsAt}` : "Belum dipilih"} /></div><div className="summary-notice">Pengajuan ditinjau perawat sebelum dikonfirmasi. Persetujuan waktu manual bukan penerimaan kunjungan.</div><div className="summary-actions">{step > 1 && <button type="button" className="booking-secondary" disabled={locked} onClick={() => setStep(step - 1)}>Kembali</button>}<button className="booking-secondary" disabled={locked} type="button" onClick={() => void save()}>Simpan draf</button><button form="booking-flow" className="booking-primary" disabled={step === 4 ? submitDisabled : locked} type="submit">{step === 4 ? "Kirim pengajuan" : "Lanjut"}</button></div></div></aside></div>
    <p className="homecare-help">ForCare is not an emergency-response service. If you need urgent help, contact local emergency services.</p>
  </div>;
}

function ReadOnly({ label, value, full = false }: { label: string; value: string; full?: boolean }) { return <div className={`booking-field homecare-readonly${full ? " full" : ""}`}><strong>{label}</strong><span>{value}</span></div>; }
function Summary({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function Screening({ form, update, updateObservationTime }: { form: PatientHomecareForm; update: <K extends keyof PatientHomecareForm>(key: K, value: PatientHomecareForm[K]) => void; updateObservationTime: (type: MeasurementType, value: string) => void }) {
  const toggle = (condition: BookingIntake["conditions"][number]) => update("conditions", condition === "none" ? form.conditions.includes("none") ? [] : ["none"] : form.conditions.includes(condition) ? form.conditions.filter(item => item !== condition) : [...form.conditions.filter(item => item !== "none"), condition]);
  const measurement = (type: MeasurementType) => <div className="screening-measurement" key={type}><Field label={<>{measurementNames[type]} <em>(opsional)</em></>}><div className="unit-input"><input aria-label={measurementNames[type]} type="number" min="0.001" max="99999.999" step="0.001" inputMode="decimal" value={form.values[type] ?? ""} onChange={event => update("values", { ...form.values, [type]: event.target.value })} /><small>{measurementDisplayUnits[type]}</small></div></Field><Field label={`Waktu UTC ${measurementNames[type]}`}><input type="datetime-local" step="1" required={!!form.values[type]} value={form.observationTimes[type] ?? ""} onChange={event => updateObservationTime(type, event.target.value)} /></Field></div>;
  return <section className="booking-panel"><div className="booking-panel-title"><h2>Screening</h2><small>Langkah 2 dari 4</small></div><div className="booking-panel-body screening-fields">
    <Field label="Keluhan utama" className="full"><textarea required maxLength={2000} rows={3} value={form.complaint} onChange={event => update("complaint", event.target.value)} /></Field>
    <Field label={<>Keluhan tambahan <em>(opsional)</em></>} className="full"><textarea maxLength={2000} rows={2} placeholder="Keluhan lain yang Anda rasakan" value={form.otherComplaint} onChange={event => update("otherComplaint", event.target.value)} /></Field>
    <div className="pressure-field"><strong className="field-label">Tekanan darah <em>(opsional)</em></strong><div className="pressure-measurements">{measurement("bp_systolic_mmhg")}{measurement("bp_diastolic_mmhg")}</div></div>
    {measurement("temperature_c")}{measurement("heart_rate_bpm")}
    <Field label={<>Riwayat kondisi harian <em>(opsional)</em></>} className="full"><textarea rows={2} maxLength={4000} value={form.history} onChange={event => update("history", event.target.value)} /></Field>
    <fieldset><legend>Tingkat kesadaran <em>(opsional)</em></legend>{(Object.keys(consciousnessNames) as (keyof typeof consciousnessNames)[]).map(item => <label className={`choice-card${form.consciousness === item ? " selected" : ""}`} key={item}><input type="radio" name="consciousness" checked={form.consciousness === item} onChange={() => update("consciousness", item)} />{consciousnessNames[item]}</label>)}<button type="button" className="screening-clear" onClick={() => update("consciousness", null)}>Hapus pilihan kesadaran</button></fieldset>
    <fieldset><legend>Kondisi fisik umum <em>(opsional, boleh pilih lebih dari satu)</em></legend>{(Object.keys(conditionNames) as (keyof typeof conditionNames)[]).map(item => <label className={`choice-card${form.conditions.includes(item) ? " selected" : ""}`} key={item}><input type="checkbox" checked={form.conditions.includes(item)} onChange={() => toggle(item)} />{conditionNames[item]}</label>)}</fieldset>
    {measurement("weight_kg")}{measurement("spo2_pct")}
    <p className="availability-note full">Kosongkan pengukuran yang tidak dilakukan. Setiap nilai yang diisi memerlukan waktu pengukuran UTC; tidak ada nilai normal atau nol yang diasumsikan.</p>
  </div></section>;
}

export function HomecareStatusNotice({ status }: { status: HomecareBooking["status"] }) {
  if (status === "accepted") return <p className="patient-live-message" role="status">Kunjungan sudah diterima perawat. Anda dapat membatalkan sebelum mulai dengan alasan.</p>;
  if (status === "submitted") return <p className="patient-live-message" role="status">Pengajuan terkirim dan menunggu keputusan perawat. Anda dapat membatalkan sebelum mulai dengan alasan.</p>;
  return null;
}
export function HomecareQuotaStatus({ count }: { count: number | null }) {
  if (count === null) return <p className="homecare-quota-status" role="status">Memeriksa batas 3 pengajuan aktif dari server…</p>;
  return <p className="homecare-quota-status" role={count >= 3 ? "alert" : "status"}>Pengajuan aktif: {count} dari 3. Draf tidak dihitung. Persetujuan ketersediaan manual juga bukan penerimaan kunjungan.{count >= 3 ? " Batalkan pengajuan aktif atau tunggu keputusan sebelum mengirim lagi." : ""}</p>;
}

export function HomecarePriorityStatus({ requestId }: { requestId: string }) {
  const { homecare } = usePatientWorkspace(), loader = useCallback((signal: AbortSignal) => homecare.myPriorityRequest(requestId, signal), [homecare, requestId]);
  const { state, reload } = usePatientRead(loader);
  if (state.status !== "ready") return <ReadState state={state} retry={reload} />;
  const request = state.data;
  return <section className="priority-status" aria-label="Status permintaan ketersediaan"><h3>Permintaan ketersediaan manual</h3><p>Status: {request.status === "pending" ? "Menunggu tinjauan ketersediaan" : request.status === "availability_accepted" ? "Ketersediaan disetujui; pengajuan belum otomatis dikirim atau diterima" : "Ketersediaan ditolak"}</p><p>{request.statement}</p><p>Alasan tinjauan: {value(request.reason)}</p><Link href={`/pasien/homecare/pesan?draft=${request.bookingId}`}>Buka pengajuan</Link></section>;
}
