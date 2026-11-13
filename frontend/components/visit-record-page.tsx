"use client";

import Link from "next/link";
import {
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ArrowLeft, Check, Circle, Plus, X } from "lucide-react";
import { formatVisitDate, type NurseVisit } from "@/lib/visit-data";
import {
  createEmptyVisitRecord,
  getRecordCompleteness,
  hasValidVisitTimes,
  patientVisitReferences,
  unavailableVisitReference,
  type MedicalSupply,
  type VisitMedicalRecord,
} from "@/lib/visit-medical-record";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import "./patient-medical-history.css";
import "./visit-record.css";

function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`medical-field ${className}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

function UnitInput({
  unit,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { unit: string }) {
  return (
    <div className="medical-unit-input">
      <input {...props} />
      <span aria-hidden="true">{unit}</span>
    </div>
  );
}

export function VisitRecordPage({
  initialVisit,
}: {
  initialVisit: NurseVisit;
}) {
  const {
    visits,
    medicalRecords,
    visitDrafts,
    saveVisitDraft,
    saveMedicalRecord,
    notify,
  } = useNurseData();
  const visit =
    visits.find((item) => item.id === initialVisit.id) ?? initialVisit;
  const [record, setRecord] = useState<VisitMedicalRecord>(
    () =>
      medicalRecords[visit.id] ??
      visitDrafts[visit.id] ??
      createEmptyVisitRecord(visit),
  );
  const [attempted, setAttempted] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const newItemRef = useRef<string | null>(null);
  const completed = visit.status === "done";
  const sections = getRecordCompleteness(record);
  const completeCount = sections.filter((section) => section.complete).length;
  const reference =
    patientVisitReferences[visit.patient.id] ?? unavailableVisitReference;
  const timePattern = "(?:[01][0-9]|2[0-3])[.:][0-5][0-9]";

  function change<K extends keyof VisitMedicalRecord>(
    key: K,
    value: VisitMedicalRecord[K],
  ) {
    setRecord((previous) => ({ ...previous, [key]: value }));
    setDraftSaved(false);
  }

  function changeSupply(id: string, updates: Partial<MedicalSupply>) {
    change(
      "supplies",
      record.supplies.map((item) =>
        item.id === id ? { ...item, ...updates } : item,
      ),
    );
  }

  function addSupply() {
    const id = crypto.randomUUID();
    newItemRef.current = id;
    setRecord((previous) => ({
      ...previous,
      noSuppliesUsed: false,
      supplies: [
        ...previous.supplies,
        { id, name: "", kind: "Bahan", quantity: "1", unit: "" },
      ],
    }));
    setDraftSaved(false);
  }

  function removeSupply(id: string) {
    change(
      "supplies",
      record.supplies.filter((item) => item.id !== id),
    );
    addButtonRef.current?.focus();
  }

  return (
    <>
      <NurseHeader activePage="visits" />
      <main id="konten-utama" className="dashboard-main visit-record-main">
        <Link href="/jadwal-kunjungan" className="back-to-requests">
          <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
          Kembali ke Jadwal
        </Link>
        <div className="request-detail-heading visit-record-heading">
          <h1>Rekam Medis Kunjungan</h1>
          <p>
            {visit.patient.name} · {visit.patient.id} ·{" "}
            {formatVisitDate(visit.date)} · {visit.time}
            {completed && (
              <span className="record-completed-label">Selesai</span>
            )}
          </p>
        </div>

        <form
          ref={formRef}
          className="medical-record-layout"
          onSubmit={(event) => {
            event.preventDefault();
            if (completed) return;
            setAttempted(true);
            if (completeCount !== sections.length) {
              if (!hasValidVisitTimes(record))
                formRef.current
                  ?.querySelector<HTMLInputElement>("#record-ended-at")
                  ?.focus();
              return;
            }
            if (saveMedicalRecord(visit.id, record)) {
              setAttempted(false);
              setDraftSaved(false);
              notify(
                `Rekam medis ${visit.patient.name} tersimpan. Kunjungan ditandai selesai.`,
              );
            }
          }}
        >
          <fieldset className="medical-record-fields" disabled={completed}>
            <legend className="sr-only">
              Catatan pemeriksaan dan tindakan kunjungan
            </legend>
            <section
              className="card medical-record-card"
              aria-labelledby="record-responsibility-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-responsibility-title">
                  Penanggung jawab tindakan
                </h2>
              </div>
              <div className="record-responsibility-body">
                <Field label="Nama perawat" htmlFor="record-nurse-name">
                  <input
                    id="record-nurse-name"
                    value={record.nurseName}
                    readOnly
                    className="medical-control medical-readonly"
                  />
                </Field>
                <Field label="ID perawat" htmlFor="record-nurse-id">
                  <input
                    id="record-nurse-id"
                    value={record.nurseId}
                    readOnly
                    className="medical-control medical-readonly"
                  />
                </Field>
                <Field label="Waktu mulai" htmlFor="record-started-at">
                  <UnitInput
                    id="record-started-at"
                    unit="WIB"
                    required
                    inputMode="numeric"
                    pattern={timePattern}
                    title="Gunakan format jam HH.MM, misalnya 14.00"
                    placeholder="HH.MM"
                    value={record.startedAt}
                    onChange={(event) =>
                      change("startedAt", event.target.value)
                    }
                    onBlur={() =>
                      change("startedAt", record.startedAt.replace(":", "."))
                    }
                  />
                </Field>
                <Field label="Waktu selesai" htmlFor="record-ended-at">
                  <UnitInput
                    id="record-ended-at"
                    unit="WIB"
                    required
                    inputMode="numeric"
                    pattern={timePattern}
                    title="Gunakan format jam HH.MM, misalnya 14.45"
                    placeholder="HH.MM"
                    value={record.endedAt}
                    aria-describedby={
                      !hasValidVisitTimes(record)
                        ? "record-time-error"
                        : undefined
                    }
                    onChange={(event) => change("endedAt", event.target.value)}
                    onBlur={() =>
                      change("endedAt", record.endedAt.replace(":", "."))
                    }
                  />
                </Field>
                {!hasValidVisitTimes(record) && (
                  <p
                    id="record-time-error"
                    className="record-time-error"
                    role="status"
                  >
                    Isi waktu dengan format HH.MM. Waktu selesai harus setelah
                    waktu mulai.
                  </p>
                )}
              </div>
            </section>

            <section
              className="card medical-record-card"
              aria-labelledby="record-examination-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-examination-title">Hasil pemeriksaan pasien</h2>
              </div>
              <div className="record-examination-body">
                <div className="record-vitals-grid">
                  <Field label="Tekanan darah" htmlFor="record-systolic">
                    <div className="record-blood-pressure">
                      <input
                        id="record-systolic"
                        required
                        inputMode="numeric"
                        pattern="[1-9][0-9]*"
                        aria-label="Tekanan darah sistolik"
                        value={record.systolic}
                        onChange={(event) =>
                          change("systolic", event.target.value)
                        }
                      />
                      <span aria-hidden="true">/</span>
                      <input
                        id="record-diastolic"
                        required
                        inputMode="numeric"
                        pattern="[1-9][0-9]*"
                        aria-label="Tekanan darah diastolik"
                        value={record.diastolic}
                        onChange={(event) =>
                          change("diastolic", event.target.value)
                        }
                      />
                    </div>
                  </Field>
                  <Field label="Suhu tubuh" htmlFor="record-temperature">
                    <UnitInput
                      id="record-temperature"
                      unit="°C"
                      required
                      inputMode="decimal"
                      pattern="[0-9]{1,2}([.,][0-9]{1,2})?"
                      value={record.temperature}
                      onChange={(event) =>
                        change("temperature", event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Detak jantung" htmlFor="record-heart-rate">
                    <UnitInput
                      id="record-heart-rate"
                      unit="bpm"
                      required
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      value={record.heartRate}
                      onChange={(event) =>
                        change("heartRate", event.target.value)
                      }
                    />
                  </Field>
                  <Field
                    label="Tingkat kesadaran"
                    htmlFor="record-consciousness"
                  >
                    <select
                      id="record-consciousness"
                      className="medical-control medical-select"
                      required
                      value={record.consciousness}
                      onChange={(event) =>
                        change("consciousness", event.target.value)
                      }
                    >
                      <option value="">Pilih kondisi</option>
                      <option>Sadar penuh</option>
                      <option>Penurunan kesadaran</option>
                      <option>Tidak sadar</option>
                    </select>
                  </Field>
                </div>
                <Field
                  label="Hasil observasi fisik dan pemeriksaan"
                  htmlFor="record-observations"
                >
                  <textarea
                    id="record-observations"
                    className="medical-control record-observations"
                    required
                    maxLength={4000}
                    value={record.observations}
                    onChange={(event) =>
                      change("observations", event.target.value)
                    }
                  />
                </Field>
              </div>
            </section>

            <section
              className="card medical-record-card"
              aria-labelledby="record-procedures-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-procedures-title">
                  Catatan internal: rincian tindakan medis
                </h2>
              </div>
              <div className="record-procedures-body">
                <Field
                  label="Tindakan medis yang dilakukan"
                  htmlFor="record-procedures"
                >
                  <textarea
                    id="record-procedures"
                    className="medical-control record-procedures"
                    required
                    maxLength={4000}
                    value={record.procedures}
                    onChange={(event) =>
                      change("procedures", event.target.value)
                    }
                  />
                </Field>
              </div>
            </section>

            <section
              className="card medical-record-card record-log-card"
              aria-labelledby="record-log-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-log-title">
                  Log penggunaan alat dan bahan medis
                </h2>
                {!completed && (
                  <button
                    ref={addButtonRef}
                    type="button"
                    className="button button-white button-small"
                    onClick={addSupply}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Tambah item
                  </button>
                )}
              </div>
              <div
                className="record-log-table-wrap"
                role="region"
                aria-label="Log penggunaan alat dan bahan medis"
                tabIndex={0}
              >
                <table className="record-log-table">
                  <colgroup>
                    <col className="log-col-name" />
                    <col className="log-col-kind" />
                    <col className="log-col-quantity" />
                    <col className="log-col-unit" />
                    <col className="log-col-action" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Nama alat / bahan</th>
                      <th scope="col">Jenis</th>
                      <th scope="col">Jumlah</th>
                      <th scope="col">Satuan</th>
                      <th scope="col">
                        <span className="sr-only">Tindakan</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.supplies.map((item, index) => (
                      <tr key={item.id}>
                        <td>
                          <input
                            ref={(element) => {
                              if (element && newItemRef.current === item.id) {
                                element.focus();
                                newItemRef.current = null;
                              }
                            }}
                            className="medical-control"
                            aria-label={`Nama alat atau bahan ${index + 1}`}
                            required
                            maxLength={120}
                            value={item.name}
                            onChange={(event) =>
                              changeSupply(item.id, {
                                name: event.target.value,
                              })
                            }
                          />
                        </td>
                        <td>
                          <select
                            className="medical-control medical-select"
                            aria-label={`Jenis item ${index + 1}`}
                            value={item.kind}
                            onChange={(event) =>
                              changeSupply(item.id, {
                                kind: event.target
                                  .value as MedicalSupply["kind"],
                              })
                            }
                          >
                            <option>Bahan</option>
                            <option>Alat</option>
                          </select>
                        </td>
                        <td>
                          <input
                            className="medical-control"
                            aria-label={`Jumlah item ${index + 1}`}
                            required
                            inputMode="numeric"
                            pattern="[1-9][0-9]*"
                            value={item.quantity}
                            onChange={(event) =>
                              changeSupply(item.id, {
                                quantity: event.target.value,
                              })
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="medical-control"
                            aria-label={`Satuan item ${index + 1}`}
                            required
                            maxLength={40}
                            value={item.unit}
                            onChange={(event) =>
                              changeSupply(item.id, {
                                unit: event.target.value,
                              })
                            }
                          />
                        </td>
                        <td>
                          {!completed && (
                            <button
                              type="button"
                              className="record-remove-item"
                              aria-label={`Hapus item ${index + 1}${item.name ? ` ${item.name}` : ""}`}
                              onClick={() => removeSupply(item.id)}
                            >
                              <X size={17} aria-hidden="true" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {record.supplies.length === 0 && (
                <div className="record-no-supplies">
                  <p>Belum ada alat atau bahan dicatat.</p>
                  <label>
                    <input
                      type="checkbox"
                      required
                      checked={record.noSuppliesUsed}
                      onChange={(event) =>
                        change("noSuppliesUsed", event.target.checked)
                      }
                    />
                    Tidak menggunakan alat atau bahan medis
                  </label>
                </div>
              )}
            </section>
          </fieldset>

          <aside
            className="medical-record-sidebar"
            aria-label="Kelengkapan dan referensi catatan"
          >
            <section
              className="card medical-record-card record-completeness-card"
              aria-labelledby="record-completeness-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-completeness-title">Kelengkapan catatan</h2>
                <span
                  className="record-progress"
                  role="status"
                  aria-live="polite"
                >
                  {completeCount} dari {sections.length}
                </span>
              </div>
              <ul className="record-completeness-list">
                {sections.map((section) => (
                  <li key={section.label}>
                    {section.complete ? (
                      <span className="record-check-icon">
                        <Check size={13} strokeWidth={3} aria-hidden="true" />
                      </span>
                    ) : (
                      <Circle
                        size={18}
                        className="record-incomplete-icon"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {section.label}
                      <span className="sr-only">
                        : {section.complete ? "Lengkap" : "Belum lengkap"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section
              className="card medical-record-card"
              aria-labelledby="record-reference-title"
            >
              <div className="section-header record-card-header">
                <h2 id="record-reference-title">Referensi pasien</h2>
              </div>
              <div className="record-reference-body">
                <dl className="patient-reference-details">
                  <div>
                    <dt>Keluhan utama (pengajuan)</dt>
                    <dd>{reference.complaint}</dd>
                  </div>
                  <div>
                    <dt>Check-in terakhir · {reference.lastCheckIn}</dt>
                    <dd>{reference.checkInSummary}</dd>
                  </div>
                  <div>
                    <dt>Alamat kunjungan</dt>
                    <dd>{reference.address}</dd>
                  </div>
                </dl>
                <Link
                  href={`/pasien-rekam-medis/${visit.patient.id}`}
                  className="button record-outline-button"
                >
                  Buka rekam medis pasien
                </Link>
              </div>
            </section>
            {completed ? (
              <div className="record-finished-note">
                <strong>Kunjungan selesai</strong>
                <p>Rekam medis kunjungan ini sudah disimpan.</p>
                <Link href="/jadwal-kunjungan" className="text-button">
                  Kembali ke Jadwal
                </Link>
              </div>
            ) : (
              <div className="record-save-actions">
                <button
                  type="button"
                  className="button record-outline-button"
                  onClick={() => {
                    if (saveVisitDraft(visit.id, record)) {
                      setDraftSaved(true);
                    setAttempted(false);
                      notify(
                        "Draf rekam medis disimpan. Kunjungan belum diselesaikan.",
                      );
                    }
                  }}
                >
                  Simpan draf
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  onClick={() => setAttempted(true)}
                >
                  Simpan &amp; selesaikan kunjungan
                </button>
                {draftSaved && (
                  <p className="record-save-note" role="status">
                    Draf tersimpan. Kunjungan belum diselesaikan.
                  </p>
                )}
                {attempted && completeCount !== sections.length && (
                  <p className="record-validation-error" role="alert">
                    Lengkapi bagian yang belum terisi dengan benar sebelum
                    menyelesaikan kunjungan.
                  </p>
                )}
              </div>
            )}
          </aside>
        </form>
      </main>

    </>
  );
}
