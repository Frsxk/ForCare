"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { Search, UsersRound } from "lucide-react";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseProfile, useNurseRead, useNurseWorkspace } from "@/components/nurse-workspace-provider";
import type { ResourceState } from "@/lib/api/scoped-resource";
import type { ApiError } from "@/lib/api/client";
import { PatientAnalysisPanel } from "@/components/patient-analysis";
import { MedicalSnapshotPanel } from "@/components/medical-snapshot-panel";
export { SnapshotView } from "@/components/medical-snapshot-panel";
import { createNurseApi, type NurseProfile, type PatientList } from "@/lib/api/nurse";
import "./patient-directory.css";
import "./patient-record.css";
import "./nurse-profile.css";
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
export function PatientRows({ patients }: { patients: PatientList["items"] }) {
  return <div className="patient-directory-scroll" role="region" aria-label="Pasien penugasan aktif" tabIndex={0}><table className="patient-directory-table live-patients-table">
    <caption className="sr-only">Hanya pasien dalam penugasan aktif Anda. Check-in adalah laporan pasien, bukan penilaian risiko.</caption>
    <thead><tr><th scope="col">Pasien</th><th scope="col">Laporan pasien terakhir</th><th scope="col">Penilaian risiko</th><th scope="col">Rekam medis</th></tr></thead>
    <tbody>{patients.map(patient => <tr key={patient.id}>
      <td><div className="patient-identity"><strong>{patient.displayName}</strong><span className="secondary-text">{patient.recordNumber ?? "Nomor RM belum dicatat"}</span></div></td>
      <td>{patient.latestCheckIn ? <><span>{patient.latestCheckIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"}</span><small>{patient.latestCheckIn.localDate ?? "Tanggal belum dicatat"}</small></> : "Belum ada check-in"}</td>
      <td><span className="secondary-text">Belum tersedia</span></td>
      <td><Link className="button button-small patient-record-button" href={`/pasien-rekam-medis/${patient.id}`} aria-label={`Buka rekam medis ${patient.displayName}`}>Buka rekam medis</Link></td>
    </tr>)}</tbody>
  </table>{patients.length === 0 && <div className="empty-state"><h2>Belum ada pasien pada daftar ini</h2><p>Hanya pasien yang sedang ditugaskan kepada akun Anda yang ditampilkan.</p></div>}</div>;
}
export function NurseDashboardView({ list }: { list: PatientList }) {
  return <>
    <section className="stats" aria-label="Data penugasan yang berhasil dimuat"><div className="stat"><span className="stat-icon stat-icon-cream"><UsersRound size={25} aria-hidden="true" /></span><div><p className="stat-label">Pasien penugasan aktif</p><p className="stat-value">{list.items.length} pasien dimuat</p><p>{list.page.hasMore ? "Masih ada halaman berikutnya; ini bukan total seluruh pasien." : "Seluruh halaman pada daftar ini telah dimuat."}</p></div></div></section>
    <section className="card"><div className="section-header"><h2>Pasien Anda</h2><Link className="text-button" href="/pasien-rekam-medis">Lihat direktori</Link></div><PatientRows patients={list.items} /></section>
    <div className="live-two-column"><section className="card live-card"><h2>Analisis &amp; risiko</h2><p>Analisis AI belum tersedia di antarmuka ini. Skor klinis dan tren belum tersedia; tidak ada persetujuan otomatis.</p><Link className="text-button" href="/pemantauan-risiko">Lihat ketersediaan</Link></section><section className="card live-card"><h2>Kunjungan &amp; pengajuan</h2><p>Layanan jadwal dan pemesanan belum tersedia. Tidak ada angka aktivitas yang dihitung dari data contoh.</p><Link className="text-button" href="/jadwal-kunjungan">Jadwal kunjungan</Link></section></div>
  </>;
}
export function LiveNurseDashboard() {
  const { api } = useNurseWorkspace(); const profile = useNurseProfile();
  const loader = useCallback((signal: AbortSignal) => api.patients({}, signal), [api]);
  const list = useNurseRead(loader);
  return <><NurseHeader activePage="dashboard" /><main id="konten-utama" className="dashboard-main live-stack"><section className="welcome"><div><h1>Selamat datang{profile.status === "ready" ? `, ${profile.data.displayName}` : ""}</h1><p>Ruang kerja perawat · penugasan aktif</p></div><Link className="button button-primary" href="/pasien-rekam-medis">Buka pasien</Link></section><ReadPanel state={list.state} reload={list.reload}>{data => <NurseDashboardView list={data} />}</ReadPanel></main></>;
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
  return <><NurseHeader activePage="patients" /><main id="konten-utama" className="dashboard-main patient-directory-main"><section aria-labelledby="patients-title"><div className="page-heading patient-directory-heading"><div><h1 id="patients-title">Pasien &amp; Rekam Medis</h1><p>Pasien dalam penugasan aktif Anda</p></div><Link className="button button-outline" href="/pemantauan-risiko">Ketersediaan analisis</Link></div><div className="patient-directory-card"><form className="patient-directory-toolbar" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}><label className="search-field patient-directory-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Cari nama pasien atau nomor RM</span><input type="search" maxLength={100} value={query} placeholder="Cari nama pasien atau nomor RM" onChange={event => setQuery(event.target.value)} /></label><button className="button button-primary" type="submit">Cari</button></form><DirectoryResults key={search} search={search} /></div></section></main></>;
}
const observationNames: Record<string, string> = { weight_kg: "Berat badan", temperature_c: "Suhu", heart_rate_bpm: "Denyut jantung", bp_systolic_mmhg: "Tekanan sistolik", bp_diastolic_mmhg: "Tekanan diastolik", spo2_pct: "SpO₂" };
export function ObservationsView({ data }: { data: Awaited<ReturnType<NurseApi["observations"]>> }) {
  const latest = data.latestObservation, confirmed = data.lastConfirmed;
  return <div className="live-two-column"><div><h3>Laporan pasien terbaru</h3>{latest ? <><p>{observationNames[latest.type] ?? latest.type}: {`${latest.value} ${latest.unit}`}</p><p className="secondary-text">Waktu pengukuran (UTC): {latest.observedAt}</p><p>Nilai yang dilaporkan pasien, bukan konfirmasi perawat.</p></> : <p>Belum ada pengukuran pasien yang diserahkan.</p>}</div><div><h3>Konfirmasi perawat terakhir</h3>{confirmed ? <><p>{`${confirmed.value} ${confirmed.unit}`}</p><p className="secondary-text">Pengukuran (UTC): {confirmed.observedAt}<br />Dikonfirmasi (UTC): {confirmed.confirmedAt}</p><p>Konfirmasi dapat berasal dari pengukuran yang lebih lama; tidak menggantikan laporan terbaru.</p></> : <p>Belum ada konfirmasi perawat.</p>}</div><p>Tren dan skor klinis belum tersedia.</p></div>;
}
export function CareGuideView({ guide }: { guide: Awaited<ReturnType<NurseApi["careGuide"]>> }) {
  return <div className="live-stack">{guide.orders.length === 0 && <p>Belum ada instruksi aktif yang dapat ditampilkan.</p>}{guide.orders.map(order => <article key={order.id}><h3>Instruksi perawatan · revisi {order.revisionNumber}</h3><p className="live-prewrap">{order.instructions}</p>{order.items && order.items.length > 0 && <ol>{order.items.map((item, index) => <li key={index}>{item.text}</li>)}</ol>}<small className="secondary-text">Sumber {order.sourceDocumentId} · versi {order.sourceVersion}</small></article>)}{guide.orders.length >= 100 && <p>Proyeksi panduan dibatasi 100 instruksi; daftar ini belum tentu lengkap.</p>}{guide.sources.map(source => <details key={source.id}><summary>{source.title} · revisi {source.revisionNumber}</summary><p className="live-prewrap">{source.body}</p></details>)}</div>;
}
function PatientClinicalReads({ patientId }: { patientId: string }) {
  const { api } = useNurseWorkspace();
  const summaryLoader = useCallback((signal: AbortSignal) => api.summary(patientId, signal), [api, patientId]);
  const observationsLoader = useCallback((signal: AbortSignal) => api.observations(patientId, signal), [api, patientId]);
  const checkInLoader = useCallback((signal: AbortSignal) => api.checkIns(patientId, null, signal), [api, patientId]);
  const guideLoader = useCallback((signal: AbortSignal) => api.careGuide(patientId, signal), [api, patientId]);
  const summary = useNurseRead(summaryLoader), observations = useNurseRead(observationsLoader), checkIns = useNurseRead(checkInLoader), guide = useNurseRead(guideLoader);
  return <div className="live-stack"><section className="card live-card"><h2>Ringkasan pasien</h2><ReadPanel state={summary.state} reload={summary.reload}>{data => <><p>{data.latestCheckIn ? `${data.latestCheckIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"} · ${data.latestCheckIn.localDate ?? "Tanggal belum dicatat"}` : "Belum ada check-in yang diserahkan."}</p><p>{data.activeOrderCount} instruksi aktif menurut server.</p></>}</ReadPanel></section>
    <MedicalSnapshotPanel patientId={patientId} />
    <section className="card live-card"><h2>Observasi</h2><ReadPanel state={observations.state} reload={observations.reload}>{data => <ObservationsView data={data} />}</ReadPanel></section>
    <section className="card live-card"><h2>Check-in yang diserahkan pasien</h2><ReadPanel state={checkIns.state} reload={checkIns.reload}>{data => <>{data.items.length === 0 && <p>Belum ada check-in yang diserahkan.</p>}{data.items.map(checkIn => <details key={checkIn.id}><summary>{checkIn.localDate} · {checkIn.condition === "complaint" ? "Pasien melaporkan keluhan" : "Pasien melaporkan baik-baik saja"}</summary><p className="live-prewrap">{checkIn.note ?? "Catatan belum diisi"}</p><p>Laporan kepatuhan obat: {{ regular: "Teratur", missed_once: "Terlewat sekali", none: "Tidak diminum" }[checkIn.medicationAdherence]}</p>{checkIn.observations.length ? <ul>{checkIn.observations.map(o => <li key={o.id}>{observationNames[o.type]}: {o.value} {o.unit} · {o.observedAt} (UTC) · laporan pasien</li>)}</ul> : <p>Pengukuran belum dicatat.</p>}</details>)}{data.page.hasMore && <p>Menampilkan halaman pertama (hingga 20 check-in), bukan seluruh riwayat.</p>}</>}</ReadPanel></section>
    <section className="card live-card"><h2>Panduan perawatan aktif</h2><ReadPanel state={guide.state} reload={guide.reload}>{data => <CareGuideView guide={data} />}</ReadPanel></section>
    {checkIns.state.status === "ready" && <PatientAnalysisPanel patientId={patientId} checkInId={checkIns.state.data.items[0]?.id ?? null} checkInDate={checkIns.state.data.items[0]?.localDate ?? null} />}
    <section className="card live-card"><h2>Skor klinis</h2><p>Skor dan penilaian risiko klinis belum tersedia. Draf analisis tidak menghasilkan skor dan tidak menggantikan keputusan perawat.</p></section>
  </div>;
}
export function LivePatientDetail({ patientId }: { patientId: string }) {
  const { api } = useNurseWorkspace();
  const loader = useCallback((signal: AbortSignal) => api.detail(patientId, signal), [api, patientId]);
  const detail = useNurseRead(loader);
  return <><NurseHeader activePage="patients" /><main id="konten-utama" className="dashboard-main patient-record-main"><Link className="patient-record-back" href="/pasien-rekam-medis">← Kembali ke pasien</Link><ReadPanel state={detail.state} reload={detail.reload}>{data => <><div className="patient-record-identity"><span aria-hidden="true">{data.displayName.split(/\s+/).slice(0, 2).map(part => part[0]).join("")}</span><div><h1>{data.displayName}</h1><p>{data.recordNumber ?? "Nomor RM belum dicatat"}</p></div></div><section className="card patient-profile-card"><div className="patient-record-card-heading"><h2>Profil pasien</h2></div><dl className="patient-record-details patient-profile-grid"><div><dt>Tanggal lahir</dt><dd>{data.profile.birthDate}</dd></div><div><dt>Jenis kelamin (data sumber)</dt><dd>{data.profile.gender}</dd></div><div><dt>Perawat utama</dt><dd>{data.primaryNurse?.displayName || "Belum dicatat"}</dd></div><div className="patient-detail-wide"><dt>Akses</dt><dd>Penugasan aktif{data.access.expiresAt ? ` · berakhir ${data.access.expiresAt} (UTC)` : ""}</dd></div></dl></section><PatientClinicalReads patientId={patientId} /></>}</ReadPanel></main></>;
}
export function ProfileContent({ profile }: { profile: NurseProfile }) {
  const details = [["Nama lengkap", profile.displayName], ["ID perawat", profile.staffCode], ["Disiplin (data sumber)", profile.discipline], ["Email", profile.email], ["Nomor telepon", profile.phone ?? "Belum dicatat"], ["Zona waktu tampilan", profile.displayTimeZone]];
  return <section className="nurse-profile-identity"><div className="nurse-profile-identity-heading"><span className="nurse-profile-avatar" aria-hidden="true">{profile.displayName.split(/\s+/).slice(0, 2).map(part => part[0]).join("")}</span><div><h2>{profile.displayName}</h2><p>Perawat · ID {profile.staffCode}</p></div></div><dl className="nurse-profile-details">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>;
}
export function LiveNurseProfile() {
  const { api, profile } = useNurseWorkspace(); const state = useNurseProfile();
  return <><NurseHeader activePage="profile" /><main id="konten-utama" className="dashboard-main nurse-profile-main"><h1 className="nurse-profile-title">Profil</h1><div className="nurse-profile-layout"><div className="nurse-profile-primary"><ReadPanel state={state} reload={() => void profile.load(api.profile)}>{data => <ProfileContent profile={data} />}</ReadPanel></div><aside className="nurse-profile-sidebar"><div className="card live-card"><h2>Layanan akun</h2><p>Profil dibaca langsung dari akun Anda. Pengaturan notifikasi dan perubahan profil belum tersedia pada layar ini.</p><Link className="text-button" href="/notifikasi">Notifikasi</Link></div></aside></div></main></>;
}
export function UnavailableWorkflow({ title, activePage }: { title: string; activePage: "requests" | "visits" | "notifications" | "patients" }) {
  return <><NurseHeader activePage={activePage} /><main id="konten-utama" className="dashboard-main live-stack"><div className="page-heading"><h1>{title}</h1></div><section className="card live-card" aria-labelledby="unavailable-title"><h2 id="unavailable-title">Layanan belum tersedia</h2><p>Alur ini belum terhubung ke layanan akun. Tidak ada data contoh, keputusan, jadwal atau notifikasi yang ditampilkan sebagai data langsung.</p><p>Analisis dan persetujuan AI belum tersedia di antarmuka ini. Penilaian risiko klinis tetap tidak tersedia.</p><Link className="button button-primary" href="/pasien-rekam-medis">Buka pasien penugasan aktif</Link></section></main></>;
}
