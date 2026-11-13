import type { Metadata } from "next";
import { PatientCheckinPage } from "@/components/patient-checkin-page";

export const metadata: Metadata = { title: "Check-in Harian | ForCare" };
export default function Page() { return <PatientCheckinPage />; }
