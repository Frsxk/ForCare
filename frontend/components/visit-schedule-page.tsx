"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import {
  formatVisitDate,
  visitDemoDate,
  type NurseVisit,
} from "@/lib/visit-data";
import { NurseHeader } from "@/components/nurse-header";
import { useNurseData } from "@/components/nurse-data-provider";

const tabs = [
  { value: "upcoming", label: "Mendatang" },
  { value: "done", label: "Selesai" },
  { value: "all", label: "Semua" },
] as const;
type VisitTab = (typeof tabs)[number]["value"];

export function VisitSchedulePage() {
  const { visits } = useNurseData();
  const [tab, setTab] = useState<VisitTab>("upcoming");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const filteredVisits = visits
    .filter((visit) =>
      tab === "upcoming"
        ? visit.date >= visitDemoDate && visit.status === "scheduled"
        : tab === "done"
          ? visit.status === "done"
          : true,
    )
    .toSorted((a, b) =>
      `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
    );
  const today = filteredVisits.filter((visit) => visit.date === visitDemoDate);
  const upcoming = filteredVisits.filter((visit) => visit.date > visitDemoDate);
  const pastDates = [
    ...new Set(
      filteredVisits
        .filter((visit) => visit.date < visitDemoDate)
        .map((visit) => visit.date),
    ),
  ]
    .sort()
    .reverse();

  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next].value);
    tabRefs.current[next]?.focus();
  }

  function visitRow(visit: NurseVisit, future = false) {
    const action = future
      ? "Lihat pasien"
      : visit.status === "done"
        ? "Lihat rekam medis"
        : "Isi rekam medis";
    return (
      <li className="schedule-page-row" key={visit.id}>
        <div className="schedule-page-patient">
          <strong>
            {future
              ? `${formatVisitDate(visit.date, true)} · ${visit.time}`
              : `${visit.time} · ${visit.patient.name}`}
          </strong>
          <span className="secondary-text">
            {future
              ? `${visit.patient.name} · ${visit.patient.id}`
              : visit.patient.id}
          </span>
        </div>
        <span className={`schedule-status schedule-status-${visit.status}`}>
          {visit.status === "done" ? "Selesai" : "Terjadwal"}
        </span>
        <Link
          className="button button-primary button-small schedule-row-action"
          href={future ? `/pasien-rekam-medis/${visit.patient.id}?tab=profile` : `/jadwal-kunjungan/${visit.id}`}
          aria-label={`${action} ${visit.patient.name}${future ? ` ${formatVisitDate(visit.date, true)}` : ""}`}
        >
          {action}
        </Link>
      </li>
    );
  }

  return (
    <>
      <NurseHeader activePage="visits" />
      <main id="konten-utama" className="dashboard-main visit-schedule-main">
        <div className="page-heading">
          <h1>Jadwal Kunjungan</h1>
          <p>Kunjungan yang akan dan sudah Anda lakukan</p>
        </div>
        <div
          className="visit-tabs"
          role="tablist"
          aria-label="Filter jadwal kunjungan"
        >
          {tabs.map((item, index) => (
            <button
              key={item.value}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              id={`visit-tab-${item.value}`}
              aria-selected={tab === item.value}
              aria-controls={`visit-panel-${tab}`}
              tabIndex={tab === item.value ? 0 : -1}
              className={`visit-tab${tab === item.value ? " is-selected" : ""}`}
              onClick={() => setTab(item.value)}
              onKeyDown={(event) => navigateTabs(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          className="schedule-groups"
          role="tabpanel"
          id={`visit-panel-${tab}`}
          aria-labelledby={`visit-tab-${tab}`}
          tabIndex={0}
        >
          {today.length > 0 && (
            <section
              className="card schedule-group"
              aria-labelledby="schedule-today-title"
            >
              <div className="section-header schedule-today-header">
                <h2 id="schedule-today-title">
                  {formatVisitDate(visitDemoDate)} · hari ini
                </h2>
              </div>
              <ul>{today.map((visit) => visitRow(visit))}</ul>
            </section>
          )}
          {upcoming.length > 0 && (
            <section
              className="card schedule-group"
              aria-labelledby="schedule-upcoming-title"
            >
              <div className="section-header schedule-upcoming-header">
                <h2 id="schedule-upcoming-title">Mendatang</h2>
              </div>
              <ul>{upcoming.map((visit) => visitRow(visit, true))}</ul>
            </section>
          )}
          {pastDates.map((date) => (
            <section
              className="card schedule-group"
              key={date}
              aria-labelledby={`schedule-past-${date}`}
            >
              <div className="section-header schedule-past-header">
                <h2 id={`schedule-past-${date}`}>{formatVisitDate(date)}</h2>
              </div>
              <ul>
                {filteredVisits
                  .filter((visit) => visit.date === date)
                  .map((visit) => visitRow(visit))}
              </ul>
            </section>
          ))}
          {filteredVisits.length === 0 && (
            <div className="card empty-state schedule-empty">
              <CalendarDays size={32} aria-hidden="true" />
              <h2>Belum ada kunjungan</h2>
              <p>
                {tab === "done"
                  ? "Kunjungan yang selesai akan ditampilkan di sini."
                  : "Jadwal kunjungan akan ditampilkan di sini."}
              </p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
