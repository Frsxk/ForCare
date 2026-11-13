"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell, Menu, X, ChevronRight, ClipboardList } from "lucide-react";
import { ilhamProfile } from "@/lib/patient-record-data";
import "./patient-profile-page.css";

export function PatientProfilePage(){
  const [menuOpen,setMenuOpen]=useState(false);
  const [contacts,setContacts]=useState({phone:ilhamProfile.phone,address:"Jl. Raya No. 12, Tebet, Jakarta Selatan",emergencyName:"Siti Hasim (Ibu)",emergencyPhone:"0812-0000-0002"});
  useEffect(()=>{const saved=window.sessionStorage.getItem("forcare-patient-contacts");if(!saved)return;const timeout=window.setTimeout(()=>{try{setContacts(JSON.parse(saved));}catch{window.sessionStorage.removeItem("forcare-patient-contacts");}},0);return()=>window.clearTimeout(timeout);},[]);
  return <main className="patient-profile-app">
    <header className="patient-header"><div className="patient-header-inner"><Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority/></Link><nav className={`patient-nav${menuOpen?" is-open":""}`} aria-label="Navigasi pasien"><Link href="/pasien">Beranda</Link><Link href="/pasien/homecare">Homecare</Link><Link href="/pasien/check-in">Check-in Harian</Link><Link href="/pasien/panduan">Panduan Perawatan</Link></nav><div className="patient-account"><Link href="/pasien/notifikasi" className="patient-bell" aria-label="Lihat notifikasi"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile" aria-label="Buka profil pasien"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>Ilham S. Hasim</strong><small>RM-2026-001</small></span></Link><button className="patient-menu-button" aria-label={menuOpen?"Tutup menu":"Buka menu"} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X size={22}/>:<Menu size={22}/>}</button></div></div></header>
    <div className="patient-profile-main"><header className="patient-profile-title"><h1>Profil</h1><Link className="profile-edit-button" href="/pasien/profil/kontak">Ubah kontak</Link></header><div className="patient-profile-layout"><div className="patient-profile-primary">
      <section className="profile-identity-card"><div className="profile-identity-head"><span className="patient-profile-avatar">IH</span><div><h2>Ilham Shahputra Hasim</h2><p>Pasien · No. rekam medis RM-2026-001</p></div><span className="active-patient-badge">Pasien aktif</span></div><div className="profile-identity-body"><h3>Identitas</h3><div className="profile-facts"><Fact label="Nama lengkap" value="Ilham Shahputra Hasim"/><Fact label="Nomor rekam medis" value="RM-2026-001"/><Fact label="NIK" value={ilhamProfile.nik}/><Fact label="Tanggal lahir" value="12 Maret 1990 (36 tahun)"/><Fact label="Jenis kelamin" value="Laki-laki"/><Fact label="Status asuransi" value="BPJS Kesehatan"/></div></div></section>
      <InfoCard title="Kontak dan alamat"><Fact label="Nomor telepon" value={contacts.phone}/><Fact label="Alamat" value={contacts.address}/></InfoCard>
      <InfoCard title="Kontak darurat"><Fact label="Nama · hubungan" value={contacts.emergencyName}/><Fact label="Nomor telepon" value={contacts.emergencyPhone}/></InfoCard>
    </div><aside className="patient-profile-side"><section className="assigned-nurse-card"><header>Perawat penanggung jawab</header><div><span className="nurse-profile-avatar">DM</span><p><strong>Dinda Maharani</strong><small>NUR-001 · Perawat</small></p></div></section><section className="profile-shortcuts"><Link href="/pasien/notifikasi"><span className="profile-shortcut-icon"><Bell size={19}/></span><span><strong>Notifikasi</strong><small>3 belum dibaca</small></span><ChevronRight size={18}/></Link><Link href="/pasien/homecare"><span className="profile-shortcut-icon"><ClipboardList size={19}/></span><span><strong>Riwayat pengajuan homecare</strong></span><ChevronRight size={18}/></Link></section><Link className="profile-signout" href="/login">Keluar</Link></aside></div></div>
  </main>;
}

function Fact({label,value}:{label:string;value:string}){return <div className="profile-fact"><small>{label}</small><strong>{value}</strong></div>}
function InfoCard({title,children}:{title:string;children:React.ReactNode}){return <section className="profile-info-card"><header>{title}</header><div>{children}</div></section>}
