import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { VisitRecordPage } from "@/components/visit-record-page";
import { initialVisits, visitDemoDate } from "@/lib/visit-data";

type Props = { params: Promise<{ visitId: string }> };

export function generateStaticParams() {
  return initialVisits.map((visit) => ({ visitId: visit.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { visitId } = await params;
  const visit = initialVisits.find((item) => item.id === visitId);
  if (!visit) notFound();
  return { title: `Rekam Medis · ${visit.patient.name} | ForCare` };
}

export default async function Page({ params }: Props) {
  const { visitId } = await params;
  const visit = initialVisits.find((item) => item.id === visitId);
  if (!visit) notFound();
  if (visit.date > visitDemoDate) redirect(`/pasien-rekam-medis/${visit.patient.id}?tab=profile`);
  return <VisitRecordPage key={visit.id} initialVisit={visit} />;
}
