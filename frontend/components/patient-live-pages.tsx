"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Bell, BookOpen, Activity, Menu, X } from "lucide-react";
import { usePatientWorkspace, usePatientResource, usePatientRead } from "./patient-workspace-provider";
import { SessionActions } from "./session-actions";
import { checkInValuesEqual, measurementUnits, prepareCheckIn, prepareCheckInSubmit, preparePatientContact, type CheckIn, type CheckInInput, type MeasurementType, type PatientProfile, type PatientWriteController } from "@/lib/api/patient";
import type { ResourceState } from "@/lib/api/scoped-resource";
import "./patient-dashboard.css";
import "./patient-checkin-page.css";
import "./patient-care-guide-page.css";
import "./patient-profile-page.css";
import "./patient-live-pages.css";

export type PatientLiveSection = "dashboard" | "checkin" | "guide" | "profile" | "contact" | "homecare" | "booking" | "notifications";
const titles: Record<PatientLiveSection, string> = { dashboard: "Beranda", checkin: "Check-in Harian", guide: "Panduan Perawatan", profile: "Profil Pasien", contact: "Ubah Kontak", homecare: "Homecare", booking: "Pesan Homecare", notifications: "Notifikasi" };
const measurements: Record<MeasurementType, string> = { temperature_c: "Suhu tubuh (°C)", heart_rate_bpm: "Detak jantung (bpm)", bp_systolic_mmhg: "Tekanan sistolik (mmHg)", bp_diastolic_mmhg: "Tekanan diastolik (mmHg)", weight_kg: "Berat badan (kg)", spo2_pct: "Saturasi oksigen (%)" };
const medicationLabels = { regular: "Teratur", missed_once: "Terlewat sekali", none: "Tidak minum" };
function LoadingError<T>({ state, retry }: { state: ResourceState<T>; retry: () => unknown }) {
  if (state.status === "error") return <div className="patient-live-message" role="alert"><p>{state.error.message}</p><button onClick={() => void retry()}>Muat ulang</button></div>;
  return <p className="patient-live-message" role="status">Memuat data dari server…</p>;
}
export function PatientLivePage({ section }: { section: PatientLiveSection }) {
  const workspace = usePatientWorkspace(), profile = usePatientResource(workspace.profile);
  if (profile.status !== "ready") return <main className="patient-app"><div className="patient-main"><h1>{titles[section]}</h1><SessionActions /><LoadingError state={profile} retry={() => workspace.profile.load(workspace.api.profile)} /></div></main>;
  return <PatientLiveShell section={section} profile={profile.data}><PatientPageContent section={section} profile={profile.data} /></PatientLiveShell>;
}
export function PatientLiveShell({ section, profile, children }: { section: PatientLiveSection; profile: PatientProfile; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const initials = profile.fullName.split(/\s+/).slice(0, 2).map(word => word[0]).join("");
  return <main className="patient-app patient-live-app">
    <header className="patient-header"><div className="patient-header-inner">
      <Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/images/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
      <nav className={`patient-nav${menuOpen ? " is-open" : ""}`} aria-label="Navigasi pasien">{[["/pasien", "Beranda", "dashboard"], ["/pasien/homecare", "Homecare", "homecare"], ["/pasien/check-in", "Check-in Harian", "checkin"], ["/pasien/panduan", "Panduan Perawatan", "guide"]].map(([href, label, id]) => <Link key={href} href={href} className={section === id ? "is-active" : undefined} aria-current={section === id ? "page" : undefined} onClick={() => setMenuOpen(false)}>{label}</Link>)}</nav>
      <div className="patient-account"><SessionActions /><Link className="patient-bell" href="/pasien/notifikasi" aria-label="Notifikasi"><Bell size={19} /></Link><Link href="/pasien/profil" className="patient-account-profile"><span className="patient-avatar">{initials}</span><span className="patient-account-text"><strong>{profile.fullName}</strong><small>{profile.recordNumber ?? "Nomor RM belum tersedia"}</small></span></Link><button className="patient-menu-button" aria-label={menuOpen ? "Tutup menu" : "Buka menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button></div>
    </div></header>
    <div className="patient-main"><section className="patient-welcome"><div><h1>{titles[section]}</h1><p>{profile.fullName}</p></div><Link className="patient-primary-button" href="/pasien/check-in">Catat kondisi</Link></section>{children}</div>
  </main>;
}
function PatientPageContent({ section, profile }: { section: PatientLiveSection; profile: PatientProfile }) {
  const { writer } = usePatientWorkspace(), retained = writer(profile.id);
  return <><WriteNotice writer={retained} />{section === "dashboard" ? <Dashboard profile={profile} /> : section === "checkin" ? <CheckInPage profile={profile} writer={retained} /> : section === "guide" ? <GuidePage profile={profile} /> : section === "profile" ? <Profile profile={profile} /> : section === "contact" ? <ContactPage profile={profile} writer={retained} /> : <Unavailable section={section} />}</>;
}
function useWriter(writer: PatientWriteController) { return useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot); }
function WriteNotice({ writer }: { writer: PatientWriteController }) {
  const state = useWriter(writer);
  if (state.status === "idle") return null;
  if (state.status === "sending") return <p className="patient-live-message" role="status">Menunggu konfirmasi server…</p>;
  if (state.status === "verified") return <p className="patient-live-message" role="status">Perubahan tersimpan dan telah dibaca kembali dari server.</p>;
  return <div className="patient-live-message" role="alert"><p>{state.status === "uncertain" ? "Hasil pengiriman belum dapat dipastikan. Jangan membuat pengganti. Isi dan identitas permintaan tetap disimpan selama sesi ini, termasuk saat berpindah halaman." : "Permintaan ditolak. Muat ulang data sebelum memperbaiki isian."}</p>{state.error && <p>{state.error.message}</p>}<div className="patient-live-actions">{state.status === "uncertain" ? <><button onClick={() => void writer.reconcile()}>Periksa hasil (tanpa mengirim)</button><button onClick={() => void writer.send(state.operation)}>Kirim ulang permintaan yang sama</button></> : <button onClick={() => writer.reset()}>Tutup pesan</button>}<Link href={state.operation.kind === "profile" ? "/pasien/profil/kontak" : "/pasien/check-in"}>Buka isian terkait</Link></div><p>Pengiriman ulang hanya dilakukan atas tindakan Anda. Jika draf baru belum memiliki ID, pemeriksaan saja tidak dapat menemukannya; kirim ulang permintaan yang sama untuk memulihkan ID.</p></div>;
}
function ProfileDetails({ profile }: { profile: PatientProfile }) {
  return <dl className="profile-info">{[["Nama lengkap", profile.fullName], ["No. rekam medis", profile.recordNumber], ["Tanggal lahir", profile.birthDate], ["Jenis kelamin", profile.gender === "male" ? "Laki-laki" : profile.gender === "female" ? "Perempuan" : profile.gender], ["Perawat utama", profile.primaryNurse?.displayName], ["Telepon", profile.phone], ["Alamat", profile.addressLine], ["Kontak darurat", profile.emergencyContactName], ["Telepon darurat", profile.emergencyContactPhone]].map(([label, value]) => <div className="profile-info-item" key={label}><dt>{label}</dt><dd>{value || "Belum tersedia"}</dd></div>)}</dl>;
}
function Profile({ profile }: { profile: PatientProfile }) {
  return <section className="patient-card"><div className="patient-card-heading"><h2>Data profil Anda</h2><Link href="/pasien/profil/kontak">Ubah kontak</Link></div><ProfileDetails profile={profile} /><p className="patient-live-padding">Nama, identitas, dan perawat utama tidak dapat diubah melalui halaman ini.</p></section>;
}
function CheckInDetails({ checkIn }: { checkIn: CheckIn }) {
  return <div className="patient-live-padding"><p><strong>{checkIn.condition === "ok" ? "Baik-baik saja" : "Ada keluhan"}</strong> · {checkIn.status === "draft" ? "Draf (belum dikirim)" : "Sudah dikirim"}</p><p>{checkIn.localDate} · zona waktu {checkIn.timeZone}</p><p>Minum obat: {medicationLabels[checkIn.medicationAdherence]}</p>{checkIn.note && <p className="patient-live-copy">{checkIn.note}</p>}<dl>{checkIn.observations.map(o => <div key={o.type}><dt>{measurements[o.type]}</dt><dd>{o.value} · {o.observedAt}</dd></div>)}</dl></div>;
}
function Dashboard({ profile }: { profile: PatientProfile }) {
  const { api } = usePatientWorkspace(), loader = useCallback((signal: AbortSignal) => api.checkIns(profile.id, null, signal), [api, profile.id]);
  const { state, reload } = usePatientRead(loader);
  return <div className="patient-dashboard-grid"><div className="patient-primary-column"><section className="patient-card"><div className="patient-card-heading mint"><h2>Catatan check-in terbaru</h2><Link href="/pasien/check-in">Lihat riwayat</Link></div>{state.status !== "ready" ? <LoadingError state={state} retry={reload} /> : state.data.items[0] ? <CheckInDetails checkIn={state.data.items[0]} /> : <p className="patient-live-padding">Belum ada check-in. Buat draf pertama Anda.</p>}</section><section className="patient-card shortcuts"><div className="patient-card-heading"><h2>Perawatan Anda</h2></div><Link className="shortcut-row" href="/pasien/check-in"><span><Activity /></span><div><strong>Check-in harian</strong><small>Simpan draf, periksa, lalu kirim</small></div></Link><Link className="shortcut-row" href="/pasien/panduan"><span><BookOpen /></span><div><strong>Panduan perawatan</strong><small>Instruksi terbit dan analisis yang disetujui</small></div></Link></section><section className="patient-card patient-live-padding"><h2>Jadwal dan layanan homecare</h2><p>Jadwal kunjungan dan pemesanan belum tersedia pada layanan ini. Tidak ada jadwal contoh yang ditampilkan.</p><Link href="/pasien/homecare">Ketersediaan homecare</Link></section></div><aside className="patient-side-column"><section className="patient-card"><div className="patient-card-heading"><h2>Pasien</h2></div><ProfileDetails profile={profile} /></section></aside></div>;
}
type FormValues = { condition: CheckInInput["condition"] | ""; medication: CheckInInput["medicationAdherence"] | ""; note: string; observedAt: string; values: Partial<Record<MeasurementType, string>> };
const emptyForm = (): FormValues => ({ condition: "", medication: "", note: "", observedAt: "", values: {} });
function restoredForm(writer: PatientWriteController): FormValues {
  const state = writer.getSnapshot();
  if (state.status !== "idle" && state.operation.kind !== "profile" && state.operation.kind !== "submit") {
    if (state.status === "verified" && state.result && "status" in state.result && state.result.status === "draft") return formFor(state.result);
    return formFor(JSON.parse(state.operation.intent.body));
  }
  return emptyForm();
}
function formFor(c: CheckInInput): FormValues { return { condition: c.condition, medication: c.medicationAdherence, note: c.note ?? "", observedAt: "", values: Object.fromEntries(c.observations.map(o => [o.type, String(o.value)])) }; }
function CheckInPage({ profile, writer }: { profile: PatientProfile; writer: PatientWriteController }) {
  const { api } = usePatientWorkspace();
  const [cursor, setCursor] = useState<string | null>(null), [draft, setDraft] = useState<CheckIn | undefined>(), [form, setForm] = useState<FormValues>(() => restoredForm(writer)), [error, setError] = useState("");
  const loader = useCallback((signal: AbortSignal) => api.checkIns(profile.id, cursor, signal), [api, profile.id, cursor]), { state, reload } = usePatientRead(loader);
  const mutation = useWriter(writer), locked = mutation.status === "sending" || mutation.status === "uncertain";
  const saved = mutation.status === "verified" && mutation.operation.kind !== "profile" ? mutation.result as CheckIn : undefined;
  const currentDraft = saved ? (saved.status === "draft" ? saved : undefined) : draft;
  const choose = (c?: CheckIn) => { if (locked) return; writer.reset(); setDraft(c); setForm(c ? formFor(c) : emptyForm()); setError(""); };
  const build = (): CheckInInput => {
    if (!form.condition || !form.medication) throw new Error("Pilih kondisi dan status minum obat.");
    const observations = (Object.keys(measurements) as MeasurementType[]).filter(type => form.values[type]?.trim()).map(type => {
      const old = currentDraft?.observations.find(o => o.type === type), value = Number(form.values[type]);
      const observedAt = form.observedAt ? new Date(`${form.observedAt}Z`).toISOString() : old?.observedAt;
      if (!observedAt) throw new Error("Isi waktu pengukuran (UTC) untuk pengukuran baru.");
      return { type, value, unit: measurementUnits[type], observedAt };
    });
    return { condition: form.condition, medicationAdherence: form.medication, note: form.note.trim() || null, observations };
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { const operation = prepareCheckIn(profile.id, build(), currentDraft); writer.reset(); await writer.send(operation); const result = writer.getSnapshot(); if (result.status === "verified") { const c = result.result as CheckIn; setDraft(c); setForm(formFor(c)); void reload(); } } catch { setError("Periksa isian: catatan maksimal 4.000 karakter; nilai pengukuran harus positif dan maksimal tiga angka desimal. Isi waktu UTC untuk pengukuran baru."); }
  };
  const submit = async () => {
    if (!currentDraft) return;
    setError("");
    try {
      if (!checkInValuesEqual(build(), currentDraft)) { setError("Simpan perubahan sebagai draf sebelum mengirim."); return; }
      writer.reset(); await writer.send(prepareCheckInSubmit(profile.id, currentDraft));
      if (writer.getSnapshot().status === "verified") { setDraft(undefined); setForm(emptyForm()); void reload(); }
    } catch { setError("Draf belum dapat dikirim. Muat ulang dan periksa isian."); }
  };
  return <div className="checkin-layout"><section className="checkin-form-card"><div className="checkin-card-heading"><h2>{currentDraft ? `Ubah draf · versi ${currentDraft.version}` : "Buat draf check-in"}</h2></div><form className="checkin-form-body" onSubmit={save}><fieldset disabled={locked}><legend>Bagaimana kondisi Anda?</legend><div className="feeling-options">{[["ok", "Baik-baik saja"], ["complaint", "Ada keluhan"]].map(([value, label]) => <label key={value} className={form.condition === value ? "selected" : undefined}><input required type="radio" name="condition" value={value} checked={form.condition === value} onChange={() => setForm({ ...form, condition: value as FormValues["condition"] })} />{label}</label>)}</div><label className="patient-live-field">Status minum obat<select required value={form.medication} onChange={e => setForm({ ...form, medication: e.target.value as FormValues["medication"] })}><option value="">Pilih status</option>{Object.entries(medicationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="checkin-vitals">{(Object.keys(measurements) as MeasurementType[]).map(type => <label key={type}>{measurements[type]}<input type="number" min="0.001" max="99999.999" step="0.001" inputMode="decimal" value={form.values[type] ?? ""} onChange={e => setForm({ ...form, values: { ...form.values, [type]: e.target.value } })} /></label>)}</div><label className="patient-live-field">Waktu pengukuran baru (UTC, bukan waktu lokal)<input type="datetime-local" step="0.001" value={form.observedAt} onChange={e => setForm({ ...form, observedAt: e.target.value })} /></label><p>Pengukuran opsional. Kosongkan nilai untuk menghapusnya dari draf. Waktu pengukuran yang sudah tersimpan dipertahankan bila waktu baru kosong.</p><label className="patient-live-field">Catatan<textarea maxLength={4000} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></label><p>Draf tidak dikirim ke perawat sampai Anda menekan Kirim draf. Check-in yang sudah dikirim tidak dapat diedit.</p>{error && <p role="alert">{error}</p>}<div className="checkin-actions patient-live-actions"><button type="submit" className="patient-primary-button">Simpan draf</button><button type="button" disabled={!currentDraft} onClick={() => void submit()}>Kirim draf ke perawat</button><button type="button" onClick={() => choose()}>Draf baru</button></div></fieldset></form>{currentDraft && <details className="patient-live-padding"><summary>Periksa draf tersimpan sebelum mengirim</summary><CheckInDetails checkIn={currentDraft} /></details>}</section><aside className="checkin-history-card"><div className="checkin-card-heading"><h2>Riwayat Anda</h2><button disabled={locked} onClick={() => void reload()}>Muat ulang</button></div>{state.status !== "ready" ? <LoadingError state={state} retry={reload} /> : <div className="patient-live-padding">{!state.data.items.length && <p>Belum ada check-in.</p>}{state.data.items.map(c => <article key={c.id} className="patient-live-history"><CheckInDetails checkIn={c} />{c.status === "draft" && <button disabled={locked} onClick={() => choose(c)}>Buka draf ini</button>}</article>)}<div className="patient-live-actions">{cursor && <button onClick={() => setCursor(null)}>Kembali ke terbaru</button>}{state.data.page.hasMore && <button onClick={() => setCursor(state.data.page.nextCursor)}>Riwayat berikutnya</button>}</div></div>}</aside></div>;
}
function GuidePage({ profile }: { profile: PatientProfile }) {
  const { api } = usePatientWorkspace(), [cursor, setCursor] = useState<string | null>(null);
  const guideLoader = useCallback((signal: AbortSignal) => api.guide(profile.id, signal), [api, profile.id]), guide = usePatientRead(guideLoader);
  const analysisLoader = useCallback(async (signal: AbortSignal) => { const list = await api.published(profile.id, cursor, signal); const items = await Promise.all(list.items.map(item => api.analysis(profile.id, item.id, signal))); return { ...list, items }; }, [api, profile.id, cursor]), analyses = usePatientRead(analysisLoader);
  return <div className="patient-primary-column"><p>Instruksi yang telah diterbitkan dan analisis tersimpan yang sudah disetujui tenaga kesehatan. Tidak ada analisis otomatis di halaman ini.</p><section className="patient-card"><div className="patient-card-heading mint"><h2>Panduan dan instruksi perawatan</h2><button onClick={() => void guide.reload()}>Muat ulang</button></div>{guide.state.status !== "ready" ? <LoadingError state={guide.state} retry={guide.reload} /> : <div className="patient-live-padding">{!guide.state.data.sources.length && !guide.state.data.orders.length && <p>Belum ada panduan terbit untuk akun Anda.</p>}{guide.state.data.sources.map(source => <article key={source.id} className="patient-live-history"><h3>{source.title}</h3><small>Revisi {source.revisionNumber} · disetujui {source.approvedAt ?? "waktu belum tersedia"}</small><p className="patient-live-copy">{source.body}</p></article>)}{guide.state.data.orders.map(order => <article key={order.id} className="patient-live-history"><h3>{order.kind === "medication" ? "Instruksi obat" : order.kind === "followup" ? "Tindak lanjut" : "Perawatan"}</h3><p className="patient-live-copy">{order.instructions}</p><ul>{order.items.map((item, i) => <li key={i}>{item.text}</li>)}</ul><small>Berlaku mulai {order.effectiveFrom}{order.effectiveTo ? ` sampai ${order.effectiveTo}` : ""}</small></article>)}</div>}</section><section className="patient-card"><div className="patient-card-heading"><h2>Analisis yang telah diterbitkan</h2><button onClick={() => void analyses.reload()}>Muat ulang</button></div>{analyses.state.status !== "ready" ? <LoadingError state={analyses.state} retry={analyses.reload} /> : <div className="patient-live-padding">{!analyses.state.data.items.length && <p>Belum ada analisis terbit yang dapat ditampilkan.</p>}{analyses.state.data.items.map(analysis => <article key={analysis.id} className="patient-live-history"><h3>Catatan perawatan</h3><small>Diterbitkan {analysis.publishedAt}</small><ul>{analysis.claims.map(claim => <li key={claim.id} className="patient-live-copy">{claim.text}</li>)}</ul></article>)}<div className="patient-live-actions">{cursor && <button onClick={() => setCursor(null)}>Kembali ke terbaru</button>}{analyses.state.data.page.hasMore && <button onClick={() => setCursor(analyses.state.status === "ready" ? analyses.state.data.page.nextCursor : null)}>Analisis berikutnya</button>}</div></div>}</section></div>;
}
function ContactPage({ profile, writer }: { profile: PatientProfile; writer: PatientWriteController }) {
  const { api, profile: resource } = usePatientWorkspace();
  // A new verified version resets the editor, never pairing stale fields with a fresh version.
  return <ContactEditor key={`${profile.id}:${profile.version}`} profile={profile} writer={writer} reload={() => resource.load(api.profile)} />;
}
const contactFields = ["phone", "addressLine", "emergencyContactName", "emergencyContactPhone"] as const;
function contactForm(profile: Pick<PatientProfile, typeof contactFields[number]>) {
  return { phone: profile.phone, addressLine: profile.addressLine ?? "", emergencyContactName: profile.emergencyContactName ?? "", emergencyContactPhone: profile.emergencyContactPhone ?? "" };
}
export function ContactEditor({ profile, writer, reload }: { profile: PatientProfile; writer: PatientWriteController; reload: () => unknown }) {
  const [form, setForm] = useState(() => {
    const retained = writer.getSnapshot();
    return retained.status !== "idle" && retained.status !== "verified" && retained.operation.kind === "profile" ? contactForm(JSON.parse(retained.operation.intent.body)) : contactForm(profile);
  }), [error, setError] = useState("");
  const state = useWriter(writer), locked = state.status === "sending" || state.status === "uncertain";
  const changed = contactFields.some(field => (form[field].trim() || null) !== (profile[field]?.trim() || null));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (locked || !changed) return;
    try { const operation = preparePatientContact(profile, form); writer.reset(); await writer.send(operation); }
    catch { setError("Periksa nomor telepon dan panjang isian kontak. Muat ulang profil bila versi telah berubah."); }
  };
  return <section className="patient-card"><div className="patient-card-heading"><h2>Kontak Anda</h2><button disabled={locked} onClick={() => void reload()}>Muat ulang profil</button><Link href="/pasien/profil">Kembali ke profil</Link></div><form className="patient-live-padding" onSubmit={save}><fieldset disabled={locked} className="patient-live-fieldset">{([["phone", "Telepon", 32], ["addressLine", "Alamat", 500], ["emergencyContactName", "Nama kontak darurat", 200], ["emergencyContactPhone", "Telepon darurat", 32]] as const).map(([name, label, max]) => <label key={name} className="patient-live-field">{label}<input required={name === "phone"} type={name.includes("Phone") || name === "phone" ? "tel" : "text"} maxLength={max} value={form[name]} onChange={e => setForm({ ...form, [name]: e.target.value })} /></label>)}{error && <p role="alert">{error}</p>}<button className="patient-primary-button" type="submit" disabled={locked || !changed}>Simpan kontak</button><p>Tinjau kontak yang telah dibaca dari server sebelum mengubah dan menyimpan lagi. Nama dan penugasan perawat tidak diubah.</p></fieldset></form></section>;
}
export function PatientUnavailable({ section }: { section: "homecare" | "booking" | "notifications" }) { return <Unavailable section={section} />; }
function Unavailable({ section }: { section: PatientLiveSection }) {
  return <section className="patient-card patient-live-padding"><h2>{titles[section]} belum tersedia</h2><p>{section === "notifications" ? "Layanan notifikasi belum terhubung. Tidak ada notifikasi contoh atau status baca lokal." : "Pemesanan, pemilihan perawat, dan jadwal homecare belum didukung layanan saat ini. Tidak ada pemesanan yang dibuat dari halaman ini."}</p><p>Untuk bantuan perawatan atau jadwal, hubungi fasilitas kesehatan Anda melalui saluran yang biasa digunakan.</p>{section === "homecare" && <p><Link href="/pasien/homecare/pesan">Periksa ketersediaan pemesanan homecare (belum tersedia)</Link></p>}<Link href="/pasien">Kembali ke beranda</Link></section>;
}
