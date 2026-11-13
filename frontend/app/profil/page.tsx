import type { Metadata } from "next";
import { NurseProfilePage } from "@/components/nurse-profile-page";

export const metadata: Metadata = {
  title: "Profil Perawat | ForCare",
  description: "Profil perawat dan pengaturan notifikasi ForCare.",
};

export default function Page() {
  return <NurseProfilePage />;
}
