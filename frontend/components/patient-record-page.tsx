"use client";

import { Suspense, useRef, useState, type ReactNode, type KeyboardEvent, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Info, Pencil, Sparkles } from "lucide-react";
import { nurse } from "@/lib/dashboard-data";
import { patientDirectory, type PatientRisk } from "@/lib/patient-directory-data";
import { emptyMedicalHistory, ilhamAssessmentDraft, ilhamDailyCheckIns, ilhamProfile, formatPatientDate, type PatientMedicalHistory } from "@/lib/patient-record-data";
import { formatVisitDate } from "@/lib/visit-data";
import { type VisitMedicalRecord } from "@/lib/visit-medical-record";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import "./patient-record.css";

type Profile = (typeof patientDirectory)[number];
const tabs = [
  { value: "profile", label: "Profil Pasien" },
  { value: "medical", label: "Riwayat medis" },
  { value: "assessment", label: "Penilaian kondisi" },
  { value: "care", label: "Riwayat perawatan" },
] as const;
type PatientTab = (typeof tabs)[number]["value"];
const riskOptions: { value: PatientRisk; label: string }[] = [{ value: "low", label: "Rendah" }, { value: "medium", label: "Sedang" }, { value: "high", label: "Tinggi" }];

function RecordCard({ title, children, className = "", action, cream = false }: { title: ReactNode; children: ReactNode; className?: string; action?: ReactNode; cream?: boolean }) {
  return <section className={`card patient-record-card ${className}`}>
    <div className={`patient-record-card-heading${cream ? " is-cream" : ""}`}><h2>{title}</h2>{action}</div>{children}
  </section>;
}
function Detail({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "patient-detail-wide" : undefined}><dt>{label}</dt><dd>{children}</dd></div>;
}
function Placeholder({ children }: { children: ReactNode }) { return <span className="patient-data-placeholder">{children}</span>; }

export function PatientRecordPage({ profile }: { profile: Profile }) {
  return <Suspense fallback={<main className="dashboard-main" role="status">Memuat rekam medis pasien...</main>}><PatientRecordContent profile={profile} /></Suspense>;
}

