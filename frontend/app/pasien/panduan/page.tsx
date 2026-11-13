import type { Metadata } from "next";
import { PatientCareGuidePage } from "@/components/patient-care-guide-page";

export const metadata: Metadata = { title: "Panduan Perawatan | ForCare" };
export default function Page() { return <PatientCareGuidePage />; }
