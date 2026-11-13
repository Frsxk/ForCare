"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  requestStatusLabels,
  type HomecareRequest,
} from "@/lib/dashboard-data";
import type { HomecareRequestDetail } from "@/lib/homecare-request-details";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import { HomecareDecision } from "@/components/homecare-decision";

export function HomecareRequestDetailPage({
  initialRequest,
  detail,
}: {
  initialRequest: HomecareRequest;
  detail: HomecareRequestDetail;
}) {
  const { requests } = useNurseData();
  const request =
    requests.find((item) => item.id === initialRequest.id) ?? initialRequest;
  const vitals = [
    { label: "Tekanan darah", value: detail.screening.bloodPressure },
    { label: "Suhu tubuh", value: detail.screening.bodyTemperature },
    { label: "Detak jantung", value: detail.screening.heartRate },
    { label: "Tingkat kesadaran", value: detail.screening.consciousness },
  ];

  return (
    <>
      <NurseHeader activePage="requests" />
      <main id="konten-utama" className="dashboard-main homecare-detail-main">
        <Link href="/pengajuan-homecare" className="back-to-requests">
          <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
          Kembali ke Pengajuan
        </Link>
        <div className="request-detail-heading">
          <h1>
            Pengajuan {request.id} · {request.patient.name}
          </h1>
          <div className="request-detail-meta">
            <p>Diajukan {detail.submittedAt}</p>
            <span className={`request-status request-status-${request.status}`}>
              {requestStatusLabels[request.status]}
            </span>
          </div>
        </div>

        <div className="request-detail-grid">
          <div className="request-detail-left">
            <section
              className="card request-identity-card"
              aria-labelledby="identity-title"
            >
              <div className="section-header teal-header">
                <h2 id="identity-title">Identitas pasien</h2>
              </div>
              <dl className="identity-fields">
                <div>
                  <dt>RM</dt>
                  <dd>{request.patient.id}</dd>
                </div>
                <div>
                  <dt>Usia / jenis kelamin</dt>
                  <dd>{detail.identity.ageAndSex}</dd>
                </div>
                <div>
                  <dt>Keluar RS</dt>
                  <dd>{detail.identity.dischargedAt}</dd>
                </div>
                <div>
                  <dt>Telepon</dt>
                  <dd>{detail.identity.phone}</dd>
                </div>
              </dl>
            </section>

            <section
              className="card request-screening-card"
              aria-labelledby="screening-title"
            >
              <div className="section-header teal-header">
                <h2 id="screening-title">Screening dan anamnesis</h2>
              </div>
              <div className="request-screening-body">
                <dl className="screening-complaint">
                  <div>
                    <dt>Keluhan utama</dt>
                    <dd>{detail.screening.chiefComplaint}</dd>
                  </div>
                </dl>
                <dl className="screening-vitals">
                  {vitals.map((vital) => (
                    <div key={vital.label}>
                      <dt>{vital.label}</dt>
                      <dd>{vital.value}</dd>
                    </div>
                  ))}
                </dl>
                <dl className="screening-history">
                  <div>
                    <dt>Riwayat kondisi harian</dt>
                    <dd>{detail.screening.dailyCondition}</dd>
                  </div>
                  <div>
                    <dt>Kondisi fisik umum</dt>
                    <dd>{detail.screening.physicalCondition}</dd>
                  </div>
                </dl>
              </div>
            </section>

            <HomecareDecision key={request.id} request={request} />
          </div>

          <aside
            className="request-detail-sidebar"
            aria-label="Ringkasan dan jadwal pengajuan"
          >
            <section className="request-risk-card" aria-labelledby="risk-title">
              <div className="section-header attention-header">
                <h2 id="risk-title">Ringkasan risiko</h2>
                <span className="ai-badge">Draf AI</span>
              </div>
              <div className="request-risk-body">
                <span className={`risk-badge risk-${detail.risk.level}`}>
                  {detail.risk.label}
                </span>
                <p>
                  <strong>Keluhan utama:</strong> {detail.risk.chiefComplaint}
                </p>
                <p>
                  <strong>Tanda vital:</strong> {detail.risk.vitalNote}
                </p>
              </div>
            </section>

            <section
              className="card request-schedule-card"
              aria-labelledby="schedule-title"
            >
              <div className="section-header teal-header">
                <h2 id="schedule-title">Jadwal diminta</h2>
              </div>
              <dl className="requested-schedule-fields">
                <div>
                  <dt>Tanggal</dt>
                  <dd>{detail.requestedDate}</dd>
                </div>
                <div>
                  <dt>Jam</dt>
                  <dd>{detail.requestedTime}</dd>
                </div>
                <div>
                  <dt>Dokter</dt>
                  <dd>{request.doctor}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
