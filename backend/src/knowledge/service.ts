import type { SQL } from "bun";
import type { AuthConfig } from "../config";
import type { AuthContext } from "../auth/policy";
import { AppError } from "../http/errors";
import { parseStrict } from "../http/request";
import { retrieveKnowledge, requireKnowledgeNurse } from "./repository";
import { knowledgeSearchSchema, type KnowledgeSearch, type KnowledgeSearchResponse } from "./schemas";

export type KnowledgeService = {
  search(auth: AuthContext, input: KnowledgeSearch): Promise<KnowledgeSearchResponse>;
};

export function createKnowledgeService(options: { sql: SQL; config: AuthConfig }): KnowledgeService {
  return {
    async search(auth, input) {
      if (auth.role !== "nurse" || !auth.staffId) throw new AppError("FORBIDDEN", "Nurse access is required", 403);
      const parsed = parseStrict(knowledgeSearchSchema, input);
      return options.sql.begin(async (tx) => {
        await requireKnowledgeNurse(tx, auth.staffId!, options.config, auth.accountId);
        const { corpusId: _boundCorpusId, ...response } = await retrieveKnowledge(tx, parsed);
        return response;
      });
    },
  };
}
