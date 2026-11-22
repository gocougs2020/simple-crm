# Importing from Pipedrive

`pnpm import:pipedrive` copies a Pipedrive account into the CRM: teammates, organizations, people, deals (as clients), product deals (as services), notes, activities and email. It's safe to run more than once: a second run updates what the first brought in and adds anything new.

## Before you start

1. **Create the owner account** in the CRM (open the app and sign up). The import is recorded as that person.
2. **Get a Pipedrive API token**: in Pipedrive, open your profile menu → Personal preferences → API. Use an admin's token so every deal, note and email is visible to it. The token only reads; nothing in Pipedrive changes.
3. **Choose the database.** With `DATABASE_URL` set (copy it from Vercel → Storage → Neon), the import writes to that database. Without it, it writes to the local database in `.data/`. Stop `pnpm dev` first: only one process can open the local database.

Put the settings in `.env.local` (never committed):

```bash
PIPEDRIVE_API_TOKEN=…
# Optional: your company's Pipedrive subdomain (thirdpool for thirdpool.pipedrive.com)
PIPEDRIVE_COMPANY_DOMAIN=thirdpool
# Optional: import into Neon instead of the local database
DATABASE_URL=postgres://…
```

## Run it

```bash
pnpm import:pipedrive --dry-run
```

Reads Pipedrive and prints what it would do (how many clients land in each category and stage, and which services they use) without writing anything. Check it, then:

```bash
pnpm import:pipedrive
```

