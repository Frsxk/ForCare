import type { Metadata } from "next";
import { PatientProfilePage } from "@/components/patient-profile-page";

export const metadata: Metadata = { title: "Profil Pasien | ForCare" };
export default function Page() { return <PatientProfilePage />; }
