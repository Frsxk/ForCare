import { z } from "zod";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function isIsoUtc(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
}

export const isoUtcSchema = z
  .string()
  .refine(isIsoUtc, "timestamp must be an exact ISO 8601 UTC timestamp with Z");

export const availabilityWindowSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((value) => value.startMinute < value.endMinute, {
    message: "startMinute must precede endMinute",
  });

export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;

export const availabilitySlotInputSchema = z
  .object({
    startsAt: isoUtcSchema,
    endsAt: isoUtcSchema,
  })
  .strict();

export type AvailabilitySlotInput = z.infer<typeof availabilitySlotInputSchema>;

export const availabilityPublishSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    timeZone: z.string().trim().min(1).max(128),
    slotMinutes: z.number().int().min(1).max(480),
    bufferMinutes: z.number().int().min(0).max(120),
    effectiveFrom: isoUtcSchema,
    effectiveTo: isoUtcSchema,
    windows: z.array(availabilityWindowSchema).max(7 * 24),
    slots: z.array(availabilitySlotInputSchema).max(200),
  })
  .strict();

export type AvailabilityPublish = z.infer<typeof availabilityPublishSchema>;