| Option | What it does |
| --- | --- |
| `--dry-run` | Show the plan, write nothing |
| `--email=all` | Import email for everyone. By default only people tied to a client (its contact, or anyone at its organization) get their email imported, because the rest is mostly outreach and can run to hundreds of thousands of messages |
| `--no-email` | Skip email. Email is read person by person, so it's most of the run time |
| `--no-users` | Don't add Pipedrive users who aren't teammates here (their records get no owner) |
| `--as=you@company.com` | Record the import as this teammate instead of the owner |
| `--since=14` | Only add what was created in Pipedrive in the last 14 days (or since a date: `--since=2026-11-08`). Records brought in before are still updated unless you add `--new-only` |
| `--new-only` | Only add what's new; change nothing that's already here. See [Bringing over what's new](#bringing-over-whats-new) |
| `--reset` | Show what a reset would remove; `--reset --yes` removes everything the import added |

## How Pipedrive maps to the CRM

### Deals become one client per organization

Pipedrive keeps a deal per pipeline, so an organization that bought two products has three or more deals. Here they collapse into **one client per organization** (or per person, for deals with no organization), and the products it uses are tracked as services on that client.

Pipelines are read by name:

- **"… Account Management"** pipelines are products. The product is the name without "Account Management" (ThirdPool, CoRecruit, TalentScout), and each becomes a service in Settings → Services.
- **Every other pipeline** is a sales pipeline.

Each client's category comes from all of its deals:

| Category | When |
| --- | --- |
| Current | Any deal in a product pipeline that isn't in a Paused or Terminated stage and isn't lost, or any won sales deal |
| Past | Product deals only in Paused or Terminated stages, or lost |
| Prospective | Everything else: open or lost sales deals |

Current wins over past, and past over prospective: an organization with an active ThirdPool deal and a terminated CoRecruit deal is a current client.

### Stage: the furthest deal, named exactly as in Pipedrive

Within its category, the client takes the stage of its furthest deal, and that stage is created in the category's pipeline with Pipedrive's name, verbatim. "Furthest" means, in order:

1. Open and won deals before lost ones
2. Stages that move forward before parking stages (Incubate, Lost, Cold follow-up, Paused, Terminated)
3. The later stage in Pipedrive's order
4. The most recently updated deal

Stages with the same name in several Pipedrive pipelines (each product pipeline has "Implementation") become one stage. Only stages a client lands in are created; they're placed first, in Pipedrive's order, and any stages that were already in the pipeline stay after them (delete the ones you don't need in Settings → Pipelines).

A prospect whose only sales deals are lost keeps the stage the deal was lost in and gets the tag **Lost in Pipedrive**, so they're easy to filter or bulk-move.

**Archived deals** come in too. When all of an organization's deals are archived in Pipedrive, its client is imported archived: its history, notes and services are kept, but it stays off the boards, as in Pipedrive. When an organization has both, its live deals decide the stage, and an archived product deal counts as an ended service. On a later run, a client follows Pipedrive: archived when all its deals are archived there, restored when one is live again. A client someone archived or restored by hand in the CRM is left as it is.

### Everything else

| Pipedrive | CRM |
| --- | --- |
| Users | Teammates, matched by email, then by name. Users who aren't teammates but own or wrote something are added as **deactivated** teammates so history stays attributed; invite them from Settings → Team to bring them back |
| Organizations | Organizations: name, address, website (or the "Website Domain" field), industry, owner. Labels go in a "Labels" field |
| People | People: name, primary email and phone, organization, owner. Labels and the "Tags" field become tags; "Title Specific" becomes the title |
| Custom fields | Custom fields with the same name, type and options (organizations, people, and deals → clients). On a client, the furthest deal's values come first; multi-option fields combine across deals |
| Product deals | A service on the client per deal: started on the deal's Start Date (or first won date), ended on its End Date (or when it was paused, terminated or lost) when it stopped. Price is the deal's MRR when filled in (monthly), otherwise the deal value as a yearly price, since deal values here are annual contract values; check odd ones in each client's Services card. The deal title, Products and Plan / Level go in the service's note. Migration `0022` then archives the imported "Products" client field, since services and their plans say the same thing; restore it in Settings → Fields if you want it back |
| Notes | Notes, pinned if pinned in Pipedrive, on the person, organization and client |
| Activities | Calls, meetings (and lunches), emails, texts and tasks (deadlines and custom types become tasks, with the type in the subject). Done ones are history; open ones are planned with their due date |
| Email | Email activities with the full message, sender and recipients, for people tied to a client (`--email=all` for everyone). Pipedrive's click-tracking links are replaced with the original links |

Files, leads (the Leads inbox) and Pipedrive projects aren't imported.

## Running it again

Every imported record is remembered in `external_ids`, so a second run:

- updates organizations, people and clients with Pipedrive's current values (including moving a client to its new stage or category, recorded in its history),
- adds notes, activities and email that are new since, and
- leaves alone anything created in the CRM by hand.

Edits made in the CRM to imported fields are overwritten by Pipedrive's values on the next run, so once the team works in the CRM, stop running the full import and use `--new-only` instead. Two exceptions: an email or phone that Pipedrive replaces is kept in the person's other emails and phones, and a record that duplicates were merged into (`pnpm run dedupe`) only has its blanks filled.

## Bringing over what's new

Once the team works in the CRM, bring over only what was added in Pipedrive since, without touching anything that's already here:

```bash
pnpm import:pipedrive --since=14 --new-only --dry-run
pnpm import:pipedrive --since=14 --new-only
```

The dry run lists what will be added: new organizations and people (and which of them are already here), new deals, notes and activities by type. It adds, from the last 14 days:

- **Organizations and people** created in Pipedrive. One that's already here is matched rather than added: an organization by its whole name (ignoring capitals); a person by the same name and a shared email or phone, or by an email only one person here has. A match only fills that record's blanks, as merging duplicates does.
- **Deals.** A deal for an organization or person that's already a client joins that client: its stage, category and fields stay as the team left them (the run lists these deals, so you can move a client by hand if a deal changes that), and a new product deal adds its service unless the client already has that service going. A deal for someone who isn't a client yet becomes a new client, as in a full import; a stage it needs is added after the pipeline's other stages.
- **Notes, activities (calls, meetings, texts, tasks) and email**, on the records they belong to.

Nothing that's here changes: names, owners, stages, fields, the order of stages, and records archived or edited by hand all stay as they are. Running it again adds only what's still new.

### Merged records

Merging duplicates (`pnpm run dedupe`, or Merge on the People and Organizations pages) moves each Pipedrive id onto the record that was kept, so a note or activity on a duplicate that was merged away lands on the kept record. A run also checks every Pipedrive id against what's here:

- one that still names a merged-away record follows its "merged" history to the record it went into,
- one whose record was removed by hand (with `--new-only`) is matched again by name, email or phone, the same way as new records.

An activity whose person isn't here is put on their organization and its client instead; one with nothing to go on is left out, and the run says how many.

`--since` without `--new-only` adds only what's new in the window too, but still updates the records brought in before with Pipedrive's values, like a full run.

## Duplicates

Pipedrive accounts collect duplicates. After importing, run `pnpm run dedupe` to merge organizations with the same name (ignoring capitals) and people who share an email or phone; it's safe to run again after a later import. See [DEDUPE.md](DEDUPE.md).

## Starting over

```bash
pnpm import:pipedrive --reset --yes
```

Removes the imported clients, people, organizations, notes, activities, email and custom fields, and the stages, services and deactivated teammates the import added when nothing else uses them.
