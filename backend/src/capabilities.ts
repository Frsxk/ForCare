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
    availability: { state: "enabled" },
    bookings: { state: "enabled" },
    priorityRequests: { state: "enabled" },
    clinicalRecords: { state: "enabled" },
    checkIns: { state: "enabled" },
    assessments: {
      state: "gated",
      reason: "Instrument approval and numeric assessment scoring require G02 approval",
      gate: "G02",
    },
    dailySummaries: { state: "missing", reason: "No approved summary definition", gate: "G02" },
    clinicalScoring: { state: "gated", gate: "G02" },
    analysisDrafts: { state: "gated", gate: "G02" },
    knowledgeRetrieval: { state: "gated", gate: "G05" },
    webPush: { state: "gated", gate: "G05" },
  };
}
