import { z } from "zod";
import { isoUtcSchema } from "../checkins/schemas";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);

export const priorityRequestCreateSchema = z
  .object({
    bookingId: z.string().uuid(),
    statement: text(4000),
    startsAt: isoUtcSchema.optional(),
    endsAt: isoUtcSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.startsAt === undefined) !== (input.endsAt === undefined)) {
      context.addIssue({
        code: "custom",
        path: [input.startsAt === undefined ? "startsAt" : "endsAt"],
        message: "startsAt and endsAt must be supplied together",
      });
    }
  });

export const priorityRequestReviewSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    decision: z.enum(["accept_availability", "decline"]),
    reason: text(4000),
    available: z.boolean(),
  })
  .strict()
  .superRefine((input, context) => {
    const accepts = input.decision === "accept_availability";
    if (input.available !== accepts) {
      context.addIssue({
        code: "custom",
        path: ["available"],
        message: accepts
          ? "accept_availability requires available=true"
          : "decline requires available=false",
      });
    }
  });

export type PriorityRequestCreate = z.infer<typeof priorityRequestCreateSchema>;
export type PriorityRequestReview = z.infer<typeof priorityRequestReviewSchema>;
