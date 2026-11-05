/**
 * A small, read-only Pipedrive REST client for the importer. Uses API v2
 * (cursor pages) where Pipedrive offers it and v1 (offset pages) for the rest.
 * Retries rate limits and server errors with backoff, so a long import can
 * run unattended.
 */

export type PdId = number;

export type PdUser = { id: PdId; name: string; email: string; active_flag: boolean };
export type PdStage = { id: PdId; name: string; order_nr: number; pipeline_id: PdId; deal_probability: number | null };
export type PdPipeline = { id: PdId; name: string; order_nr: number };
export type PdFieldOption = { id: number | string; label: string };
export type PdField = { key: string; name: string; field_type: string; options?: PdFieldOption[] | null; edit_flag?: boolean };
export type PdLabel = { id: number; label: string };

export type PdOrganization = {
  id: PdId;
  name: string;
  owner_id: PdId | null;
  add_time: string;
  update_time: string | null;
  address: { value?: string | null; formatted_address?: string | null } | null;
  website: string | null;
  industry: string | number | null;
  label_ids?: number[];
  labels?: PdLabel[];
  custom_fields?: Record<string, unknown> | null;
};

export type PdPerson = {
  id: PdId;
  name: string;
  first_name: string | null;
  last_name: string | null;
  org_id: PdId | null;
  owner_id: PdId | null;
  add_time: string;
  update_time: string | null;
  emails?: { value: string; primary: boolean; label?: string }[] | null;
  phones?: { value: string; primary: boolean; label?: string }[] | null;
  job_title?: string | null;
  label_ids?: number[];
  labels?: PdLabel[];
  email_messages_count?: number;
  custom_fields?: Record<string, unknown> | null;
};

export type PdDeal = {
  id: PdId;
  title: string;
  value: number | null;
  currency: string | null;
  mrr: number | null;
  person_id: PdId | null;
  org_id: PdId | null;
  pipeline_id: PdId;
  stage_id: PdId;
  status: "open" | "won" | "lost" | "deleted";
  owner_id: PdId | null;
  add_time: string;
  update_time: string | null;
  stage_change_time: string | null;
  won_time: string | null;
  first_won_time?: string | null;
  lost_time: string | null;
  close_time: string | null;
  lost_reason: string | null;
  expected_close_date: string | null;
  is_deleted?: boolean;
  is_archived?: boolean;
  label_ids?: number[];
  labels?: PdLabel[];
  custom_fields?: Record<string, unknown> | null;
};

export type PdActivity = {
  id: PdId;
  subject: string | null;
  type: string;
  owner_id: PdId | null;
  creator_user_id: PdId | null;
  is_deleted?: boolean;
  add_time: string;
  deal_id: PdId | null;
  lead_id: string | null;
  person_id: PdId | null;
  org_id: PdId | null;
  due_date: string | null;
  due_time: string | null;
  duration: string | null;
  done: boolean;
  marked_as_done_time: string | null;
  location: { value?: string | null } | string | null;
  conference_meeting_url: string | null;
  public_description: string | null;
  note: string | null;
  outcome?: unknown;
};

export type PdActivityType = { key_string: string; name: string; active_flag: boolean };

export type PdNote = {
  id: PdId;
  user_id: PdId | null;
  deal_id: PdId | null;
  person_id: PdId | null;
  org_id: PdId | null;
  lead_id: string | null;
  content: string;
  add_time: string;
  active_flag: boolean;
  pinned_to_deal_flag: boolean;
  pinned_to_person_flag: boolean;
  pinned_to_organization_flag: boolean;
};

export type PdMailParty = { email_address: string; name: string | null; linked_person_id: PdId | null };
export type PdMailMessage = {
  id: PdId;
  from: PdMailParty[];
  to: PdMailParty[];
  cc: PdMailParty[];
  subject: string | null;
  snippet: string | null;
  body?: string | null;
  user_id: PdId | null;
  deal_id: PdId | null;
  sent_flag: 0 | 1;
  draft_flag: 0 | 1;
  deleted_flag: 0 | 1;
  message_time: string;
};

export class PipedriveApi {
  private base: string;
  requests = 0;

  constructor(
    private token: string,
    companyDomain?: string,
  ) {
    this.base = process.env.PIPEDRIVE_BASE_URL ?? `https://${companyDomain || "api"}.pipedrive.com`;
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { "x-api-token": this.token, accept: "application/json" } });
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (res.status === 401) throw new Error("Pipedrive rejected the API token (401). Check PIPEDRIVE_API_TOKEN.");
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 8) throw new Error(`Pipedrive kept answering ${res.status} for ${url.pathname}. Try again later.`);
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 60_000));
        continue;
      }
      const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !body?.success) throw new Error(`Pipedrive ${res.status} on ${url.pathname}: ${body?.error ?? res.statusText}`);
      return body as T;
    }
  }

  /** Every item of a v2 list endpoint, following cursors. */
  async allV2<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.get<{ data: T[] | null; additional_data?: { next_cursor?: string | null } }>(path, { ...params, limit: 500, cursor });
      out.push(...(page.data ?? []));
      cursor = page.additional_data?.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }

  /** Every item of a v1 list endpoint, following offsets. */
  async allV1<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}, pageSize = 500): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    for (;;) {
      const page = await this.get<{ data: T[] | null; additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } } }>(path, { ...params, start, limit: pageSize });
      out.push(...(page.data ?? []));
      const p = page.additional_data?.pagination;
      if (!p?.more_items_in_collection || p.next_start === undefined) return out;
      start = p.next_start;
    }
  }

  users = () => this.allV1<PdUser>("/v1/users").catch(async () => (await this.get<{ data: PdUser[] }>("/v1/users")).data);
  pipelines = () => this.allV2<PdPipeline>("/api/v2/pipelines");
  stages = () => this.allV2<PdStage>("/api/v2/stages");
  activityTypes = async () => (await this.get<{ data: PdActivityType[] }>("/v1/activityTypes")).data ?? [];
  fields = (entity: "deal" | "person" | "organization" | "activity") => this.allV1<PdField>(`/v1/${entity}Fields`);
  organizations = () => this.allV2<PdOrganization>("/api/v2/organizations", { include_labels: true });
  persons = () => this.allV2<PdPerson>("/api/v2/persons", { include_labels: true, include_fields: "email_messages_count" });
  deals = () => this.allV2<PdDeal>("/api/v2/deals", { status: "open,won,lost", include_labels: true, include_fields: "first_won_time" });
  activities = () => this.allV2<PdActivity>("/api/v2/activities");
  notes = () => this.allV1<PdNote>("/v1/notes");

  /** A person's email, bodies included. The v1 endpoint wraps each message as `{ data: message }`. */
  async personMail(personId: PdId): Promise<PdMailMessage[]> {
    const rows = await this.allV1<{ data: PdMailMessage }>(`/v1/persons/${personId}/mailMessages`, { include_body: 1 }, 50);
    return rows.map((r) => r.data).filter(Boolean);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items`, `limit` at a time. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
