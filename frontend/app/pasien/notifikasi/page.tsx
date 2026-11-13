import type { Metadata } from "next";
import { PatientNotificationsPage } from "@/components/patient-notifications-page";

export const metadata: Metadata = { title: "Notifikasi Pasien | ForCare" };
export default function Page() { return <PatientNotificationsPage />; }
