import { z } from "zod";
import { checkInObservationSchema, isoUtcSchema } from "../checkins/schemas";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum: number) => text(maximum).nullable();

export const bookingIntakeSchema = z
  .object({
    complaint: text(2000),
    otherComplaint: nullableText(2000),
    history: nullableText(4000),
    consciousness: z.enum(["alert", "drowsy", "confused"]).nullable(),
    conditions: z
      .array(z.enum(["pale", "weak", "cold_sweat", "none"]))
      .max(4)
      .superRefine((conditions, context) => {
        if (new Set(conditions).size !== conditions.length) {
          context.addIssue({ code: "custom", path: ["conditions"], message: "conditions must be unique" });
        }
        if (conditions.includes("none") && conditions.length !== 1) {
          context.addIssue({ code: "custom", path: ["conditions"], message: "none cannot be combined" });
        }
      }),
    observations: z
      .array(checkInObservationSchema)
      .max(6)
      .superRefine((observations, context) => {
        const types = observations.map((observation) => observation.type);
        if (new Set(types).size !== types.length) {
          context.addIssue({ code: "custom", path: ["observations"], message: "observation types must be unique" });
        }
      }),
    note: nullableText(4000),
    consent: z.boolean(),
  })
  .strict();

export const bookingCreateSchema = z
  .object({
    nurseId: z.string().uuid(),
    slotId: z.string().uuid().nullable(),
    startsAt: isoUtcSchema,
    endsAt: isoUtcSchema,
    intake: bookingIntakeSchema,
  })
  .strict();

export const bookingPatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    nurseId: z.string().uuid().optional(),
    slotId: z.string().uuid().nullable().optional(),
    startsAt: isoUtcSchema.optional(),
    endsAt: isoUtcSchema.optional(),
    intake: bookingIntakeSchema.optional(),
  })
  .strict()
  .refine(
    ({ expectedVersion: _version, ...fields }) => Object.values(fields).some((value) => value !== undefined),
    "at least one draft field is required",
  );

export const bookingVersionSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();
export const bookingCancelSchema = z
  .object({ expectedVersion: z.number().int().min(0), reason: text(2000) })
  .strict();
export const bookingDecisionSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    decision: z.enum(["accept", "reject"]),
    reason: text(2000).nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === "reject" && input.reason === null) {
      context.addIssue({ code: "custom", path: ["reason"], message: "rejection reason is required" });
    }
  });
export const bookingRescheduleSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    slotId: z.string().uuid().nullable(),
    startsAt: isoUtcSchema,
    endsAt: isoUtcSchema,
    reason: text(2000),
    patientAgreed: z.literal(true),
  })
  .strict();

export type BookingIntake = z.infer<typeof bookingIntakeSchema>;
export type BookingCreate = z.infer<typeof bookingCreateSchema>;
export type BookingPatch = z.infer<typeof bookingPatchSchema>;
export type BookingVersion = z.infer<typeof bookingVersionSchema>;
export type BookingCancel = z.infer<typeof bookingCancelSchema>;
export type BookingDecision = z.infer<typeof bookingDecisionSchema>;
export type BookingReschedule = z.infer<typeof bookingRescheduleSchema>;
