import type { Patient } from "@/lib/dashboard-data";

export function PatientIdentity({ patient }: { patient: Patient }) {
  return (
    <div className="patient-identity">
      <strong>{patient.name}</strong>
      <span className="secondary-text">{patient.id}</span>
    </div>
  );
}

export function Avatar({
  initials,
  nurse: isNurse = false,
}: {
  initials: string;
  nurse?: boolean;
}) {
  return (
    <span
      className={`avatar${isNurse ? " avatar-nurse" : ""}`}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
