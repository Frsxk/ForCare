"use client";

import Link from "next/link";
import { useCallback, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { ArrowLeft, CalendarDays, Check, Search, X } from "lucide-react";
import { NurseHeader } from "@/components/nurse-header";
import { ReadError, ReadPanel } from "@/components/nurse-workspace-pages";
import { useNurseWorkspace, useNurseRead } from "@/components/nurse-workspace-provider";
import { asApiError, type ApiError } from "@/lib/api/client";
import {
  prepareAvailabilityWrite,
  prepareNurseBookingCancellation,
  prepareNurseBookingDecision,
  prepareNurseBookingReschedule,
  preparePriorityRequestReview,
  type Availability,
  type AvailabilityInput,
  type AvailabilitySlots,
  type BookingStatus,
  type HomecareBooking,
  type HomecareCareGuide,
  type HomecareApi,
  type HomecareWriteController,
  type HomecareWriteResult,
  type Page,
  type PriorityRequest,
} from "@/lib/api/homecare";
import "./homecare-nurse.css";

export const nurseBookingStatusLabels: Record<BookingStatus, string> = {
  draft: "Draf",
  submitted: "Menunggu keputusan",
  accepted: "Diterima",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
};
const priorityStatusLabels = { pending: "Menunggu tinjauan ketersediaan", availability_accepted: "Ketersediaan dikonfirmasi", declined: "Ditolak" } as const;
const noIdentity = "Identitas di luar izin akses saat ini tidak ditampilkan.";
const immediateHelp = "ForCare bukan layanan respons kegawatdaruratan. Jika membutuhkan pertolongan segera, hubungi layanan darurat setempat.";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}
function identity(booking: HomecareBooking) {
  return booking.profileSnapshot?.fullName ?? noIdentity;
}
function recordNumber(booking: HomecareBooking) {
  return booking.profileSnapshot?.recordNumber ?? "Nomor RM di luar izin akses saat ini tidak ditampilkan.";
}
function statusClass(status: BookingStatus) {
  return status === "submitted" ? "pending" : status;
}
function freshResult<T extends HomecareWriteResult>(writer: HomecareWriteController): T | null {
  const state = writer.getSnapshot();
  return state.status === "verified" && state.result ? state.result as T : null;
}
function isBeforeStart(booking: HomecareBooking) {
  return Date.parse(booking.startsAt) > Date.now() && ["submitted", "accepted"].includes(booking.status);
}

export function HomecareWriteFeedback({ writer }: { writer: HomecareWriteController }) {
  const state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  if (state.status === "idle") return null;
  if (state.status === "sending") return <p className="homecare-nurse-notice" role="status">Menunggu konfirmasi dan pembacaan ulang server…</p>;
  if (state.status === "verified") {
    return <p className="homecare-nurse-notice is-verified" role="status">Tindakan tersimpan dan telah diverifikasi melalui pembacaan ulang server.</p>;
  }
  return <div className="homecare-nurse-notice" role="alert">
    <p>{state.status === "uncertain" ? "Hasil tindakan belum dapat dipastikan. Jangan membuat pengajuan pengganti atau mengubah status secara lokal. Permintaan asli tetap disimpan selama sesi ini, termasuk saat berpindah halaman." : "Server menolak tindakan ini. Data belum dianggap berubah; muat ulang snapshot sebelum mencoba dengan versi terbaru."}</p>
    {state.error && <p>{state.error.message}{state.error.requestId ? ` · Referensi ${state.error.requestId}` : ""}</p>}
    {state.status === "uncertain" ? <div className="homecare-nurse-actions">
      {["availability-put", "booking-update", "priority-review"].includes(state.operation.kind) && <button type="button" className="button button-outline" onClick={() => void writer.reconcile()}>Periksa hasil tanpa mengirim</button>}
      <button type="button" className="button button-outline" onClick={() => void writer.send(state.operation)}>Kirim ulang permintaan yang sama</button>
    </div> : <button type="button" className="button button-outline" onClick={() => writer.reset()}>Tutup pesan</button>}
  </div>;
}

