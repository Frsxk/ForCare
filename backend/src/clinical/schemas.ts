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

export const clinicalSourceKindSchema = z.enum([
  "protocol",
  "medication",
  "wound_care",
  "diet",
  "activity",
  "danger_sign",
]);

export const careOrderKindSchema = z.enum(["medication", "followup", "care"]);

export const careOrderItemTypeSchema = z.enum([
  "medication",
  "storage",
  "wound_care",
  "device_care",
  "diet",
  "activity",
  "danger_sign",
  "first_aid",
  "followup",
]);

export const medicalObservationSchema = z
  .object({
    type: boundedText(100),
    value: z.union([z.number().finite(), boundedText(200)]).optional(),
    unit: boundedText(50).optional(),
    observedAt: isoUtcSchema.optional(),
  })
  .strict();

export const medicalSnapshotSchema = z
  .object({
    primaryDiagnosis: boundedText(500).nullable(),
    secondaryDiagnoses: z.array(boundedText(300)).max(50),
    admittedAt: isoUtcSchema.nullable(),
    dischargedAt: isoUtcSchema.nullable(),
    allergies: z.array(boundedText(200)).max(50),
    procedures: z.array(boundedText(300)).max(50),
    complaints: boundedText(2000).nullable(),
    observations: z.array(medicalObservationSchema).max(200),
    internalNote: boundedText(4000).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.admittedAt === null ||
      value.dischargedAt === null ||
      new Date(value.dischargedAt).getTime() >= new Date(value.admittedAt).getTime(),
    "dischargedAt must not precede admittedAt",
  );

export const medicalRecordCreateSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    sourceReference: boundedText(300),
    payload: medicalSnapshotSchema,
    supersedesId: z.string().uuid().optional(),
  })
  .strict();

export const clinicalSourceCreateSchema = z
  .object({
    patientId: z.string().uuid(),
    medicalRecordVersionId: z.string().uuid(),
    kind: clinicalSourceKindSchema,
    title: boundedText(200),
    body: boundedText(20000),
    supersedesId: z.string().uuid().optional(),
  })
  .strict();

export const clinicalSourcePatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    medicalRecordVersionId: z.string().uuid(),
    kind: clinicalSourceKindSchema,
    title: boundedText(200),
    body: boundedText(20000),
  })
  .strict();

export const publishExpectedVersionSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const careOrderItemSchema = z
  .object({
    type: careOrderItemTypeSchema,
    text: boundedText(1000),
  })
  .strict();

export const careOrderPayloadSchema = z
  .object({
    instructions: boundedText(4000),
    items: z.array(careOrderItemSchema).max(50).optional(),
  })
  .strict();

export const careOrderCreateSchema = z
  .object({
    patientId: z.string().uuid(),
    kind: careOrderKindSchema,
    sourceDocumentId: z.string().uuid(),
    sourceVersion: z.number().int().min(1),
    payload: careOrderPayloadSchema,
    effectiveFrom: isoUtcSchema,
    effectiveTo: isoUtcSchema.optional(),
    supersedesId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.effectiveTo === undefined ||
      new Date(value.effectiveTo).getTime() > new Date(value.effectiveFrom).getTime(),
    "effectiveTo must be after effectiveFrom",
  );

export const careOrderPatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    kind: careOrderKindSchema,
    sourceDocumentId: z.string().uuid(),
    sourceVersion: z.number().int().min(1),
    payload: careOrderPayloadSchema,
    effectiveFrom: isoUtcSchema,
    effectiveTo: isoUtcSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.effectiveTo === undefined ||
      new Date(value.effectiveTo).getTime() > new Date(value.effectiveFrom).getTime(),
    "effectiveTo must be after effectiveFrom",
  );

export const careOrderPublishSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    status: z.enum(["active", "completed", "cancelled"]),
  })
  .strict();

export type MedicalRecordCreate = z.infer<typeof medicalRecordCreateSchema>;
export type ClinicalSourceCreate = z.infer<typeof clinicalSourceCreateSchema>;
export type ClinicalSourcePatch = z.infer<typeof clinicalSourcePatchSchema>;
export type CareOrderCreate = z.infer<typeof careOrderCreateSchema>;
export type CareOrderPatch = z.infer<typeof careOrderPatchSchema>;
export type CareOrderPublish = z.infer<typeof careOrderPublishSchema>;
