"use server";

import { refresh } from "next/cache";
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionAdmin, actionUser, hashToken, randomToken, revokeSessions } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { customFieldTypes, entityTypes, userRoles } from "@/lib/constants";
import { sendEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/origin";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { loadSampleData } from "@/lib/sample-data";
import InviteEmail from "@/emails/invite";

const { users, pipelines, stages, deals, customFields, workspace } = schema;
const uuid = z.uuid();

// ─── Profile ─────────────────────────────────────────────────────────────

export async function updateProfile(input: { name: string; title: string | null }): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = z.object({ name: z.string().trim().min(1, "Enter your name.").max(80), title: z.string().trim().max(80).nullable() }).parse(input);
    const db = await getDb();
    await db
      .update(users)
      .set({ name: data.name, title: data.title || null })
      .where(eq(users.id, user.id));
    refresh();
  });
}

/** Changing your password signs out every other device. */
export async function changePassword(input: { current: string; next: string }): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    if (!user.passwordHash || !(await verifyPassword(input.current, user.passwordHash))) throw new ActionError("Your current password isn't right.");
    const problem = passwordProblem(input.next, user.email);
    if (problem) throw new ActionError(problem);
    const db = await getDb();
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(input.next) })
      .where(eq(users.id, user.id));
    await revokeSessions(user.id, user.sessionId);
  });
}

// ─── Team ────────────────────────────────────────────────────────────────

async function emailInvite(userId: string, inviterId: string, inviterName: string) {
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  // A new invite replaces any earlier one still waiting.
  await db.delete(schema.authTokens).where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.kind, "invite"), isNull(schema.authTokens.usedAt)));
  const token = randomToken();
  await db.insert(schema.authTokens).values({ tokenHash: await hashToken(token), kind: "invite", userId, createdBy: inviterId, expiresAt: new Date(Date.now() + 7 * 86400_000) });
  const url = `${await siteOrigin()}/invite/${token}`;
  const brand = await emailBrand();
  await sendEmail({ to: u.email, subject: `${inviterName} invited you to ${brand.workspaceName}'s CRM`, react: InviteEmail({ brand, inviter: inviterName, url }), tags: [{ name: "type", value: "invite" }] });
  return url;
}

const inviteInput = z.object({
  name: z.string().trim().min(1, "Enter their name.").max(80),
  email: z.email("Enter a valid email address.").transform((e) => e.trim().toLowerCase()),
  role: z.enum(["admin", "member"]),
});

/** Adds a teammate and emails them a link to set their password. Locally, the link is also returned so you can open it. */
export async function inviteTeammate(input: z.input<typeof inviteInput>): Promise<Result<{ devUrl: string | null }>> {
  return run(async () => {
    const admin = await actionAdmin();
    const data = inviteInput.parse(input);
    const db = await getDb();
    const [existing] = await db.select().from(users).where(eq(users.email, data.email));
    if (existing?.passwordHash) throw new ActionError(`${data.email} is already on the team.`);
    const id = existing?.id ?? (await db.insert(users).values({ email: data.email, name: data.name, role: data.role }).returning({ id: users.id }))[0].id;
    if (existing) await db.update(users).set({ name: data.name, role: data.role, deactivatedAt: null }).where(eq(users.id, id));
    const url = await emailInvite(id, admin.id, admin.name);
    refresh();
    return { devUrl: process.env.RESEND_API_KEY ? null : url };
  });
}

export async function resendInvite(userId: string): Promise<Result<{ devUrl: string | null }>> {
  return run(async () => {
    const admin = await actionAdmin();
    const url = await emailInvite(uuid.parse(userId), admin.id, admin.name);
    return { devUrl: process.env.RESEND_API_KEY ? null : url };
  });
}

export async function setRole(userId: string, role: (typeof userRoles)[number]): Promise<Result> {
  return run(async () => {
    const admin = await actionAdmin();
    const r = z.enum(userRoles).parse(role);
    const db = await getDb();
    const [target] = await db.select().from(users).where(eq(users.id, uuid.parse(userId)));
    if (!target) throw new ActionError("That teammate no longer exists.");
    if ((target.role === "owner" || r === "owner") && admin.role !== "owner") throw new ActionError("Only the owner can change who owns the workspace.");
    if (target.role === "owner" && r !== "owner") {
      const [{ n }] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "owner"), ne(users.id, target.id)));
      if (!n) throw new ActionError("Make someone else an owner first, so the workspace always has one.");
    }
    await db.update(users).set({ role: r }).where(eq(users.id, target.id));
    refresh();
  });
}

