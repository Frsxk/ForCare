"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Bell, BookOpen, CalendarDays, HeartPulse, Menu, Pill, Plus, Thermometer, UserRound, X, Activity, TriangleAlert } from "lucide-react";
import "./patient-dashboard.css";

const patient = { name: "Ilham Shahputra Hasim", shortName: "Ilham S. Hasim", id: "RM-2026-001", initials: "IH", age: "36 tahun", gender: "Laki-laki", discharge: "8 Nov 2026", nurse: "Dinda Maharani", nurseId: "NUR-001", phone: "0812-0000-0001" };

export function PatientDashboard() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [taken, setTaken] = useState<Record<string, boolean>>({ "Obat A": true });
  const [notice, setNotice] = useState("");
  const markTaken = (medicine: string) => {
    setTaken((previous) => ({ ...previous, [medicine]: !previous[medicine] }));
    setNotice(taken[medicine] ? `${medicine} ditandai belum diminum.` : `${medicine} ditandai sudah diminum.`);
    window.setTimeout(() => setNotice(""), 2800);
  };

  return <main className="patient-app">
    <header className="patient-header"><div className="patient-header-inner">
      <Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
      <nav className={`patient-nav${menuOpen ? " is-open" : ""}`} aria-label="Navigasi pasien">
        <a className="is-active" href="#beranda" onClick={() => setMenuOpen(false)}>Beranda</a><Link href="/pasien/homecare" onClick={() => setMenuOpen(false)}>Homecare</Link><Link href="/pasien/check-in" onClick={() => setMenuOpen(false)}>Check-in Harian</Link><Link href="/pasien/panduan" onClick={() => setMenuOpen(false)}>Panduan Perawatan</Link>
      </nav>
      <div className="patient-account"><Link className="patient-bell" href="/pasien/notifikasi" aria-label="Notifikasi"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>{patient.shortName}</strong><small>{patient.id}</small></span></Link><button className="patient-menu-button" aria-label={menuOpen ? "Tutup menu" : "Buka menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={22}/> : <Menu size={22}/>}</button></div>
    </div></header>
    <div className="patient-main" id="beranda">
      <section className="patient-welcome"><div><h1>Selamat siang, Ilham</h1><p>Kamis, 12 November 2026</p></div><Link className="patient-primary-button" href="/pasien/homecare"><Plus size={17}/>Ajukan homecare</Link></section>
      <div className="patient-dashboard-grid">
        <div className="patient-primary-column">
          <section className="nurse-visit-banner"><div className="banner-time"><small>HARI INI</small><strong>14.00</strong></div><div className="banner-copy"><h2>Kunjungan perawat</h2><p>{patient.nurse} ({patient.nurseId}) akan datang sesuai jadwal yang sudah dikonfirmasi.</p></div><a href={`tel:${patient.phone}`} className="banner-contact">Hubungi</a></section>
          <section className="patient-card last-checkin" id="check-in"><div className="patient-card-heading mint"><h2>Check-in terakhir</h2><span>11 Nov 2026 · 19.30 · Baik-baik saja</span></div><div className="vitals-list"><Vital icon={<Thermometer/>} label="Suhu tubuh" value="36,8 °C"/><Vital icon={<HeartPulse/>} label="Detak jantung" value="78 bpm"/><Vital icon={<Activity/>} label="Tekanan darah" value="120/80"/><Vital icon={<Pill/>} label="Minum obat" value="Teratur"/></div></section>
          <section className="patient-card next-schedule"><div className="patient-card-heading pale-mint"><h2>Jadwal berikutnya</h2></div><div className="schedule-item"><span className="schedule-icon"><UserRound/></span><div><strong>Kunjungan perawat</strong><small>Hari ini, Kamis 12 Nov 2026 · 14.00 · Dinda Maharani (NUR-001)</small></div><span className="schedule-badge">Terjadwal</span></div><div className="schedule-item"><span className="schedule-icon"><CalendarDays/></span><div><strong>Kontrol dokter</strong><small>Kamis, 26 Nov 2026 · 09.00 · dr. Andini Pratama</small></div><a className="schedule-link" href="#jadwal">Lihat jadwal</a></div></section>
          <section className="patient-card homecare-status" id="status-homecare"><div className="homecare-status-heading"><h2>Status pengajuan homecare</h2><Link href="/pasien/homecare">Lihat semua</Link></div><ol className="homecare-steps"><li className="step-complete"><span/><div><strong>Pengajuan HC-0014 terkirim</strong><small>12 Nov 2026 · 09.15 · dr. Andini Pratama</small></div></li><li className="step-current"><span/><div><strong>Menunggu ditinjau perawat</strong><small>Jadwal diminta: Sen, 16 Nov 2026 · 10.00</small></div></li><li><span/><div><strong>Jadwal dikonfirmasi</strong></div></li></ol></section>
        </div>
        <aside className="patient-side-column">
          <section className="patient-card patient-profile"><div className="patient-card-heading"><h2>Pasien</h2></div><div className="mini-profile"><span className="patient-avatar large">IH</span><div><strong>{patient.name}</strong><small>{patient.gender} · {patient.age}</small></div></div><div className="profile-info"><Info label="No. rekam medis" value={patient.id}/><Info label="Keluar RS" value={patient.discharge}/><Info label="Perawat" value={patient.nurse}/><Info label="Telepon" value={patient.phone}/></div></section>
          <section className="patient-card medication-card"><div className="patient-card-heading medication-heading"><h2>Pengingat minum obat</h2></div><div className="medication-list">{[{name:"Obat A",time:"08.00 WIB"},{name:"Obat B",time:"20.00 WIB"}].map((medicine)=><div className="medication-row" key={medicine.name}><span className="medication-icon"><Pill/></span><div className="medication-copy"><strong>{medicine.name}</strong><small>{medicine.time}</small></div><button className={taken[medicine.name]?"medication-done":"medication-toggle"} onClick={()=>markTaken(medicine.name)}>{taken[medicine.name]?"Sudah diminum":"Tandai diminum"}</button></div>)}</div><p className="medication-note">Dosis dan aturan minum mengikuti resep dokter.</p></section>
          <section className="patient-card shortcuts" id="panduan"><div className="patient-card-heading"><h2>Pintasan</h2></div><Link href="/pasien/homecare" className="shortcut-row"><span><Plus/></span><div><strong>Pesan homecare</strong><small>Ajukan kunjungan perawat</small></div></Link><Link href="/pasien/check-in" className="shortcut-row"><span><Activity/></span><div><strong>Check-in harian</strong><small>Catat kondisi hari ini</small></div></Link><Link href="/pasien/panduan" className="shortcut-row"><span><BookOpen/></span><div><strong>Panduan perawatan</strong><small>Tips merawat di rumah</small></div></Link><Link href="/pasien/panduan" className="shortcut-row"><span className="warning-shortcut"><TriangleAlert/></span><div><strong>Gejala bahaya &amp; P3K</strong><small>Kapan harus segera ke RS</small></div></Link></section>
        </aside>
      </div>
    </div>
    {notice&&<div className="patient-toast" role="status">{notice}</div>}
  </main>;
}

function Vital({icon,label,value}:{icon:React.ReactNode;label:string;value:string}) { return <div className="vital-item"><span className="vital-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>; }
function Info({label,value}:{label:string;value:string}) { return <div className="profile-info-item"><small>{label}</small><strong>{value}</strong></div>; }