async function loadFollowingPages<T extends { id: string }>(
  resource: { load: (loader: (signal: AbortSignal) => Promise<Page<T>>) => Promise<Page<T> | undefined>; getSnapshot: () => { status: string; data?: Page<T>; error?: ApiError } },
  current: Page<T>,
  read: (signal: AbortSignal) => Promise<Page<T>>,
) {
  const result = await resource.load(async signal => {
    const next = await read(signal);
    return { ...next, items: [...new Map([...current.items, ...next.items].map(item => [item.id, item])).values()] };
  });
  if (!result) {
    const state = resource.getSnapshot();
    if (state.status === "error" && state.error) throw state.error;
  }
}
function NextPageButton({ label, onClick }: { label: string; onClick: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return <div className="homecare-nurse-pagination">
    <button className="button button-outline" disabled={busy} onClick={() => { setBusy(true); setError(null); void onClick().catch(error => setError(asApiError(error))).finally(() => setBusy(false)); }}>{busy ? "Memuat halaman berikutnya…" : label}</button>
    {error && <ReadError error={error} retry={() => void onClick()} />}
  </div>;
}

export function NurseBookingRows({ bookings, onReset }: { bookings: HomecareBooking[]; onReset?: () => void }) {
  return <div className="homecare-table-wrap" role="region" aria-label="Daftar pengajuan homecare" tabIndex={0}>
    <table className="homecare-table homecare-nurse-table">
      <caption className="sr-only">Pengajuan homecare pasien dan status peninjauannya; identitas privat hanya muncul jika akses server masih berlaku.</caption>
      <colgroup><col className="hc-col-patient" /><col className="hc-col-id" /><col className="hc-col-schedule" /><col className="hc-col-doctor" /><col className="hc-col-status" /><col className="hc-col-action" /></colgroup>
      <thead><tr><th scope="col">Pasien</th><th scope="col">Pengajuan</th><th scope="col">Jadwal diminta</th><th scope="col">Dokter</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Tindakan</span></th></tr></thead>
      <tbody>{bookings.map(booking => <tr key={booking.id}>
        <td><div className="patient-identity"><strong>{identity(booking)}</strong><span className="secondary-text">{recordNumber(booking)}</span></div></td>
        <td><span className="homecare-nurse-id" title={`${booking.id} · versi ${booking.version}`}>{booking.id}</span></td>
        <td>{formatTime(booking.startsAt)}<span className="sr-only"> sampai {formatTime(booking.endsAt)}</span></td>
        <td><span className="secondary-text">Tidak tersedia</span></td>
        <td><span className={`request-status request-status-${statusClass(booking.status)}`}>{nurseBookingStatusLabels[booking.status]}</span></td>
        <td><Link className="button button-primary button-small request-review" href={`/pengajuan-homecare/${booking.id}`} aria-label={`Tinjau pengajuan ${identity(booking)}`}>Tinjau</Link></td>
      </tr>)}</tbody>
    </table>
    {bookings.length === 0 && <div className="empty-state homecare-empty"><Search size={30} aria-hidden="true" /><h2>Tidak ada pengajuan pada filter ini</h2><p>Hasil berasal dari server untuk akun perawat dan kriteria yang dipilih.</p>{onReset && <button className="text-button" onClick={onReset}>Atur ulang filter</button>}</div>}
  </div>;
}
function BookingQueue({ status, search, onReset }: { status?: BookingStatus; search: string; onReset: () => void }) {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => homecare.bookings({ status, search: search || undefined }, signal), [homecare, status, search]);
  const list = useNurseRead(loader);
  return <><ReadPanel state={list.state} reload={list.reload}>{data => <>
    <p className="sr-only" role="status" aria-live="polite">{data.items.length} pengajuan dimuat{data.page.hasMore ? "; masih ada halaman berikutnya" : ""}.</p>
    <NurseBookingRows bookings={data.items} onReset={onReset} />
    {data.page.nextCursor && <NextPageButton label="Muat pengajuan berikutnya" onClick={() => loadFollowingPages(list.resource, data, signal => homecare.bookings({ status, search: search || undefined, cursor: data.page.nextCursor }, signal))} />}
  </>}</ReadPanel></>;
}
const queueFilters: { label: string; value?: BookingStatus }[] = [
  { label: "Semua" }, { label: "Menunggu", value: "submitted" }, { label: "Diterima", value: "accepted" }, { label: "Ditolak", value: "rejected" }, { label: "Dibatalkan", value: "cancelled" },
];
export function LiveHomecareNurseRequests() {
  const [status, setStatus] = useState<BookingStatus | undefined>();
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  return <><NurseHeader activePage="requests" /><main id="konten-utama" className="dashboard-main homecare-main homecare-nurse-main">
    <section aria-labelledby="homecare-title"><div className="page-heading"><h1 id="homecare-title">Pengajuan Homecare</h1><p>Tinjau dan putuskan pengajuan dari pasien Anda</p></div>
      <div className="homecare-toolbar">
        <div className="status-filters" role="group" aria-label="Filter status pengajuan">{queueFilters.map(filter => <button type="button" key={filter.label} className={`status-filter${status === filter.value ? " is-selected" : ""}`} aria-pressed={status === filter.value} onClick={() => setStatus(filter.value)}>{filter.label}</button>)}</div>
        <form className="homecare-nurse-search-form" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}>
          <label className="search-field homecare-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Cari nama pasien atau nomor RM</span><input type="search" maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari nama pasien atau nomor RM" /></label>
          <button className="button button-primary" type="submit">Cari</button>
        </form>
      </div>
      <BookingQueue key={`${status ?? "all"}-${search}`} status={status} search={search} onReset={() => { setStatus(undefined); setQuery(""); setSearch(""); }} />
      <div className="homecare-nurse-help"><p>Persetujuan pengajuan adalah tindakan terpisah dari tinjauan ketersediaan di luar jadwal.</p><p>{immediateHelp}</p></div>
      <NursePriorityQueue />
    </section>
  </main></>;
}

function NursePriorityQueue() {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => homecare.priorityRequests({}, signal), [homecare]);
  const list = useNurseRead(loader);
  return <section className="card live-card homecare-nurse-priority" aria-labelledby="priority-queue-title"><div className="homecare-nurse-section-heading"><div><h2 id="priority-queue-title">Tinjauan ketersediaan di luar jadwal</h2><p>Keputusan ini hanya menyetujui pengecualian interval. Persetujuan tidak mengirim atau menerima pemesanan.</p></div><button className="button button-outline" type="button" onClick={() => void list.reload()}>Muat ulang</button></div>
    <ReadPanel state={list.state} reload={list.reload}>{data => <>{data.items.length === 0 ? <p className="empty-state">Belum ada permintaan tinjauan ketersediaan.</p> : <ul className="homecare-nurse-priority-list">{data.items.map(request => <li key={request.id}><div><strong>{request.patient?.displayName ?? noIdentity}</strong><span>{request.patient?.recordNumber ?? "Nomor RM tidak tersedia"}</span><span className="homecare-nurse-id">Permintaan {request.id}</span><span>{formatTime(request.startsAt)} — {formatTime(request.endsAt)}</span><span className={`request-status request-status-${request.status === "pending" ? "pending" : request.status === "declined" ? "rejected" : "accepted"}`}>{priorityStatusLabels[request.status]}</span></div><Link className="button button-primary button-small" href={`/pengajuan-homecare/${request.bookingId}?prioritas=${encodeURIComponent(request.id)}`}>Tinjau ketersediaan</Link></li>)}</ul>}
      {data.page.nextCursor && <NextPageButton label="Muat tinjauan berikutnya" onClick={() => loadFollowingPages(list.resource, data, signal => homecare.priorityRequests({ cursor: data.page.nextCursor }, signal))} />}
    </>}</ReadPanel>
  </section>;
}

