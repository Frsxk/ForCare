import type { SQL } from "bun";
import type { AuthContext } from "../auth/policy";
import { requireSelfOrPrimaryScope } from "../clinical/policy";
import type { AuthConfig } from "../config";
import { decodeCursor, encodeCursor, hashFilter, type CursorBinding } from "../http/cursor";
import { AppError } from "../http/errors";
import { isoTimestamp } from "../http/time";
import { listAssessmentRunMetadata } from "./repository";

const UNAVAILABLE_REASON = "G02_NOT_APPROVED";

export type AssessmentService = {
  getPatientAssessments(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ): Promise<unknown>;
};

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

function metadataDto(row: Awaited<ReturnType<typeof listAssessmentRunMetadata>>[number]) {
  // Metadata only: no score, formula, threshold, inputs or confirmation claim.
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    instrumentCode: row.instrument_code,
    instrumentName: row.instrument_name,
    sourceCheckInId: row.source_check_in_id,
    status: row.status,
    unavailableReason: row.unavailable_reason,
    computedAt: nullableTimestamp(row.computed_at),
    reviewedBy: row.reviewed_by,
    createdAt: isoTimestamp(row.created_at),
  };
}

export function createAssessmentService(options: { sql: SQL; config: AuthConfig }): AssessmentService {
  const { sql, config } = options;

  async function getPatientAssessments(
    auth: AuthContext,
    patientId: string,
    query: { cursor: string | null; limit: number },
  ) {
    await requireSelfOrPrimaryScope(sql, auth, patientId);
    const binding: CursorBinding = {
      accountId: auth.accountId,
      sessionId: auth.sessionId,
      scope: `assessments:${patientId}:${auth.role}`,
      filterHash: hashFilter(patientId),
    };
    const after = query.cursor ? decodeCursor(query.cursor, binding, config.sessionSecret) : null;
    const createdAt = after === null ? null : new Date(after.name);
    if (createdAt !== null && Number.isNaN(createdAt.getTime())) {
      throw new AppError("VALIDATION_FAILED", "Invalid or expired cursor", 422);
    }
    const rows = await listAssessmentRunMetadata(sql, {
      patientId,
      limit: query.limit,
      afterCreatedAt: createdAt === null ? null : isoTimestamp(createdAt),
      afterId: after?.id ?? null,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const last = selected.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            binding,
            { name: isoTimestamp(last.created_at), id: last.id },
            config.sessionSecret,
          )
        : null;

    return {
      patientId,
      score: { status: "unavailable", reason: UNAVAILABLE_REASON },
      // Numeric scoring and confirmed assessment reporting require an approved
      // G02 policy. No stored numeric run is promoted to this field.
      lastConfirmedAssessment: null,
      history: {
        items: selected.map(metadataDto),
        page: { nextCursor, hasMore },
      },
      trend: { status: "unavailable", reason: UNAVAILABLE_REASON },
    };
  }

  return { getPatientAssessments };
}
