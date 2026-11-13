"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Bell, Menu, Plus, X } from "lucide-react";
import { requestStatusLabels, type RequestStatus } from "@/lib/dashboard-data";
import { useNurseData } from "@/components/nurse-data-provider";
import "./patient-homecare-page.css";

type Filter = "all" | RequestStatus | "draft";
const tabs: { id: Filter; label: string }[] = [{ id: "all", label: "Semua" }, { id: "pending", label: "Menunggu" }, { id: "accepted", label: "Diterima" }, { id: "rejected", label: "Ditolak" }, { id: "draft", label: "Draf" }];
const patientId = "RM-2026-001";
const drafts = [{ id: "DRAF-01", schedule: "Disimpan 11 Nov 2026 · belum dikirim", status: "draft" as const }];

export function PatientHomecarePage() {
  const { requests } = useNurseData();
  const patientRequests = useMemo(() => requests.filter((request) => request.patient.id === patientId), [requests]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState(() => patientRequests[patientRequests.length - 1]?.id ?? "HC-0014");
  const [menuOpen, setMenuOpen] = useState(false);
  const allItems = [...patientRequests, ...drafts];
  const visibleItems = allItems.filter((item) => filter === "all" || item.status === filter);
  const selectedRequest = patientRequests.find((request) => request.id === selectedId);
  const selectedDraft = drafts.find((draft) => draft.id === selectedId);

  return <main className="patient-homecare-app">
    <header className="patient-header"><div className="patient-header-inner">
      <Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
      <nav className={`patient-nav${menuOpen ? " is-open" : ""}`} aria-label="Navigasi pasien"><Link href="/pasien" onClick={()=>setMenuOpen(false)}>Beranda</Link><Link href="/pasien/homecare" className="is-active" aria-current="page" onClick={()=>setMenuOpen(false)}>Homecare</Link><Link href="/pasien/check-in" onClick={()=>setMenuOpen(false)}>Check-in Harian</Link><Link href="/pasien/panduan" onClick={()=>setMenuOpen(false)}>Panduan Perawatan</Link></nav>
      <div className="patient-account"><Link className="patient-bell" href="/pasien/notifikasi" aria-label="Notifikasi"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile" aria-label="Buka profil pasien"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>Ilham S. Hasim</strong><small>{patientId}</small></span></Link><button className="patient-menu-button" aria-label={menuOpen?"Tutup menu":"Buka menu"} aria-expanded={menuOpen} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X size={22}/>:<Menu size={22}/>}</button></div>
    </div></header>
    <div className="patient-homecare-main">
      <section className="patient-homecare-heading"><div><h1>Homecare</h1><p>Pantau status pengajuan dan jadwal kunjungan Anda</p></div><Link className="patient-primary-button" href="/pasien/homecare/pesan"><Plus size={17}/>Pesan homecare</Link></section>
      <div className="homecare-tabs" role="tablist" aria-label="Filter status pengajuan">{tabs.map((tab)=><button key={tab.id} role="tab" aria-selected={filter===tab.id} className={filter===tab.id?"active":""} onClick={()=>setFilter(tab.id)}>{tab.label}</button>)}</div>
      <div className="patient-homecare-layout">
        <section className="homecare-request-list" aria-label="Daftar pengajuan homecare">{visibleItems.length===0?<div className="homecare-empty">Belum ada pengajuan pada kategori ini.</div>:visibleItems.map((item)=>{
          const draft = item.status === "draft";
          const request = draft ? undefined : patientRequests.find((entry)=>entry.id===item.id);
          return <button key={item.id} className={`homecare-request-row${selectedId===item.id?" selected":""}`} onClick={()=>setSelectedId(item.id)} aria-pressed={selectedId===item.id}>
            <span><strong>{draft?"Draf pengajuan":`${item.id} · Kunjungan homecare`}</strong><small>{draft?item.schedule:`${request?.schedule} · ${request?.doctor} · diajukan 12 Nov`}</small></span><b className={`homecare-status-label ${draft?"draft":item.status}`}>{draft?"Draf":requestStatusLabels[item.status as RequestStatus]==="Menunggu"?"Menunggu konfirmasi":requestStatusLabels[item.status as RequestStatus]}</b>
          </button>;
        })}</section>
        {(selectedRequest||selectedDraft)&&<aside className="homecare-detail-card"><div className="homecare-detail-heading"><h2>Detail {selectedRequest?.id??"pengajuan"}</h2><span className={`homecare-status-label ${selectedRequest?.status??"draft"}`}>{selectedRequest?(selectedRequest.status==="pending"?"Menunggu konfirmasi":requestStatusLabels[selectedRequest.status]):"Draf"}</span></div>
          {selectedRequest?<div className="homecare-detail-content"><Detail label="Jadwal yang diminta" value={selectedRequest.schedule.replace(" · "," 2026 · ")}/><Detail label="Dokter" value={selectedRequest.doctor}/><Detail label="Perawat" value="Dinda Maharani (NUR-001)"/>{selectedRequest.status==="rejected"&&selectedRequest.rejectionReason&&<Detail label="Alasan penolakan" value={selectedRequest.rejectionReason}/>}<ol className="request-timeline"><li className="complete"><span/><div><strong>Pengajuan terkirim</strong><small>12 Nov 2026 · 09.15</small></div></li><li className={selectedRequest.status==="pending"?"current":"complete"}><span/><div><strong>{selectedRequest.status==="pending"?"Sedang ditinjau perawat":"Ditinjau perawat"}</strong><small>{selectedRequest.status==="pending"?"Menunggu konfirmasi": "12 Nov 2026"}</small></div></li><li className={selectedRequest.status==="accepted"?"complete":""}><span/><div><strong>Keputusan perawat</strong><small>{selectedRequest.status==="pending"?"Belum ada keputusan":requestStatusLabels[selectedRequest.status]}</small></div></li></ol><div className="homecare-notice">ⓘ　Anda akan mendapat notifikasi setelah perawat memutuskan.</div></div>:<div className="homecare-detail-content"><Detail label="Status" value="Belum dikirim"/><p className="draft-hint">Lengkapi dan kirim pengajuan ketika Anda siap.</p><Link className="patient-primary-button" href="/pasien/homecare/pesan">Lanjutkan draf</Link></div>}
        </aside>}
      </div>
    </div>
  </main>;
}

function Detail({label,value}:{label:string;value:string}) { return <div className="homecare-detail-item"><small>{label}</small><strong>{value}</strong></div>; }
