import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { patientDirectory } from "@/lib/patient-directory-data";
import { PatientRecordPage } from "@/components/patient-record-page";

type Props = { params: Promise<{ patientId: string }> };

export function generateStaticParams() {
  return patientDirectory.map(({ patient }) => ({ patientId: patient.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { patientId } = await params;
  const profile = patientDirectory.find((item) => item.patient.id === patientId);
  if (!profile) notFound();
  return { title: `Rekam Medis · ${profile.patient.name} | ForCare` };
}

export default async function Page({ params }: Props) {
  const { patientId } = await params;
  const profile = patientDirectory.find((item) => item.patient.id === patientId);
  if (!profile) notFound();
  return <PatientRecordPage key={patientId} profile={profile} />;
}
