import { LiveHomecareNurseRequestDetail } from "@/components/homecare-nurse";

export const metadata = { title: "Detail pengajuan homecare | ForCare" };

export default async function Page({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  return <LiveHomecareNurseRequestDetail key={requestId} requestId={requestId} />;
}
