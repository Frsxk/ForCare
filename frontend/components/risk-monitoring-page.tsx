"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, UsersRound, TriangleAlert, CircleAlert, ShieldCheck, Search, Check } from "lucide-react";
import { patientDirectory, riskLabels, type PatientRisk } from "@/lib/patient-directory-data";
import { NurseHeader } from "@/components/nurse-header";
import { PatientIdentity } from "@/components/patient-identity";
import { useNurseData } from "@/components/nurse-data-provider";
import "./risk-monitoring.css";

const monitoringPatients = [4, 1, 0, 2, 3, 5].map((index) => patientDirectory[index]);
const riskOptions: { value: PatientRisk; label: string }[] = [
  { value: "low", label: "Rendah" },
  { value: "medium", label: "Sedang" },
  { value: "high", label: "Tinggi" },
];

export function RiskMonitoringPage() {
  return <Suspense fallback={<main className="dashboard-main" role="status">Memuat pemantauan risiko...</main>}><RiskMonitoringContent /></Suspense>;
}

function RiskMonitoringContent() {
  const { riskReviews, approvePatientRisk, notify } = useNurseData();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(() => {
    const requestedId = searchParams.get("patientId");
    return monitoringPatients.some(({ patient }) => patient.id === requestedId)
      ? requestedId!
      : monitoringPatients[0].patient.id;
  });
  const [choices, setChoices] = useState<Record<string, PatientRisk>>({});
  useEffect(() => {
    const requestedId = searchParams.get("patientId");
    if (monitoringPatients.some(({ patient }) => patient.id === requestedId)) {
      setSelectedId(requestedId!);
    }
  }, [searchParams]);
  const selected = monitoringPatients.find((item) => item.patient.id === selectedId)!;
  const selectedRisk = riskReviews[selectedId] ?? selected.risk;
  const choice = choices[selectedId] ?? selectedRisk;
  const approved = riskReviews[selectedId] !== undefined;
  const unchangedApproval = approved && choice === selectedRisk;
  const query = search.trim().toLocaleLowerCase("id-ID");
  const visible = monitoringPatients.filter(({ patient }) => `${patient.name} ${patient.id}`.toLocaleLowerCase("id-ID").includes(query));
  const stats = [
    { label: "Total pasien", value: patientDirectory.length, icon: UsersRound, tone: "cream" },
    { label: "Risiko tinggi", value: patientDirectory.filter((item) => (riskReviews[item.patient.id] ?? item.risk) === "high").length, icon: TriangleAlert, tone: "blue" },
    { label: "Risiko sedang", value: patientDirectory.filter((item) => (riskReviews[item.patient.id] ?? item.risk) === "medium").length, icon: CircleAlert, tone: "cream" },
    { label: "Risiko rendah", value: patientDirectory.filter((item) => (riskReviews[item.patient.id] ?? item.risk) === "low").length, icon: ShieldCheck, tone: "blue" },
  ];

  return <>
    <NurseHeader activePage="patients" />
    <main id="konten-utama" className="dashboard-main risk-monitoring-main">
      <Link className="risk-back-link" href="/pasien-rekam-medis"><ArrowLeft size={16} aria-hidden="true" /> Kembali ke Pasien &amp; Rekam Medis</Link>
      <div className="page-heading risk-monitoring-heading">
        <h1>Pemantauan Risiko</h1>
        <p>Tingkat risiko setiap pasien dihitung dari check-in harian dan skrining pemesanan</p>
      </div>
      <section className="stats risk-monitoring-stats" aria-label="Ringkasan tingkat risiko">
        {stats.map(({ label, value, icon: Icon, tone }) => <div className="stat" key={label}>
          <span className={`stat-icon stat-icon-${tone}`}><Icon size={25} strokeWidth={1.9} aria-hidden="true" /></span>
          <div><p className="stat-label">{label}</p><p className="stat-value">{value}</p></div>
        </div>)}
      </section>
      <div className="risk-monitoring-layout">
        <section className="risk-monitoring-card risk-list-card" aria-label="Daftar risiko pasien">
          <div className="risk-search-header">
            <label className="search-field risk-monitoring-search"><Search size={19} aria-hidden="true" /><span className="sr-only">Cari nama atau nomor RM</span>
              <input type="search" value={search} placeholder="Cari nama atau nomor RM" onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <p className="sr-only" role="status">{visible.length} pasien ditampilkan</p>
          <div className="risk-table-scroll" role="region" aria-label="Tabel tingkat risiko pasien" tabIndex={0}>
            <table className="risk-monitoring-table">
              <caption className="sr-only">Pilih pasien untuk meninjau tingkat risiko</caption>
              <colgroup><col className="risk-col-patient" /><col className="risk-col-level" /><col className="risk-col-factor" /><col className="risk-col-updated" /></colgroup>
              <thead><tr><th scope="col">Pasien</th><th scope="col">Tingkat risiko</th><th scope="col">Faktor utama</th><th scope="col">Diperbarui</th></tr></thead>
              <tbody>{visible.map(({ patient, risk, reason, checkIn }) => <tr key={patient.id} className={selectedId === patient.id ? "is-selected" : ""}>
                <td><button className="risk-patient-select" aria-label={`Tinjau risiko ${patient.name}`} aria-pressed={selectedId === patient.id} onClick={() => setSelectedId(patient.id)}><PatientIdentity patient={patient} /></button></td>
                <td><span className={`risk-badge risk-${riskReviews[patient.id] ?? risk}`}>{riskLabels[riskReviews[patient.id] ?? risk]}</span><small>{riskReviews[patient.id] ? "Disetujui perawat" : "Draf AI"}</small></td>
                <td>{reason}</td><td className="risk-updated">{patient.id === "RM-2026-001" ? "12 Nov · 09.15" : checkIn}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {visible.length === 0 && <div className="empty-state"><h2>Pasien tidak ditemukan</h2><p>Coba nama atau nomor RM lain.</p><button className="text-button" onClick={() => setSearch("")}>Hapus pencarian</button></div>}
        </section>
        <aside className="risk-monitoring-sidebar" aria-label="Peninjauan risiko pasien">
          <section className="risk-monitoring-card" aria-labelledby="risk-selected-name">
            <div className="risk-card-heading"><h2 id="risk-selected-name">{selected.patient.name}</h2><span className={`risk-badge risk-${selectedRisk}`}>{riskLabels[selectedRisk]}</span></div>
            <div className="risk-review-body">
              <div className="risk-review-meta"><span>{selectedId}</span><span className="risk-draft-badge">{approved ? "Disetujui perawat" : "Draf AI"}</span></div>
              <fieldset className="risk-choice-fieldset"><legend>Ubah tingkat risiko <span>(draf AI: {riskOptions.find((option) => option.value === selected.risk)?.label})</span></legend>
                <div className="risk-choices">{riskOptions.map(({ value, label }) => <label key={value} className={`risk-choice${choice === value ? " is-selected" : ""}`}><input type="radio" name="patient-risk" value={value} checked={choice === value} onChange={() => setChoices((previous) => ({ ...previous, [selectedId]: value }))} /><span>{label}</span></label>)}</div>
              </fieldset>
              <div className="risk-review-actions"><button className="button risk-approve-button" disabled={unchangedApproval} onClick={() => { approvePatientRisk(selectedId, choice); notify(`Tingkat risiko ${selected.patient.name} disetujui: ${riskLabels[choice].toLowerCase()}.`); }}>{unchangedApproval ? "Sudah disetujui" : "Setujui tingkat risiko"}</button><Link className="button risk-record-button" href={`/pasien-rekam-medis/${selectedId}`}>Rekam medis</Link></div>
            </div>
          </section>
          <section className="risk-monitoring-card" aria-labelledby="risk-basis-title">
            <div className="risk-card-heading risk-basis-heading"><h2 id="risk-basis-title">Dasar penilaian</h2></div>
            <ul className="risk-basis-list">{["Check-in harian", "Skrining pemesanan", "Tanda vital terakhir"].map((label) => <li key={label}><span><Check size={14} strokeWidth={3} aria-hidden="true" /></span>{label}</li>)}</ul>
          </section>
        </aside>
      </div>
    </main>
  </>;
}
