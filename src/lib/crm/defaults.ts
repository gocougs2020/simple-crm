import type { ClientCategory } from "@/lib/constants";

type StageDefault = { name: string; probability: number; rottingDays: number | null };

/**
 * The stages a new workspace (or a new pipeline) starts with, per client
 * category. Everything can be renamed, reordered or removed in Settings.
 */
export const defaultStages: Record<ClientCategory, { pipeline: string; stages: StageDefault[] }> = {
  prospective: {
    pipeline: "Sales",
    stages: [
      { name: "Lead", probability: 10, rottingDays: 14 },
      { name: "Contacted", probability: 20, rottingDays: 14 },
      { name: "Meeting scheduled", probability: 40, rottingDays: 14 },
      { name: "Proposal sent", probability: 60, rottingDays: 14 },
      { name: "Negotiation", probability: 80, rottingDays: 14 },
      { name: "Not now", probability: 5, rottingDays: null },
    ],
  },
  current: {
    pipeline: "Accounts",
    stages: [
      { name: "Onboarding", probability: 0, rottingDays: 30 },
      { name: "Active", probability: 0, rottingDays: null },
      { name: "Renewal due", probability: 0, rottingDays: 14 },
      { name: "At risk", probability: 0, rottingDays: 7 },
    ],
  },
  past: {
    pipeline: "Former clients",
    stages: [
      { name: "Recently left", probability: 0, rottingDays: null },
      { name: "Win-back candidate", probability: 0, rottingDays: null },
      { name: "In win-back campaign", probability: 0, rottingDays: null },
      { name: "Do not contact", probability: 0, rottingDays: null },
    ],
  },
};
