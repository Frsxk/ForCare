export type CapabilityState = "enabled" | "disabled" | "missing" | "optional" | "gated";

export type Capability = {
  state: CapabilityState;
  reason?: string;
  gate?: string;
};

export function capabilitySnapshot(): Record<string, Capability> {
  return {
    identitySessions: { state: "enabled" },
    patientProfiles: { state: "enabled" },
    patientScope: { state: "enabled" },
    nurseDirectory: { state: "enabled" },
    availability: { state: "missing", reason: "Availability is not built", gate: "G03" },
    bookings: { state: "missing", reason: "Bookings are not built", gate: "G03" },
    clinicalRecords: { state: "gated", reason: "Clinical record visibility is not approved", gate: "G04" },
    dailySummaries: { state: "missing", reason: "No approved summary definition", gate: "G02" },
    clinicalScoring: { state: "gated", gate: "G02" },
    analysisDrafts: { state: "gated", gate: "G02" },
    knowledgeRetrieval: { state: "gated", gate: "G05" },
    webPush: { state: "gated", gate: "G05" },
  };
}
