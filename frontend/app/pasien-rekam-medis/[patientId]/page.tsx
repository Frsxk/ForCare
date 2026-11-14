import { LivePatientDetail } from "@/components/nurse-workspace-pages";

export const metadata = { title: "Rekam Medis | ForCare" };

export default async function Page({ params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = await params;
  return <LivePatientDetail key={patientId} patientId={patientId} />;
}
