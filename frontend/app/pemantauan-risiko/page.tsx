import type { Metadata } from "next";
import { RiskMonitoringPage } from "@/components/risk-monitoring-page";

export const metadata: Metadata = {
  title: "Pemantauan Risiko | ForCare",
  description: "Tinjau dan setujui tingkat risiko pasien dalam pemantauan.",
};

export default function Page() {
  return <RiskMonitoringPage />;
}
