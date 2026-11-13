import { patients, type Patient } from "@/lib/dashboard-data";

export const visitDemoDate = "2026-11-12";

export type NurseVisit = {
  id: string;
  patient: Patient;
  date: string;
  time: string;
  status: "scheduled" | "done";
};

// Kunjungan setelah hari demo tetap terjadwal dan belum dapat diselesaikan.
export const initialVisits: NurseVisit[] = [
  {
    id: "VIS-001",
    patient: patients[2],
    date: visitDemoDate,
    time: "09.00",
    status: "done",
  },
  {
    id: "VIS-002",
    patient: patients[0],
    date: visitDemoDate,
    time: "14.00",
    status: "scheduled",
  },
  {
    id: "VIS-003",
    patient: patients[4],
    date: visitDemoDate,
    time: "16.00",
    status: "scheduled",
  },
  {
    id: "VIS-004",
    patient: patients[2],
    date: "2026-11-17",
    time: "09.00",
    status: "scheduled",
  },
  {
    id: "VIS-005",
    patient: patients[3],
    date: "2026-11-10",
    time: "10.00",
    status: "done",
  },
];

export function formatVisitDate(date: string, compact = false) {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: compact ? "short" : "long",
    day: "numeric",
    month: "short",
    ...(compact ? {} : { year: "numeric" }),
    timeZone: "Asia/Jakarta",
  }).format(new Date(`${date}T00:00:00Z`));
}
