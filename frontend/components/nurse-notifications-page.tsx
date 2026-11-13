"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Bell, CalendarDays, ClipboardCheck, FileText } from "lucide-react";
import type { NotificationCategory } from "@/lib/notification-data";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";
import "./nurse-notifications.css";

const tabs: { value: "all" | NotificationCategory; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "requests", label: "Pengajuan" },
  { value: "visits", label: "Jadwal kunjungan" },
  { value: "records", label: "Rekam medis" },
];
const icons = { requests: ClipboardCheck, visits: CalendarDays, records: FileText };

export function NurseNotificationsPage() {
  const { notifications, unreadNotificationCount, markNotificationRead, markNotificationsRead } = useNurseData();
  const [tab, setTab] = useState<"all" | NotificationCategory>("all");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const visible = notifications.filter((notification) => tab === "all" || notification.category === tab);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next].value);
    tabRefs.current[next]?.focus();
  }

  return <>
    <NurseHeader activePage="notifications" />
    <main id="konten-utama" className="dashboard-main nurse-notifications-main">
      <div className="page-heading nurse-notifications-heading">
        <div><h1>Notifikasi</h1><p role="status" aria-live="polite">{unreadNotificationCount} belum dibaca</p></div>
        <button className="button button-primary" disabled={unreadNotificationCount === 0} onClick={markNotificationsRead}>Tandai semua dibaca</button>
      </div>
      <div className="nurse-notification-tabs" role="tablist" aria-label="Kategori notifikasi">
        {tabs.map(({ value, label }, index) => <button key={value} ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" id={`notification-tab-${value}`} aria-controls={`notification-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} className={`nurse-notification-tab${tab === value ? " is-selected" : ""}`} onClick={() => setTab(value)} onKeyDown={(event) => navigateTabs(event, index)}>{label}</button>)}
      </div>
      <section role="tabpanel" tabIndex={0} id={`notification-panel-${tab}`} aria-labelledby={`notification-tab-${tab}`}>
        {visible.length > 0 ? <ul className="card nurse-notification-list">{visible.map((notification) => {
          const Icon = icons[notification.category];
          return <li key={notification.id} className={`nurse-notification-item${notification.read ? "" : " is-unread"}`}>
            <Link className="nurse-notification-link" href={notification.href} onClick={() => markNotificationRead(notification.id)}>
              <span className="nurse-notification-dot" aria-hidden="true" />
              <span className={`nurse-notification-icon notification-icon-${notification.category}`}><Icon size={20} strokeWidth={1.7} aria-hidden="true" /></span>
              <span className="nurse-notification-copy"><span className="sr-only">{notification.read ? "Sudah dibaca. " : "Belum dibaca. "}</span><strong>{notification.title}</strong><span>{notification.description}</span></span>
              <time dateTime={notification.dateTime}>{notification.timestamp}</time>
            </Link>
          </li>;
        })}</ul> : <div className="card empty-state"><Bell size={32} aria-hidden="true" /><h2>Belum ada notifikasi</h2><p>Notifikasi untuk kategori ini akan muncul di sini.</p></div>}
      </section>
    </main>
  </>;
}
