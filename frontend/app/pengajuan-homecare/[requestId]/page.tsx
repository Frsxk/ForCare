import { LiveHomecareNurseRequestDetail } from "@/components/homecare-nurse";

export const metadata = { title: "Detail pengajuan homecare | ForCare" };

export default async function Page({ params, searchParams }: { params: Promise<{ requestId: string }>; searchParams: Promise<{ prioritas?: string }> }) {
  const [{ requestId }, { prioritas }] = await Promise.all([params, searchParams]);
  return <LiveHomecareNurseRequestDetail key={requestId} requestId={requestId} priorityId={prioritas ?? null} />;
}
