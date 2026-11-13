"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Bell, Menu, X, ArrowLeft, Search, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useNurseData } from "@/components/nurse-data-provider";
import "./homecare-booking-flow.css";

type Booking = { name:string; phone:string; address:string; birth:string; nik:string; rm:string; complaint:string; other:string; systolic:string; diastolic:string; temperature:string; pulse:string; history:string; consciousness:string; conditions:string[]; date:string; time:string; note:string };
const initial: Booking = { name:"Ilham Shahputra Hasim", phone:"0812-0000-0001", address:"Jl. Raya No. 12, Kebayoran, Jakarta Selatan", birth:"1990-03-12", nik:"3174 0000 0000 0001", rm:"RM-2026-001", complaint:"Badan terasa lemas sejak dua hari terakhir.", other:"", systolic:"120", diastolic:"80", temperature:"36,8", pulse:"78", history:"Kondisi cukup stabil, nafsu makan menurun.", consciousness:"Sadar penuh", conditions:["Lemas"], date:"2026-11-16", time:"10.00", note:"" };
const steps = ["Identitas", "Screening", "Jadwal", "Tinjau"];
const dates = [{day:"Jum",n:"13",value:"2026-11-13"},{day:"Sab",n:"14",value:"2026-11-14"},{day:"Min",n:"15",value:"2026-11-15",off:true},{day:"Sen",n:"16",value:"2026-11-16"},{day:"Sel",n:"17",value:"2026-11-17"}];
const times = ["08.00","09.00","10.00","11.00","13.00","14.00","15.00","16.00"];

