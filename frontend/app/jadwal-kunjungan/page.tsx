import type { Metadata } from "next";
import { VisitSchedulePage } from "@/components/visit-schedule-page";

export const metadata: Metadata = {
  title: "Jadwal Kunjungan | ForCare",
  description:
    "Jadwal kunjungan homecare perawat, rekam medis, dan riwayat kunjungan pasien.",
};

export default function Page() {
  return <VisitSchedulePage />;
}
