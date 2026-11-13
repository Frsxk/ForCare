import type { Metadata } from "next";
import { NurseNotificationsPage } from "@/components/nurse-notifications-page";

export const metadata: Metadata = {
  title: "Notifikasi | ForCare",
  description: "Notifikasi pengajuan homecare, jadwal kunjungan, dan rekam medis perawat.",
};

export default function Page() {
  return <NurseNotificationsPage />;
}
