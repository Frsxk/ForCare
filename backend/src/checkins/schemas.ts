import { z } from "zod";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isIsoUtc(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
}

export const isoUtcSchema = z.string().refine(isIsoUtc, "timestamp must be ISO 8601 UTC with Z");

const boundedText = (max: number) => z.string().trim().min(1).max(max);

/** Approved check-in condition enum. */
export const checkInConditionSchema = z.enum(["ok", "complaint"]);
export type CheckInCondition = z.infer<typeof checkInConditionSchema>;

/** Approved scalar medication adherence status; no per-medication rows. */
export const medicationAdherenceStatusSchema = z.enum(["regular", "missed_once", "none"]);
export const medicationAdherenceSchema = medicationAdherenceStatusSchema;
export type MedicationAdherenceStatus = z.infer<typeof medicationAdherenceStatusSchema>;
export type MedicationAdherenceInput = z.infer<typeof medicationAdherenceSchema>;

export const observationTypeSchema = z.enum([
  "temperature_c",
  "heart_rate_bpm",
  "bp_systolic_mmhg",
  "bp_diastolic_mmhg",
  "weight_kg",
  "spo2_pct",
]);

export type ObservationType = z.infer<typeof observationTypeSchema>;

/** Target-contract units per typed measurement, exact lowercase tokens. */
export const OBSERVATION_UNITS: Readonly<Record<ObservationType, string>> = {
  temperature_c: "c",
  heart_rate_bpm: "bpm",
  bp_systolic_mmhg: "mmhg",
  bp_diastolic_mmhg: "mmhg",
  weight_kg: "kg",
  spo2_pct: "pct",
};

// numeric(8,3) technical precision: at most five integer digits and three
// decimals, finite and strictly positive. This is a storage bound, not a
// clinical reference or alert threshold. Values with more than three
// fraction digits are rejected, never rounded.
const MAX_TECHNICAL_VALUE = 99999.999;

function hasAtMostThreeFractionDigits(value: number): boolean {
  return Number(value.toFixed(3)) === value;
}

export const checkInObservationSchema = z
  .object({
    type: observationTypeSchema,
    value: z
      .number()
      .finite()
      .positive()
      .max(MAX_TECHNICAL_VALUE)
      .refine(hasAtMostThreeFractionDigits, "value must have at most three fraction digits"),
    unit: z.enum(["c", "bpm", "mmhg", "kg", "pct"]),
    observedAt: isoUtcSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.unit !== OBSERVATION_UNITS[value.type]) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: `unit must be ${OBSERVATION_UNITS[value.type]} for ${value.type}`,
      });
    }
  });

/** One snapshot may not repeat a measurement type. */
export const observationSnapshotSchema = z
  .array(checkInObservationSchema)
  .max(20)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.type)) {
        context.addIssue({
          code: "custom",
          path: [index, "type"],
          message: `duplicate observation type ${item.type}`,
        });
      }
      seen.add(item.type);
    });
  });

const editableCheckInFields = {
  condition: checkInConditionSchema,
  note: boundedText(4000).nullable(),
  medicationAdherence: medicationAdherenceSchema,
  observations: observationSnapshotSchema,
};

const PATCHABLE_FIELDS = Object.keys(editableCheckInFields) as (keyof typeof editableCheckInFields)[];

export const checkInCreateSchema = z
  .object({
    ...editableCheckInFields,
    supersedesCheckInId: z.string().uuid().optional(),
  })
  .strict();

export const checkInUpdateSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    ...editableCheckInFields,
  })
  .strict();

export const checkInPatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    ...z.object(editableCheckInFields).partial().shape,
  })
  .strict()
  .refine(
    (value) => PATCHABLE_FIELDS.some((field) => value[field] !== undefined),
    "at least one editable field is required",
  );

export const checkInSubmitSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const observationConfirmSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    note: boundedText(500).nullable().optional(),
  })
  .strict();

export type CheckInCreate = z.infer<typeof checkInCreateSchema>;
export type CheckInUpdate = z.infer<typeof checkInUpdateSchema>;
export type CheckInPatch = z.infer<typeof checkInPatchSchema>;
export type CheckInSubmit = z.infer<typeof checkInSubmitSchema>;
export type ObservationConfirm = z.infer<typeof observationConfirmSchema>;
export type CheckInObservationInput = z.infer<typeof checkInObservationSchema>;
