import type { Metadata } from "next";
import { HomecareRequestsPage } from "@/components/homecare-requests-page";

export const metadata: Metadata = {
  title: "Pengajuan Homecare | ForCare",
  description: "Tinjau dan putuskan pengajuan homecare dari pasien Anda.",
};

export default function Page() {
  return <HomecareRequestsPage />;
}
