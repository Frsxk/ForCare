"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { patientDirectory, riskLabels, type PatientRisk } from "@/lib/patient-directory-data";
import { formatPatientDate } from "@/lib/patient-record-data";
import { formatVisitDate, visitDemoDate } from "@/lib/visit-data";
import { NurseHeader } from "@/components/nurse-header";
import { PatientIdentity } from "@/components/patient-identity";
import { useNurseData } from "@/components/nurse-data-provider";
import "./patient-directory.css";

const filters: { value: "all" | PatientRisk; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "high", label: riskLabels.high },
  { value: "medium", label: riskLabels.medium },
  { value: "low", label: riskLabels.low },
];

export function PatientDirectoryPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | PatientRisk>("all");
  const { visits, requests, riskReviews, patientHistories } = useNurseData();
  const query = search.trim().toLocaleLowerCase("id-ID");
  const visible = patientDirectory.map((item) => ({ ...item, risk: riskReviews[item.patient.id] ?? item.risk, discharged: patientHistories[item.patient.id]?.discharged ? formatPatientDate(patientHistories[item.patient.id].discharged) : item.discharged })).filter(({ patient, risk }) =>
    (filter === "all" || risk === filter) && `${patient.name} ${patient.id}`.toLocaleLowerCase("id-ID").includes(query),
  );

  function nextVisit(patientId: string) {
    const next = visits.filter((visit) => visit.patient.id === patientId &&
      (visit.date > visitDemoDate || (visit.date === visitDemoDate && visit.status === "scheduled")))
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
    if (next) return `${next.date === visitDemoDate ? "Hari ini" : formatVisitDate(next.date, true)} · ${next.time}`;
    if (requests.some((request) => request.patient.id === patientId && request.status === "pending")) return "Menunggu konfirmasi";
    return "-";
  }

  return <>
    <NurseHeader activePage="patients" />
    <main id="konten-utama" className="dashboard-main patient-directory-main">
      <section aria-labelledby="patients-title">
        <div className="page-heading patient-directory-heading">
          <div><h1 id="patients-title">Pasien &amp; Rekam Medis</h1><p>Pasien dalam pemantauan Anda</p></div>
          <Link className="button button-primary" href="/pemantauan-risiko">Pemantauan Risiko</Link>
        </div>
        <div className="patient-directory-card">
          <div className="patient-directory-toolbar">
            <label className="search-field patient-directory-search">
              <Search size={19} strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">Cari nama pasien atau nomor RM</span>
              <input type="search" placeholder="Cari nama pasien atau nomor RM" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <div className="patient-risk-filters" role="group" aria-label="Filter tingkat risiko">
              {filters.map((item) => <button key={item.value} aria-pressed={filter === item.value} className={`patient-risk-filter${filter === item.value ? " is-selected" : ""}`} onClick={() => setFilter(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <p className="sr-only" role="status">{visible.length} pasien ditampilkan</p>
          <div className="patient-directory-scroll" role="region" aria-label="Daftar pasien dan rekam medis" tabIndex={0}>
            <table className="patient-directory-table">
              <caption className="sr-only">Pasien dalam pemantauan, check-in terakhir, risiko, dan kunjungan berikutnya</caption>
              <colgroup>{["patient", "age", "discharge", "checkin", "risk", "visit", "action"].map((column) => <col key={column} className={`pd-col-${column}`} />)}</colgroup>
              <thead><tr>
                <th scope="col">Pasien</th><th scope="col">Usia · JK</th><th scope="col">Keluar RS</th><th scope="col">Check-in terakhir</th>
                <th scope="col">Tingkat risiko <span className="ai-badge">Draf AI</span></th><th scope="col">Kunjungan berikutnya</th><th scope="col"><span className="sr-only">Tindakan</span></th>
              </tr></thead>
              <tbody>{visible.map(({ patient, age, sex, discharged, checkIn, complaint, risk, reason }) => <tr key={patient.id}>
                <td><PatientIdentity patient={patient} /></td>
                <td>{age} th · {sex}</td><td>{discharged}</td>
                <td><span className={`risk-badge ${complaint ? "risk-medium" : "risk-low"}`}>{complaint ? "Ada keluhan" : "Baik-baik saja"}</span><small>{checkIn}</small></td>
                <td><span className={`risk-badge risk-${risk}`}>{riskLabels[risk]}</span><small>{reason}</small></td>
                <td>{nextVisit(patient.id)}</td>
                <td><Link className="button button-small patient-record-button" aria-label={`Buka rekam medis ${patient.name}`} href={`/pasien-rekam-medis/${patient.id}`}>Buka rekam medis</Link></td>
              </tr>)}</tbody>
            </table>
          </div>
          {visible.length === 0 && <div className="empty-state"><Search size={30} aria-hidden="true" /><h2>Pasien tidak ditemukan</h2><p>Coba nama atau nomor RM lain, atau ubah filter risiko.</p><button className="text-button" onClick={() => { setSearch(""); setFilter("all"); }}>Atur ulang filter</button></div>}
        </div>
      </section>
    </main>

  </>;
}
