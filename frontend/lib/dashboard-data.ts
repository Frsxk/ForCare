// Data contoh terpusat. Ganti dengan hasil API saat integrasi backend tersedia.
export const nurse = {
  name: "Dinda Maharani",
  firstName: "Dinda",
  initials: "DM",
  id: "NUR-001",
  role: "Perawat homecare",
  phone: "0812-0000-0100",
};

export const dashboardDate = "Kamis, 12 November 2026";

export type Patient = {
  id: string;
  name: string;
  initials: string;
};

export const patients: Patient[] = [
  { id: "RM-2026-001", name: "Ilham Shahputra Hasim", initials: "IS" },
  { id: "RM-2026-002", name: "Aruna Wijaya", initials: "AW" },
  { id: "RM-2026-003", name: "Damar Wicaksono", initials: "DW" },
  { id: "RM-2026-004", name: "Citra Lestari", initials: "CL" },
  { id: "RM-2026-005", name: "Elang Pratama", initials: "EP" },
  { id: "RM-2026-006", name: "Farah Nabila", initials: "FN" },
];

export const attentionItems = [
  {
    patient: patients[4],
    risk: "high",
    riskLabel: "Risiko tinggi",
    reason: "Melaporkan keluhan · obat terlewat sebagian",
    source: "Check-in 11 Nov · 19.55",
  },
  {
    patient: patients[1],
    risk: "medium",
    riskLabel: "Risiko sedang",
    reason: "Melaporkan keluhan",
    source: "Check-in 11 Nov · 20.05",
  },
  {
    patient: patients[0],
    risk: "medium",
    riskLabel: "Risiko sedang",
    reason: "Lemas dua hari · pusing ringan",
    source: "Skrining 12 Nov · 09.15",
  },
] as const;

export type RequestStatus = "pending" | "accepted" | "rejected";

export type HomecareRequest = {
  id: string;
  patient: Patient;
  schedule: string;
  doctor: string;
  status: RequestStatus;
  rejectionReason?: string;
};

export const requestStatusLabels: Record<RequestStatus, string> = {
  pending: "Menunggu",
  accepted: "Diterima",
  rejected: "Ditolak",
};

export const homecareRequests: HomecareRequest[] = [
  {
    id: "HC-0014",
    status: "pending",
    patient: patients[0],
    schedule: "Sen, 16 Nov · 10.00",
    doctor: "dr. Andini Pratama",
  },
  {
    id: "HC-0015",
    status: "pending",
    patient: patients[1],
    schedule: "Jum, 13 Nov · 13.00",
    doctor: "dr. Raka Wijaya",
  },
  {
    id: "HC-0013",
    status: "pending",
    patient: patients[3],
    schedule: "Sab, 14 Nov · 09.00",
    doctor: "dr. Andini Pratama",
  },
  {
    id: "HC-0012",
    status: "accepted",
    patient: patients[2],
    schedule: "Kam, 12 Nov · 09.00",
    doctor: "dr. Raka Wijaya",
  },
];
