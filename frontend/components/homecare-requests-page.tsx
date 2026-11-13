"use client";

import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { requestStatusLabels, type RequestStatus } from "@/lib/dashboard-data";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import { PatientIdentity } from "@/components/patient-identity";

const filters: { value: "all" | RequestStatus; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "pending", label: "Menunggu" },
  { value: "accepted", label: "Diterima" },
  { value: "rejected", label: "Ditolak" },
];

export function HomecareRequestsPage() {
  const { requests } = useNurseData();
  const [filter, setFilter] = useState<"all" | RequestStatus>("all");
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase("id-ID");
  const visibleRequests = requests.filter(
    (request) =>
      (filter === "all" || request.status === filter) &&
      `${request.patient.name} ${request.patient.id}`
        .toLocaleLowerCase("id-ID")
        .includes(query),
  );

  return (
    <>
      <NurseHeader activePage="requests" />
      <main id="konten-utama" className="dashboard-main homecare-main">
        <section aria-labelledby="homecare-title">
          <div className="page-heading">
            <h1 id="homecare-title">Pengajuan Homecare</h1>
            <p>Tinjau dan putuskan pengajuan dari pasien Anda</p>
          </div>
          <div className="homecare-toolbar">
            <div
              className="status-filters"
              role="group"
              aria-label="Filter status pengajuan"
            >
              {filters.map((item) => (
                <button
                  key={item.value}
                  className={`status-filter${filter === item.value ? " is-selected" : ""}`}
                  aria-pressed={filter === item.value}
                  onClick={() => setFilter(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="search-field homecare-search">
              <Search size={18} strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">Cari nama pasien atau nomor RM</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Cari nama pasien atau nomor RM"
              />
            </label>
            <p className="sr-only" role="status" aria-live="polite">
              {visibleRequests.length} pengajuan ditampilkan
            </p>
          </div>
          <div
            className="homecare-table-wrap"
            role="region"
            aria-label="Daftar pengajuan homecare"
            tabIndex={0}
          >
            <table className="homecare-table">
              <caption className="sr-only">
                Pengajuan homecare pasien dan status peninjauannya
              </caption>
              <colgroup>
                <col className="hc-col-patient" />
                <col className="hc-col-id" />
                <col className="hc-col-schedule" />
                <col className="hc-col-doctor" />
                <col className="hc-col-status" />
                <col className="hc-col-action" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Pasien</th>
                  <th scope="col">Pengajuan</th>
                  <th scope="col">Jadwal diminta</th>
                  <th scope="col">Dokter</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Tindakan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRequests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <PatientIdentity patient={request.patient} />
                    </td>
                    <td>{request.id}</td>
                    <td>{request.schedule}</td>
                    <td>{request.doctor}</td>
                    <td>
                      <span
                        className={`request-status request-status-${request.status}`}
                      >
                        {requestStatusLabels[request.status]}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="button button-primary button-small request-review"
                        href={`/pengajuan-homecare/${request.id}`}
                        aria-label={`Tinjau pengajuan ${request.patient.name}`}
                      >
                        Tinjau
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRequests.length === 0 && (
              <div className="empty-state homecare-empty">
                <Search size={30} aria-hidden="true" />
                <h2>
                  {query
                    ? "Pengajuan tidak ditemukan"
                    : `Belum ada pengajuan ${requestStatusLabels[filter === "all" ? "pending" : filter].toLowerCase()}`}
                </h2>
                <p>
                  {query
                    ? "Coba nama pasien atau nomor RM lain, atau ubah filter status."
                    : "Pengajuan dengan status ini akan ditampilkan di sini."}
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Atur ulang filter
                </button>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