function PatientRecordContent({ profile }: { profile: Profile }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = tabs.find((item) => item.value === searchParams.get("tab"))?.value ?? "profile";
  function setTab(next: PatientTab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault(); setTab(tabs[next].value); tabRefs.current[next]?.focus();
  }
  return <>
    <NurseHeader activePage="patients" />
    <main id="konten-utama" className="dashboard-main patient-record-main">
      <Link className="patient-record-back" href="/pasien-rekam-medis"><ArrowLeft size={16} aria-hidden="true" />Kembali ke Pasien &amp; Rekam Medis</Link>
      <div className="patient-record-identity"><span aria-hidden="true">{profile.patient.initials}</span><div><h1>{profile.patient.name}</h1><p>{profile.patient.id} · {profile.sex === "L" ? "Laki-laki" : "Perempuan"} · {profile.age} tahun</p></div></div>
      <div className="patient-record-tabs" role="tablist" aria-label="Bagian rekam medis pasien">{tabs.map(({ value, label }, index) => <button key={value} ref={(element) => { tabRefs.current[index] = element; }} id={`patient-tab-${value}`} role="tab" aria-controls={`patient-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={tab === value ? "is-selected" : ""} onClick={() => setTab(value)} onKeyDown={(event) => navigateTabs(event, index)}>{label}</button>)}</div>
      <div className="patient-record-panel" role="tabpanel" tabIndex={0} id={`patient-panel-${tab}`} aria-labelledby={`patient-tab-${tab}`}>
        {tab === "profile" && <PatientProfile profile={profile} />}
        {tab === "medical" && <MedicalHistory profile={profile} />}
        {tab === "assessment" && <ConditionAssessment profile={profile} />}
        {tab === "care" && <CareHistory profile={profile} />}
      </div>
    </main>
  </>;
}

function PatientProfile({ profile }: { profile: Profile }) {
  const detail = profile.patient.id === "RM-2026-001" ? ilhamProfile : null;
  return <RecordCard title="Profil pasien" className="patient-profile-card">
    <dl className="patient-profile-grid patient-record-details">
      <Detail label="Nama lengkap">{profile.patient.name}</Detail><Detail label="Nomor rekam medis">{profile.patient.id}</Detail><Detail label="NIK">{detail?.nik ?? "Belum tersedia"}</Detail>
      <Detail label="Tanggal lahir · usia">{detail ? `${detail.birthday} · ${profile.age} tahun` : `Belum tersedia · ${profile.age} tahun`}</Detail><Detail label="Jenis kelamin">{profile.sex === "L" ? "Laki-laki" : "Perempuan"}</Detail><Detail label="Golongan darah">{detail?.bloodType ?? "Belum tersedia"}</Detail>
      <Detail label="Alamat" wide>{detail?.address ?? "Belum tersedia"}</Detail>
      <Detail label="Nomor telepon">{detail?.phone ?? "Belum tersedia"}</Detail><Detail label="Kontak darurat">{detail?.emergency ?? "Belum tersedia"}</Detail><Detail label="Status asuransi">{detail?.insurance ?? "Belum tersedia"}</Detail>
    </dl>
  </RecordCard>;
}

function DailyCheckIns({ ilham }: { ilham: boolean }) {
  return <RecordCard title="Keluhan harian yang dirasakan pasien" className="patient-checkins-card">
    {ilham ? <div className="patient-checkins-scroll" role="region" aria-label="Tabel keluhan harian" tabIndex={0}><table className="patient-checkins-table">
      <caption className="sr-only">Riwayat check-in dan tanda vital yang dilaporkan pasien</caption>
      <thead><tr>{["Waktu", "Kondisi", "Keluhan", "Suhu", "Detak", "Tekanan darah", "Minum obat"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{ilhamDailyCheckIns.map((item) => <tr key={item.time}><th scope="row">{item.time}</th><td><span className={`risk-badge ${item.warning ? "risk-medium" : "risk-low"}`}>{item.condition}</span></td><td>{item.complaint}</td><td>{item.temperature}</td><td>{item.pulse}</td><td>{item.pressure}</td><td>{item.medication}</td></tr>)}</tbody>
    </table></div> : <p className="patient-empty">Belum ada data check-in harian untuk pasien ini.</p>}
  </RecordCard>;
}

function MedicalHistory({ profile }: { profile: Profile }) {
  const { patientHistories, savePatientHistory, notify, medicalRecords, visits } = useNurseData();
  const history = patientHistories[profile.patient.id] ?? emptyMedicalHistory;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PatientMedicalHistory>({ ...history });
  const [error, setError] = useState(false);
  const ilham = profile.patient.id === "RM-2026-001";
  function update(field: keyof PatientMedicalHistory, value: string) { setForm((previous) => ({ ...previous, [field]: value })); setError(false); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const submitted = Object.fromEntries(Object.keys(emptyMedicalHistory).map((key) => [key, String(values.get(key) ?? "")])) as PatientMedicalHistory;
    if (!savePatientHistory(profile.patient.id, submitted)) { setError(true); return; }
    setEditing(false); notify(`Riwayat medis ${profile.patient.name} disimpan atas nama ${nurse.name} (${nurse.id}).`);
  }
  const latestVisit = visits.filter((visit) => visit.patient.id === profile.patient.id && medicalRecords[visit.id]).toSorted((a,b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))[0];
  const latestRecord = latestVisit ? medicalRecords[latestVisit.id] : undefined;
  return <div className="patient-medical-sections">
    <RecordCard title="Diagnosis dan rawat inap" className={editing ? "patient-history-edit-card" : "patient-history-read-card"} action={!editing && <button className="button patient-edit-button" onClick={() => { setForm({ ...history }); setError(false); setEditing(true); }}><Pencil size={15} aria-hidden="true" />Edit riwayat</button>}>
      {editing ? <form onSubmit={submit}>
        <div className="patient-history-edit-body">
          <p className="patient-history-info"><Info size={18} aria-hidden="true" />Perubahan tercatat atas nama {nurse.name} ({nurse.id}). Isi sesuai data dari rumah sakit.</p>
          <div className="patient-history-fields">
            <label>Diagnosis utama<textarea name="diagnosis" required maxLength={2000} placeholder="Diagnosis utama" value={form.diagnosis} onChange={(event) => update("diagnosis", event.target.value)} /></label>
            <label>Diagnosis sekunder <span>(opsional)</span><textarea name="secondaryDiagnosis" maxLength={2000} placeholder="Diagnosis sekunder" value={form.secondaryDiagnosis} onChange={(event) => update("secondaryDiagnosis", event.target.value)} /></label>
            <label>Tanggal masuk RS<input name="admitted" required type="date" value={form.admitted} max={form.discharged || undefined} onChange={(event) => update("admitted", event.target.value)} /></label>
            <label>Tanggal keluar RS<input name="discharged" required type="date" value={form.discharged} min={form.admitted || undefined} onChange={(event) => update("discharged", event.target.value)} /></label>
            <label>Riwayat alergi<textarea name="allergies" required maxLength={2000} placeholder={'Tulis "Tidak ada" bila tidak ada alergi'} value={form.allergies} onChange={(event) => update("allergies", event.target.value)} /></label>
            <label>Riwayat operasi / tindakan medis terakhir<textarea name="procedures" required maxLength={2000} placeholder="Tindakan terakhir dan tanggalnya" value={form.procedures} onChange={(event) => update("procedures", event.target.value)} /></label>
          </div>
          {error && <p className="patient-form-error" role="alert">Isi diagnosis utama, alergi, dan tindakan terakhir. Pastikan tanggal keluar tidak mendahului tanggal masuk.</p>}
        </div>
        <div className="patient-history-form-actions"><button type="button" className="button patient-outline-button" onClick={() => { setEditing(false); setError(false); }}>Batal</button><button className="button button-primary" type="submit">Simpan riwayat</button></div>
      </form> : <dl className="patient-record-details patient-history-details">
        <Detail label="Diagnosis utama">{history.diagnosis || <Placeholder>[Diagnosis utama · diisi dari data rumah sakit]</Placeholder>}</Detail>
        <Detail label="Diagnosis sekunder">{history.secondaryDiagnosis || <Placeholder>[Diagnosis sekunder · diisi dari data rumah sakit]</Placeholder>}</Detail>
        <div className="patient-two-details"><Detail label="Tanggal masuk RS">{formatPatientDate(history.admitted)}</Detail><Detail label="Tanggal keluar RS">{formatPatientDate(history.discharged)}</Detail></div>
        <Detail label="Riwayat alergi (obat, makanan, bahan sintetis)">{history.allergies || <Placeholder>[Riwayat alergi · diisi dari data rumah sakit]</Placeholder>}</Detail>
        <Detail label="Riwayat operasi / tindakan medis terakhir">{history.procedures || <Placeholder>[Tindakan terakhir · diisi dari data rumah sakit]</Placeholder>}</Detail>
      </dl>}
    </RecordCard>
    {editing && <div className="patient-equal-columns">
      <RecordCard title="Keluhan dan tanda-tanda vital" cream action={ilham && <span className="patient-card-caption">Pengajuan HC-0014 · 12 Nov 2026</span>}>
        <dl className="patient-record-details patient-reference-block"><Detail label="Keluhan">{ilham ? "Badan terasa lemas sejak dua hari terakhir." : "Belum tersedia"}</Detail><div className="patient-vital-reference"><Detail label="Tekanan darah">{ilham ? "120/80 mmHg" : "-"}</Detail><Detail label="Suhu tubuh">{ilham ? "36,8 °C" : "-"}</Detail><Detail label="Detak jantung">{ilham ? "78 bpm" : "-"}</Detail></div></dl>
      </RecordCard>
      <RecordCard title="Hasil observasi fisik dan pemeriksaan perawat"><div className="patient-reference-block"><p className="patient-record-meta">{latestRecord && latestVisit ? `${formatVisitDate(latestVisit.date)} · ${latestRecord.nurseName} (${latestRecord.nurseId})` : ilham ? `Kamis, 12 Nov 2026 · ${nurse.name} (${nurse.id})` : "Belum tersedia"}</p><p>{latestRecord ? `${latestRecord.observations} Kesadaran: ${latestRecord.consciousness}. TD ${latestRecord.systolic}/${latestRecord.diastolic} mmHg · ${latestRecord.temperature} °C · ${latestRecord.heartRate} bpm.` : ilham ? "Pasien tampak lemas ringan. Kesadaran: sadar penuh. TD 120/80 mmHg · 36,8 °C · 78 bpm." : "Belum ada catatan pemeriksaan pasien."}</p></div></RecordCard>
    </div>}
    <DailyCheckIns ilham={ilham} />
  </div>;
}

function ConditionAssessment({ profile }: { profile: Profile }) {
  const { patientAssessments, riskReviews, approvePatientAssessment, notify } = useNurseData();
  const ilham = profile.patient.id === "RM-2026-001";
  const draftSummary = ilham ? ilhamAssessmentDraft : `Ringkasan data contoh: ${profile.reason}. Draf ini perlu diverifikasi perawat.`;
  const approved = patientAssessments[profile.patient.id];
  const [risk, setRisk] = useState<PatientRisk>(riskReviews[profile.patient.id] ?? profile.risk);
  const [summary, setSummary] = useState(approved?.summary ?? draftSummary);
  const [error, setError] = useState(false);
  const saved = approved?.summary === summary.trim() && riskReviews[profile.patient.id] === risk;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approvePatientAssessment(profile.patient.id, { risk, summary })) { setError(true); return; }
    notify(`Penilaian kondisi ${profile.patient.name} disetujui.`);
  }
  return <div className="patient-assessment-columns">
    <RecordCard title={<><Sparkles size={18} aria-hidden="true" />Penilaian kondisi</>}>
      <form className="patient-assessment-form" onSubmit={submit}>
        <fieldset><legend>Kategori risiko <span>(draf AI: {riskOptions.find((item) => item.value === profile.risk)?.label})</span></legend><div className="patient-risk-options">{riskOptions.map(({ value, label }) => <label key={value} className={risk === value ? "is-selected" : ""}><input name="assessment-risk" type="radio" value={value} checked={risk === value} onChange={() => setRisk(value)} /><span>{label}</span></label>)}</div></fieldset>
        <label className="patient-assessment-summary">Ringkasan penilaian<textarea required maxLength={5000} value={summary} onChange={(event) => { setSummary(event.target.value); setError(false); }} /></label>
        {error && <p className="patient-form-error" role="alert">Isi ringkasan penilaian sebelum menyetujui.</p>}
        <div className="patient-assessment-actions"><button className="button button-primary" type="submit" disabled={saved}><Check size={16} aria-hidden="true" />{saved ? "Penilaian disetujui" : "Setujui penilaian"}</button><button type="button" className="button patient-outline-button" onClick={() => { setRisk(profile.risk); setSummary(draftSummary); setError(false); }}>Kembali ke draf AI</button></div>
      </form>
    </RecordCard>
    <RecordCard title="Dasar penilaian"><div className="patient-assessment-basis"><p>Data yang dibaca AI untuk menyusun draf, per sumber:</p><dl>
      <Detail label="Check-in harian">{ilham ? "10 Nov: pusing ringan · 9 Nov: obat terlewat sebagian" : `${profile.checkIn}: ${profile.complaint ? "ada keluhan" : "baik-baik saja"}`}</Detail>
      <Detail label="Skrining pemesanan">{ilham ? "12 Nov: keluhan lemas dua hari, nafsu makan menurun" : "Belum tersedia"}</Detail>
      <Detail label="Tanda vital terakhir">{ilham ? "36,8 °C · 78 bpm · 120/80 · batas: [ditetapkan tim klinis]" : "Belum tersedia"}</Detail>
    </dl><small>Draf contoh berdasarkan data yang tersedia. Keputusan akhir ada pada perawat.</small></div></RecordCard>
  </div>;
}

function CareHistory({ profile }: { profile: Profile }) {
  const { visits, medicalRecords } = useNurseData();
  const ilham = profile.patient.id === "RM-2026-001";
  const entries: { id: string; date: string; record: VisitMedicalRecord; example?: boolean }[] = visits.filter((visit) => visit.patient.id === profile.patient.id && visit.status === "done" && medicalRecords[visit.id]).toSorted((a,b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)).map((visit) => ({ id: visit.id, date: visit.date, record: medicalRecords[visit.id] }));
  // Contoh riwayat pada PNG ditampilkan sebelum ada catatan selesai di sesi demo.
  if (ilham && entries.length === 0) entries.push({ id: "history-example", date: "2026-11-12", example: true, record: {
    nurseName: nurse.name, nurseId: nurse.id, startedAt: "14.00", endedAt: "14.45", procedures: "Pemeriksaan tanda vital dan observasi kondisi umum pasien.",
    systolic: "120", diastolic: "80", temperature: "36,8", heartRate: "78", consciousness: "Sadar penuh", observations: "Pasien tampak lemas ringan.", noSuppliesUsed: false,
    supplies: [{ id: "gloves", name: "Sarung tangan", kind: "Bahan", quantity: "2", unit: "pasang" }, { id: "gauze", name: "Kassa steril", kind: "Bahan", quantity: "4", unit: "lembar" }, { id: "bp", name: "Tensimeter", kind: "Alat", quantity: "1", unit: "buah" }],
  } });
  return <div className="patient-equal-columns patient-care-columns">
    <RecordCard title="Rencana tindakan dan instruksi"><dl className="patient-record-details patient-care-plan">
      <Detail label="Rencana tindakan"><Placeholder>[Rencana tindakan · disusun perawat dan dokter]</Placeholder></Detail>
      <Detail label="Instruksi obat">{ilham ? "Obat A pukul 08.00 · Obat B pukul 20.00 · dosis sesuai resep dokter" : "Belum tersedia"}</Detail>
      <Detail label="Jadwal perawatan luka"><Placeholder>[Jadwal perawatan luka · diisi perawat]</Placeholder></Detail>
      <div className="patient-two-details"><Detail label="Perawat yang menangani">{nurse.name} ({nurse.id})</Detail><Detail label="Dokter">{ilham ? "dr. Andini Pratama" : "Belum tersedia"}</Detail></div>
    </dl></RecordCard>
    <RecordCard title="Riwayat kunjungan dan tindakan"><div className="patient-care-entries">{entries.length ? entries.map(({ id, date, record, example }) => <article className="patient-care-entry" key={id}>
      <div className="patient-care-entry-heading"><h3>{formatVisitDate(date)} · {record.startedAt}–{record.endedAt}</h3><span className="patient-care-done">Selesai</span></div>
      <dl className="patient-record-details"><Detail label="Perawat penanggung jawab">{record.nurseName} ({record.nurseId})</Detail><Detail label="Tindakan yang dilakukan">{record.procedures}</Detail><Detail label="Alat dan bahan medis">{record.supplies.length ? record.supplies.map((item) => `${item.name} ${item.quantity} ${item.unit}`).join(" · ") : "Tidak menggunakan alat atau bahan medis"}</Detail></dl>
      {!example && <Link className="text-button" href={`/jadwal-kunjungan/${id}`}>Lihat catatan kunjungan</Link>}
    </article>) : <p className="patient-empty">Belum ada riwayat kunjungan selesai untuk pasien ini.</p>}</div></RecordCard>
  </div>;
}