function StaticFields({ entries, className = "homecare-nurse-fields" }: { entries: [string, string | null | undefined][]; className?: string }) {
  return <dl className={className}>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value?.trim() ? value : "Belum dicatat"}</dd></div>)}</dl>;
}
export function NurseBookingSnapshot({ booking }: { booking: HomecareBooking }) {
  const profile = booking.profileSnapshot, intake = booking.intake;
  const observations = intake?.observations ?? [];
  const reported = (type: NonNullable<HomecareBooking["intake"]>["observations"][number]["type"]) => {
    const observation = observations.find(item => item.type === type);
    return observation ? `${observation.value} ${observation.unit}` : "Belum dicatat";
  };
  return <>
    <section className="card request-identity-card" aria-labelledby="nurse-identity-title"><div className="section-header teal-header"><h2 id="nurse-identity-title">Identitas pasien</h2></div>
      {profile ? <><StaticFields className="identity-fields" entries={[["RM", profile.recordNumber], ["Tanggal lahir / jenis kelamin", [profile.birthDate, profile.gender === "female" ? "Perempuan" : profile.gender === "male" ? "Laki-laki" : profile.gender].filter(Boolean).join(" / ")], ["Keluar RS", null], ["Telepon", profile.phone]]} /><details className="homecare-nurse-identity-extra"><summary>Rincian snapshot pasien</summary><StaticFields entries={[["Nama", profile.fullName], ["Alamat kunjungan", profile.addressLine], ["Kontak darurat", profile.emergencyContactName], ["Telepon darurat", profile.emergencyContactPhone]]} /></details></> : <div className="request-screening-body"><p>Snapshot identitas dan intake tidak lagi tersedia karena izin akses berakhir atau pengajuan sudah terminal.</p></div>}
    </section>
    <section className="card request-screening-card" aria-labelledby="nurse-screening-title"><div className="section-header teal-header"><h2 id="nurse-screening-title">Screening dan anamnesis</h2></div><div className="request-screening-body">
      {intake ? <>
        <StaticFields className="screening-complaint" entries={[["Keluhan utama", intake.complaint], ["Keluhan tambahan", intake.otherComplaint]]} />
        <dl className="screening-vitals"><div><dt>Tekanan darah</dt><dd>Sistolik: {reported("bp_systolic_mmhg")}<br />Diastolik: {reported("bp_diastolic_mmhg")}</dd></div><div><dt>Suhu tubuh</dt><dd>{reported("temperature_c")}</dd></div><div><dt>Detak jantung</dt><dd>{reported("heart_rate_bpm")}</dd></div><div><dt>Tingkat kesadaran</dt><dd>{intake.consciousness === "alert" ? "Sadar penuh" : intake.consciousness === "drowsy" ? "Mengantuk / kurang waspada" : intake.consciousness === "confused" ? "Bingung" : "Belum dicatat"}</dd></div></dl>
        <StaticFields className="screening-history" entries={[["Riwayat kondisi harian", intake.history], ["Kondisi fisik umum", intake.conditions.length ? intake.conditions.map(item => ({ pale: "Tampak pucat", weak: "Lemas", cold_sweat: "Berkeringat dingin", none: "Tidak ada keluhan fisik" })[item]).join(", ") : null]]} />
        <div className="homecare-nurse-observations"><h3>Observasi yang dilaporkan</h3>{observations.length ? <ul>{observations.map(observation => <li key={observation.type}>{observation.type}: {observation.value} {observation.unit} · {formatTime(observation.observedAt)}</li>)}</ul> : <p>Belum dicatat; bukan hasil normal.</p>}</div>
        <StaticFields className="screening-history" entries={[["Catatan untuk perawat", intake.note]]} />
        <p className="secondary-text">Persetujuan pasien untuk berbagi intake: {intake.consent ? "Ya" : "Tidak"}.</p>
      </> : <p>Intake tidak tersedia pada snapshot yang diizinkan server.</p>}
    </div></section>
  </>;
}

async function safeWrite(writer: HomecareWriteController, operation: Parameters<HomecareWriteController["send"]>[0]) {
  try { await writer.send(operation); } catch { /* Retained state is rendered to the nurse. */ }
}
function BookingDecision({ booking, onVerified }: { booking: HomecareBooking; onVerified: (booking: HomecareBooking) => void }) {
  const { homecareWrites } = useNurseWorkspace();
  const [writer] = useState(() => homecareWrites.writer());
  const state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const [decision, setDecision] = useState<"accept" | "reject">("accept"), [reason, setReason] = useState(""), [error, setError] = useState<string | null>(null);
  const locked = state.status === "sending" || state.status === "uncertain";
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (locked || booking.status !== "submitted" || (decision === "reject" && !reason.trim())) { setError("Alasan penolakan wajib diisi."); return; }
    const operation = prepareNurseBookingDecision(booking, { decision, reason: reason.trim() || null });
    writer.reset(); await safeWrite(writer, operation);
    const result = freshResult<HomecareBooking>(writer); if (result) onVerified(result);
  }
  if (booking.status !== "submitted" && state.status === "idle") return <div className={`decision-result decision-result-${booking.status}`}>{booking.status === "accepted" ? <Check size={26} aria-hidden="true" /> : <X size={26} aria-hidden="true" />}<div><h3>Pengajuan {nurseBookingStatusLabels[booking.status].toLowerCase()}</h3><p>{booking.decisionReason ?? `Status server: ${nurseBookingStatusLabels[booking.status]}.`}</p><Link className="text-button" href="/pengajuan-homecare">Kembali ke Pengajuan</Link></div></div>;
  return <><p>Periksa data pasien, lalu terima atau tolak pengajuan ini. Penolakan wajib disertai alasan.</p><form onSubmit={event => void submit(event)} className={`homecare-nurse-form${decision === "reject" ? " rejection-form" : ""}`}>
    {decision === "reject" ? <label htmlFor="rejection-reason">Alasan penolakan <span aria-hidden="true">*</span><textarea id="rejection-reason" required maxLength={4000} rows={3} disabled={locked} value={reason} onChange={event => setReason(event.target.value)} autoFocus placeholder="Tuliskan alasan pengajuan ditolak" /></label> : <details><summary>Tambahkan alasan penerimaan (opsional)</summary><label className="sr-only" htmlFor="acceptance-reason">Alasan penerimaan</label><textarea id="acceptance-reason" maxLength={4000} rows={3} disabled={locked} value={reason} onChange={event => setReason(event.target.value)} /></details>}
    {error && <p role="alert">{error}</p>}<HomecareWriteFeedback writer={writer} />
    <div className={decision === "reject" ? "decision-form-actions" : "request-decision-actions"}>{decision === "reject" && <button className="button button-soft" disabled={locked} type="button" onClick={() => setDecision("accept")}>Batal</button>}<button className={`button ${decision === "accept" ? "button-accept" : "button-danger"}`} disabled={locked || (decision === "reject" && !reason.trim())} type="submit" title={`Kirim keputusan versi ${booking.version}`}>{decision === "accept" ? "Terima pengajuan" : "Tolak pengajuan"}</button>{decision === "accept" && <button className="button button-danger-outline" disabled={locked} type="button" onClick={() => setDecision("reject")}>Tolak pengajuan</button>}</div>
  </form></>;
}
function BookingCancellation({ booking, onVerified }: { booking: HomecareBooking; onVerified: (booking: HomecareBooking) => void }) {
  const { homecareWrites } = useNurseWorkspace();
  const [writer] = useState(() => homecareWrites.writer()), state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const [reason, setReason] = useState(""), [open, setOpen] = useState(false);
  const locked = state.status === "sending" || state.status === "uncertain";
  if (!isBeforeStart(booking) && state.status === "idle") return null;
  async function cancel(event: FormEvent) {
    event.preventDefault(); if (locked || !reason.trim()) return;
    const operation = prepareNurseBookingCancellation(booking, reason.trim()); writer.reset(); await safeWrite(writer, operation);
    const result = freshResult<HomecareBooking>(writer); if (result) onVerified(result);
  }
  return <>{!open && state.status === "idle" ? <button type="button" className="button button-danger-outline" onClick={() => setOpen(true)}>Batalkan kunjungan atau pengajuan</button> : <form className="homecare-nurse-form" onSubmit={event => void cancel(event)}><label>Alasan pembatalan (wajib)<textarea rows={3} required maxLength={4000} disabled={locked} value={reason} onChange={event => setReason(event.target.value)} /></label><HomecareWriteFeedback writer={writer} /><button className="button button-danger" type="submit" disabled={locked || !reason.trim()}>Konfirmasi pembatalan</button></form>}</>;
}

