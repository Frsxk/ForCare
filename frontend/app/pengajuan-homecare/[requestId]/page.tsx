import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HomecareRequestDetailPage } from "@/components/homecare-request-detail-page";
import { homecareRequests } from "@/lib/dashboard-data";
import { homecareRequestDetails } from "@/lib/homecare-request-details";

type Props = { params: Promise<{ requestId: string }> };

export function generateStaticParams() {
  return homecareRequests.map((request) => ({ requestId: request.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { requestId } = await params;
  const request = homecareRequests.find((item) => item.id === requestId);
  if (!request) notFound();
  return {
    title: `Pengajuan ${request.id} · ${request.patient.name} | ForCare`,
  };
}

export default async function Page({ params }: Props) {
  const { requestId } = await params;
  const request = homecareRequests.find((item) => item.id === requestId);
  const detail = homecareRequestDetails[requestId];
  if (!request || !detail) notFound();

  return <HomecareRequestDetailPage initialRequest={request} detail={detail} />;
}