/** Deactivated teammates can't sign in; their history stays. Reactivating restores access with their old password. */
export async function setDeactivated(userId: string, deactivated: boolean): Promise<Result> {
  return run(async () => {
    const admin = await actionAdmin();
    const db = await getDb();
    const [target] = await db.select().from(users).where(eq(users.id, uuid.parse(userId)));
    if (!target) throw new ActionError("That teammate no longer exists.");
    if (target.id === admin.id) throw new ActionError("You can't deactivate yourself.");
    if (target.role === "owner" && admin.role !== "owner") throw new ActionError("Only an owner can deactivate an owner.");
    await db
      .update(users)
      .set({ deactivatedAt: deactivated ? new Date() : null })
      .where(eq(users.id, target.id));
    if (deactivated) await revokeSessions(target.id);
    refresh();
  });
}

// ─── Workspace and brand kit ─────────────────────────────────────────────

export async function updateWorkspace(input: { name: string; currency: string; timezone: string }): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = z
      .object({
        name: z.string().trim().min(1, "Enter a name.").max(80),
        currency: z.string().regex(/^[A-Z]{3}$/, "Pick a currency."),
        timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Pick a time zone."),
      })
      .parse(input);
    const db = await getDb();
    await db
      .insert(workspace)
      .values({ id: 1, ...data })
      .onConflictDoUpdate({ target: workspace.id, set: { ...data, updatedAt: new Date() } });
    refresh();
  });
}

const brandInput = z.object({
  logoUrl: z.union([z.url().startsWith("https://", "Use an https:// image URL."), z.literal("")]).optional(),
  accentColor: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1f2937."), z.literal("")]).optional(),
  senderName: z.string().trim().max(80).optional(),
  replyTo: z.union([z.email(), z.literal("")]).optional(),
  postalAddress: z.string().trim().max(300).optional(),
  website: z.union([z.url(), z.literal("")]).optional(),
  signature: z.string().max(1000).optional(),
});

export async function updateBrand(input: z.input<typeof brandInput>): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = brandInput.parse(input);
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== "" && v !== undefined));
    const db = await getDb();
    await db
      .insert(workspace)
      .values({ id: 1, brand: clean })
      .onConflictDoUpdate({ target: workspace.id, set: { brand: clean, updatedAt: new Date() } });
    refresh();
  });
}

// ─── Pipelines and stages ────────────────────────────────────────────────

export async function createPipeline(name: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    await actionAdmin();
    const n = z.string().trim().min(1, "Name the pipeline.").max(60).parse(name);
    const db = await getDb();
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${pipelines.position}), -1)::int` }).from(pipelines);
    const [p] = await db.insert(pipelines).values({ name: n, position: max + 1 }).returning({ id: pipelines.id });
    await db.insert(stages).values(["Lead", "Qualified", "Proposal", "Negotiation"].map((s, i) => ({ pipelineId: p.id, name: s, position: i, probability: [10, 30, 60, 80][i] })));
    refresh();
    return p;
  });
}

export async function renamePipeline(pipelineId: string, name: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const db = await getDb();
    await db
      .update(pipelines)
      .set({ name: z.string().trim().min(1, "Name the pipeline.").max(60).parse(name) })
      .where(eq(pipelines.id, uuid.parse(pipelineId)));
    refresh();
  });
}

export async function deletePipeline(pipelineId: string): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const db = await getDb();
    const [{ n }] = await db.select({ n: count() }).from(deals).where(eq(deals.pipelineId, uuid.parse(pipelineId)));
    if (n) throw new ActionError(`This pipeline has ${n} deal${n === 1 ? "" : "s"}. Move them to another pipeline first.`);
    await db.delete(pipelines).where(eq(pipelines.id, pipelineId));
    refresh();
  });
}

const stageInput = z.object({
  name: z.string().trim().min(1, "Name the stage.").max(60),
  probability: z.number().int().min(0).max(100),
  rottingDays: z.number().int().min(1).max(365).nullable(),
});

export async function saveStage(pipelineId: string, stageId: string | null, input: z.input<typeof stageInput>): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = stageInput.parse(input);
    const db = await getDb();
    if (stageId) await db.update(stages).set(data).where(eq(stages.id, uuid.parse(stageId)));
    else {
      const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${stages.position}), -1)::int` }).from(stages).where(eq(stages.pipelineId, uuid.parse(pipelineId)));
      await db.insert(stages).values({ ...data, pipelineId, position: max + 1 });
    }
    refresh();
  });
}

export async function reorderStages(pipelineId: string, ids: string[]): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const list = z.array(uuid).max(50).parse(ids);
    const db = await getDb();
    for (const [i, id] of list.entries()) await db.update(stages).set({ position: i }).where(and(eq(stages.id, id), eq(stages.pipelineId, uuid.parse(pipelineId))));
    refresh();
  });
}

