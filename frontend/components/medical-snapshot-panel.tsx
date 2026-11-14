"use client";

import { useCallback, useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { useNurseRead, useNurseWorkspace } from "@/components/nurse-workspace-provider";
import { decodeMedicalSnapshot, prepareMedicalRecord, type MedicalRecord, type MedicalSnapshot, type MedicalWriteController } from "@/lib/api/nurse";

type MedicalDraft = { sourceReference: string; primaryDiagnosis: string; secondaryDiagnoses: string; admittedAt: string; dischargedAt: string; allergies: string; procedures: string; complaints: string; observations: string; internalNote: string };
export function medicalDraft(record: Pick<MedicalRecord, "payload" | "sourceReference"> | null): MedicalDraft {
  const payload = record?.payload;
  return {
    sourceReference: record?.sourceReference ?? "", primaryDiagnosis: payload?.primaryDiagnosis ?? "",
    secondaryDiagnoses: JSON.stringify(payload?.secondaryDiagnoses ?? [], null, 2), admittedAt: payload?.admittedAt ?? "", dischargedAt: payload?.dischargedAt ?? "",
    allergies: JSON.stringify(payload?.allergies ?? [], null, 2), procedures: JSON.stringify(payload?.procedures ?? [], null, 2), complaints: payload?.complaints ?? "",
    observations: JSON.stringify(payload?.observations ?? [], null, 2), internalNote: payload?.internalNote ?? "",
  };
}
export function snapshotFromDraft(draft: MedicalDraft): MedicalSnapshot {
  const nullable = (value: string) => value.trim() === "" ? null : value.trim();
  return decodeMedicalSnapshot({
    primaryDiagnosis: nullable(draft.primaryDiagnosis), secondaryDiagnoses: JSON.parse(draft.secondaryDiagnoses),
    admittedAt: nullable(draft.admittedAt), dischargedAt: nullable(draft.dischargedAt), allergies: JSON.parse(draft.allergies), procedures: JSON.parse(draft.procedures),
    complaints: nullable(draft.complaints), observations: JSON.parse(draft.observations), internalNote: nullable(draft.internalNote),
  });
}
const fields: { name: keyof MedicalDraft; label: string; max?: number; json?: boolean; help?: string }[] = [
  { name: "sourceReference", label: "Referensi sumber (wajib)", max: 300 },
  { name: "primaryDiagnosis", label: "Diagnosis utama", max: 500 },
  { name: "secondaryDiagnoses", label: "Diagnosis sekunder", json: true, help: 'Daftar JSON teks, maksimal 50 diagnosis; setiap teks maksimal 300 karakter. Contoh format: ["teks dari sumber"].' },
  { name: "admittedAt", label: "Waktu masuk (UTC)", help: "Format YYYY-MM-DDTHH:mm:ss.SSSZ atau YYYY-MM-DDTHH:mm:ssZ; kosong berarti belum dicatat." },
  { name: "dischargedAt", label: "Waktu pulang (UTC)", help: "Format UTC yang sama; tidak boleh sebelum waktu masuk." },
  { name: "allergies", label: "Alergi", json: true, help: "Daftar JSON teks, maksimal 50 alergi; setiap teks maksimal 200 karakter. [] berarti belum ada isian, bukan konfirmasi bebas alergi." },
  { name: "procedures", label: "Tindakan / prosedur", json: true, help: "Daftar JSON teks, maksimal 50 tindakan; setiap teks maksimal 300 karakter." },
  { name: "complaints", label: "Keluhan", max: 2000 },
  { name: "observations", label: "Observasi dari sumber", json: true, help: 'Daftar JSON, maksimal 200 observasi. Setiap objek wajib memiliki type (maks. 100 karakter); value opsional (angka atau teks maks. 200 karakter), unit opsional (maks. 50 karakter), observedAt opsional (UTC). Contoh format: [{"type":"jenis dari sumber","value":0}]. Jangan menambahkan kunci lain; hapus kunci opsional bila belum dicatat.' },
  { name: "internalNote", label: "Catatan internal", max: 4000 },
];
export function MedicalSnapshotForm({ draft, onChange, onSubmit, revisionNumber, disabled }: { draft: MedicalDraft; onChange: (draft: MedicalDraft) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; revisionNumber: number; disabled: boolean }) {
  const id = useId();
  return <form className="live-stack" onSubmit={onSubmit} aria-label={revisionNumber ? "Koreksi snapshot rekam medis" : "Snapshot rekam medis pertama"}>
    <p>{revisionNumber ? `Koreksi ini menambahkan snapshot lengkap setelah revisi ${revisionNumber}; versi lama tidak diubah.` : "Buat snapshot lengkap pertama berdasarkan sumber yang Anda periksa."} Isian teks kosong berarti belum dicatat (null). Daftar kosong ditulis sebagai []; jangan mengisinya dengan fakta perkiraan.</p>
    <fieldset disabled={disabled} className="patient-history-fields"><legend>Isi snapshot lengkap</legend>{fields.map(field => <div key={field.name}>
      <label htmlFor={`${id}-${field.name}`}>{field.label}</label>
      <textarea id={`${id}-${field.name}`} name={field.name} required={field.name === "sourceReference" || field.json} maxLength={field.max} rows={field.json ? 4 : 2} spellCheck={!field.json} value={draft[field.name]} aria-describedby={field.help ? `${id}-${field.name}-help` : undefined} onChange={event => onChange({ ...draft, [field.name]: event.target.value })} />
      {field.help && <small id={`${id}-${field.name}-help`}>{field.help}</small>}
    </div>)}</fieldset>
    <button className="button button-primary" disabled={disabled} type="submit">{revisionNumber ? "Simpan koreksi sebagai revisi baru" : "Simpan snapshot pertama"}</button>
  </form>;
}
export function SnapshotView({ record }: { record: MedicalRecord | null }) {
  if (!record) return <p>Belum ada snapshot rekam medis. Diagnosis, alergi, dan observasi belum dapat disimpulkan.</p>;
  const payload = record.payload;
  const entries: [string, string | string[] | null][] = [
    ["Diagnosis utama", payload.primaryDiagnosis], ["Diagnosis sekunder", payload.secondaryDiagnoses], ["Waktu masuk (UTC)", payload.admittedAt], ["Waktu pulang (UTC)", payload.dischargedAt],
    ["Alergi", payload.allergies], ["Tindakan / prosedur", payload.procedures], ["Keluhan", payload.complaints], ["Catatan internal", payload.internalNote],
  ];
  return <article className="live-stack"><div><h3>Snapshot revisi {record.revisionNumber}</h3><p className="live-prewrap">Referensi sumber: {record.sourceReference}</p><small>Dicatat {record.recordedAt} (UTC)</small></div>
    <dl className="patient-record-details">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="live-prewrap">{Array.isArray(value) ? value.length ? <ul>{value.map((item, index) => <li key={index}>{item}</li>)}</ul> : "Belum dicatat" : value ?? "Belum dicatat"}</dd></div>)}</dl>
    <div><h4>Observasi dari sumber</h4>{payload.observations.length ? <ul>{payload.observations.map((item, index) => <li key={index} className="live-prewrap">{item.type}: {item.value === undefined ? "Nilai belum dicatat" : String(item.value)}{item.unit === undefined ? "" : ` ${item.unit}`}{item.observedAt === undefined ? " · waktu belum dicatat" : ` · ${item.observedAt} (UTC)`}</li>)}</ul> : <p>Belum dicatat</p>}</div>
  </article>;
}
function SnapshotEditor({ patientId, latest, writer, seed }: { patientId: string; latest: MedicalRecord | null; writer: MedicalWriteController; seed: MedicalDraft | null }) {
  const [draft, setDraft] = useState(() => seed ?? medicalDraft(latest));
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writer.getSnapshot().status !== "idle") return;
    try {
      const payload = snapshotFromDraft(draft);
      const intent = prepareMedicalRecord(patientId, latest, draft.sourceReference, payload);
      setError(null);
      await writer.send(intent);
    } catch {
      setError("Periksa referensi sumber, batas panjang teks, daftar JSON, serta format dan urutan waktu UTC. Semua kolom snapshot harus disertakan.");
    }
  }
  return <>{error && <p className="patient-form-error" role="alert">{error}</p>}<MedicalSnapshotForm draft={draft} onChange={setDraft} onSubmit={event => void save(event)} revisionNumber={latest?.revisionNumber ?? 0} disabled={false} /></>;
}
export function MedicalSnapshotPanel({ patientId }: { patientId: string }) {
  return <PatientMedicalSnapshots key={patientId} patientId={patientId} />;
}
function PatientMedicalSnapshots({ patientId }: { patientId: string }) {
  const { api, medical } = useNurseWorkspace();
  const [writer] = useState(() => medical.patient(patientId));
  const write = useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot);
  const loader = useCallback((signal: AbortSignal) => api.records(patientId, null, signal), [api, patientId]);
  const records = useNurseRead(loader);
  const [seed, setSeed] = useState<MedicalDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const latestRead = records.state.status === "ready" ? records.state.data.items.reduce<MedicalRecord | null>((latest, item) => !latest || item.revisionNumber > latest.revisionNumber ? item : latest, null) : null;
  const latest = write.record && (!latestRead || write.record.revisionNumber > latestRead.revisionNumber) ? write.record : latestRead;
  async function startCorrection() {
    if (write.status === "sending" || write.status === "uncertain") return;
    const previous = write.status === "rejected" && write.intent ? JSON.parse(write.intent.body) : null;
    setSeed(previous ? medicalDraft(previous) : null);
    setEditorOpen(false);
    const fresh = await records.reload();
    if (!fresh) return;
    writer.reset();
    setEditorOpen(true);
  }
  return <section className="card live-card live-stack" aria-labelledby={`medical-title-${patientId}`}>
    <div><h2 id={`medical-title-${patientId}`}>Snapshot rekam medis</h2><p>Snapshot sumber ditulis perawat. Koreksi selalu membuat revisi baru yang menggantikan tepat revisi terbaru, bukan mengubah riwayat.</p></div>
    {records.state.status === "error" ? <div role="alert"><p>{records.state.error.message}</p>{records.state.error.requestId && <small>Referensi permintaan: {records.state.error.requestId}</small>}<button className="button button-outline" onClick={() => void records.reload()}>Muat ulang snapshot</button></div> : records.state.status !== "ready" ? <p role="status">Memuat snapshot dari server…</p> : <><SnapshotView record={latest} />{records.state.data.page.hasMore && <p>Riwayat menampilkan hingga 20 revisi terbaru, bukan seluruh riwayat.</p>}{records.state.data.items.filter(record => record.id !== latest?.id).map(record => <details key={record.id}><summary>Riwayat revisi {record.revisionNumber}</summary><SnapshotView record={record} /></details>)}</>}
    {write.status === "sending" && <p role="status">Mengirim atau memeriksa ulang snapshot. Jangan buat permintaan pengganti.</p>}
    {write.error && <div role="alert"><p>{write.error.message}</p>{write.error.requestId && <small>Referensi permintaan: {write.error.requestId}</small>}{write.error.retryAfterSeconds !== undefined && <p>Coba lagi setelah {write.error.retryAfterSeconds} detik.</p>}</div>}
    {write.status === "uncertain" && <div className="live-feedback"><p role="alert">Hasil penyimpanan belum dapat dipastikan. Isian dan identitas permintaan tetap disimpan untuk pasien ini selama sesi aktif, termasuk saat berpindah halaman. Jangan buat snapshot pengganti.</p><button type="button" className="button button-outline" onClick={() => void writer.reconcile()}>Periksa hasil tanpa mengirim</button><button type="button" className="button button-outline" onClick={() => { if (write.intent) void writer.send(write.intent); }}>Kirim ulang permintaan yang sama</button></div>}
    {write.status === "verified" && <p role="status">Snapshot revisi {write.record?.revisionNumber} tersimpan dan sudah diverifikasi melalui pembacaan ulang.</p>}
    {write.status === "rejected" && <p role="alert">Permintaan ditolak sebelum ada bukti penyimpanan. Muat ulang revisi terbaru sebelum memperbaiki isian dan membuat permintaan baru.</p>}
    {!["sending", "uncertain"].includes(write.status) && <button type="button" className="button button-outline" onClick={() => void startCorrection()}>{write.status === "rejected" ? "Muat ulang sebelum koreksi" : latest ? "Muat terbaru dan tambah koreksi" : "Muat terbaru dan buat snapshot pertama"}</button>}
    {editorOpen && write.status === "idle" && records.state.status === "ready" && <SnapshotEditor key={`${latest?.id ?? "first"}-${seed?.sourceReference ?? "source"}`} patientId={patientId} latest={latest} writer={writer} seed={seed} />}
  </section>;
}
