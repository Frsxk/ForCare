import { patients } from "@/lib/dashboard-data";

export type PatientRisk = "high" | "medium" | "low";
export const riskLabels: Record<PatientRisk, string> = {
  high: "Risiko tinggi", medium: "Risiko sedang", low: "Risiko rendah",
};

// Placeholder mengikuti referensi; tingkat risiko tidak dihitung secara klinis.
const profiles: { age: number; sex: string; discharged: string; checkIn: string; complaint: boolean; risk: PatientRisk; reason: string }[] = [
  { age: 36, sex: "L", discharged: "8 Nov 2026", checkIn: "11 Nov · 19.30", complaint: false, risk: "medium", reason: "Lemas dua hari · pusing ringan" },
  { age: 54, sex: "P", discharged: "5 Nov 2026", checkIn: "11 Nov · 20.05", complaint: true, risk: "medium", reason: "Melaporkan keluhan" },
  { age: 61, sex: "L", discharged: "3 Nov 2026", checkIn: "11 Nov · 18.40", complaint: false, risk: "low", reason: "Kondisi baik · obat teratur" },
  { age: 47, sex: "P", discharged: "6 Nov 2026", checkIn: "10 Nov · 19.10", complaint: false, risk: "low", reason: "Kondisi baik" },
  { age: 68, sex: "L", discharged: "2 Nov 2026", checkIn: "11 Nov · 19.55", complaint: true, risk: "high", reason: "Keluhan · obat terlewat sebagian" },
  { age: 39, sex: "P", discharged: "7 Nov 2026", checkIn: "9 Nov · 20.20", complaint: false, risk: "low", reason: "Kondisi baik" },
];
export const patientDirectory = patients.map((patient, index) => ({ patient, ...profiles[index] }));
