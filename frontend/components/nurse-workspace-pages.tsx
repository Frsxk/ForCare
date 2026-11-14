"use client";

import Link from "next/link";
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Bell, CalendarCheck, CalendarDays, CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck, ClipboardClock, Search, ShieldCheck, TriangleAlert, UsersRound } from "lucide-react";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseProfile, useNurseRead, useNurseWorkspace } from "@/components/nurse-workspace-provider";
import type { ResourceState } from "@/lib/api/scoped-resource";
import type { ApiError } from "@/lib/api/client";
import { PatientAnalysisPanel } from "@/components/patient-analysis";
import { MedicalSnapshotPanel } from "@/components/medical-snapshot-panel";
import { Avatar } from "@/components/patient-identity";
import { SessionActions } from "@/components/session-actions";
export { SnapshotView } from "@/components/medical-snapshot-panel";
import { createNurseApi, type NurseProfile, type PatientList } from "@/lib/api/nurse";
import type { HomecareBooking, Page } from "@/lib/api/homecare";
import "./patient-directory.css";
import "./patient-record.css";
import "./nurse-profile.css";
import "./nurse-notifications.css";
import "./risk-monitoring.css";
import "./visit-record.css";
import "./nurse-workspace.css";

type NurseApi = ReturnType<typeof createNurseApi>;
export function ReadError({ error, retry }: { error: ApiError; retry: () => void }) {
  return <div className="live-feedback" role="alert"><p>{error.message}</p>{error.requestId && <small>Referensi permintaan: {error.requestId}</small>}{error.retryAfterSeconds !== undefined && <p>Coba lagi setelah {error.retryAfterSeconds} detik.</p>}<button className="button button-outline" onClick={retry}>Muat ulang</button></div>;
}
export function ReadPanel<T>({ state, reload, children }: { state: ResourceState<T>; reload: () => void; children: (data: T) => ReactNode }) {
  if (state.status === "error") return <ReadError error={state.error} retry={reload} />;
  if (state.status !== "ready") return <p className="live-feedback" role="status">Memuat data dari server…</p>;
  return children(state.data);
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]).join(""); }
function RecordCard({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return <section className={`card patient-record-card ${className}`}><div className="patient-record-card-heading"><h2>{title}</h2></div>{children}</section>;
}
function Tabs({ items, selected, onSelect, prefix, className, label }: { items: readonly string[]; selected: number; onSelect: (index: number) => void; prefix: string; className: string; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); onSelect(next); refs.current[next]?.focus();
  }
  return <div className={className} role="tablist" aria-label={label}>{items.map((item, index) => <button key={item} ref={element => { refs.current[index] = element; }} type="button" role="tab" id={`${prefix}-tab-${index}`} aria-controls={`${prefix}-panel-${index}`} aria-selected={selected === index} tabIndex={selected === index ? 0 : -1} className={`${className === "nurse-notification-tabs" ? "nurse-notification-tab " : ""}${selected === index ? "is-selected" : ""}`} onClick={() => onSelect(index)} onKeyDown={event => navigate(event, index)}>{item}</button>)}</div>;
}
export function PatientRows({ patients }: { patients: PatientList["items"] }) {
  return <div className="patient-directory-scroll" role="region" aria-label="Pasien penugasan aktif" tabIndex={0}><table className="patient-directory-table">
    <caption className="sr-only">Hanya pasien dalam penugasan aktif Anda. Check-in adalah laporan pasien, bukan penilaian risiko.</caption>
    <colgroup>{["patient", "age", "discharge", "checkin", "risk", "visit", "action"].map(column => <col key={column} className={`pd-col-${column}`} />)}</colgroup>
    <thead><tr><th scope="col">Pasien</th><th scope="col">Usia · JK</th><th scope="col">Keluar RS</th><th scope="col">Check-in terakhir</th><th scope="col">Tingkat risiko</th><th scope="col">Kunjungan berikutnya</th><th scope="col"><span className="sr-only">Tindakan</span></th></tr></thead>
    <tbody>{patients.map(patient => <tr key={patient.id}>
      <td><div className="request-patient"><Avatar initials={initials(patient.displayName)} /><div className="patient-identity"><strong>{patient.displayName}</strong><span className="secondary-text">{patient.recordNumber ?? "Nomor RM belum dicatat"}</span></div></div></td>
      <td>Belum tersedia</td><td>Belum tersedia</td>
      <td>{patient.latestCheckIn ? <><span>{patient.latestCheckIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"}</span><small>{patient.latestCheckIn.localDate ?? "Tanggal belum dicatat"}</small></> : "Belum ada check-in"}</td>
      <td><span className="secondary-text">Belum tersedia</span></td><td>Belum tersedia</td>
      <td><Link className="button button-small patient-record-button" href={`/pasien-rekam-medis/${patient.id}`} aria-label={`Buka rekam medis ${patient.displayName}`}>Buka rekam medis</Link></td>
    </tr>)}</tbody>
  </table>{patients.length === 0 && <div className="empty-state"><Search size={30} aria-hidden="true" /><h2>Belum ada pasien pada daftar ini</h2><p>Hanya pasien yang sedang ditugaskan kepada akun Anda yang ditampilkan.</p></div>}</div>;
}
const dashboardFallbackIdentity = "Identitas di luar izin akses saat ini tidak ditampilkan.";
function dashboardPatient(booking: HomecareBooking) {
  return booking.profileSnapshot?.fullName ?? dashboardFallbackIdentity;
}
function dashboardUtcTime(value: string) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}
function DashboardVisitRow({ booking }: { booking: HomecareBooking }) {
  return <li className="schedule-page-row"><div className="schedule-page-patient"><strong>{dashboardUtcTime(booking.startsAt)}</strong><span className="secondary-text">{dashboardPatient(booking)} · {booking.profileSnapshot?.recordNumber ?? "Nomor RM di luar izin akses"}</span></div><span className="schedule-status schedule-status-scheduled">Diterima</span><Link className="button button-primary button-small schedule-row-action" href={`/pengajuan-homecare/${booking.id}`} aria-label={`Buka kunjungan ${dashboardPatient(booking)}`}>Buka kunjungan</Link></li>;
}
export function NurseDashboardView({ list, pending = null, today = null, upcoming = null }: { list: PatientList; pending?: Page<HomecareBooking> | null; today?: HomecareBooking[] | null; upcoming?: HomecareBooking[] | null }) {
  const loaded = pending !== null && today !== null && upcoming !== null;
  const pendingCount = pending ? `${pending.items.length}${pending.page.hasMore ? "+" : ""}` : "Memuat…";
  const stats = [{ label: "Pasien penugasan aktif", value: `${list.items.length} pasien dimuat`, icon: UsersRound, tone: "cream" }, { label: "Pengajuan menunggu", value: pendingCount, icon: ClipboardClock, tone: "blue" }, { label: "Kunjungan hari ini", value: today ? `${today.length}` : "Memuat…", icon: CalendarCheck, tone: "cream" }, { label: "Kunjungan mendatang", value: upcoming ? `${upcoming.length}` : "Memuat…", icon: CheckCircle2, tone: "blue" }];
  const latestRequests = pending?.items.slice(0, 3) ?? [];
  const nearest = upcoming?.[0] ?? null;
  return <>
    <section className="stats" aria-label="Ringkasan aktivitas perawat">{stats.map(({ label, value, icon: Icon, tone }) => <div className="stat" key={label}><span className={`stat-icon stat-icon-${tone}`}><Icon size={25} strokeWidth={1.9} aria-hidden="true" /></span><div><p className="stat-label">{label}</p><p className={`stat-value${value === "Memuat…" ? " nurse-unavailable-value" : ""}`}>{value}</p></div></div>)}</section>
    {list.page.hasMore && <p className="sr-only">Masih ada halaman berikutnya; jumlah dimuat bukan total seluruh pasien.</p>}
    <section className="card attention-card" aria-labelledby="attention-title"><div className="section-header attention-header"><h2 id="attention-title">Perlu perhatian</h2><span className="ai-badge">Penilaian belum tersedia</span></div><div className="attention-table-wrap" role="region" aria-label="Pasien yang perlu perhatian" tabIndex={0}><table className="attention-table"><colgroup>{["patient", "risk", "reason", "source", "action"].map(column => <col key={column} className={`col-${column}`} />)}</colgroup><thead><tr><th scope="col">Pasien</th><th scope="col">Tingkat risiko</th><th scope="col">Faktor utama</th><th scope="col">Sumber data</th><th scope="col"><span className="sr-only">Tindakan</span></th></tr></thead><tbody><tr><td colSpan={5}><p className="patient-empty">Penilaian risiko klinis belum tersedia pada layanan ini. Daftar penugasan bukan daftar pasien berisiko.</p></td></tr></tbody></table></div></section>
    <div className="dashboard-grid">
      <section className="card requests-card" id="pengajuan" aria-labelledby="requests-title"><div className="section-header teal-header"><h2 id="requests-title">Pengajuan terbaru</h2><Link href="/pengajuan-homecare" className="button button-white button-small">Lihat semua</Link></div>
        {loaded && !latestRequests.length ? <ul className="request-list"><li className="patient-empty">Tidak ada pengajuan yang menunggu keputusan Anda.</li></ul> : !loaded ? <ul className="request-list"><li className="patient-empty">Memuat pengajuan dari server…</li></ul> : <ul className="homecare-nurse-schedule-list">{latestRequests.map(booking => <li className="schedule-page-row" key={booking.id}><div className="schedule-page-patient"><strong>{dashboardPatient(booking)}</strong><span className="secondary-text">{dashboardUtcTime(booking.startsAt)} · {booking.profileSnapshot?.recordNumber ?? "Nomor RM di luar izin akses"}</span></div><span className="request-status request-status-pending">Menunggu keputusan</span><Link className="button button-primary button-small schedule-row-action" href={`/pengajuan-homecare/${booking.id}`} aria-label={`Tinjau pengajuan ${dashboardPatient(booking)}`}>Tinjau</Link></li>)}</ul>}
      </section>
      <section className="card visits-card" aria-labelledby="visits-title"><div className="section-header teal-header"><h2 id="visits-title">Kunjungan hari ini</h2></div>
        {!today ? <ul className="visit-list"><li className="patient-empty">Memuat jadwal dari server…</li></ul> : today.length ? <ul className="homecare-nurse-schedule-list">{today.map(booking => <DashboardVisitRow key={booking.id} booking={booking} />)}</ul> : <ul className="visit-list"><li className="patient-empty">Tidak ada kunjungan terjadwal hari ini (UTC). <Link className="text-button" href="/jadwal-kunjungan">Buka jadwal</Link></li></ul>}
      </section>
      <section className="card upcoming-card" id="jadwal" aria-labelledby="upcoming-title"><div className="section-header mint-header"><h2 id="upcoming-title">Jadwal terdekat</h2></div>
        {!upcoming ? <ul className="upcoming-list"><li className="upcoming-row"><span className="calendar-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><strong>Memuat jadwal dari server…</strong><span className="secondary-text">Hanya kunjungan yang sudah diterima yang ditampilkan.</span></div></li></ul> : nearest ? <ul className="upcoming-list"><li className="upcoming-row"><span className="calendar-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><strong>{dashboardUtcTime(nearest.startsAt)}</strong><span className="secondary-text">{dashboardPatient(nearest)} · {nearest.profileSnapshot?.recordNumber ?? "Nomor RM di luar izin akses"}</span></div><Link className="text-button" href="/jadwal-kunjungan">Buka jadwal</Link></li></ul> : <ul className="upcoming-list"><li className="upcoming-row"><span className="calendar-icon"><CalendarDays size={19} aria-hidden="true" /></span><div><strong>Belum ada kunjungan mendatang</strong><span className="secondary-text">Lihat kunjungan yang diterima pada jadwal.</span></div></li></ul>}
      </section>
    </div>
  </>;
}
export function LiveNurseDashboard() {
  const { api, homecare } = useNurseWorkspace(); const profile = useNurseProfile();
  const loader = useCallback((signal: AbortSignal) => api.patients({}, signal), [api]);
  const list = useNurseRead(loader);
  const pendingLoader = useCallback((signal: AbortSignal) => homecare.bookings({ status: "submitted" }, signal), [homecare]);
  const pending = useNurseRead(pendingLoader);
  const scheduleLoader = useCallback((signal: AbortSignal) => {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    return homecare.schedule({ from: start.toISOString(), to: new Date(start.getTime() + 31 * 24 * 60 * 60_000).toISOString() }, signal);
  }, [homecare]);
  const schedule = useNurseRead(scheduleLoader);
  const todayKey = new Date().toISOString().slice(0, 10), now = Date.now();
  const accepted = schedule.state.status === "ready" ? schedule.state.data.items : null;
  const today = accepted ? accepted.filter(booking => booking.startsAt.slice(0, 10) === todayKey) : null;
  const upcoming = accepted ? accepted.filter(booking => Date.parse(booking.startsAt) > now && booking.startsAt.slice(0, 10) > todayKey) : null;
  return <><NurseHeader activePage="dashboard" /><main id="konten-utama" className="dashboard-main"><section className="welcome" id="beranda" aria-labelledby="welcome-title"><div><h1 id="welcome-title">Selamat datang{profile.status === "ready" ? `, ${profile.data.displayName}` : ""}</h1><p>Ruang kerja perawat · penugasan aktif</p></div><Link className="button button-primary welcome-action" href="/pengajuan-homecare">Tinjau pengajuan</Link></section><ReadPanel state={list.state} reload={list.reload}>{data => <>
    <NurseDashboardView list={data} pending={pending.state.status === "ready" ? pending.state.data : null} today={today} upcoming={upcoming} />
    {pending.state.status === "error" && <ReadError error={pending.state.error} retry={pending.reload} />}
    {schedule.state.status === "error" && <ReadError error={schedule.state.error} retry={schedule.reload} />}
    {schedule.state.status === "ready" && schedule.state.data.page.nextCursor && <p className="patient-empty">Jadwal menampilkan halaman pertama (31 hari ke depan), bukan seluruh riwayat.</p>}
  </>}</ReadPanel></main></>;
}
function DirectoryResults({ search }: { search: string }) {
  const { api } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => api.patients({ search }, signal), [api, search]);
  const list = useNurseRead(loader);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  async function more() {
    if (loadingMore || list.state.status !== "ready" || !list.state.data.page.nextCursor) return;
    const previous = list.state.data;
    setLoadingMore(true); setMoreError(null);
    // Reuse the scoped resource's cancellation/epoch guard; no separate unscoped fetch.
    const result = await list.resource.load(async signal => {
      const next = await api.patients({ search, cursor: previous.page.nextCursor }, signal);
      const items = [...new Map([...previous.items, ...next.items].map(item => [item.id, item])).values()];
      return { ...next, items };
    });
    if (!result) { const state = list.resource.getSnapshot(); if (state.status === "error") setMoreError(state.error); }
    setLoadingMore(false);
  }
  return <><ReadPanel state={list.state} reload={list.reload}>{data => <><p className="live-feedback" role="status">{data.items.length} pasien dimuat{data.page.hasMore ? " · masih ada halaman berikutnya" : ""}. Pencarian mengikuti nama atau nomor RM.</p><PatientRows patients={data.items} />{data.page.hasMore && <div className="live-feedback"><button className="button button-outline" onClick={() => void more()} disabled={loadingMore}>Muat pasien berikutnya</button></div>}</>}</ReadPanel>{moreError && <p role="alert">{moreError.message}</p>}</>;
}
export function LivePatientDirectory() {
  const [query, setQuery] = useState(""); const [search, setSearch] = useState("");
  return <><NurseHeader activePage="patients" /><main id="konten-utama" className="dashboard-main patient-directory-main"><section aria-labelledby="patients-title"><div className="page-heading patient-directory-heading"><div><h1 id="patients-title">Pasien &amp; Rekam Medis</h1><p>Pasien dalam penugasan aktif Anda</p></div><Link className="button button-primary" href="/pemantauan-risiko">Pemantauan Risiko</Link></div><div className="patient-directory-card"><form className="patient-directory-toolbar" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}><label className="search-field patient-directory-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Cari nama pasien atau nomor RM</span><input type="search" maxLength={100} value={query} placeholder="Cari nama pasien atau nomor RM" onChange={event => setQuery(event.target.value)} /></label><div className="patient-risk-filters" role="group" aria-label="Filter tingkat risiko"><button type="submit" aria-pressed="true" className="patient-risk-filter is-selected">Semua · Cari</button>{["Tinggi", "Sedang", "Rendah"].map(label => <button type="button" className="patient-risk-filter" key={label} disabled title="Penilaian risiko belum tersedia">{label}</button>)}</div></form><DirectoryResults key={search} search={search} /></div></section></main></>;
}
const observationNames: Record<string, string> = { weight_kg: "Berat badan", temperature_c: "Suhu", heart_rate_bpm: "Denyut jantung", bp_systolic_mmhg: "Tekanan sistolik", bp_diastolic_mmhg: "Tekanan diastolik", spo2_pct: "SpO₂" };
export function ObservationsView({ data }: { data: Awaited<ReturnType<NurseApi["observations"]>> }) {
  const latest = data.latestObservation, confirmed = data.lastConfirmed;
  return <div className="live-two-column"><div><h3>Laporan pasien terbaru</h3>{latest ? <><p>{observationNames[latest.type] ?? latest.type}: {`${latest.value} ${latest.unit}`}</p><p className="secondary-text">Waktu pengukuran (UTC): {latest.observedAt}</p><p>Nilai yang dilaporkan pasien, bukan konfirmasi perawat.</p></> : <p>Belum ada pengukuran pasien yang diserahkan.</p>}</div><div><h3>Konfirmasi perawat terakhir</h3>{confirmed ? <><p>{`${confirmed.value} ${confirmed.unit}`}</p><p className="secondary-text">Pengukuran (UTC): {confirmed.observedAt}<br />Dikonfirmasi (UTC): {confirmed.confirmedAt}</p><p>Konfirmasi dapat berasal dari pengukuran yang lebih lama; tidak menggantikan laporan terbaru.</p></> : <p>Belum ada konfirmasi perawat.</p>}</div><p>Tren dan skor klinis belum tersedia.</p></div>;
}
export function CareGuideView({ guide }: { guide: Awaited<ReturnType<NurseApi["careGuide"]>> }) {
  return <div className="live-stack">{guide.orders.length === 0 && <p>Belum ada instruksi aktif yang dapat ditampilkan.</p>}{guide.orders.map(order => <article key={order.id}><h3>Instruksi perawatan · revisi {order.revisionNumber}</h3><p className="live-prewrap">{order.instructions}</p>{order.items && order.items.length > 0 && <ol>{order.items.map((item, index) => <li key={index}>{item.text}</li>)}</ol>}<small className="secondary-text">Sumber {order.sourceDocumentId} · versi {order.sourceVersion}</small></article>)}{guide.orders.length >= 100 && <p>Proyeksi panduan dibatasi 100 instruksi; daftar ini belum tentu lengkap.</p>}{guide.sources.map(source => <details key={source.id}><summary>{source.title} · revisi {source.revisionNumber}</summary><p className="live-prewrap">{source.body}</p></details>)}</div>;
}
function PatientClinicalReads({ patientId, tab }: { patientId: string; tab: number }) {
  const { api } = useNurseWorkspace();
  const summaryLoader = useCallback((signal: AbortSignal) => api.summary(patientId, signal), [api, patientId]);
  const observationsLoader = useCallback((signal: AbortSignal) => api.observations(patientId, signal), [api, patientId]);
  const checkInLoader = useCallback((signal: AbortSignal) => api.checkIns(patientId, null, signal), [api, patientId]);
  const guideLoader = useCallback((signal: AbortSignal) => api.careGuide(patientId, signal), [api, patientId]);
  const summary = useNurseRead(summaryLoader), observations = useNurseRead(observationsLoader), checkIns = useNurseRead(checkInLoader), guide = useNurseRead(guideLoader);
  return <>
    <div hidden={tab !== 1} role="tabpanel" tabIndex={0} id="patient-panel-1" aria-labelledby="patient-tab-1"><div className="patient-medical-sections">
      <MedicalSnapshotPanel patientId={patientId} />
      <RecordCard title="Keluhan harian yang dirasakan pasien" className="patient-checkins-card"><ReadPanel state={checkIns.state} reload={checkIns.reload}>{data => <>{data.items.length === 0 ? <p className="patient-empty">Belum ada check-in yang diserahkan.</p> : <div className="patient-checkins-scroll" role="region" aria-label="Tabel keluhan harian" tabIndex={0}><table className="patient-checkins-table"><caption className="sr-only">Riwayat check-in dan pengukuran yang dilaporkan pasien</caption><thead><tr>{["Waktu", "Kondisi", "Keluhan", "Pengukuran pasien", "Minum obat"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{data.items.map(checkIn => <tr key={checkIn.id}><th scope="row">{checkIn.localDate}</th><td>{checkIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"}</td><td className="live-prewrap">{checkIn.note ?? "Catatan belum diisi"}</td><td>{checkIn.observations.length ? checkIn.observations.map(o => <p key={o.id}>{observationNames[o.type] ?? o.type}: {o.value} {o.unit} · {o.observedAt} (UTC)</p>) : "Pengukuran belum dicatat."}</td><td>{{ regular: "Teratur", missed_once: "Terlewat sekali", none: "Tidak diminum" }[checkIn.medicationAdherence]}</td></tr>)}</tbody></table></div>}{data.page.hasMore && <p className="patient-empty">Menampilkan halaman pertama (hingga 20 check-in), bukan seluruh riwayat.</p>}</>}</ReadPanel></RecordCard>
    </div></div>
    <div hidden={tab !== 2} role="tabpanel" tabIndex={0} id="patient-panel-2" aria-labelledby="patient-tab-2"><div className="patient-medical-sections">
      {checkIns.state.status === "ready" ? <PatientAnalysisPanel patientId={patientId} checkInId={checkIns.state.data.items[0]?.id ?? null} checkInDate={checkIns.state.data.items[0]?.localDate ?? null} /> : <ReadPanel state={checkIns.state} reload={checkIns.reload}>{() => null}</ReadPanel>}
      <div className="patient-assessment-columns"><RecordCard title="Observasi"><div className="patient-reference-block"><ReadPanel state={observations.state} reload={observations.reload}>{data => <ObservationsView data={data} />}</ReadPanel></div></RecordCard><RecordCard title="Dasar penilaian"><div className="patient-assessment-basis"><ReadPanel state={summary.state} reload={summary.reload}>{data => <><p>{data.latestCheckIn ? `${data.latestCheckIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"} · ${data.latestCheckIn.localDate ?? "Tanggal belum dicatat"}` : "Belum ada check-in yang diserahkan."}</p><p>{data.activeOrderCount} instruksi aktif menurut server.</p></>}</ReadPanel><p>Skor dan penilaian risiko klinis belum tersedia. Draf analisis tidak menghasilkan skor dan tidak menggantikan keputusan perawat.</p></div></RecordCard></div>
    </div></div>
    <div hidden={tab !== 3} role="tabpanel" tabIndex={0} id="patient-panel-3" aria-labelledby="patient-tab-3"><div className="patient-equal-columns patient-care-columns"><RecordCard title="Rencana tindakan dan instruksi"><div className="patient-care-entries"><ReadPanel state={guide.state} reload={guide.reload}>{data => <CareGuideView guide={data} />}</ReadPanel></div></RecordCard><RecordCard title="Riwayat kunjungan dan tindakan"><div className="patient-care-entries"><p>Riwayat tindakan dan penyelesaian klinis belum tersedia di layanan ini.</p><Link className="text-button" href="/jadwal-kunjungan">Lihat jadwal kunjungan</Link></div></RecordCard></div></div>
  </>;
}
export function LivePatientDetail({ patientId }: { patientId: string }) {
  const { api } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => api.detail(patientId, signal), [api, patientId]);
  const detail = useNurseRead(loader);
  const [tab, setTab] = useState(0);
  return <><NurseHeader activePage="patients" /><main id="konten-utama" className="dashboard-main patient-record-main"><Link className="patient-record-back" href="/pasien-rekam-medis"><ArrowLeft size={16} aria-hidden="true" />Kembali ke Pasien &amp; Rekam Medis</Link><ReadPanel state={detail.state} reload={detail.reload}>{data => <><div className="patient-record-identity"><span aria-hidden="true">{initials(data.displayName)}</span><div><h1>{data.displayName}</h1><p>{data.recordNumber ?? "Nomor RM belum dicatat"}</p></div></div><Tabs items={["Profil Pasien", "Riwayat medis", "Penilaian kondisi", "Riwayat perawatan"]} selected={tab} onSelect={setTab} prefix="patient" className="patient-record-tabs" label="Bagian rekam medis pasien" /><div className="patient-record-panel"><div hidden={tab !== 0} role="tabpanel" tabIndex={0} id="patient-panel-0" aria-labelledby="patient-tab-0"><RecordCard title="Profil pasien" className="patient-profile-card"><dl className="patient-record-details patient-profile-grid">{[["Nama lengkap", data.displayName], ["Nomor rekam medis", data.recordNumber ?? "Belum dicatat"], ["NIK", "Belum tersedia"], ["Tanggal lahir", data.profile.birthDate], ["Jenis kelamin", data.profile.gender === "female" ? "Perempuan" : data.profile.gender === "male" ? "Laki-laki" : data.profile.gender], ["Golongan darah", "Belum tersedia"], ["Alamat", "Belum tersedia"], ["Nomor telepon", "Belum tersedia"], ["Kontak darurat", "Belum tersedia"], ["Perawat utama", data.primaryNurse?.displayName || "Belum dicatat"], ["Akses", `Penugasan aktif${data.access.expiresAt ? ` · berakhir ${data.access.expiresAt} (UTC)` : ""}`]].map(([label, value]) => <div key={label} className={label === "Alamat" ? "patient-detail-wide" : undefined}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></RecordCard></div><PatientClinicalReads key={patientId} patientId={patientId} tab={tab} /></div></>}</ReadPanel></main></>;
}
export function ProfileContent({ profile }: { profile: NurseProfile }) {
  const details = [["Nama lengkap", profile.displayName], ["ID perawat", profile.staffCode], ["Disiplin (data sumber)", profile.discipline], ["Email", profile.email], ["Nomor telepon", profile.phone ?? "Belum dicatat"], ["Zona waktu tampilan", profile.displayTimeZone]];
  return <section className="nurse-profile-identity" aria-labelledby="profile-name"><div className="nurse-profile-identity-heading"><span className="nurse-profile-avatar" aria-hidden="true">{initials(profile.displayName)}</span><div><h2 id="profile-name">{profile.displayName}</h2><p>Perawat · ID {profile.staffCode}</p></div></div><dl className="nurse-profile-details">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}
export function LiveNurseProfile() {
  const { api, profile } = useNurseWorkspace(); const state = useNurseProfile();
  return <><NurseHeader activePage="profile" /><main id="konten-utama" className="dashboard-main nurse-profile-main"><h1 className="nurse-profile-title">Profil</h1><div className="nurse-profile-layout"><div className="nurse-profile-primary"><ReadPanel state={state} reload={() => void profile.load(api.profile)}>{data => <ProfileContent profile={data} />}</ReadPanel><section className="card nurse-profile-settings" aria-labelledby="notification-settings-title"><div className="nurse-profile-settings-heading"><h2 id="notification-settings-title">Pengaturan notifikasi</h2></div><div className="nurse-profile-settings-body">{["Pengajuan homecare", "Jadwal kunjungan", "Rekam medis"].map(label => <label className="nurse-notification-option" key={label}><input type="checkbox" disabled /><span className="nurse-notification-check" aria-hidden="true" /><span><strong>{label}</strong><small>Preferensi belum tersedia dari layanan akun.</small></span></label>)}</div></section></div><aside className="nurse-profile-sidebar" aria-label="Pintasan profil"><div className="nurse-profile-shortcuts"><Link className="nurse-profile-shortcut" href="/notifikasi"><span className="nurse-profile-shortcut-icon"><Bell size={21} aria-hidden="true" /></span><span><strong>Notifikasi</strong><small>Jumlah belum tersedia</small></span><ChevronRight size={16} aria-hidden="true" /></Link><Link className="nurse-profile-shortcut" href="/jadwal-kunjungan"><span className="nurse-profile-shortcut-icon"><ClipboardCheck size={20} aria-hidden="true" /></span><span><strong>Jadwal kunjungan saya</strong><small>Termasuk pengaturan ketersediaan</small></span><ChevronRight size={16} aria-hidden="true" /></Link></div><div className="nurse-profile-session"><SessionActions /></div></aside></div></main></>;
}
export function UnavailableWorkflow({ title, activePage }: { title: string; activePage: "requests" | "visits" | "notifications" | "patients" }) {
  if (activePage === "notifications") return <UnavailableNotifications />;
  if (activePage === "patients") return <RiskMonitoringUnavailable />;
  return <><NurseHeader activePage={activePage} /><main id="konten-utama" className="dashboard-main visit-record-main"><Link href="/jadwal-kunjungan" className="back-to-requests"><ArrowLeft size={16} aria-hidden="true" />Kembali ke Jadwal</Link><div className="request-detail-heading visit-record-heading"><h1>{activePage === "visits" ? "Rekam Medis Kunjungan" : title}</h1><p>Catatan kunjungan belum tersedia dari layanan klinis.</p></div><div className="medical-record-layout"><fieldset className="medical-record-fields" disabled><legend className="sr-only">Catatan pemeriksaan dan tindakan kunjungan · belum tersedia</legend>
    <section className="card medical-record-card"><div className="section-header record-card-header"><h2>Penanggung jawab tindakan</h2></div><div className="record-responsibility-body">{["Nama perawat", "ID perawat", "Waktu mulai", "Waktu selesai"].map(label => <label className="medical-field" key={label}>{label}<input className="medical-control medical-readonly" value="" placeholder="Belum tersedia" readOnly /></label>)}</div></section>
    <section className="card medical-record-card"><div className="section-header record-card-header"><h2>Hasil pemeriksaan pasien</h2></div><div className="record-examination-body"><div className="record-vitals-grid">{["Tekanan darah", "Suhu tubuh", "Detak jantung", "Tingkat kesadaran"].map(label => <label className="medical-field" key={label}>{label}<input className="medical-control" value="" placeholder="Belum tersedia" readOnly /></label>)}</div><label className="medical-field">Hasil observasi fisik dan pemeriksaan<textarea className="medical-control record-observations" value="" placeholder="Data pemeriksaan belum tersedia" readOnly /></label></div></section>
    <section className="card medical-record-card"><div className="section-header record-card-header"><h2>Catatan internal: rincian tindakan medis</h2></div><div className="record-procedures-body"><label className="medical-field">Tindakan medis yang dilakukan<textarea className="medical-control record-procedures" value="" placeholder="Data tindakan belum tersedia" readOnly /></label></div></section>
    <section className="card medical-record-card record-log-card"><div className="section-header record-card-header"><h2>Log penggunaan alat dan bahan medis</h2><button className="button button-white button-small" disabled>Tambah item</button></div><div className="record-log-table-wrap" role="region" aria-label="Log penggunaan alat dan bahan medis" tabIndex={0}><table className="record-log-table"><colgroup>{["name", "kind", "quantity", "unit", "action"].map(column => <col key={column} className={`log-col-${column}`} />)}</colgroup><thead><tr>{["Nama alat / bahan", "Jenis", "Jumlah", "Satuan"].map(label => <th key={label} scope="col">{label}</th>)}<th scope="col"><span className="sr-only">Tindakan</span></th></tr></thead><tbody><tr><td colSpan={5} className="patient-empty">Log belum tersedia. Ini bukan pernyataan bahwa tidak ada alat atau bahan digunakan.</td></tr></tbody></table></div></section>
    </fieldset><aside className="medical-record-sidebar" aria-label="Kelengkapan dan referensi catatan"><section className="card medical-record-card"><div className="section-header record-card-header"><h2>Kelengkapan catatan</h2></div><ul className="record-completeness-list">{["Penanggung jawab", "Pemeriksaan pasien", "Tindakan medis", "Alat dan bahan"].map(label => <li key={label}><CircleAlert size={18} aria-hidden="true" /><span>{label} · belum tersedia</span></li>)}</ul></section><section className="card medical-record-card"><div className="section-header record-card-header"><h2>Referensi pasien</h2></div><div className="record-reference-body"><dl className="patient-reference-details">{["Keluhan utama (pengajuan)", "Check-in terakhir", "Alamat kunjungan"].map(label => <div key={label}><dt>{label}</dt><dd>Belum tersedia</dd></div>)}</dl></div></section><div className="record-save-actions"><button className="button record-outline-button" disabled>Simpan draf</button><button className="button button-primary" disabled>Simpan &amp; selesaikan kunjungan</button><p className="record-save-note">Penyimpanan dan penyelesaian klinis belum tersedia. Status jadwal tidak diubah.</p></div></aside></div></main></>;
}
function UnavailableNotifications() {
  const [tab, setTab] = useState(0);
  return <><NurseHeader activePage="notifications" /><main id="konten-utama" className="dashboard-main nurse-notifications-main"><div className="page-heading nurse-notifications-heading"><div><h1>Notifikasi</h1><p role="status">Jumlah belum dibaca belum tersedia</p></div><button className="button button-primary" disabled>Tandai semua dibaca</button></div><Tabs items={["Semua", "Pengajuan", "Jadwal kunjungan", "Rekam medis"]} selected={tab} onSelect={setTab} prefix="notification" className="nurse-notification-tabs" label="Kategori notifikasi" /><section role="tabpanel" tabIndex={0} id={`notification-panel-${tab}`} aria-labelledby={`notification-tab-${tab}`}><div className="card empty-state"><Bell size={32} aria-hidden="true" /><h2>Notifikasi belum tersedia</h2><p>Layanan notifikasi belum terhubung. Tidak ada notifikasi atau status dibaca yang dibuat.</p></div></section></main></>;
}
function RiskMonitoringUnavailable() {
  const { api } = useNurseWorkspace();
  const [query, setQuery] = useState(""), [search, setSearch] = useState(""), [selectedId, setSelectedId] = useState<string | null>(null);
  const loader = useCallback((signal: AbortSignal) => api.patients({ search }, signal), [api, search]);
  const list = useNurseRead(loader);
  const selected = list.state.status === "ready" ? list.state.data.items.find(patient => patient.id === selectedId) : null;
  const stats = [{ label: "Pasien dimuat", icon: UsersRound }, { label: "Risiko tinggi", icon: TriangleAlert }, { label: "Risiko sedang", icon: CircleAlert }, { label: "Risiko rendah", icon: ShieldCheck }];
  return <><NurseHeader activePage="patients" /><main id="konten-utama" className="dashboard-main risk-monitoring-main"><Link className="risk-back-link" href="/pasien-rekam-medis"><ArrowLeft size={16} aria-hidden="true" />Kembali ke Pasien &amp; Rekam Medis</Link><div className="page-heading risk-monitoring-heading"><h1>Pemantauan Risiko</h1><p>Penilaian risiko klinis belum tersedia. Check-in bukan kategori risiko.</p></div><section className="stats risk-monitoring-stats" aria-label="Ringkasan tingkat risiko">{stats.map(({ label, icon: Icon }, index) => <div className="stat" key={label}><span className={`stat-icon stat-icon-${index % 2 ? "blue" : "cream"}`}><Icon size={25} aria-hidden="true" /></span><div><p className="stat-label">{label}</p><p className="stat-value nurse-unavailable-value">{index === 0 && list.state.status === "ready" ? `${list.state.data.items.length}${list.state.data.page.hasMore ? "+" : ""}` : "Belum tersedia"}</p></div></div>)}</section><div className="risk-monitoring-layout"><section className="risk-monitoring-card risk-list-card" aria-label="Daftar risiko pasien"><form className="risk-search-header" onSubmit={event => { event.preventDefault(); setSelectedId(null); setSearch(query.trim()); }}><label className="search-field risk-monitoring-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Cari nama atau nomor RM</span><input type="search" maxLength={100} value={query} placeholder="Cari nama atau nomor RM" onChange={event => setQuery(event.target.value)} /></label><button className="button button-white button-small" type="submit">Cari</button></form><ReadPanel state={list.state} reload={list.reload}>{data => <><div className="risk-table-scroll" role="region" aria-label="Tabel tingkat risiko pasien" tabIndex={0}><table className="risk-monitoring-table"><colgroup><col className="risk-col-patient" /><col className="risk-col-level" /><col className="risk-col-factor" /><col className="risk-col-updated" /></colgroup><thead><tr>{["Pasien", "Tingkat risiko", "Faktor utama", "Diperbarui"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{data.items.map(patient => <tr key={patient.id} className={selectedId === patient.id ? "is-selected" : ""}><td><button className="risk-patient-select" aria-pressed={selectedId === patient.id} onClick={() => setSelectedId(patient.id)}><div className="patient-identity"><strong>{patient.displayName}</strong><span className="secondary-text">{patient.recordNumber ?? "Nomor RM belum dicatat"}</span></div></button></td><td>Belum tersedia</td><td>Penilaian klinis belum tersedia</td><td className="risk-updated">Belum tersedia</td></tr>)}</tbody></table></div>{!data.items.length && <div className="empty-state"><h2>Belum ada pasien pada daftar ini</h2><p>Coba nama atau nomor RM lain.</p></div>}{data.page.hasMore && <p className="patient-empty">Halaman pertama saja. <Link className="text-button" href="/pasien-rekam-medis">Buka direktori untuk semua halaman</Link></p>}</>}</ReadPanel></section><aside className="risk-monitoring-sidebar" aria-label="Peninjauan risiko pasien"><section className="risk-monitoring-card"><div className="risk-card-heading"><h2>{selected?.displayName ?? "Pilih pasien"}</h2></div><div className="risk-review-body"><p className="risk-review-meta">{selected?.recordNumber ?? "Penugasan aktif"}</p><fieldset className="risk-choice-fieldset" disabled><legend>Ubah tingkat risiko · belum tersedia</legend><div className="risk-choices">{["Rendah", "Sedang", "Tinggi"].map(label => <label className="risk-choice" key={label}><input type="radio" name="unavailable-risk" /><span>{label}</span></label>)}</div></fieldset><div className="risk-review-actions"><button className="button risk-approve-button" disabled>Setujui tingkat risiko</button>{selected ? <Link className="button risk-record-button" href={`/pasien-rekam-medis/${selected.id}`}>Rekam medis</Link> : <button className="button risk-record-button" disabled>Rekam medis</button>}</div></div></section><section className="risk-monitoring-card"><div className="risk-card-heading risk-basis-heading"><h2>Dasar penilaian</h2></div><ul className="risk-basis-list">{["Check-in harian", "Skrining pemesanan", "Tanda vital terakhir"].map(label => <li key={label}>{label} · belum dinilai</li>)}</ul></section></aside></div></main></>;
}
