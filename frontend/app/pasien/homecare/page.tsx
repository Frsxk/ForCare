import type { Metadata } from "next";
import { PatientHomecarePage } from "@/components/patient-homecare-page";

export const metadata: Metadata = { title: "Homecare | ForCare" };
export default function Page() { return <PatientHomecarePage />; }
