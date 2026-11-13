"use client";

import Link from "next/link";
import { Bell, Check, ChevronRight, ClipboardCheck } from "lucide-react";
import { nurse, patients } from "@/lib/dashboard-data";
import { notificationSettings } from "@/lib/notification-data";
import { visitDemoDate } from "@/lib/visit-data";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import "./nurse-profile.css";

export function NurseProfilePage() {
  const { visits, unreadNotificationCount, notificationPreferences, setNotificationPreference, signOutDemo } = useNurseData();
  const todayCount = visits.filter((visit) => visit.date === visitDemoDate).length;
  const details = [
    { label: "Nama lengkap", value: nurse.name },
    { label: "ID perawat", value: nurse.id },
    { label: "Peran", value: nurse.role },
    { label: "Nomor telepon", value: nurse.phone },
    { label: "Pasien ditangani", value: `${patients.length} pasien` },
    { label: "Kunjungan hari ini", value: `${todayCount} kunjungan` },
  ];

  return <>
    <NurseHeader activePage="profile" />
    <main id="konten-utama" className="dashboard-main nurse-profile-main">
      <h1 className="nurse-profile-title">Profil</h1>
      <div className="nurse-profile-layout">
        <div className="nurse-profile-primary">
          <section className="nurse-profile-identity" aria-labelledby="profile-name">
            <div className="nurse-profile-identity-heading">
              <span className="nurse-profile-avatar" aria-hidden="true">{nurse.initials}</span>
              <div><h2 id="profile-name">{nurse.name}</h2><p>Perawat · ID {nurse.id}</p></div>
              <span className="nurse-profile-active">Aktif</span>
            </div>
            <dl className="nurse-profile-details">{details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </section>
          <section className="card nurse-profile-settings" aria-labelledby="notification-settings-title">
            <div className="nurse-profile-settings-heading"><h2 id="notification-settings-title">Pengaturan notifikasi</h2></div>
            <div className="nurse-profile-settings-body">{notificationSettings.map(({ id, label, description }) => <label className={`nurse-notification-option${notificationPreferences[id] ? " is-checked" : ""}`} key={id}>
              <input type="checkbox" checked={notificationPreferences[id]} onChange={(event) => setNotificationPreference(id, event.target.checked)} />
              <span className="nurse-notification-check" aria-hidden="true">{notificationPreferences[id] && <Check size={13} strokeWidth={3} />}</span>
              <span><strong>{label}</strong><small>{description}</small></span>
            </label>)}</div>
          </section>
        </div>
        <aside className="nurse-profile-sidebar" aria-label="Pintasan profil">
          <div className="nurse-profile-shortcuts">
            <Link className="nurse-profile-shortcut" href="/notifikasi">
              <span className="nurse-profile-shortcut-icon"><Bell size={21} strokeWidth={1.6} aria-hidden="true" /></span>
              <span><strong>Notifikasi</strong><small>{unreadNotificationCount} belum dibaca</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
            <Link className="nurse-profile-shortcut" href="/jadwal-kunjungan">
              <span className="nurse-profile-shortcut-icon"><ClipboardCheck size={20} strokeWidth={1.6} aria-hidden="true" /></span>
              <strong>Jadwal kunjungan saya</strong><ChevronRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <button className="button nurse-profile-signout" onClick={signOutDemo}>Keluar</button>
        </aside>
      </div>
    </main>
  </>;
}
