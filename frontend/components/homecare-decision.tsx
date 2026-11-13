"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import type { HomecareRequest } from "@/lib/dashboard-data";
import { useNurseData } from "@/components/nurse-data-provider";

export function HomecareDecision({ request }: { request: HomecareRequest }) {
  const { decideRequest, notify } = useNurseData();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  function decide(status: "accepted" | "rejected") {
    if (
      request.status !== "pending" ||
      (status === "rejected" && !reason.trim())
    )
      return;
    decideRequest(request.id, status, reason);
    notify(
      `Pengajuan ${request.id} berhasil ${status === "accepted" ? "diterima" : "ditolak"}.`,
    );
  }

  return (
    <section
      className="card request-decision-card"
      aria-labelledby="decision-title"
    >
      <div className="section-header teal-header">
        <h2 id="decision-title">Keputusan perawat</h2>
      </div>
      <div className="request-decision-body">
        {request.status === "pending" ? (
          <>
            <p>
              Periksa data pasien, lalu terima atau tolak pengajuan ini.
              Penolakan wajib disertai alasan.
            </p>
            {rejecting ? (
              <form
                className="rejection-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  decide("rejected");
                }}
              >
                <label htmlFor="rejection-reason">
                  Alasan penolakan <span aria-hidden="true">*</span>
                </label>
                <textarea
                  id="rejection-reason"
                  rows={3}
                  maxLength={500}
                  required
                  autoFocus
                  placeholder="Tuliskan alasan pengajuan ditolak"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <div className="decision-form-actions">
                  <button
                    type="button"
                    className="button button-soft"
                    onClick={() => setRejecting(false)}
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    className="button button-danger"
                    disabled={!reason.trim()}
                  >
                    Tolak pengajuan
                  </button>
                </div>
              </form>
            ) : (
              <div className="request-decision-actions">
                <button
                  className="button button-accept"
                  onClick={() => decide("accepted")}
                >
                  Terima pengajuan
                </button>
                <button
                  className="button button-danger-outline"
                  onClick={() => setRejecting(true)}
                >
                  Tolak pengajuan
                </button>
              </div>
            )}
          </>
        ) : (
          <div className={`decision-result decision-result-${request.status}`}>
            {request.status === "accepted" ? (
              <CheckCircle2 size={26} aria-hidden="true" />
            ) : (
              <XCircle size={26} aria-hidden="true" />
            )}
            <div>
              <h3>
                Pengajuan{" "}
                {request.status === "accepted" ? "diterima" : "ditolak"}
              </h3>
              <p>
                {request.status === "accepted"
                  ? "Pengajuan ini sudah diterima."
                  : request.rejectionReason ||
                    "Alasan penolakan belum tersedia."}
              </p>
              <Link className="text-button" href="/pengajuan-homecare">
                Kembali ke Pengajuan
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