export type NurseRescheduleTarget = { slotId: string | null; startsAt: string; endsAt: string };
function SlotChoice({ booking, onChosen }: { booking: HomecareBooking; onChosen: (target: NurseRescheduleTarget | null) => void }) {
  const { homecare } = useNurseWorkspace();
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [range, setRange] = useState<{ from: string; to: string } | null>(null), [error, setError] = useState<string | null>(null);
  const loader = useCallback(async (signal: AbortSignal) => {
    if (!range) return null;
    const [slotPage, request] = await Promise.all([
      homecare.slots(booking.nurseId, { from: range.from, to: range.to }, signal),
      booking.priorityRequestId ? homecare.priorityRequest(booking.priorityRequestId, signal).catch(error => { if (asApiError(error).status === 404) return null; throw error; }) : Promise.resolve(null),
    ]);
    return { slots: slotPage, approved: request?.status === "availability_accepted" && request.bookingId === booking.id && request.nurseId === booking.nurseId && request.startsAt >= range.from && request.endsAt <= range.to && Date.parse(request.startsAt) > Date.now() ? request : null };
  }, [homecare, booking.id, booking.nurseId, booking.priorityRequestId, range]);
  const slots = useNurseRead(loader);
  function lookup(event: FormEvent) {
    event.preventDefault(); setError(null); onChosen(null);
    try {
      const start = new Date(from).toISOString(), end = new Date(to).toISOString();
      if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 31 * 86400000) throw new Error();
      setRange({ from: start, to: end });
    } catch { setError("Isi awal dan akhir interval pencarian UTC yang benar (maksimal 31 hari)."); }
  }
  return <div className="homecare-nurse-slot-picker"><form onSubmit={lookup} className="homecare-nurse-inline-form"><label>Awal pencarian (UTC)<input required type="datetime-local" step={1} value={from} onChange={event => setFrom(event.target.value)} /></label><label>Akhir pencarian (UTC)<input required type="datetime-local" step={1} value={to} onChange={event => setTo(event.target.value)} /></label><button className="button button-outline" type="submit">Cari slot server</button></form>
    {error && <p role="alert">{error}</p>}
    {range && <ReadPanel state={slots.state} reload={slots.reload}>{data => data && <>
      <p>Zona waktu konfigurasi: {data.slots.timeZone ?? "Belum dikonfigurasi"}. Semua pilihan dikirim dalam UTC.</p>
      {data.approved && <label className="homecare-nurse-attestation"><input type="radio" name={`slot-${booking.id}`} onChange={() => onChosen({ slotId: null, startsAt: data.approved!.startsAt, endsAt: data.approved!.endsAt })} />Gunakan pengecualian {data.approved.id}: {formatTime(data.approved.startsAt)} — {formatTime(data.approved.endsAt)}</label>}
      {data.slots.items.length ? <div className="homecare-nurse-slot-list" role="radiogroup" aria-label="Slot server yang tersedia">{data.slots.items.map(slot => <label key={slot.id}><input type="radio" name={`slot-${booking.id}`} onChange={() => onChosen({ slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt })} /><span>{formatTime(slot.startsAt)} — {formatTime(slot.endsAt)}</span><small>Versi ketersediaan {slot.availabilityVersion} · ID {slot.id}</small></label>)}</div> : !data.approved && <p className="empty-state">Tidak ada slot server yang tersedia pada interval ini.</p>}
      {data.slots.page.nextCursor && <NextPageButton label="Muat slot berikutnya" onClick={async () => {
        if (!range) return;
        const next = await homecare.slots(booking.nurseId, { ...range, cursor: data.slots.page.nextCursor });
        const merged: AvailabilitySlots = { ...next, items: [...data.slots.items, ...next.items] };
        slots.resource.load(async signal => {
          if (signal.aborted) throw new DOMException("Dibatalkan", "AbortError");
          return { ...data, slots: merged };
        });
      }} />}
    </>}</ReadPanel>}
  </div>;
}
export function isNurseRescheduleTimely(booking: HomecareBooking, target: NurseRescheduleTarget, now: number): boolean {
  return booking.status === "accepted" && Date.parse(booking.startsAt) > now && Date.parse(target.startsAt) > now;
}

function BookingReschedule({ booking, onVerified }: { booking: HomecareBooking; onVerified: (booking: HomecareBooking) => void }) {
  const { homecareWrites } = useNurseWorkspace();
  const [writer] = useState(() => homecareWrites.writer()), state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const [chosen, setChosen] = useState<NurseRescheduleTarget | null>(null), [reason, setReason] = useState(""), [agreed, setAgreed] = useState(false), [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null);
  const [renderTime] = useState(() => Date.now());
  const locked = state.status === "sending" || state.status === "uncertain";
  if (booking.status !== "accepted" || Date.parse(booking.startsAt) <= renderTime) return null;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (!chosen || !reason.trim() || !agreed || locked) { setError("Pilih slot atau pengecualian, isi alasan, dan konfirmasi persetujuan pasien."); return; }
    if (!isNurseRescheduleTimely(booking, chosen, Date.now())) { setError("Jadwal saat ini atau jadwal pengganti sudah dimulai. Muat ulang snapshot dan pilih jadwal yang masih berlaku."); return; }
    const operation = prepareNurseBookingReschedule(booking, { slotId: chosen.slotId, startsAt: chosen.startsAt, endsAt: chosen.endsAt, reason: reason.trim(), patientAgreed: true });
    writer.reset(); await safeWrite(writer, operation);
    const result = freshResult<HomecareBooking>(writer); if (result) onVerified(result);
  }
  return <section className="homecare-nurse-reschedule"><h3>Ubah jadwal oleh perawat yang sama</h3><p>Jadwal saat ini harus belum dimulai. Perawat tidak berubah. Server memeriksa ulang slot, konflik, dan pengecualian sebelum mengubah ID kunjungan yang sama.</p>
    {!open && state.status === "idle" ? <button className="button button-outline" type="button" onClick={() => { writer.reset(); setOpen(true); }}>Pilih jadwal pengganti</button> : <form className="homecare-nurse-form" onSubmit={event => void submit(event)}><SlotChoice key={booking.id} booking={booking} onChosen={setChosen} />
      {chosen && <p className="homecare-nurse-selection">Dipilih: {formatTime(chosen.startsAt)} — {formatTime(chosen.endsAt)} · {chosen.slotId ? `slot ${chosen.slotId}` : "pengecualian yang disetujui"}</p>}
      <label>Alasan perubahan jadwal (wajib)<textarea required maxLength={4000} rows={3} disabled={locked} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <label className="homecare-nurse-attestation"><input type="checkbox" disabled={locked} checked={agreed} onChange={event => setAgreed(event.target.checked)} />Saya telah memperoleh persetujuan pasien untuk interval pengganti ini.</label>
      {error && <p role="alert">{error}</p>}<HomecareWriteFeedback writer={writer} /><button className="button button-primary" disabled={locked || !chosen || !agreed || !reason.trim()} type="submit">Kirim perubahan jadwal versi {booking.version}</button>
    </form>}
  </section>;
}

