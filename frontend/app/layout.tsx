import type { Metadata } from "next";
import { NurseDataProvider } from "@/components/nurse-data-provider";
import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-700.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/plus-jakarta-sans/latin-800.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beranda Perawat | ForCare",
  description:
    "Dashboard perawat ForCare untuk meninjau pengajuan homecare, memantau pasien, dan mengelola jadwal kunjungan.",
  icons: { icon: "/forcare-mark.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body>
        <NurseDataProvider>{children}</NurseDataProvider>
      </body>
    </html>
  );
}
