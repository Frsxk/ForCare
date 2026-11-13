"use client";
import Link from "next/link";
import {
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ClipboardClock,
  UsersRound,
} from "lucide-react";
import {
  attentionItems,
  dashboardDate,
  nurse,
  patients,
} from "@/lib/dashboard-data";
import { riskLabels } from "@/lib/patient-directory-data";
import { formatVisitDate, visitDemoDate } from "@/lib/visit-data";
import { Avatar, PatientIdentity } from "@/components/patient-identity";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
export function NurseDashboard() {
  const { requests, reviewedPatients, visits, riskReviews } = useNurseData();
  const todayVisits = visits
    .filter((visit) => visit.date === visitDemoDate)
    .map((visit) => ({ ...visit, needsRecord: visit.status === "scheduled" }));
  const upcomingVisits = visits
    .filter((visit) => visit.date > visitDemoDate)
    .toSorted((a, b) =>
      `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
    )
    .slice(0, 2)
    .map((visit) => ({
      ...visit,
      schedule: `${formatVisitDate(visit.date, true)} · ${visit.time}`,
    }));
  const pendingRequestCount = requests.filter(
    (request) => request.status === "pending",
  ).length;
  const stats = [
    {
      label: "Total pasien",
      value: patients.length,
      icon: UsersRound,
      tone: "cream",
    },
    {
      label: "Pengajuan menunggu",
      value: pendingRequestCount,
      icon: ClipboardClock,
      tone: "blue",
    },
    {
      label: "Kunjungan hari ini",
      value: todayVisits.length,
      icon: CalendarCheck,
      tone: "cream",
    },
    {
      label: "Selesai hari ini",
      value: `${todayVisits.filter((visit) => visit.status === "done").length} / ${todayVisits.length}`,
      icon: CheckCircle2,
      tone: "blue",
    },
  ];

  return (
    <>
      <NurseHeader activePage="dashboard" />
      <main id="konten-utama" className="dashboard-main">
        <section
          className="welcome"
          id="beranda"
          aria-labelledby="welcome-title"
        >
          <div>
            <h1 id="welcome-title">Selamat siang, {nurse.firstName}</h1>
            <p>{dashboardDate}</p>
          </div>
          <Link
            href="/pengajuan-homecare"
            className="button button-primary welcome-action"
          >
            Tinjau pengajuan
          </Link>
        </section>

        <section className="stats" aria-label="Ringkasan aktivitas perawat">
          {stats.map(({ label, value, icon: Icon, tone }) => (
            <div className="stat" key={label}>
              <span className={`stat-icon stat-icon-${tone}`}>
                <Icon size={25} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <div>
                <p className="stat-label">{label}</p>
                <p className="stat-value">{value}</p>
              </div>
            </div>
          ))}
        </section>

        <section
          className="card attention-card"
          aria-labelledby="attention-title"
        >
          <div className="section-header attention-header">
            <h2 id="attention-title">Perlu perhatian</h2>
            <span className="ai-badge">Draf AI</span>
          </div>
          <div
            className="attention-table-wrap"
            role="region"
            aria-label="Pasien yang perlu perhatian"
            tabIndex={0}
          >
            <table className="attention-table">
              <colgroup>
                <col className="col-patient" />
                <col className="col-risk" />
                <col className="col-reason" />
                <col className="col-source" />
                <col className="col-action" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Pasien</th>
                  <th scope="col">Tingkat risiko</th>
                  <th scope="col">Faktor utama</th>
                  <th scope="col">Sumber data</th>
                  <th scope="col">
                    <span className="sr-only">Tindakan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {attentionItems.map((item) => {
                  const reviewed = reviewedPatients.includes(item.patient.id);
                  return (
                    <tr key={item.patient.id}>
                      <td>
                        <PatientIdentity patient={item.patient} />
                      </td>
                      <td>
                        <span className={`risk-badge risk-${riskReviews[item.patient.id] ?? item.risk}`}>
                          {riskLabels[riskReviews[item.patient.id] ?? item.risk]}
                        </span>
                      </td>
                      <td className="reason-cell">{item.reason}</td>
                      <td className="source-cell">{item.source}</td>
                      <td className="action-cell">
                        <Link
                          className={`button button-primary button-small${reviewed ? " button-reviewed" : ""}`}
                          href={`/pemantauan-risiko?patientId=${encodeURIComponent(item.patient.id)}`}
                          aria-label={`${reviewed ? "Lihat hasil tinjauan" : "Tinjau pasien"} ${item.patient.name}`}
                        >
                          {reviewed ? "Ditinjau" : "Tinjau"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="dashboard-grid">
          <section
            className="card requests-card"
            id="pengajuan"
            aria-labelledby="requests-title"
          >
            <div className="section-header teal-header">
              <h2 id="requests-title">Pengajuan terbaru</h2>
              <Link
                href="/pengajuan-homecare"
                className="button button-white button-small"
              >
                Lihat semua
              </Link>
            </div>
            <ul className="request-list">
              {requests.slice(0, 3).map((request) => (
                <li className="request-row" key={request.id}>
                  <div className="request-patient">
                    <Avatar initials={request.patient.initials} />
                    <div className="patient-identity">
                      <strong>{request.patient.name}</strong>
                      <span className="secondary-text">
                        {request.patient.id} · {request.id}
                      </span>
                    </div>
                  </div>
                  <span className="request-schedule">{request.schedule}</span>
                  <span className="request-doctor">{request.doctor}</span>
                  <Link
                    className={`button button-primary button-small request-review${request.status !== "pending" ? " button-reviewed" : ""}`}
                    href={`/pengajuan-homecare/${request.id}`}
                    aria-label={`Tinjau pengajuan ${request.patient.name}`}
                  >
                    {request.status !== "pending" ? "Ditinjau" : "Tinjau"}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="card visits-card" aria-labelledby="visits-title">
            <div className="section-header teal-header">
              <h2 id="visits-title">Kunjungan hari ini</h2>
            </div>
            <ul className="visit-list">
              {todayVisits.map((visit) => (
                <li key={visit.patient.id} className="visit-row">
                  <div>
                    <strong>
                      {visit.time} · {visit.patient.name}
                    </strong>
                    <span className="secondary-text">
                      {visit.patient.id}
                      {visit.needsRecord ? " · isi rekam medis" : ""}
                    </span>
                  </div>
                  <span className={`visit-status status-${visit.status}`}>
                    {visit.status === "done" ? "Selesai" : "Terjadwal"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section
            className="card upcoming-card"
            id="jadwal"
            aria-labelledby="upcoming-title"
          >
            <div className="section-header mint-header">
              <h2 id="upcoming-title">Jadwal terdekat</h2>
            </div>
            <ul className="upcoming-list">
              {upcomingVisits.map((visit) => (
                <li className="upcoming-row" key={visit.patient.id}>
                  <span className="calendar-icon">
                    <CalendarDays
                      size={19}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>
                  <div>
                    <strong>{visit.schedule}</strong>
                    <span className="secondary-text">
                      {visit.patient.name} · {visit.patient.id}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
