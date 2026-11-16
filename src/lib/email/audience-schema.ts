import { z } from "zod";
import { clientCategories } from "@/lib/constants";

const uuid = z.uuid();
const days = z.number().int().min(1).max(3650);

/** Campaign and saved-audience filters, as the browser sends them. Mirrors `CampaignAudience` in the schema. */
export const audienceSchema = z.object({
  tags: z.array(z.string().max(40)).max(50).optional(),
  tagMatch: z.enum(["any", "all"]).optional(),
  excludeTags: z.array(z.string().max(40)).max(50).optional(),
  ownerIds: z.array(uuid).max(100).optional(),
  organizationIds: z.array(uuid).max(500).optional(),
  activeWithinDays: days.optional(),
  inactiveForDays: days.optional(),
  noCampaignForDays: days.optional(),
  customFields: z
    .array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/).max(80), values: z.array(z.string().max(300)).max(50) }))
    .max(20)
    .optional(),
  pipelineIds: z.array(uuid).max(50).optional(),
  stageIds: z.array(uuid).max(100).optional(),
  clientCategories: z.array(z.enum(clientCategories)).max(3).optional(),
  clientTags: z.array(z.string().max(40)).max(50).optional(),
  serviceIds: z.array(uuid).max(100).optional(),
  churnReasons: z.array(z.string().max(300)).max(50).optional(),
  openToReturnOnly: z.boolean().optional(),
  decisionMakersOnly: z.boolean().optional(),
  organizationIndustries: z.array(z.string().max(80)).max(100).optional(),
  organizationFields: z
    .array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/).max(80), values: z.array(z.string().max(300)).max(50) }))
    .max(20)
    .optional(),
  personIds: z.array(uuid).max(5000).optional(),
});

export type AudienceInput = z.input<typeof audienceSchema>;
