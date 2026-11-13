"use client";

import { riskLabels } from "@/lib/patient-directory-data";
import { Check } from "lucide-react";
import { attentionItems, nurse, type Patient } from "@/lib/dashboard-data";
import { Avatar, PatientIdentity } from "@/components/patient-identity";
import { useNurseData } from "@/components/nurse-data-provider";

export function PatientReview({
  patient,
  onClose,
}: {
  patient: Patient;
  onClose: () => void;
}) {
  const { reviewedPatients, reviewPatient, notify, riskReviews } = useNurseData();
  const attention = attentionItems.find(
    (item) => item.patient.id === patient.id,
  );
  const reviewed = reviewedPatients.includes(patient.id);

  return (
    <>
      <div className="detail-identity">
        <Avatar initials={patient.initials} />
        <PatientIdentity patient={patient} />
      </div>
      {attention ? (
        <>
          <div className="detail-section">
            <div className="detail-label-row">
              <h3>Ringkasan perhatian</h3>
              <span className="ai-badge">Draf AI</span>
            </div>
            <p>{attention.reason}</p>
            <span className={`risk-badge risk-${riskReviews[patient.id] ?? attention.risk}`}>
              {riskLabels[riskReviews[patient.id] ?? attention.risk]}
            </span>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Sumber data</dt>
              <dd>{attention.source}</dd>
            </div>
            <div>
              <dt>Status peninjauan</dt>
              <dd>{reviewed ? "Sudah ditinjau" : "Belum ditinjau"}</dd>
            </div>
            <div>
              <dt>Perawat</dt>
              <dd>{nurse.name}</dd>
            </div>
          </dl>
          <div className="modal-footer">
            <button
              className="button button-primary"
              disabled={reviewed}
              onClick={() => {
                reviewPatient(patient.id);
                notify(`Data ${patient.name} sudah ditandai sebagai ditinjau.`);
                onClose();
              }}
            >
              <Check size={17} aria-hidden="true" />
              {reviewed ? "Sudah ditinjau" : "Tandai sudah ditinjau"}
            </button>
          </div>
        </>
      ) : (
        <div className="detail-section">
          <h3>Rekam medis</h3>
          <p>Belum ada ringkasan check-in untuk pasien ini pada data contoh.</p>
        </div>
      )}
    </>
  );
}
