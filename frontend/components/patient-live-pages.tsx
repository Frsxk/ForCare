"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Bell, BookOpen, Activity, HeartPulse, ClipboardCheck, Menu, X, Gauge, Pill, BellRing, LockKeyhole, Utensils, Footprints, Scale, Thermometer, Wind, Plus, UserRound, CalendarDays, TriangleAlert, ChevronRight, ChevronDown, ArrowLeft } from "lucide-react";
import { usePatientWorkspace, usePatientResource, usePatientRead } from "./patient-workspace-provider";
import { SessionActions } from "./session-actions";
import { AccountPopover } from "./account-popover";
import { GeneralCareGuide, guideCategories, type GuideCategory } from "./patient-care-guide-page";
import { checkInValuesEqual, measurementUnits, prepareCheckIn, prepareCheckInSubmit, preparePatientContact, type CheckIn, type CheckInInput, type MeasurementType, type PatientProfile, type PatientWriteController } from "@/lib/api/patient";
import type { PatientGuide } from "@/lib/api/patient";
import type { ResourceState } from "@/lib/api/scoped-resource";
import { HomecareBookingFlow, HomecareHistory } from "./homecare-patient";
import type { HomecareBooking } from "@/lib/api/homecare";
import { formatPatientDate, formatPatientTime, formatPatientDateTime, patientBookingStatusLabels } from "@/lib/patient-homecare-display";
import "./patient-dashboard.css";
import "./patient-checkin-page.css";
import "./patient-care-guide-page.css";
import "./patient-profile-page.css";
import "./patient-contact-edit-page.css";
import "./patient-notifications-page.css";
import "./patient-live-pages.css";

