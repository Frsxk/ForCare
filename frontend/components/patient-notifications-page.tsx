"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Bell, Menu, X, ClipboardCheck, CalendarDays, Pill, Activity } from "lucide-react";
import "./patient-notifications-page.css";

type NoticeCategory="Pengajuan"|"Kunjungan"|"Check-in"|"Pengingat";
type Notice={id:string;category:NoticeCategory;title:string;description:string;date:string;read:boolean;icon:"request"|"visit"|"pill"|"checkin"};
const initialNotices:Notice[]=[
  {id:"hc14",category:"Pengajuan",title:"Pengajuan HC-0014 menunggu konfirmasi",description:"Perawat sedang meninjau pengajuan Anda untuk Senin, 16 Nov 2026 pukul 10.00.",date:"12 Nov · 09.15",read:false,icon:"request"},
  {id:"visit14",category:"Kunjungan",title:"Kunjungan perawat hari ini pukul 14.00",description:"Dinda Maharani (NUR-001) akan datang ke alamat Anda.",date:"12 Nov · 08.00",read:false,icon:"visit"},
  {id:"meda",category:"Pengingat",title:"Waktunya minum Obat A",description:"Pengingat pukul 08.00. Catat keteraturan minum obat di Check-in Harian.",date:"12 Nov · 08.00",read:false,icon:"pill"},
  {id:"checkin",category:"Check-in",title:"Jangan lupa check-in harian",description:"Perbarui kondisi Anda hari ini agar perawat dapat memantau pemulihan.",date:"11 Nov · 19.00",read:true,icon:"checkin"},
  {id:"hc12",category:"Pengajuan",title:"Pengajuan HC-0012 diterima",description:"Kunjungan dijadwalkan Kamis, 12 Nov 2026 pukul 14.00.",date:"11 Nov · 14.20",read:true,icon:"request"},
  {id:"doctor",category:"Kunjungan",title:"Jadwal kontrol dokter",description:"Kontrol dengan dr. Andini Pratama pada Kamis, 26 Nov 2026 pukul 09.00.",date:"8 Nov · 12.00",read:true,icon:"visit"},
];
const filters=["Semua","Pengajuan","Kunjungan","Check-in","Pengingat"] as const;

export function PatientNotificationsPage(){
  const [notices,setNotices]=useState(initialNotices);
  const [filter,setFilter]=useState<(typeof filters)[number]>("Semua");
  const [menuOpen,setMenuOpen]=useState(false);
  const unread=notices.filter((item)=>!item.read).length;
  const visible=notices.filter((item)=>filter==="Semua"||item.category===filter);
  const markAll=()=>setNotices((previous)=>previous.map((item)=>({...item,read:true})));
  const Icon=({type}:{type:Notice["icon"]})=>type==="request"?<ClipboardCheck size={19}/>:type==="visit"?<CalendarDays size={19}/>:type==="pill"?<Pill size={19}/>:<Activity size={19}/>;
  return <main className="patient-notifications-app">
    <header className="patient-header"><div className="patient-header-inner"><Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority/></Link><nav className={`patient-nav${menuOpen?" is-open":""}`} aria-label="Navigasi pasien"><Link href="/pasien">Beranda</Link><Link href="/pasien/homecare">Homecare</Link><Link href="/pasien/check-in">Check-in Harian</Link><Link href="/pasien/panduan">Panduan Perawatan</Link></nav><div className="patient-account"><Link className="patient-bell is-active" href="/pasien/notifikasi" aria-label="Notifikasi" aria-current="page"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile" aria-label="Buka profil pasien"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>Ilham S. Hasim</strong><small>RM-2026-001</small></span></Link><button className="patient-menu-button" aria-label={menuOpen?"Tutup menu":"Buka menu"} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X size={22}/>:<Menu size={22}/>}</button></div></div></header>
    <div className="patient-notifications-main"><header className="notifications-heading"><div><h1>Notifikasi</h1><p>{unread} belum dibaca</p></div><button className="mark-all-read" onClick={markAll} disabled={unread===0}>Tandai semua dibaca</button></header><div className="notification-tabs" role="tablist" aria-label="Filter notifikasi">{filters.map((item)=><button key={item} role="tab" aria-selected={filter===item} className={filter===item?"active":""} onClick={()=>setFilter(item)}>{item}</button>)}</div><section className="notifications-list" aria-label="Daftar notifikasi">{visible.map((item)=><button key={item.id} className={`notification-row${item.read?" read":" unread"}`} onClick={()=>setNotices((previous)=>previous.map((notice)=>notice.id===item.id?{...notice,read:true}:notice))}><span className="notification-dot" aria-hidden="true"/><span className={`notification-icon ${item.icon}`}><Icon type={item.icon}/></span><span className="notification-copy"><strong>{item.title}</strong><small>{item.description}</small></span><time>{item.date}</time></button>)}{visible.length===0&&<p className="notifications-empty">Belum ada notifikasi pada kategori ini.</p>}</section></div>
  </main>;
}
