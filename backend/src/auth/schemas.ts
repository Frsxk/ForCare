import { z } from "zod";

export const genderSchema = z.enum(["male", "female"]);

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const birthDateSchema = z
  .string()
  .refine(isCalendarDate, "birthDate must be a valid calendar date")
  .refine(
    (value) => value <= new Date().toISOString().slice(0, 10),
    "birthDate must not be in the future",
  );

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^\+?[0-9][0-9 ()-]*$/, "phone must contain digits and may start with +");
const passwordSchema = z.string().min(8).max(128);

export const registrationSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    birthDate: birthDateSchema,
    gender: genderSchema,
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export const logoutSchema = z
  .object({
    pushSubscriptionId: z.string().uuid().optional(),
  })
  .strict();

export type RegistrationInput = z.infer<typeof registrationSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