export type PatientLiveSection = "dashboard" | "checkin" | "guide" | "profile" | "contact" | "homecare" | "booking" | "notifications";
const titles: Record<PatientLiveSection, string> = { dashboard: "Beranda", checkin: "Check-in Harian", guide: "Panduan Perawatan", profile: "Profil Pasien", contact: "Ubah Kontak", homecare: "Homecare", booking: "Pesan Homecare", notifications: "Notifikasi" };
const measurements: Record<MeasurementType, string> = { temperature_c: "Suhu tubuh (°C)", heart_rate_bpm: "Detak jantung (bpm)", bp_systolic_mmhg: "Tekanan sistolik (mmHg)", bp_diastolic_mmhg: "Tekanan diastolik (mmHg)", weight_kg: "Berat badan (kg)", spo2_pct: "Saturasi oksigen (%)" };
const vitalLabels: Record<MeasurementType, string> = { temperature_c: "Suhu tubuh", heart_rate_bpm: "Detak jantung", bp_systolic_mmhg: "Tekanan darah", bp_diastolic_mmhg: "Tekanan darah", weight_kg: "Berat badan", spo2_pct: "Saturasi oksigen" };
const vitalUnits: Partial<Record<MeasurementType, string>> = { temperature_c: "\u00b0C", heart_rate_bpm: "bpm", weight_kg: "kg", spo2_pct: "%" };
const vitalIcons: Partial<Record<MeasurementType, ReactNode>> = { temperature_c: <Thermometer />, heart_rate_bpm: <HeartPulse />, weight_kg: <Scale />, spo2_pct: <Wind /> };
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
  const initials = profile.fullName.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
  const nav = [["/pasien", "Beranda", "dashboard"], ["/pasien/homecare", "Homecare", "homecare"], ["/pasien/check-in", "Check-in Harian", "checkin"], ["/pasien/panduan", "Panduan Perawatan", "guide"]] as const;
  const sectionClass = { dashboard: "patient", checkin: "checkin", guide: "care-guide", profile: "patient-profile", contact: "contact-edit", notifications: "patient-notifications", homecare: "patient-homecare", booking: "booking" }[section];
  return <main className={`patient-app patient-live-app ${sectionClass}-app${section === "dashboard" ? " patient-dashboard-app" : ""}`}>
    <header className="patient-header"><div className="patient-header-inner">
      <Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/images/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
      <nav className={`patient-nav${menuOpen ? " is-open" : ""}`} aria-label="Navigasi pasien">{nav.map(([href, label, id]) => <Link key={href} href={href} className={section === id || section === "booking" && id === "homecare" ? "is-active" : undefined} aria-current={section === id ? "page" : undefined} onClick={() => setMenuOpen(false)}>{label}</Link>)}</nav>
      <div className="patient-account"><Link className={`patient-bell${section === "notifications" ? " is-active" : ""}`} href="/pasien/notifikasi" aria-label="Notifikasi" aria-current={section === "notifications" ? "page" : undefined}><Bell size={19} /></Link><AccountPopover name={profile.fullName} detail={profile.recordNumber ?? "Nomor RM belum tersedia"} profileHref="/pasien/profil" className="patient-account-profile"><span className="patient-avatar">{initials}</span><span className="patient-account-text"><strong>{profile.fullName}</strong><small>{profile.recordNumber ?? "Nomor RM belum tersedia"}</small></span></AccountPopover><button className="patient-menu-button" aria-label={menuOpen ? "Tutup menu" : "Buka menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button></div>
    </div></header>
    <div className={section === "homecare" || section === "booking" ? undefined : `${sectionClass}-main`}>{section === "checkin" ? <header className="checkin-heading"><h1>Check-in Harian</h1><p>Perbarui kondisi kesehatan Anda agar perawat dapat memantau pemulihan di rumah</p></header> : section === "guide" ? <header className="care-guide-heading"><h1>Panduan Perawatan</h1><p>Panduan umum merawat diri di rumah. Ikuti selalu arahan dokter dan perawat Anda.</p></header> : section === "profile" ? <header className="patient-profile-title"><h1>Profil</h1><Link className="profile-edit-button" href="/pasien/profil/kontak">Ubah kontak</Link></header> : section === "notifications" ? <header className="notifications-heading"><div><h1>Notifikasi</h1><p>Status belum dibaca belum tersedia</p></div><button type="button" className="mark-all-read" disabled>Tandai semua dibaca</button></header> : null}{children}</div>
  </main>;
}
function PatientPageContent({ section, profile }: { section: PatientLiveSection; profile: PatientProfile }) {
  const { writer } = usePatientWorkspace(), retained = writer(profile.id);
  return <><WriteNotice writer={retained} />{section === "dashboard" ? <Dashboard profile={profile} /> : section === "checkin" ? <CheckInPage profile={profile} writer={retained} /> : section === "guide" ? <GuidePage profile={profile} /> : section === "profile" ? <Profile profile={profile} /> : section === "contact" ? <ContactPage profile={profile} writer={retained} /> : section === "homecare" ? <HomecareHistory profile={profile} /> : section === "booking" ? <HomecareBookingFlow profile={profile} /> : <Unavailable section={section} />}</>;
}
function useWriter(writer: PatientWriteController) { return useSyncExternalStore(writer.subscribe, writer.getSnapshot, writer.getSnapshot); }
function WriteNotice({ writer }: { writer: PatientWriteController }) {
  const state = useWriter(writer);
  if (state.status === "idle") return null;
  if (state.status === "sending") return <p className="patient-live-message" role="status">Menunggu konfirmasi server…</p>;
  if (state.status === "verified") return <p className="patient-live-message" role="status">Perubahan tersimpan dan telah dibaca kembali dari server.</p>;
  return <div className="patient-live-message" role="alert"><p>{state.status === "uncertain" ? "Hasil pengiriman belum dapat dipastikan. Jangan membuat pengganti. Isi dan identitas permintaan tetap disimpan selama sesi ini, termasuk saat berpindah halaman." : "Permintaan ditolak. Muat ulang data sebelum memperbaiki isian."}</p>{state.error && <p>{state.error.message}</p>}<div className="patient-live-actions">{state.status === "uncertain" ? <><button onClick={() => void writer.reconcile()}>Periksa hasil (tanpa mengirim)</button><button onClick={() => void writer.send(state.operation)}>Kirim ulang permintaan yang sama</button></> : <button onClick={() => writer.reset()}>Tutup pesan</button>}<Link href={state.operation.kind === "profile" ? "/pasien/profil/kontak" : "/pasien/check-in"}>Buka isian terkait</Link></div><p>Pengiriman ulang hanya dilakukan atas tindakan Anda. Jika draf baru belum memiliki ID, pemeriksaan saja tidak dapat menemukannya; kirim ulang permintaan yang sama untuk memulihkan ID.</p></div>;
}
function initialsFor(name: string) { return name.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(); }
function genderFor(profile: PatientProfile) { return profile.gender === "male" ? "Laki-laki" : profile.gender === "female" ? "Perempuan" : profile.gender; }
function Fact({ label, value }: { label: string; value?: string | null }) { return <div className="profile-fact"><small>{label}</small><strong>{value || "Belum tersedia"}</strong></div>; }
function Profile({ profile }: { profile: PatientProfile }) {
  return <div className="patient-profile-layout"><div className="patient-profile-primary"><section className="profile-identity-card"><div className="profile-identity-head"><span className="patient-profile-avatar">{initialsFor(profile.fullName)}</span><div><h2>{profile.fullName}</h2><p>Pasien · No. rekam medis {profile.recordNumber || "Belum tersedia"}</p></div></div><div className="profile-identity-body"><h3>Identitas</h3><div className="profile-facts"><Fact label="Nama lengkap" value={profile.fullName} /><Fact label="Nomor rekam medis" value={profile.recordNumber} /><Fact label="NIK" /><Fact label="Tanggal lahir" value={profile.birthDate} /><Fact label="Jenis kelamin" value={genderFor(profile)} /><Fact label="Status asuransi" /></div></div></section><section className="profile-info-card"><header>Kontak dan alamat</header><div><Fact label="Nomor telepon" value={profile.phone} /><Fact label="Alamat" value={profile.addressLine} /></div></section><section className="profile-info-card"><header>Kontak darurat</header><div><Fact label="Nama · hubungan" value={profile.emergencyContactName} /><Fact label="Nomor telepon" value={profile.emergencyContactPhone} /></div></section></div><aside className="patient-profile-side"><section className="assigned-nurse-card"><header>Perawat penanggung jawab</header><div><span className="nurse-profile-avatar">{profile.primaryNurse ? initialsFor(profile.primaryNurse.displayName) : "—"}</span><p><strong>{profile.primaryNurse?.displayName || "Belum tersedia"}</strong><small>Perawat</small></p></div></section><section className="profile-shortcuts"><Link href="/pasien/notifikasi"><span className="profile-shortcut-icon"><Bell size={19} /></span><span><strong>Notifikasi</strong><small>Layanan belum tersedia</small></span><ChevronRight size={18} /></Link><Link href="/pasien/homecare"><span className="profile-shortcut-icon"><ClipboardCheck size={19} /></span><span><strong>Riwayat pengajuan homecare</strong></span><ChevronRight size={18} /></Link></section><div className="profile-signout"><SessionActions /></div></aside></div>;
}
function CheckInDetails({ checkIn }: { checkIn: CheckIn }) {
  const systolic = checkIn.observations.find(o => o.type === "bp_systolic_mmhg"), diastolic = checkIn.observations.find(o => o.type === "bp_diastolic_mmhg");
  const order = Object.keys(measurements) as MeasurementType[];
  const vitals = [...checkIn.observations.filter(o => !o.type.startsWith("bp_")).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)).map(o => ({ key: o.type, label: vitalLabels[o.type], value: `${o.value.toLocaleString("id-ID")}${vitalUnits[o.type] ? ` ${vitalUnits[o.type]}` : ""}`, icon: vitalIcons[o.type] })), ...(systolic && diastolic ? [{ key: "bp", label: "Tekanan darah", value: `${systolic.value}/${diastolic.value}`, icon: <Gauge /> }] : []), { key: "medication", label: "Minum obat", value: medicationLabels[checkIn.medicationAdherence], icon: <Pill /> }];
  return <div><p className="checkin-record-time">{checkIn.localDate} · {checkIn.status === "draft" ? "Draf" : "Terkirim"} · {checkIn.condition === "ok" ? "Baik-baik saja" : "Ada keluhan"}</p><div className="vitals-list">{vitals.map(vital => <div className="vital-item" key={vital.key}><span className="vital-icon">{vital.icon}</span><div><small>{vital.label}</small><strong>{vital.value}</strong></div></div>)}</div>{checkIn.observations.length > 0 && <details className="patient-live-padding"><summary>Waktu pengukuran (UTC)</summary>{checkIn.observations.map(o => <p key={o.type}>{measurements[o.type]} · <time dateTime={o.observedAt}>{o.observedAt}</time></p>)}</details>}{checkIn.note && <p className="checkin-note">{checkIn.note}</p>}</div>;
}
export function patientAge(birthDate: string, now: Date, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (birth.getUTCFullYear() !== year || birth.getUTCMonth() !== month - 1 || birth.getUTCDate() !== day) return null;
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value);
  const age = part("year") - year - (part("month") < month || part("month") === month && part("day") < day ? 1 : 0);
  return age < 0 ? null : age;
}
export function PatientDashboardVitals({ checkIn }: { checkIn?: CheckIn }) {
  const value = (type: MeasurementType) => checkIn?.observations.find(item => item.type === type)?.value.toLocaleString("id-ID") ?? "—";
  const temperature = value("temperature_c"), pulse = value("heart_rate_bpm");
  const vitals = [
    { key: "temperature", label: "Suhu tubuh", value: temperature === "—" ? "—" : `${temperature} °C`, icon: <Thermometer /> },
    { key: "pulse", label: "Detak jantung", value: pulse === "—" ? "—" : `${pulse} bpm`, icon: <HeartPulse /> },
    { key: "bp", label: "Tekanan darah", value: `${value("bp_systolic_mmhg")}/${value("bp_diastolic_mmhg")}`, icon: <Gauge /> },
    { key: "medication", label: "Minum obat", value: checkIn ? medicationLabels[checkIn.medicationAdherence] : "—", icon: <Pill /> },
  ];
  return <div className="vitals-list" aria-label="Ringkasan check-in terakhir">{vitals.map(vital => <div className="vital-item" key={vital.key}><span className="vital-icon" aria-hidden="true">{vital.icon}</span><div><small>{vital.label}</small><strong>{vital.value}</strong></div></div>)}</div>;
}
export function PatientDashboardProgress({ booking, timeZone }: { booking: HomecareBooking; timeZone: string }) {
  const submitted = booking.submittedAt ?? booking.events.find(event => event.action === "booking.submitted")?.createdAt;
  const terminal = booking.status === "rejected" || booking.status === "cancelled";
  const decision = booking.decidedAt ?? booking.events.find(event => event.action === "booking.accepted" || event.action === "booking.rejected")?.createdAt;
  const reason = booking.decisionReason ?? [...booking.events].reverse().find(event => event.action === `booking.${booking.status}`)?.reason;
  const steps = [
    { state: booking.status === "draft" ? "current" : "complete", title: submitted ? "Pengajuan homecare terkirim" : "Draf pengajuan homecare", detail: formatPatientDateTime(submitted ?? booking.createdAt, timeZone) },
    { state: booking.status === "submitted" ? "current" : decision || booking.status === "accepted" || booking.status === "rejected" ? "complete" : "upcoming", title: booking.status === "accepted" || decision && booking.status === "cancelled" ? "Pengajuan diterima perawat" : booking.status === "rejected" ? "Pengajuan ditolak perawat" : "Menunggu ditinjau perawat", detail: decision ? `${booking.nurse.displayName} · ${formatPatientDateTime(decision, timeZone)}` : `Jadwal diminta: ${formatPatientDateTime(booking.startsAt, timeZone)}` },
    { state: terminal || booking.status === "accepted" ? "current" : "upcoming", title: terminal ? `Pengajuan ${patientBookingStatusLabels[booking.status].toLowerCase()}` : booking.status === "accepted" ? "Jadwal dikonfirmasi" : "Menunggu konfirmasi jadwal", detail: terminal ? reason || "Alasan belum tersedia" : booking.status === "accepted" ? formatPatientDateTime(booking.startsAt, timeZone) : "Kunjungan belum dikonfirmasi" },
  ];
  return <ol className="homecare-steps" aria-label={`Status pengajuan: ${patientBookingStatusLabels[booking.status]}`}>{steps.map((step, index) => <li className={`step-${step.state}${terminal && index === 2 ? " step-terminal" : ""}`} key={index} aria-current={step.state === "current" ? "step" : undefined}><span aria-hidden="true" /><div><strong>{step.title}</strong><small>{step.detail}</small></div></li>)}</ol>;
}
function Dashboard({ profile }: { profile: PatientProfile }) {
  const { api, homecare, scope } = usePatientWorkspace();
  const timeZone = scope.session.displayTimeZone;
  const loader = useCallback(async (signal: AbortSignal) => {
    const items: CheckIn[] = [];
    let cursor: string | null = null;
    do { const page = await api.checkIns(profile.id, cursor, signal); items.push(...page.items); cursor = page.page.nextCursor; } while (cursor);
    return items.filter(item => item.status === "submitted").sort((a, b) => Date.parse(b.submittedAt ?? b.updatedAt) - Date.parse(a.submittedAt ?? a.updatedAt))[0];
  }, [api, profile.id]);
  const { state, reload } = usePatientRead(loader);
  const bookingLoader = useCallback(async (signal: AbortSignal) => {
    const items: HomecareBooking[] = [];
    let cursor: string | null = null;
    do {
      const page = await homecare.myBookings({ limit: 100, cursor }, signal);
      if (page.items.some(item => item.patientId !== profile.id)) throw new Error("Patient mismatch");
      items.push(...page.items); cursor = page.page.nextCursor;
    } while (cursor);
    return items;
  }, [homecare, profile.id]);
  const bookings = usePatientRead(bookingLoader);
  const guideLoader = useCallback((signal: AbortSignal) => api.guide(profile.id, signal), [api, profile.id]), guide = usePatientRead(guideLoader);
  const [now] = useState(() => new Date());
  const next = bookings.state.status === "ready" ? bookings.state.data.filter(item => item.status === "accepted" && Date.parse(item.startsAt) > now.getTime()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] : undefined;
  const latest = bookings.state.status === "ready" ? bookings.state.data[0] : undefined;
  const checkIn = state.status === "ready" ? state.data : undefined;
  const activeOrders = guide.state.status === "ready" ? guide.state.data.orders.filter(order => Date.parse(order.effectiveFrom) <= now.getTime() && (!order.effectiveTo || Date.parse(order.effectiveTo) > now.getTime())) : [];
  const medications = activeOrders.flatMap(order => {
    const items = order.items.filter(item => item.type === "medication" || item.type === "storage");
    return order.kind === "medication" || items.length ? [{ id: order.id, instructions: order.kind === "medication" ? order.instructions : null, items }] : [];
  });
  const followups = activeOrders.filter(order => order.kind === "followup");
  const age = patientAge(profile.birthDate, now, timeZone);
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  const greeting = hour < 11 ? "pagi" : hour < 15 ? "siang" : hour < 18 ? "sore" : "malam";
  return <><section className="patient-welcome"><div><h1>Selamat {greeting}, {profile.fullName.trim().split(/\s+/)[0]}</h1><p>{new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone }).format(now)}</p></div><Link className="patient-primary-button" href="/pasien/homecare/pesan"><Plus size={17} />Ajukan homecare</Link></section><div className="patient-dashboard-grid"><div className="patient-primary-column">
    <section className="nurse-visit-banner"><div className="banner-time"><small>{next && formatPatientDate(next.startsAt, timeZone) === formatPatientDate(now.toISOString(), timeZone) ? "HARI INI" : "KUNJUNGAN"}</small><strong>{next ? formatPatientTime(next.startsAt, timeZone) : "—"}</strong></div><div className="banner-copy"><h2>Kunjungan perawat</h2><p>{next ? `${formatPatientDate(next.startsAt, timeZone)} · ${next.nurse.displayName} (${next.nurse.staffCode}) · Jadwal dikonfirmasi.` : bookings.state.status === "ready" ? "Belum ada jadwal kunjungan terkonfirmasi." : bookings.state.status === "error" ? "Jadwal belum dapat dimuat." : "Memuat jadwal kunjungan…"}</p></div><Link className="banner-contact" href="/pasien/homecare">Lihat jadwal</Link></section>
    <section className="patient-card last-checkin" id="check-in"><div className="patient-card-heading mint"><h2>Check-in terakhir</h2><Link className="dashboard-checkin-summary" href="/pasien/check-in">{checkIn ? <>{formatPatientDateTime(checkIn.submittedAt ?? checkIn.updatedAt, timeZone)} · <strong>{checkIn.condition === "ok" ? "Baik-baik saja" : "Ada keluhan"}</strong></> : "Riwayat"}<ChevronRight size={14} aria-hidden="true" /></Link></div><PatientDashboardVitals checkIn={checkIn} />{state.status !== "ready" ? <LoadingError state={state} retry={reload} /> : !checkIn && <p className="dashboard-empty-checkin">Belum ada check-in terkirim. <Link href="/pasien/check-in">Catat kondisi Anda</Link></p>}</section>
    <section className="patient-card next-schedule"><div className="patient-card-heading pale-mint"><h2>Jadwal berikutnya</h2></div><div className="schedule-item"><span className="schedule-icon"><UserRound /></span><div><strong>Kunjungan perawat</strong><small>{next ? `${formatPatientDateTime(next.startsAt, timeZone)} · ${next.nurse.displayName}` : bookings.state.status === "ready" ? "Belum ada jadwal terkonfirmasi" : "Jadwal belum tersedia"}</small></div>{next && <span className="schedule-badge">Terjadwal</span>}</div><div className="schedule-item"><span className="schedule-icon"><CalendarDays /></span><div><strong>Kontrol dokter</strong><small>{followups.length ? followups.map(order => [order.instructions, ...order.items.map(item => item.text)].join(" · ")).join(" · ") : "Informasi jadwal belum tersedia"}</small></div>{followups.length > 0 && <Link className="schedule-link" href="/pasien/panduan">Lihat panduan<ChevronRight size={14} /></Link>}</div></section>
    <section className="patient-card homecare-status" id="status-homecare"><div className="homecare-status-heading"><h2>Status pengajuan homecare</h2><Link href="/pasien/homecare">Lihat semua</Link></div>{bookings.state.status !== "ready" ? <LoadingError state={bookings.state} retry={bookings.reload} /> : latest ? <PatientDashboardProgress booking={latest} timeZone={timeZone} /> : <p className="patient-live-padding">Belum ada pengajuan homecare.</p>}</section>
    </div><aside className="patient-side-column"><section className="patient-card patient-profile"><div className="patient-card-heading"><h2>Pasien</h2></div><div className="mini-profile"><span className="patient-avatar large">{initialsFor(profile.fullName)}</span><div><strong>{profile.fullName}</strong><small>{genderFor(profile)}{age !== null ? ` · ${age} tahun` : ""}</small></div></div><div className="profile-info">{[["No. rekam medis", profile.recordNumber], ["Keluar RS", null], ["Perawat", profile.primaryNurse?.displayName], ["Telepon pasien", profile.phone]].map(([label, value]) => <div className="profile-info-item" key={label}><small>{label}</small><strong>{value || "Belum tersedia"}</strong></div>)}</div></section>
    <section className="patient-card medication-card"><div className="patient-card-heading medication-heading"><h2>Pengingat minum obat</h2></div><div className="medication-list">{guide.state.status !== "ready" ? <LoadingError state={guide.state} retry={guide.reload} /> : medications.length ? medications.map(order => <div className="medication-row" key={order.id}><span className="medication-icon"><Pill /></span><div className="medication-copy">{order.instructions && <strong>{order.instructions}</strong>}{order.items.map((item, i) => <small key={i}>{item.text}</small>)}</div></div>) : <p className="dashboard-medication-empty">Belum ada instruksi obat aktif yang diterbitkan.</p>}</div><p className="medication-note">Dosis dan aturan minum mengikuti resep dokter.</p></section>
    <section className="patient-card shortcuts"><div className="patient-card-heading"><h2>Pintasan</h2></div>{([["/pasien/homecare/pesan", "Pesan homecare", "Ajukan kunjungan perawat", Plus], ["/pasien/check-in", "Check-in harian", "Catat kondisi hari ini", Activity], ["/pasien/panduan", "Panduan perawatan", "Tips merawat di rumah", BookOpen], ["/pasien/panduan#care-guide-tab-4", "Gejala bahaya & P3K", "Kapan harus segera ke RS", TriangleAlert]] as const).map(([href, title, copy, Icon]) => <Link className="shortcut-row" href={href} key={href}><span className={Icon === TriangleAlert ? "warning-shortcut" : undefined}><Icon /></span><div><strong>{title}</strong><small>{copy}</small></div><ChevronRight className="shortcut-chevron" size={18} aria-hidden="true" /></Link>)}</section></aside></div></>;
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
  const [tab, setTab] = useState<"form" | "history">("form");
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
  return <><div className="checkin-tabs" role="tablist" aria-label="Check-in pasien"><button role="tab" aria-selected={tab === "form"} className={tab === "form" ? "active" : ""} onClick={() => setTab("form")}>Isi check-in</button><button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Riwayat</button></div>{tab === "form" ? <div className="checkin-layout"><section className="checkin-form-card"><div className="checkin-card-heading"><h2>{currentDraft ? `Ubah draf · versi ${currentDraft.version}` : "Kondisi hari ini"}</h2></div><form className="checkin-form-body" onSubmit={save}><fieldset disabled={locked} className="patient-live-fieldset"><legend>Bagaimana perasaan Anda?</legend><div className="feeling-options">{[["ok", "Baik-baik saja"], ["complaint", "Ada keluhan"]].map(([value, label]) => <label key={value} className={form.condition === value ? "selected" : undefined}><input required type="radio" name="condition" value={value} checked={form.condition === value} onChange={() => setForm({ ...form, condition: value as FormValues["condition"] })} />{label}</label>)}</div><div className="checkin-vitals">{(Object.keys(measurements) as MeasurementType[]).map(type => <label key={type}>{measurements[type]}<input type="number" min="0.001" max="99999.999" step="0.001" inputMode="decimal" value={form.values[type] ?? ""} onChange={e => setForm({ ...form, values: { ...form.values, [type]: e.target.value } })} /></label>)}</div><label className="patient-live-field">Waktu pengukuran baru (UTC, bukan waktu lokal)<input type="datetime-local" step="0.001" value={form.observedAt} onChange={e => setForm({ ...form, observedAt: e.target.value })} /></label><p>Pengukuran opsional. Kosongkan nilai untuk menghapusnya dari draf. Waktu pengukuran yang sudah tersimpan dipertahankan bila waktu baru kosong.</p><fieldset className="medication-field"><legend>Minum obat</legend><div>{Object.entries(medicationLabels).map(([value, label]) => <label key={value} className={form.medication === value ? "selected" : ""}><input required type="radio" name="medication" value={value} checked={form.medication === value} onChange={() => setForm({ ...form, medication: value as FormValues["medication"] })} />{label}</label>)}</div></fieldset><label className="patient-live-field">Catatan<textarea maxLength={4000} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></label><p>Draf tidak dikirim ke perawat sampai Anda menekan Kirim draf. Check-in yang sudah dikirim tidak dapat diedit.</p>{error && <p role="alert">{error}</p>}<div className="checkin-actions patient-live-actions"><button type="submit" className="checkin-save-draft">Simpan draf</button><button type="button" className="checkin-send patient-primary-button" disabled={!currentDraft} onClick={() => void submit()}>Kirim draf ke perawat</button><button type="button" onClick={() => choose()}>Draf baru</button></div></fieldset></form>{currentDraft && <details className="patient-live-padding"><summary>Periksa draf tersimpan sebelum mengirim</summary><CheckInDetails checkIn={currentDraft} /></details>}</section><aside className="checkin-side"><section className="last-checkin-card"><header><h2>Check-in terakhir</h2></header>{state.status !== "ready" ? <LoadingError state={state} retry={reload} /> : state.data.items[0] ? <CheckInDetails checkIn={state.data.items[0]} /> : <p className="patient-live-padding">Belum ada check-in.</p>}</section><Link className="checkin-warning" href="/pasien/panduan#bahaya"><TriangleAlert size={20} /><span><strong>Ada gejala berbahaya?</strong> Buka Panduan Perawatan atau hubungi tenaga kesehatan Anda.</span></Link></aside></div> : <section className="checkin-history-card"><header><h2>Riwayat check-in</h2><button disabled={locked} onClick={() => void reload()}>Muat ulang</button></header>{state.status !== "ready" ? <LoadingError state={state} retry={reload} /> : <>{!state.data.items.length ? <p className="patient-live-padding">Belum ada check-in.</p> : <div className="checkin-history-table-wrap"><table><thead><tr><th>Tanggal</th><th>Kondisi</th><th>Keluhan</th><th>Suhu tubuh</th><th>Detak jantung</th><th>Tekanan darah</th><th>Minum obat</th><th>Pengukuran dan draf</th></tr></thead><tbody>{state.data.items.map(c => { const systolic = c.observations.find(o => o.type === "bp_systolic_mmhg"), diastolic = c.observations.find(o => o.type === "bp_diastolic_mmhg"); return <tr key={c.id}><td>{c.localDate}<br />{c.status === "draft" ? "Draf" : "Terkirim"}</td><td><span className={`history-condition${c.condition === "complaint" ? " warning" : ""}`}>{c.condition === "ok" ? "Baik-baik saja" : "Ada keluhan"}</span></td><td className="checkin-history-note">{c.note || "—"}</td><td>{c.observations.find(o => o.type === "temperature_c")?.value ?? "—"}</td><td>{c.observations.find(o => o.type === "heart_rate_bpm")?.value ?? "—"}</td><td>{systolic && diastolic ? `${systolic.value}/${diastolic.value}` : "—"}</td><td>{medicationLabels[c.medicationAdherence]}</td><td><details><summary>Lihat seluruh pengukuran</summary>{c.observations.map(o => <p key={o.type}>{measurements[o.type]}: {o.value} · <time dateTime={o.observedAt}>{o.observedAt}</time></p>)}{!c.observations.length && <p>Tidak ada pengukuran.</p>}</details>{c.status === "draft" && <button disabled={locked} onClick={() => { choose(c); setTab("form"); }}>Buka draf ini</button>}</td></tr>; })}</tbody></table></div>}<div className="patient-live-actions patient-live-padding">{cursor && <button onClick={() => setCursor(null)}>Kembali ke terbaru</button>}{state.data.page.hasMore && <button onClick={() => setCursor(state.data.page.nextCursor)}>Riwayat berikutnya</button>}</div></>}</section>}</>;
}
const guideCategoryIcons = { "Obat": Pill, "Perawatan luka": HeartPulse, "Makan & minum": Utensils, "Aktivitas": Footprints, "Gejala bahaya": TriangleAlert };
const guideSourceCategories: Partial<Record<PatientGuide["sources"][number]["kind"], GuideCategory>> = { medication: "Obat", wound_care: "Perawatan luka", diet: "Makan & minum", activity: "Aktivitas", danger_sign: "Gejala bahaya" };
const guideItemCategories: Partial<Record<PatientGuide["orders"][number]["items"][number]["type"], GuideCategory>> = { medication: "Obat", storage: "Obat", wound_care: "Perawatan luka", diet: "Makan & minum", activity: "Aktivitas", danger_sign: "Gejala bahaya" };
export function patientGuideSections(data: PatientGuide, category: GuideCategory | null) {
  return {
    sources: data.sources.filter(source => (guideSourceCategories[source.kind] ?? null) === category),
    orders: data.orders.flatMap(order => {
      const items = order.items.filter(item => (guideItemCategories[item.type] ?? null) === category);
      return items.length || (category === null && !order.items.length) ? [{ order, items }] : [];
    }),
  };
}
export function PatientGuideSections({ data, category }: { data: PatientGuide; category: GuideCategory | null }) {
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined);
  const sections = patientGuideSections(data, category);
  const Icon = category ? guideCategoryIcons[category] : BookOpen;
  const firstId = sections.orders[0]?.order.id ?? sections.sources[0]?.id;
  const open = (id: string) => (expanded === undefined ? firstId : expanded) === id;
  const sectionIcon = (index: number) => index === 0 ? <Icon size={20} /> : index === 1 ? <BellRing size={20} /> : <LockKeyhole size={20} />;
  return <>{sections.orders.map(({ order, items }, index) => {
    const source = data.sources.find(source => source.id === order.sourceDocumentId);
    return <article className={`care-guide-section${open(order.id) ? " open" : ""}`} key={order.id}><button className="care-guide-toggle" aria-expanded={open(order.id)} onClick={() => setExpanded(open(order.id) ? null : order.id)}><span className="care-guide-icon">{sectionIcon(index)}</span><strong>{order.instructions}</strong><ChevronDown className="care-guide-chevron" size={18} /></button>{open(order.id) && <><ul>{items.map((item, i) => <li key={i}>{item.text}</li>)}</ul><div className="patient-live-padding">{source && <p>Sumber: {source.title}</p>}<small>Berlaku mulai {order.effectiveFrom}{order.effectiveTo ? ` sampai ${order.effectiveTo}` : ""}</small></div></>}</article>;
  })}{sections.sources.map((source, index) => <article className={`care-guide-section${open(source.id) ? " open" : ""}`} key={source.id}><button className="care-guide-toggle" aria-expanded={open(source.id)} onClick={() => setExpanded(open(source.id) ? null : source.id)}><span className="care-guide-icon">{sectionIcon(index + sections.orders.length)}</span><strong>{source.title}</strong><ChevronDown className="care-guide-chevron" size={18} /></button>{open(source.id) && <div className="patient-live-padding"><small>Revisi {source.revisionNumber} · disetujui {source.approvedAt ?? "waktu belum tersedia"}</small><p className="patient-live-copy">{source.body}</p></div>}</article>)}</>;
}
function GuidePage({ profile }: { profile: PatientProfile }) {
  const { api } = usePatientWorkspace();
  const [cursor, setCursor] = useState<string | null>(null);
  const [category, setCategory] = useState<GuideCategory>("Obat");
  useEffect(() => {
    const selectLinkedCategory = () => {
      const index = guideCategories.findIndex((_, item) => window.location.hash === `#care-guide-tab-${item}`);
      if (index >= 0) setCategory(guideCategories[index]);
    };
    selectLinkedCategory();
    window.addEventListener("hashchange", selectLinkedCategory);
    return () => window.removeEventListener("hashchange", selectLinkedCategory);
  }, []);
  const guideLoader = useCallback((signal: AbortSignal) => api.guide(profile.id, signal), [api, profile.id]);
  const guide = usePatientRead(guideLoader);
  const analysisLoader = useCallback(async (signal: AbortSignal) => {
    const list = await api.published(profile.id, cursor, signal);
    const items = await Promise.all(list.items.map(item => api.analysis(profile.id, item.id, signal)));
    return { ...list, items };
  }, [api, profile.id, cursor]);
  const analyses = usePatientRead(analysisLoader);
  const selected = guide.state.status === "ready" ? patientGuideSections(guide.state.data, category) : null;
  const other = guide.state.status === "ready" ? patientGuideSections(guide.state.data, null) : null;
  const hasSelected = selected && (selected.orders.length > 0 || selected.sources.length > 0);
  const hasOther = other && (other.orders.length > 0 || other.sources.length > 0);
  return <>
    <div className="care-guide-tabs" role="tablist" aria-label="Kategori panduan">
      {guideCategories.map((item, index) => <button type="button" key={item} id={`care-guide-tab-${index}`} role="tab" aria-selected={category === item} aria-controls="care-guide-content" tabIndex={category === item ? 0 : -1} className={category === item ? "active" : ""} onClick={() => setCategory(item)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % guideCategories.length : event.key === "ArrowLeft" ? (index + guideCategories.length - 1) % guideCategories.length : event.key === "Home" ? 0 : event.key === "End" ? guideCategories.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        setCategory(guideCategories[next]);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>{item}</button>)}
    </div>
    <div className="care-guide-layout">
      <section className="care-guide-list" id="care-guide-content" role="tabpanel" aria-labelledby={`care-guide-tab-${guideCategories.indexOf(category)}`}>
        <GeneralCareGuide category={category} />
        {guide.state.status === "error" ? <LoadingError state={guide.state} retry={guide.reload} /> : guide.state.status !== "ready" ? <p className="care-guide-status" role="status">Memuat instruksi perawatan…</p> : <>
          {hasSelected && <><h2 className="care-guide-published-heading">Instruksi dari tim perawatan</h2><PatientGuideSections key={category} data={guide.state.data} category={category} /></>}
          {hasOther && <details className="care-guide-section"><summary className="care-guide-toggle"><span className="care-guide-icon"><BookOpen size={20} /></span><strong>Panduan dan instruksi lainnya</strong><ChevronDown className="care-guide-chevron" size={18} /></summary><PatientGuideSections data={guide.state.data} category={null} /></details>}
        </>}
        {analyses.state.status === "error" && <LoadingError state={analyses.state} retry={analyses.reload} />}
        {analyses.state.status === "ready" && (analyses.state.data.items.length > 0 || cursor) && <details className="care-guide-section">
          <summary className="care-guide-toggle"><span className="care-guide-icon"><BookOpen size={20} /></span><strong>Catatan perawatan</strong><ChevronDown className="care-guide-chevron" size={18} /></summary>
          {analyses.state.data.items.map(analysis => <article className="care-guide-published" key={analysis.id}><small>Diterbitkan {analysis.publishedAt}</small><ul>{analysis.claims.map(claim => <li key={claim.id} className="patient-live-copy">{claim.text}</li>)}</ul></article>)}
          {(cursor || analyses.state.data.page.hasMore) && <div className="patient-live-actions">{cursor && <button type="button" onClick={() => setCursor(null)}>Kembali ke terbaru</button>}{analyses.state.data.page.hasMore && <button type="button" onClick={() => setCursor(analyses.state.status === "ready" ? analyses.state.data.page.nextCursor : null)}>Catatan berikutnya</button>}</div>}
        </details>}
      </section>
      <aside className="care-guide-aside">
        <section className="care-upcoming-card"><header>Jadwal terdekat</header><div className="care-upcoming-row"><span><UserRound size={19} /></span><div><strong>Kunjungan perawat</strong><small><Link href="/pasien/homecare">Lihat jadwal homecare</Link></small></div></div><div className="care-upcoming-row"><span><CalendarDays size={19} /></span><div><strong>Kontrol dokter</strong><small>Informasi jadwal belum tersedia</small></div></div></section>
        <section className="care-help-card" id="bahaya"><header><TriangleAlert size={18} />Perlu bantuan segera?</header><div><p>Dalam keadaan darurat, hubungi layanan darurat setempat atau fasilitas kesehatan terdekat.</p><small>Nomor perawat belum tersedia.</small></div></section>
      </aside>
    </div>
  </>;
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
  return <><Link href="/pasien/profil" className="contact-edit-back"><ArrowLeft size={16} />Kembali ke profil</Link><h1>Ubah kontak</h1><p>Perbarui informasi kontak dan kontak darurat Anda.</p><form onSubmit={save}><fieldset disabled={locked} className="patient-live-fieldset">{([["phone", "Nomor telepon", 32], ["addressLine", "Alamat", 500], ["emergencyContactName", "Kontak darurat · nama dan hubungan", 200], ["emergencyContactPhone", "Nomor telepon darurat", 32]] as const).map(([name, label, max]) => <label key={name} className="patient-live-field">{label}{name === "addressLine" ? <textarea rows={3} maxLength={max} value={form[name]} onChange={e => setForm({ ...form, [name]: e.target.value })} /> : <input required={name === "phone"} type={name.includes("Phone") || name === "phone" ? "tel" : "text"} maxLength={max} value={form[name]} onChange={e => setForm({ ...form, [name]: e.target.value })} />}</label>)}{error && <p role="alert">{error}</p>}<p>Tinjau kontak yang telah dibaca dari server sebelum mengubah dan menyimpan lagi. Nama dan penugasan perawat tidak diubah.</p><div className="patient-live-actions"><button type="button" disabled={locked} onClick={() => void reload()}>Muat ulang profil</button><Link href="/pasien/profil" className="contact-cancel">Batal</Link><button type="submit" disabled={locked || !changed}>Simpan kontak</button></div></fieldset></form></>;
}
const notificationFilters = ["Semua", "Pengajuan", "Kunjungan", "Check-in", "Pengingat"] as const;
type NotificationFilter = (typeof notificationFilters)[number];
export function PatientNotificationList({ filter, onFilterChange }: { filter: NotificationFilter; onFilterChange: (filter: NotificationFilter) => void }) {
  return <><div className="notification-tabs" role="tablist" aria-label="Filter notifikasi">{notificationFilters.map(item => <button key={item} type="button" role="tab" aria-selected={filter === item} className={filter === item ? "active" : ""} onClick={() => onFilterChange(item)}>{item}</button>)}</div><section className="notifications-list" aria-label="Daftar notifikasi"><div className="notifications-empty"><h2>Notifikasi belum tersedia</h2><p>{filter === "Semua" ? "Layanan notifikasi belum terhubung." : `Notifikasi kategori ${filter} belum tersedia karena layanan belum terhubung.`} Tidak ada notifikasi contoh atau status baca lokal.</p><p>Untuk bantuan perawatan atau jadwal, hubungi fasilitas kesehatan Anda melalui saluran yang biasa digunakan.</p><Link href="/pasien">Kembali ke beranda</Link></div></section></>;
}
function NotificationsUnavailable() {
  const [filter, setFilter] = useState<NotificationFilter>("Semua");
  return <PatientNotificationList filter={filter} onFilterChange={setFilter} />;
}
export function PatientUnavailable({ section }: { section: "homecare" | "booking" | "notifications" }) { return <Unavailable section={section} />; }
function Unavailable({ section }: { section: PatientLiveSection }) {
  return section === "notifications" ? <NotificationsUnavailable /> : <section className="patient-card patient-live-padding"><h2>{titles[section]} belum tersedia</h2><p>Pemesanan, pemilihan perawat, dan jadwal homecare belum didukung layanan saat ini. Tidak ada pemesanan yang dibuat dari halaman ini.</p><p>Untuk bantuan perawatan atau jadwal, hubungi fasilitas kesehatan Anda melalui saluran yang biasa digunakan.</p>{section === "homecare" && <p><Link href="/pasien/homecare/pesan">Periksa ketersediaan pemesanan homecare (belum tersedia)</Link></p>}<Link href="/pasien">Kembali ke beranda</Link></section>;
}