/** Deleting a stage moves its deals to another stage of the same pipeline first, so nothing is orphaned. */
export async function deleteStage(stageId: string, moveTo: string | null): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const db = await getDb();
    const [s] = await db.select().from(stages).where(eq(stages.id, uuid.parse(stageId)));
    if (!s) return;
    const others = await db.select().from(stages).where(and(eq(stages.pipelineId, s.pipelineId), ne(stages.id, s.id))).orderBy(asc(stages.position));
    if (!others.length) throw new ActionError("A pipeline needs at least one stage.");
    const [{ n }] = await db.select({ n: count() }).from(deals).where(eq(deals.stageId, s.id));
    if (n) {
      const target = others.find((o) => o.id === moveTo);
      if (!target) throw new ActionError(`Pick where this stage's ${n} deal${n === 1 ? "" : "s"} should go.`);
      await db.update(deals).set({ stageId: target.id, stageChangedAt: new Date() }).where(eq(deals.stageId, s.id));
    }
    await db.delete(stages).where(eq(stages.id, s.id));
    refresh();
  });
}

// ─── Custom fields ───────────────────────────────────────────────────────

const fieldInput = z.object({
  entityType: z.enum(entityTypes),
  label: z.string().trim().min(1, "Name the field.").max(60),
  type: z.enum(customFieldTypes),
  options: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  showInTable: z.boolean().default(false),
});

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "field";

export async function saveCustomField(fieldId: string | null, input: z.input<typeof fieldInput>): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const data = fieldInput.parse(input);
    if ((data.type === "select" || data.type === "multiselect") && !data.options.length) throw new ActionError("Add at least one option.");
    const options = [...new Set(data.options)];
    const db = await getDb();
    if (fieldId) {
      // The type and key never change after creation, so existing values stay valid.
      await db.update(customFields).set({ label: data.label, options, showInTable: data.showInTable }).where(eq(customFields.id, uuid.parse(fieldId)));
    } else {
      const base = slug(data.label);
      const taken = new Set((await db.select({ key: customFields.key }).from(customFields).where(eq(customFields.entityType, data.entityType))).map((r) => r.key));
      let key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
      const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${customFields.position}), -1)::int` }).from(customFields).where(eq(customFields.entityType, data.entityType));
      await db.insert(customFields).values({ ...data, options, key, position: max + 1 });
    }
    refresh();
  });
}

/** Archived fields disappear from forms; their values stay on records and come back if the field is restored. */
export async function archiveCustomField(fieldId: string, archived: boolean): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const db = await getDb();
    await db
      .update(customFields)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(customFields.id, uuid.parse(fieldId)));
    refresh();
  });
}

export async function reorderCustomFields(ids: string[]): Promise<Result> {
  return run(async () => {
    await actionAdmin();
    const db = await getDb();
    for (const [i, id] of z.array(uuid).max(200).parse(ids).entries()) await db.update(customFields).set({ position: i }).where(eq(customFields.id, id));
    refresh();
  });
}

// ─── Sample data (development only) ──────────────────────────────────────

export async function addSampleData(): Promise<Result<{ people: number }>> {
  return run(async () => {
    const admin = await actionAdmin();
    if (process.env.VERCEL) throw new ActionError("Sample data is only available in local development.");
    const db = await getDb();
    const [{ n }] = await db.select({ n: count() }).from(schema.people);
    if (n) throw new ActionError("Sample data can only be added to an empty workspace.");
    const r = await loadSampleData(admin.id);
    refresh();
    return r;
  });
}

/** The brand kit applied to a sample email, rendered exactly as it will send. */
export async function previewBrand(input: z.input<typeof brandInput>): Promise<string> {
  const user = await actionAdmin();
  const data = brandInput.safeParse(input);
  const brand = data.success ? Object.fromEntries(Object.entries(data.data).filter(([, v]) => v)) : {};
  const db = await getDb();
  const [ws] = await db.select({ name: workspace.name }).from(workspace).limit(1);
  const { render } = await import("@react-email/render");
  const { default: DirectEmail } = await import("@/emails/direct");
  const signature = (brand.signature as string | undefined)?.replace(/\{\{\s*sender_name\s*\}\}/gi, user.name).replace(/\{\{\s*sender_title\s*\}\}/gi, user.title ?? "").replace(/\n{2,}/g, "\n").trim();
  return render(
    DirectEmail({
      brand: { ...brand, workspaceName: ws?.name ?? "Your company" },
      preview: "",
      html: "<p>Hi Sam,</p><p>Thanks for your time today. I've attached the <a href=\"https://example.com\">proposal</a> we discussed.</p>",
      signature,
    }),
  );
}
