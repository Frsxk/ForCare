import type { Metadata } from "next";
import { PatientContactEditPage } from "@/components/patient-contact-edit-page";

export const metadata: Metadata = { title: "Ubah Kontak | ForCare" };
export default function Page() { return <PatientContactEditPage />; }
