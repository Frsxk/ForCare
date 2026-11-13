import type { Metadata } from "next";
import { PatientDashboard } from "@/components/patient-dashboard";

export const metadata: Metadata = { title: "Beranda Pasien | ForCare", description: "Ringkasan jadwal, check-in, dan perawatan pasien ForCare." };
export default function Page() { return <PatientDashboard />; }
