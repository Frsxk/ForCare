import { nurse } from "@/lib/dashboard-data";
import { initialVisits, type NurseVisit } from "@/lib/visit-data";

export type MedicalSupply = {
  id: string;
  name: string;
  kind: "Alat" | "Bahan";
  quantity: string;
  unit: string;
};

export type VisitMedicalRecord = {
  nurseName: string;
  nurseId: string;
  startedAt: string;
  endedAt: string;
  systolic: string;
  diastolic: string;
  temperature: string;
  heartRate: string;
  consciousness: string;
  observations: string;
  procedures: string;
  supplies: MedicalSupply[];
  noSuppliesUsed: boolean;
};

export type PatientVisitReference = {
  complaint: string;
  lastCheckIn: string;
  checkInSummary: string;
  address: string;
};

const timePattern = /^([01]\d|2[0-3])[.:]([0-5]\d)$/;
function timeInMinutes(value: string) {
  const match = timePattern.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function hasValidVisitTimes(record: VisitMedicalRecord) {
  const start = timeInMinutes(record.startedAt);
  const end = timeInMinutes(record.endedAt);
  return start !== null && end !== null && end > start;
}

export function getRecordCompleteness(record: VisitMedicalRecord) {
  const positiveInteger = (value: string) => /^[1-9]\d*$/.test(value);
  const validTemperature =
    /^\d{1,2}([.,]\d{1,2})?$/.test(record.temperature) &&
    Number(record.temperature.replace(",", ".")) > 0;
  return [
    {
      label: "Penanggung jawab tindakan",
      complete:
        Boolean(record.nurseName.trim() && record.nurseId.trim()) &&
        hasValidVisitTimes(record),
    },
    {
      label: "Hasil pemeriksaan pasien",
      complete:
        positiveInteger(record.systolic) &&
        positiveInteger(record.diastolic) &&
        validTemperature &&
        positiveInteger(record.heartRate) &&
        Boolean(record.consciousness && record.observations.trim()),
    },
    {
      label: "Rincian tindakan medis",
      complete: Boolean(record.procedures.trim()),
    },
    {
      label: "Log alat dan bahan medis",
      complete:
        record.supplies.length === 0
          ? record.noSuppliesUsed
          : record.supplies.every(
              (item) =>
                Boolean(item.name.trim() && item.unit.trim()) &&
                positiveInteger(item.quantity) &&
                (item.kind === "Alat" || item.kind === "Bahan"),
            ),
    },
  ];
}

export function createEmptyVisitRecord(visit: NurseVisit): VisitMedicalRecord {
  const end = Math.min((timeInMinutes(visit.time) ?? 0) + 45, 23 * 60 + 59);
  return {
    nurseName: nurse.name,
    nurseId: nurse.id,
    startedAt: visit.time,
    endedAt: `${String(Math.floor(end / 60)).padStart(2, "0")}.${String(end % 60).padStart(2, "0")}`,
    systolic: "",
    diastolic: "",
    temperature: "",
    heartRate: "",
    consciousness: "",
    observations: "",
    procedures: "",
    supplies: [],
    noSuppliesUsed: false,
  };
}

// Isi awal Ilham mengikuti PNG; seluruh catatan merupakan data contoh frontend.
const exampleRecord = (visit: NurseVisit): VisitMedicalRecord => ({
  ...createEmptyVisitRecord(visit),
  systolic: "120",
  diastolic: "80",
  temperature: "36,8",
  heartRate: "78",
  consciousness: "Sadar penuh",
  observations:
    visit.id === "VIS-002"
      ? "Pasien tampak lemas ringan dan kooperatif selama pemeriksaan."
      : "Catatan pemeriksaan kondisi pasien contoh.",
  procedures: "Pemeriksaan tanda vital dan observasi kondisi umum pasien.",
  supplies: [
    {
      id: "supply-1",
      name: "Sarung tangan",
      kind: "Bahan",
      quantity: "2",
      unit: "pasang",
    },
    {
      id: "supply-2",
      name: "Kassa steril",
      kind: "Bahan",
      quantity: "4",
      unit: "lembar",
    },
  ],
});

export const initialMedicalRecords: Record<string, VisitMedicalRecord> =
  Object.fromEntries(
    initialVisits
      .filter((visit) => visit.status === "done")
      .map((visit) => [visit.id, exampleRecord(visit)]),
  );
export const initialVisitDrafts: Record<string, VisitMedicalRecord> = {
  "VIS-002": exampleRecord(
    initialVisits.find((visit) => visit.id === "VIS-002")!,
  ),
};

export const patientVisitReferences: Record<string, PatientVisitReference> = {
  "RM-2026-001": {
    complaint: "Badan terasa lemas sejak dua hari terakhir.",
    lastCheckIn: "11 Nov 2026",
    checkInSummary: "Baik-baik saja · 36,8 °C · 78 bpm · 120/80",
    address: "Jl. Contoh Raya No. 12, Kebayoran Baru, Jakarta Selatan",
  },
};

export const unavailableVisitReference: PatientVisitReference = {
  complaint: "Belum tersedia",
  lastCheckIn: "Belum tersedia",
  checkInSummary: "Belum tersedia",
  address: "Belum tersedia",
};