export function HomecareBookingFlow() {
  const router = useRouter();
  const { submitHomecareRequest, notify } = useNurseData();
  const [step,setStep] = useState(1);
  const [booking,setBooking] = useState(initial);
  const [accepted,setAccepted] = useState(false);
  const [menuOpen,setMenuOpen] = useState(false);
  const [error,setError] = useState("");
  const update = (key:keyof Booking,value:string) => setBooking((old)=>({...old,[key]:value}));
  const toggleCondition = (value:string) => setBooking((old)=>({...old,conditions:old.conditions.includes(value)?old.conditions.filter((item)=>item!==value):[...old.conditions,value]}));
  const dateLabel = dates.find((item)=>item.value===booking.date);
  const scheduleLabel = `${dateLabel?.day}, ${dateLabel?.n} Nov · ${booking.time}`;
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(step===4){
      if(!accepted){setError("Centang pernyataan sebelum mengirim pengajuan.");return;}
      submitHomecareRequest(scheduleLabel,"dr. Andini Pratama");
      notify("Pengajuan homecare berhasil dikirim dan menunggu tinjauan perawat.");
      router.push("/pasien/homecare");
      return;
    }
    setError("");setStep((current)=>Math.min(4,current+1));
  }

  return <main className="booking-app">
    <header className="patient-header"><div className="patient-header-inner">
      <Link href="/pasien" className="patient-brand" aria-label="ForCare beranda pasien"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
      <nav className={`patient-nav${menuOpen?" is-open":""}`} aria-label="Navigasi pasien"><Link href="/pasien">Beranda</Link><Link className="is-active" href="/pasien/homecare" aria-current="page">Homecare</Link><Link href="/pasien/check-in">Check-in Harian</Link><Link href="/pasien/panduan">Panduan Perawatan</Link></nav>
      <div className="patient-account"><Link className="patient-bell" href="/pasien/notifikasi" aria-label="Notifikasi"><Bell size={19}/></Link><Link href="/pasien/profil" className="patient-account-profile" aria-label="Buka profil pasien"><span className="patient-avatar">IH</span><span className="patient-account-text"><strong>Ilham S. Hasim</strong><small>RM-2026-001</small></span></Link><button className="patient-menu-button" aria-label={menuOpen?"Tutup menu":"Buka menu"} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X size={22}/>:<Menu size={22}/>}</button></div>
    </div></header>
    <div className="booking-main">
      <Link className="booking-back" href="/pasien/homecare"><ArrowLeft size={16}/>Kembali ke Homecare</Link>
      <div className="booking-title"><h1>Pesan Homecare</h1><p>Lengkapi data berikut. Perawat akan meninjau pengajuan Anda</p></div>
      <ol className="booking-stepper" aria-label={`Langkah ${step} dari 4`}>{steps.map((label,index)=>{const n=index+1;return <li key={label} className={n<step?"done":n===step?"active":""}><span>{n<step?<Check size={16}/>:n}</span><strong>{label}</strong></li>})}</ol>
      <div className="booking-layout"><form id="booking-flow" className="booking-form" onSubmit={submit}>
        {step===1&&<section className="booking-panel"><div className="booking-panel-title"><h2>Identitas pasien</h2><small>Langkah 1 dari 4</small></div><div className="booking-panel-body identity-fields">
          <Field label="Nama pasien"><input required value={booking.name} onChange={(e)=>update("name",e.target.value)}/></Field><Field label="Nomor telepon"><input type="tel" required value={booking.phone} onChange={(e)=>update("phone",e.target.value)}/></Field>
          <Field label="Alamat" className="full"><textarea required rows={2} value={booking.address} onChange={(e)=>update("address",e.target.value)}/></Field>
          <Field label="Tanggal lahir"><input type="date" required value={booking.birth} onChange={(e)=>update("birth",e.target.value)}/></Field><Field label="NIK"><input required value={booking.nik} onChange={(e)=>update("nik",e.target.value)}/></Field>
          <Field label="Nomor rekam medis" className="full"><div className="rm-search"><Search size={18}/><input value={booking.rm} onChange={(e)=>update("rm",e.target.value)} aria-label="Nomor rekam medis"/><button type="button" onClick={()=>setError("Data rekam medis ditemukan.")}>Cari data</button></div></Field>
        </div></section>}
        {step===2&&<section className="booking-panel"><div className="booking-panel-title"><h2>Screening</h2><small>Langkah 2 dari 4</small></div><div className="booking-panel-body screening-fields">
          <Field label="Keluhan utama" className="full"><textarea rows={3} required value={booking.complaint} onChange={(e)=>update("complaint",e.target.value)}/></Field><Field label={<>Keluhan tambahan <em>(opsional)</em></>} className="full"><textarea rows={2} placeholder="Keluhan lain yang Anda rasakan" value={booking.other} onChange={(e)=>update("other",e.target.value)}/></Field>
          <div className="pressure-field"><Field label={<>Tekanan darah <em>(opsional)</em></>}><div className="paired-input"><input aria-label="Tekanan sistolik" value={booking.systolic} onChange={(e)=>update("systolic",e.target.value)}/><span>/</span><input aria-label="Tekanan diastolik" value={booking.diastolic} onChange={(e)=>update("diastolic",e.target.value)}/><small>mmHg</small></div></Field></div>
          <Field label="Suhu tubuh"><div className="unit-input"><input value={booking.temperature} onChange={(e)=>update("temperature",e.target.value)}/><small>°C</small></div></Field><Field label="Detak jantung"><div className="unit-input"><input value={booking.pulse} onChange={(e)=>update("pulse",e.target.value)}/><small>bpm</small></div></Field>
          <Field label="Riwayat kondisi harian" className="full"><textarea rows={2} value={booking.history} onChange={(e)=>update("history",e.target.value)}/></Field>
          <fieldset><legend>Tingkat kesadaran</legend>{["Sadar penuh","Mengantuk / kurang waspada","Bingung"].map((item)=><label className={`choice-card${booking.consciousness===item?" selected":""}`} key={item}><input type="radio" name="consciousness" checked={booking.consciousness===item} onChange={()=>update("consciousness",item)}/>{item}</label>)}</fieldset>
          <fieldset><legend>Kondisi fisik umum <em>(boleh pilih lebih dari satu)</em></legend>{["Tampak pucat","Lemas","Berkeringat dingin","Tidak ada keluhan fisik"].map((item)=><label className={`choice-card${booking.conditions.includes(item)?" selected":""}`} key={item}><input type="checkbox" checked={booking.conditions.includes(item)} onChange={()=>toggleCondition(item)}/>{item}</label>)}</fieldset>
        </div></section>}
        {step===3&&<section className="booking-panel"><div className="booking-panel-title"><h2>Pilih jadwal kunjungan</h2><small>Langkah 3 dari 4</small></div><div className="booking-panel-body schedule-fields"><Field label="Dokter"><select defaultValue="dr. Andini Pratama"><option>dr. Andini Pratama</option><option>dr. Raka Wijaya</option></select></Field><div><strong className="field-label">Tanggal <em>November 2026</em></strong><div className="date-choices">{dates.map((item)=><button key={item.value} type="button" disabled={item.off} className={booking.date===item.value?"selected":""} onClick={()=>update("date",item.value)}><small>{item.day}</small><strong>{item.n}</strong></button>)}</div></div><div><strong className="field-label">Jam</strong><div className="time-choices">{times.map((time)=>{const disabled=(booking.date==="2026-11-16"&&["14.00","16.00"].includes(time))||(booking.date==="2026-11-15");return <button key={time} type="button" disabled={disabled} className={booking.time===time?"selected":""} onClick={()=>update("time",time)}>{time}</button>})}</div><small className="availability-note">Jam yang dicoret sudah terisi.</small></div><Field label={<>Catatan untuk perawat <em>(opsional)</em></>}><textarea rows={3} placeholder="Contoh: pagar hijau, tekan bel dua kali." value={booking.note} onChange={(e)=>update("note",e.target.value)}/></Field></div></section>}
        {step===4&&<section className="booking-panel"><div className="booking-panel-title"><h2>Tinjau</h2><small>Langkah 4 dari 4</small></div><div className="booking-panel-body review-sections"><ReviewSection title="Identitas pasien" onEdit={()=>setStep(1)} items={[["Nama",booking.name],["Telepon",booking.phone],["Tanggal lahir",booking.birth],["No. rekam medis",booking.rm],["NIK",booking.nik],["Alamat",booking.address]]}/><ReviewSection title="Screening" onEdit={()=>setStep(2)} items={[["Keluhan utama",booking.complaint],["Tekanan darah",`${booking.systolic}/${booking.diastolic} mmHg`],["Suhu · detak jantung",`${booking.temperature} °C · ${booking.pulse} bpm`],["Kesadaran",booking.consciousness],["Kondisi fisik",booking.conditions.join(", ")||"Tidak ada keluhan"],["Riwayat",booking.history]]}/><ReviewSection title="Jadwal dan dokter" onEdit={()=>setStep(3)} items={[["Tanggal",`${dateLabel?.day}, ${dateLabel?.n} November 2026`],["Jam",`${booking.time} WIB`],["Dokter","dr. Andini Pratama"],["Catatan",booking.note||"—"]]}/><label className="consent-check"><input type="checkbox" checked={accepted} onChange={(event)=>setAccepted(event.target.checked)}/><span><strong>Saya menyatakan data di atas benar</strong><small>Data digunakan perawat untuk menilai kebutuhan kunjungan.</small></span></label></div></section>}
        {error&&<p className="booking-error" role="status">{error}</p>}
        <div className="booking-mobile-actions">{step>1&&<button type="button" className="booking-secondary" onClick={()=>setStep(step-1)}>Kembali</button>}<button type="submit" className="booking-primary">{step===4?"Kirim pengajuan":"Lanjut"}</button></div>
      </form>
      <aside className="booking-summary"><div className="booking-panel-title"><h2>Ringkasan</h2></div><div className="booking-summary-body"><div className="summary-grid"><Summary label="Pasien" value="Ilham S. Hasim"/><Summary label="RM" value={booking.rm}/><Summary label="Dokter" value="dr. Andini Pratama"/><Summary label="Jadwal" value={`${dateLabel?.day}, ${dateLabel?.n} Nov · ${booking.time}`}/></div><div className="summary-notice">ⓘ　Pengajuan ditinjau perawat sebelum dikonfirmasi.</div><div className="summary-actions">{step>1&&<button type="button" className="booking-secondary" onClick={()=>setStep(step-1)}>Kembali</button>}<button form="booking-flow" type="submit" className="booking-primary">{step===4?"Kirim pengajuan":"Lanjut"}</button></div></div></aside></div>
    </div>
  </main>;
}

function Field({label,children,className=""}:{label:React.ReactNode;children:React.ReactNode;className?:string}){return <label className={`booking-field ${className}`}><strong>{label}</strong>{children}</label>}
function Summary({label,value}:{label:string;value:string}){return <div><small>{label}</small><strong>{value}</strong></div>}
function ReviewSection({title,items,onEdit}:{title:string;items:string[][];onEdit:()=>void}){return <section className="review-section"><header><h3>{title}</h3><button type="button" onClick={onEdit}>Ubah</button></header><div className="review-grid">{items.map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div></section>}
