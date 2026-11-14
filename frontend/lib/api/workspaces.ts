import { canUseNurseWorkspace } from "./contracts";
import { createNurseApi, MedicalWriteRegistry, type NurseProfile } from "./nurse";
import { createPatientApi, PatientWriteController, type PatientProfile } from "./patient";
import { SessionScope } from "./scoped-resource";
import type { SessionController } from "./session";

// Ownership follows the cookie-backed session, never a route mount or browser storage.
export function getPatientWorkspace(controller: SessionController) {
  const state = controller.getSnapshot();
  if (state.status !== "authenticated" || state.session.account.roles.length !== 1 || state.session.account.roles[0] !== "patient" || !state.session.access.scopes.includes("patient:self")) throw new Error("Patient session required");
  return controller.retain("patient", () => {
    const scope = new SessionScope(controller), baseApi = createPatientApi(controller.api), profile = scope.resource<PatientProfile>();
    const api = { ...baseApi, profile: async (signal?: AbortSignal) => {
      const own = await baseApi.profile(signal);
      if (own.accountId !== scope.session.account.id) throw new Error("Profile account mismatch");
      return own;
    } };
    let retained: PatientWriteController | null = null;
    const clear = () => { retained?.clear(); retained = null; };
    return { scope, api, profile,
      suspend: () => { scope.suspend(); retained?.suspend(); },
      dispose: () => { clear(); scope.dispose(); },
      writer: (ownId: string) => {
        const current = profile.getSnapshot();
        if (!scope.isCurrent() || current.status !== "ready" || current.data.id !== ownId || current.data.accountId !== scope.session.account.id) throw new Error("Own patient profile required");
        if (retained && retained.ownId !== ownId) clear();
        return retained ?? (retained = new PatientWriteController(controller.api, ownId, scope.isCurrent, verified => {
          if (verified.accountId !== scope.session.account.id) throw new Error("Profile account mismatch");
          profile.replace(verified);
        }));
      },
    };
  });
}

export function getNurseWorkspace(controller: SessionController) {
  const state = controller.getSnapshot();
  if (state.status !== "authenticated" || !canUseNurseWorkspace(state.session)) throw new Error("Nurse session required");
  return controller.retain("nurse", () => {
    const scope = new SessionScope(controller), medical = new MedicalWriteRegistry(controller.api, scope.isCurrent);
    return { scope, api: createNurseApi(controller.api), profile: scope.resource<NurseProfile>(), medical,
      suspend: () => { scope.suspend(); medical.suspend(); },
      dispose: () => { medical.clear(); scope.dispose(); },
    };
  });
}