function CareGuide({ booking }: { booking: HomecareBooking }) {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => homecare.careGuide(booking.id, signal), [homecare, booking.id]);
  const guide = useNurseRead(loader);
  return <section className="card live-card homecare-nurse-guide" aria-labelledby="care-guide-title"><h2 id="care-guide-title">Panduan perawatan aktif</h2><p>Hanya proyeksi panduan/order aktif untuk kunjungan ini. Bukan rekam medis utama atau dokumentasi kunjungan.</p>
    <ReadPanel state={guide.state} reload={guide.reload}>{data => <CareGuideContent guide={data} />}</ReadPanel>
  </section>;
}
export function CareGuideContent({ guide }: { guide: HomecareCareGuide }) {
  return <>{guide.orders.length === 0 && <p>Belum ada instruksi aktif yang dapat ditampilkan.</p>}{guide.orders.map(order => <article key={order.id}><h3>Instruksi · revisi {order.revisionNumber}</h3><p className="live-prewrap">{order.instructions}</p>{order.items && <ol>{order.items.map((item, index) => <li key={index}>{item.text}</li>)}</ol>}<small className="secondary-text">Sumber {order.sourceDocumentId} · versi {order.sourceVersion}</small></article>)}{guide.sources.map(source => <details key={source.id}><summary>{source.title} · revisi {source.revisionNumber}</summary><p className="live-prewrap">{source.body}</p></details>)}</>;
}

