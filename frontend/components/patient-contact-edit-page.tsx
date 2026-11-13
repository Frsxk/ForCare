"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Bell, ArrowLeft } from "lucide-react";
import { ilhamProfile } from "@/lib/patient-record-data";
import "./patient-contact-edit-page.css";

type Contacts={phone:string;address:string;emergencyName:string;emergencyPhone:string};
const defaults:Contacts={phone:ilhamProfile.phone,address:"Jl. Raya No. 12, Tebet, Jakarta Selatan",emergencyName:"Siti Hasim (Ibu)",emergencyPhone:"0812-0000-0002"};
export function PatientContactEditPage(){
  const router=useRouter();
  const [contacts,setContacts]=useState(defaults);
  useEffect(()=>{const value=window.sessionStorage.getItem("forcare-patient-contacts");if(!value)return;const timeout=window.setTimeout(()=>{try{setContacts(JSON.parse(value));}catch{window.sessionStorage.removeItem("forcare-patient-contacts");}},0);return()=>window.clearTimeout(timeout);},[]);
  function save(event:FormEvent<HTMLFormElement>){event.preventDefault();window.sessionStorage.setItem("forcare-patient-contacts",JSON.stringify(contacts));router.push("/pasien/profil");}
  return <main className="contact-edit-app"><header className="patient-header"><div className="patient-header-inner"><Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority/></Link><nav className="patient-nav"><Link href="/pasien">Beranda</Link><Link href="/pasien/homecare">Homecare</Link><Link href="/pasien/check-in">Check-in Harian</Link><Link href="/pasien/panduan">Panduan Perawatan</Link></nav><div className="patient-account"><Link href="/pasien/notifikasi" className="patient-bell" aria-label="Notifikasi"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>Ilham S. Hasim</strong><small>RM-2026-001</small></span></Link></div></div></header><div className="contact-edit-main"><Link href="/pasien/profil" className="contact-edit-back"><ArrowLeft size={16}/>Kembali ke profil</Link><h1>Ubah kontak</h1><p>Perbarui informasi kontak dan kontak darurat Anda.</p><form onSubmit={save}><label>Nomor telepon<input type="tel" required value={contacts.phone} onChange={(event)=>setContacts({...contacts,phone:event.target.value})}/></label><label>Alamat<textarea rows={3} required value={contacts.address} onChange={(event)=>setContacts({...contacts,address:event.target.value})}/></label><label>Kontak darurat · nama dan hubungan<input required value={contacts.emergencyName} onChange={(event)=>setContacts({...contacts,emergencyName:event.target.value})}/></label><label>Nomor telepon darurat<input type="tel" required value={contacts.emergencyPhone} onChange={(event)=>setContacts({...contacts,emergencyPhone:event.target.value})}/></label><div><Link href="/pasien/profil" className="contact-cancel">Batal</Link><button type="submit">Simpan perubahan</button></div></form></div></main>;
}
