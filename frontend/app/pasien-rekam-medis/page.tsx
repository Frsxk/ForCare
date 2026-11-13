import type { Metadata } from "next";
import { PatientDirectoryPage } from "@/components/patient-directory-page";

export const metadata: Metadata = {
  title: "Pasien & Rekam Medis | ForCare",
  description: "Daftar pasien dalam pemantauan perawat dan riwayat rekam medis.",
};

export default function Page() {
  return <PatientDirectoryPage />;
}