function PriorityReviewControls({ request }: { request: PriorityRequest }) {
  const { homecareWrites } = useNurseWorkspace();
  const [writer] = useState(() => homecareWrites.writer()), state = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const [available, setAvailable] = useState(false), [decision, setDecision] = useState<"accept_availability" | "decline">("accept_availability"), [reason, setReason] = useState(""), [error, setError] = useState<string | null>(null);
  const locked = state.status === "sending" || state.status === "uncertain";
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (locked || request.status !== "pending" || !reason.trim() || available !== (decision === "accept_availability")) { setError("Pilih keputusan yang sesuai dengan konfirmasi ketersediaan dan isi alasan."); return; }
    const operation = preparePriorityRequestReview(request, { decision, reason: reason.trim(), available }); writer.reset(); await safeWrite(writer, operation);
  }
  return <article className="homecare-nurse-priority-detail"><NursePriorityReviewFields request={request} />
    {request.status === "pending" || state.status !== "idle" ? <form className="homecare-nurse-form" onSubmit={event => void submit(event)}><label>Keputusan tinjauan<select disabled={locked} value={decision} onChange={event => { const value = event.target.value as "accept_availability" | "decline"; setDecision(value); setAvailable(value === "accept_availability"); }}><option value="accept_availability">Konfirmasi tersedia untuk interval ini</option><option value="decline">Tolak permintaan ketersediaan</option></select></label>
      <label className="homecare-nurse-attestation"><input type="checkbox" disabled={locked} checked={available} onChange={event => { setAvailable(event.target.checked); setDecision(event.target.checked ? "accept_availability" : "decline"); }} />Saya benar-benar tersedia untuk interval persis di atas {decision === "decline" ? "(harus tidak dicentang saat menolak)" : "(wajib dicentang)"}.</label>
      <label>Alasan tinjauan (wajib)<textarea required maxLength={4000} rows={3} disabled={locked} value={reason} onChange={event => setReason(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<HomecareWriteFeedback writer={writer} /><button className={`button ${decision === "decline" ? "button-danger" : "button-primary"}`} disabled={locked || !reason.trim() || available !== (decision === "accept_availability")} type="submit">Simpan tinjauan ketersediaan versi {request.version}</button>
    </form> : null}
  </article>;
}

function DetailContent({ request }: { request: HomecareBooking }) {
  const { homecare } = useNurseWorkspace();
  const [booking, setBooking] = useState(request);
  return <><div className="request-detail-heading"><h1>Pengajuan {booking.id}{booking.profileSnapshot ? ` · ${booking.profileSnapshot.fullName}` : ""}</h1><div className="request-detail-meta"><p>Dibuat {formatTime(booking.createdAt)} · diperbarui {formatTime(booking.updatedAt)}</p><span className={`request-status request-status-${statusClass(booking.status)}`}>{nurseBookingStatusLabels[booking.status]}</span><span>Versi {booking.version}</span></div></div>
    <div className="request-detail-grid"><div className="request-detail-left"><NurseBookingSnapshot booking={booking} />
      <section className="card request-decision-card" aria-labelledby="decision-title"><div className="section-header teal-header"><h2 id="decision-title">Keputusan perawat</h2></div><div className="request-decision-body"><BookingDecision key={`${booking.id}-${booking.version}-${booking.status}`} booking={booking} onVerified={setBooking} /></div></section>
    </div><aside className="request-detail-sidebar" aria-label="Jadwal dan tindakan kunjungan">
      <section className="request-risk-card" aria-labelledby="risk-title"><div className="section-header attention-header"><h2 id="risk-title">Ringkasan risiko</h2></div><div className="request-risk-body"><span className="risk-badge risk-unknown">Belum tersedia</span><p>Ringkasan risiko belum tersedia dari layanan. Data screening di samping adalah laporan pasien, bukan penilaian risiko klinis.</p></div></section>
      <section className="card request-schedule-card"><div className="section-header teal-header"><h2>Jadwal diminta</h2></div><StaticFields className="requested-schedule-fields" entries={[["Tanggal", new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "UTC" }).format(new Date(booking.startsAt))], ["Jam (UTC)", new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: "UTC" }).format(new Date(booking.startsAt)) + " — " + new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: "UTC" }).format(new Date(booking.endsAt))], ["Dokter", "Tidak tersedia"]]} /><div className="homecare-nurse-card-actions"><details><summary>Rincian dan tindakan kunjungan</summary><StaticFields entries={[["ID kunjungan", booking.visitId], ["ID slot", booking.slotId], ["Perawat", booking.nurse.displayName]]} /><BookingCancellation key={`${booking.id}-${booking.version}-cancel`} booking={booking} onVerified={setBooking} /><BookingReschedule key={`${booking.id}-${booking.version}-reschedule`} booking={booking} onVerified={setBooking} /></details></div></section>
      {booking.status === "accepted" && booking.visitId && <CareGuide key={booking.id} booking={booking} />}
      <section className="card live-card"><h2>Riwayat tindakan server</h2>{booking.events.length ? <ol className="homecare-nurse-events">{booking.events.map(event => <li key={event.id}><strong>{event.action} · versi {event.version}</strong><span>{formatTime(event.createdAt)}</span>{event.reason && <p>{event.reason}</p>}<small>Peristiwa {event.id}</small></li>)}</ol> : <p>Belum ada peristiwa yang ditampilkan.</p>}</section>
      <button type="button" className="button button-outline" onClick={() => void homecare.booking(booking.id).then(setBooking)}>Baca ulang snapshot</button>
    </aside></div><div className="homecare-nurse-help"><p>Akses snapshot ditentukan oleh server dan dapat berakhir setelah kunjungan atau keputusan terminal.</p><p>{immediateHelp}</p></div></>;
}
export function NursePriorityRequestContent({ request, fallbackBookingId }: { request: PriorityRequest; fallbackBookingId: string }) {
  if (request.bookingId !== fallbackBookingId) return <p role="alert">Permintaan ketersediaan ini terkait dengan pengajuan lain dan tidak ditampilkan pada halaman ini.</p>;
  return <><div className="request-detail-heading"><h1>Tinjauan ketersediaan {request.id}</h1><div className="request-detail-meta"><p>Dibuat {formatTime(request.createdAt)}</p><span className={`request-status request-status-${request.status === "pending" ? "pending" : request.status === "declined" ? "rejected" : "accepted"}`}>{priorityStatusLabels[request.status]}</span><span>Versi {request.version}</span></div></div>
    <div className="homecare-nurse-help"><p>Hanya permintaan ketersediaan yang dapat dibaca di sini. Intake, kontak, dan draf pribadi pasien tidak dimuat.</p><p>{immediateHelp}</p></div>
    <div className="request-detail-grid"><section className="card live-card" aria-label="Tinjauan ketersediaan terpisah"><PriorityReviewControls key={`${request.id}-${request.version}`} request={request} /></section></div>
  </>;
}
export function NursePriorityReviewFields({ request }: { request: PriorityRequest }) {
  return <><h2>Tinjauan ketersediaan {request.id}</h2><StaticFields entries={[["Pasien", request.patient?.displayName ?? noIdentity], ["Nomor RM", request.patient?.recordNumber], ["Interval persis (UTC)", `${formatTime(request.startsAt)} — ${formatTime(request.endsAt)}`], ["Pernyataan pasien", request.statement], ["Status", priorityStatusLabels[request.status]], ["Alasan tinjauan", request.reason]]} />
    <p>Persetujuan hanya menyatakan Anda tersedia untuk interval persis ini. Ini tidak mengirim atau menerima pemesanan; pasien tetap mengirim pengajuan dan Anda harus menerimanya secara terpisah.</p>
  </>;
}
export async function readNurseRequest(homecare: Pick<HomecareApi, "booking" | "priorityRequest">, requestId: string, priorityId: string | null, signal: AbortSignal): Promise<HomecareBooking | PriorityRequest> {
  if (!priorityId) return homecare.booking(requestId, signal);
  const request = await homecare.priorityRequest(priorityId, signal);
  if (request.bookingId !== requestId) throw new Error("Permintaan ketersediaan ini terkait dengan pengajuan lain.");
  return request;
}
export function LiveHomecareNurseRequestDetail({ requestId, priorityId = null }: { requestId: string; priorityId?: string | null }) {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => readNurseRequest(homecare, requestId, priorityId, signal), [homecare, requestId, priorityId]);
  const read = useNurseRead(loader);
  return <><NurseHeader activePage="requests" /><main id="konten-utama" className="dashboard-main homecare-detail-main homecare-nurse-main"><Link href="/pengajuan-homecare" className="back-to-requests"><ArrowLeft size={16} aria-hidden="true" />Kembali ke Pengajuan</Link>
    <ReadPanel state={read.state} reload={read.reload}>{request => priorityId && "bookingId" in request
      ? <NursePriorityRequestContent request={request} fallbackBookingId={requestId} />
      : !priorityId && !("bookingId" in request) ? <DetailContent key={`${request.id}-${request.version}`} request={request} />
      : <p role="alert">Tautan tidak sesuai dengan jenis pengajuan yang diminta.</p>}</ReadPanel>
  </main></>;
}

