import type { PatientRisk } from "@/lib/patient-directory-data";

export type PatientMedicalHistory = {
  diagnosis: string;
  secondaryDiagnosis: string;
  admitted: string;
  discharged: string;
  allergies: string;
  procedures: string;
};

export const emptyMedicalHistory: PatientMedicalHistory = {
  diagnosis: "", secondaryDiagnosis: "", admitted: "", discharged: "", allergies: "", procedures: "",
};
export const initialPatientHistories: Record<string, PatientMedicalHistory> = {
  "RM-2026-001": { ...emptyMedicalHistory, admitted: "2026-11-03", discharged: "2026-11-08" },
};

export function isValidPatientHistory(history: PatientMedicalHistory) {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return Boolean(history.diagnosis.trim() && history.allergies.trim() && history.procedures.trim()) && validDate(history.admitted) && validDate(history.discharged) && history.discharged >= history.admitted;
}

export type PatientAssessment = { summary: string; risk: PatientRisk };
export const ilhamAssessmentDraft = "Berdasarkan check-in dan pengajuan terbaru, pasien melaporkan keluhan lemas dengan tanda vital dalam rentang yang dilaporkan.\nTerdapat satu hari dengan obat terlewat sebagian dan satu hari dengan keluhan pusing ringan. Draf ini perlu diverifikasi perawat.";

export const ilhamProfile = {
  nik: "3174 0000 0000 0001", birthday: "12 Maret 1990", bloodType: "O",
  address: "Jl. Raya No. 12, Kebayoran, Jakarta Selatan", phone: "0812-0000-0001",
  emergency: "Siti Hasim (Ibu) · 0812-0000-0002", insurance: "BPJS Kesehatan · aktif",
};

export const ilhamDailyCheckIns = [
  { time: "11 Nov 2026 · 19.30", condition: "Baik-baik saja", complaint: "Tidak ada keluhan", temperature: "36,8 °C", pulse: "78 bpm", pressure: "120/80", medication: "Teratur", warning: false },
  { time: "10 Nov 2026 · 19.45", condition: "Pusing / keluhan lain", complaint: "Pusing ringan saat bangun tidur", temperature: "37,1 °C", pulse: "82 bpm", pressure: "118/78", medication: "Teratur", warning: true },
  { time: "9 Nov 2026 · 20.10", condition: "Baik-baik saja", complaint: "-", temperature: "36,7 °C", pulse: "76 bpm", pressure: "-", medication: "Terlewat sebagian", warning: false },
];

export function formatPatientDate(value: string) {
  if (!value) return "Belum tersedia";
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}
