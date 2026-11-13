import { z } from "zod";

const phone = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^\+?[0-9][0-9 ()-]*$/, "phone must contain digits and may start with +");

const nullableContact = (max: number) => z.string().trim().max(max).nullable().optional();

export const patientProfilePatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    phone: phone.optional(),
    addressLine: nullableContact(500),
    emergencyContactName: nullableContact(200),
    emergencyContactPhone: phone.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.phone !== undefined ||
      value.addressLine !== undefined ||
      value.emergencyContactName !== undefined ||
      value.emergencyContactPhone !== undefined,
    "At least one contact field is required",
  );

export const nurseProfilePatchSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    phone: phone.nullable().optional(),
  })
  .strict()
  .refine((value) => value.phone !== undefined, "phone is required");

export type PatientProfilePatch = z.infer<typeof patientProfilePatchSchema>;
export type NurseProfilePatch = z.infer<typeof nurseProfilePatchSchema>;