const scheduleTabs = [{ value: "visits", label: "Mendatang" }, { value: "done", label: "Selesai" }, { value: "all", label: "Semua" }, { value: "availability", label: "Atur ketersediaan" }] as const;
type ScheduleTab = typeof scheduleTabs[number]["value"];
function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number, select: (tab: ScheduleTab) => void, refs: RefObject<(HTMLButtonElement | null)[]>) {
  let next: number;
  if (event.key === "ArrowRight") next = (index + 1) % scheduleTabs.length;
  else if (event.key === "ArrowLeft") next = (index + scheduleTabs.length - 1) % scheduleTabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = scheduleTabs.length - 1;
  else return;
  event.preventDefault(); select(scheduleTabs[next].value); refs.current[next]?.focus();
}
export function NurseScheduleRows({ bookings, tab = "all" }: { bookings: HomecareBooking[]; tab?: "visits" | "done" | "all" }) {
  const today = new Date().toISOString().slice(0, 10);
  const accepted = bookings.filter(booking => booking.status === "accepted" && booking.visitId && (tab !== "visits" || booking.startsAt.slice(0, 10) >= today)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  if (tab === "done" || !accepted.length) return <div className="card empty-state schedule-empty"><CalendarDays size={32} aria-hidden="true" /><h2>{tab === "done" ? "Riwayat kunjungan selesai belum tersedia" : "Belum ada kunjungan"}</h2><p>{tab === "done" ? "Layanan jadwal hanya menyediakan pengajuan yang diterima. Waktu yang telah berlalu tidak berarti kunjungan sudah selesai." : "Jadwal kunjungan yang diterima akan ditampilkan di sini."}</p></div>;
  const pastDates = [...new Set(accepted.filter(booking => booking.startsAt.slice(0, 10) < today).map(booking => booking.startsAt.slice(0, 10)))].sort().reverse();
  const groups = [
    { id: "today", title: `${new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${today}T00:00:00Z`))} · hari ini (UTC)`, items: accepted.filter(booking => booking.startsAt.slice(0, 10) === today) },
    { id: "upcoming", title: "Mendatang", items: accepted.filter(booking => booking.startsAt.slice(0, 10) > today) },
    ...pastDates.map(date => ({ id: `past-${date}`, title: `${new Intl.DateTimeFormat("id-ID", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`))} (UTC)`, items: accepted.filter(booking => booking.startsAt.slice(0, 10) === date) })),
  ];
  return <>{groups.filter(group => group.items.length).map(group => <section className="card schedule-group" key={group.id} aria-labelledby={`schedule-${group.id}-title`}><div className={`section-header schedule-${group.id.startsWith("past-") ? "past" : group.id}-header`}><h2 id={`schedule-${group.id}-title`}>{group.title}</h2></div><ul className="homecare-nurse-schedule-list">{group.items.map(booking => <li className="schedule-page-row" key={booking.visitId}><div className="schedule-page-patient"><strong>{group.id === "upcoming" ? `${formatTime(booking.startsAt)}` : `${new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: "UTC" }).format(new Date(booking.startsAt))} UTC · ${identity(booking)}`}</strong><span className="secondary-text">{group.id === "upcoming" ? `${identity(booking)} · ${recordNumber(booking)}` : recordNumber(booking)}</span></div><span className="schedule-status schedule-status-scheduled">Terjadwal</span><Link className="button button-primary button-small schedule-row-action" href={`/pengajuan-homecare/${booking.id}`} aria-label={`Buka konteks kunjungan ${identity(booking)}`} title={`ID kunjungan ${booking.visitId} · ID pengajuan ${booking.id}`}>Buka kunjungan</Link></li>)}</ul></section>)}</>;
}
export function readNurseVisitSchedule(homecare: Pick<HomecareApi, "bookings">, signal: AbortSignal, cursor?: string | null): Promise<Page<HomecareBooking>> {
  return homecare.bookings({ status: "accepted", cursor }, signal);
}
function VisitSchedule({ tab }: { tab: "visits" | "done" | "all" }) {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => readNurseVisitSchedule(homecare, signal), [homecare]);
  const visits = useNurseRead(loader);
  return <ReadPanel state={visits.state} reload={visits.reload}>{data => <><NurseScheduleRows bookings={data.items} tab={tab} />{data.page.nextCursor && <NextPageButton label="Muat kunjungan berikutnya" onClick={() => loadFollowingPages(visits.resource, data, signal => readNurseVisitSchedule(homecare, signal, data.page.nextCursor))} />}</>}</ReadPanel>;
}
export function emptyAvailabilityDraft(): AvailabilityInput {
  return { timeZone: "", slotMinutes: 0, bufferMinutes: 0, effectiveFrom: "", effectiveTo: "", windows: [], slots: [] };
}
export function availabilityDraft(current: Availability["current"]): AvailabilityInput {
  return current ? { timeZone: current.timeZone, slotMinutes: current.slotMinutes, bufferMinutes: current.bufferMinutes, effectiveFrom: current.effectiveFrom, effectiveTo: current.effectiveTo, windows: current.windows.map(window => ({ ...window })), slots: current.slots.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })) } : emptyAvailabilityDraft();
}
function AvailabilityEditor({ current, onPublished }: { current: Availability; onPublished: (result: Availability) => void }) {
  const { homecareWrites } = useNurseWorkspace();
  const [writer] = useState(() => homecareWrites.writer()), write = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const retained = write.status !== "idle" && write.operation.kind === "availability-put" ? JSON.parse(write.operation.intent.body) as AvailabilityInput & { expectedVersion: number } : null;
  const [draft, setDraft] = useState<AvailabilityInput>(() => retained ?? availabilityDraft(current.current));
  const [windows, setWindows] = useState(() => JSON.stringify(draft.windows, null, 2)), [slots, setSlots] = useState(() => JSON.stringify(draft.slots, null, 2));
  const [error, setError] = useState<string | null>(null), [reviewing, setReviewing] = useState(write.status !== "idle"), [parsed, setParsed] = useState<AvailabilityInput | null>(null);
  const locked = write.status === "sending" || write.status === "uncertain";
  function parse() {
    const windowsValue = JSON.parse(windows) as unknown, slotsValue = JSON.parse(slots) as unknown;
    const input: AvailabilityInput = { timeZone: draft.timeZone, slotMinutes: draft.slotMinutes, bufferMinutes: draft.bufferMinutes, effectiveFrom: draft.effectiveFrom.trim() ? new Date(draft.effectiveFrom).toISOString() : "", effectiveTo: draft.effectiveTo.trim() ? new Date(draft.effectiveTo).toISOString() : "", windows: windowsValue as AvailabilityInput["windows"], slots: slotsValue as AvailabilityInput["slots"] };
    return input;
  }
  function review(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (locked) return;
    try { const input = parse(); writer.reset(); setParsed(input); setReviewing(true); }
    catch { setError("Periksa JSON windows/slots, zona IANA, durasi, buffer, dan waktu UTC. Format waktu harus dapat dikonversi menjadi ISO UTC."); }
  }
  async function publish() {
    if (!parsed || locked) return;
    try {
      const operation = prepareAvailabilityWrite(current, parsed); await safeWrite(writer, operation);
      const result = freshResult<Availability>(writer); if (result) onPublished(result);
    } catch { setError("Konfigurasi ditolak validasi klien. Periksa versi, zona IANA, panjang interval, windows, dan maksimal 200 slot."); }
  }
  return <><div className="homecare-nurse-help"><p>Versi server saat ini: {current.version}. Versi dan slot bersifat immutable; publikasi selalu membuat versi baru setelah tinjauan.</p><p>Tidak ada jam kerja, zona waktu, durasi, buffer, atau slot produksi bawaan. Slot harus UTC eksplisit dan merupakan bagian dari window sesuai aturan server.</p></div>
    {current.current && <details className="homecare-nurse-current-version"><summary>Konfigurasi server versi {current.version}</summary><StaticFields entries={[["Zona waktu", current.current.timeZone], ["Durasi slot", `${current.current.slotMinutes} menit`], ["Buffer sesudah slot", `${current.current.bufferMinutes} menit`], ["Berlaku (UTC)", `${formatTime(current.current.effectiveFrom)} — ${formatTime(current.current.effectiveTo)}`], ["Jumlah windows", String(current.current.windows.length)], ["Jumlah slot", String(current.current.slots.length)]]} /></details>}
    <form className="homecare-nurse-form" onSubmit={review}><div className="homecare-nurse-settings-grid">
      <label>Zona waktu IANA<input required maxLength={100} disabled={locked} value={draft.timeZone} placeholder="Contoh format: Asia/Jakarta" onChange={event => { setDraft({ ...draft, timeZone: event.target.value }); setReviewing(false); }} /></label>
      <label>Durasi slot (menit)<input required type="number" min={1} max={480} disabled={locked} value={draft.slotMinutes || ""} onChange={event => { setDraft({ ...draft, slotMinutes: Number(event.target.value) }); setReviewing(false); }} /></label>
      <label>Buffer setelah slot (menit)<input required type="number" min={0} max={120} disabled={locked} value={Number.isFinite(draft.bufferMinutes) ? draft.bufferMinutes : ""} onChange={event => { setDraft({ ...draft, bufferMinutes: Number(event.target.value) }); setReviewing(false); }} /></label>
      <label>Berlaku dari (UTC)<input required type="datetime-local" step={1} disabled={locked} value={draft.effectiveFrom} onChange={event => { setDraft({ ...draft, effectiveFrom: event.target.value }); setReviewing(false); }} /></label>
      <label>Berlaku sampai (UTC)<input required type="datetime-local" step={1} disabled={locked} value={draft.effectiveTo} onChange={event => { setDraft({ ...draft, effectiveTo: event.target.value }); setReviewing(false); }} /></label>
    </div><label>Windows kerja (JSON)<textarea className="homecare-nurse-json" required rows={7} spellCheck={false} disabled={locked} value={windows} onChange={event => { setWindows(event.target.value); setReviewing(false); }} aria-describedby="availability-windows-help" /></label><small id="availability-windows-help">Array maksimum format {`[{"weekday":1,"startMinute":540,"endMinute":1020}]`}; weekday 1=Senin sampai 7=Minggu. Array kosong [] diperbolehkan bila memang belum ada jam kerja.</small>
      <label>Slot UTC eksplisit (JSON)<textarea className="homecare-nurse-json" required rows={10} spellCheck={false} disabled={locked} value={slots} onChange={event => { setSlots(event.target.value); setReviewing(false); }} aria-describedby="availability-slots-help" /></label><small id="availability-slots-help">Maksimal 200 objek {`{"startsAt":"YYYY-MM-DDTHH:mm:ss.SSSZ","endsAt":"YYYY-MM-DDTHH:mm:ss.SSSZ"}`}. Sistem tidak membuat slot otomatis atau menebak konversi zona/DST.</small>
      {error && <p role="alert">{error}</p>}<button className="button button-outline" disabled={locked} type="submit">Tinjau konfigurasi baru</button>
    </form>
    {reviewing && <section className="homecare-nurse-review" aria-labelledby="availability-review-title"><h3 id="availability-review-title">Tinjau sebelum publikasi</h3>{parsed ? <><StaticFields entries={[["Zona", parsed.timeZone], ["Durasi / buffer", `${parsed.slotMinutes} / ${parsed.bufferMinutes} menit`], ["Efektif", `${parsed.effectiveFrom} — ${parsed.effectiveTo}`], ["Windows / slot", `${parsed.windows.length} / ${parsed.slots.length}`]]} /><button type="button" className="button button-primary" disabled={locked} onClick={() => void publish()}>Publikasikan versi setelah {current.version}</button></> : <p>Tinjau isian tersimpan dari tindakan sebelumnya. Hasil tetap harus diverifikasi server.</p>}</section>}
    <HomecareWriteFeedback writer={writer} />
  </>;
}
function AvailabilityPanel() {
  const { homecare } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => homecare.availability(signal), [homecare]);
  const current = useNurseRead(loader);
  const [published, setPublished] = useState<Availability | null>(null);
  return <section className="card live-card" aria-labelledby="availability-editor-title"><div className="homecare-nurse-section-heading"><div><h2 id="availability-editor-title">Ketersediaan saya</h2><p>Konfigurasi penuh berdasarkan versi terakhir dari server.</p></div><button type="button" className="button button-outline" onClick={() => { setPublished(null); void current.reload(); }}>Muat ulang versi</button></div>
    {published ? <AvailabilityEditor key={published.version} current={published} onPublished={setPublished} /> : <ReadPanel state={current.state} reload={current.reload}>{data => <AvailabilityEditor key={`${data.nurseId}-${data.version}`} current={data} onPublished={setPublished} />}</ReadPanel>}
  </section>;
}
export function LiveHomecareNurseSchedule() {
  const [tab, setTab] = useState<ScheduleTab>("visits"), refs = useRef<(HTMLButtonElement | null)[]>([]);
  return <><NurseHeader activePage="visits" /><main id="konten-utama" className="dashboard-main visit-schedule-main homecare-nurse-main"><div className="page-heading"><h1>Jadwal Kunjungan</h1><p>Kunjungan yang akan dan sudah Anda lakukan</p></div>
    <div className="visit-tabs" role="tablist" aria-label="Jadwal dan ketersediaan">{scheduleTabs.map((item, index) => <button key={item.value} ref={element => { refs.current[index] = element; }} role="tab" id={`schedule-tab-${item.value}`} aria-selected={tab === item.value} aria-controls={`schedule-panel-${item.value}`} tabIndex={tab === item.value ? 0 : -1} className={`visit-tab${tab === item.value ? " is-selected" : ""}`} onClick={() => setTab(item.value)} onKeyDown={event => navigateTabs(event, index, setTab, refs)}>{item.label}</button>)}</div>
    <div className="schedule-groups" role="tabpanel" id={`schedule-panel-${tab}`} aria-labelledby={`schedule-tab-${tab}`} tabIndex={0}>{tab === "availability" ? <AvailabilityPanel /> : <VisitSchedule tab={tab} />}</div>
  </main></>;
}
