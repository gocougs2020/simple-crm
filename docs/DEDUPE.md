# Merging duplicates

There are two ways to merge: by hand from the People, Organizations or Clients page, for duplicates you spot ("Acme" and "Acme Inc", which the script won't match), and `pnpm run dedupe` for the exact duplicates an import leaves behind. Both move records the same way (`src/lib/crm/merge-records.ts`).

## Merging by hand

Select two or more people, organizations or clients in the table and choose **Merge**. The dialog lists them; pick the one to keep. It shows what the kept record will look like and where each filled-in value comes from.

- **The one you keep keeps every value it has.** Anything it's blank on is filled from the others, the most recently active first. Tags are combined; for people, every email, phone and organization is kept as in [What happens to each group](#what-happens-to-each-group), and opt-outs win.
- **Everything moves to it**: people (for organizations), clients, notes, tasks, meetings, calls, emails, texts, inbox conversations, files and history. Saved audiences that named a merged record name the kept one.
- **Duplicate clients become one.** When merging organizations brings more than one client onto the kept organization, those clients are merged with the [client rules](#clients) below: the one furthest along is kept. The same goes for a merged person's clients that have no organization.
- **Merging clients keeps everyone and everything, once.** The client you keep keeps its own category, stage, contact and organization. The others' services, performance numbers, notes, tasks, meetings, emails, calls, texts, files and history move to it. Their contacts and the people added to them are added to its people, and their organizations stay tied to it (`client_organizations`), so the people at every one of them are its people, those organizations' pages show it, and their people's emails match its Stripe customers. Nobody shows twice.
- **The others are deleted** and the kept record's history says what was merged into it. Old links to a merged record open the kept one.
- Members, admins and owners can merge (it needs the same access as archiving); viewers can't. It's one transaction: if anything fails, nothing changes.

The REST API and MCP have it too: `POST /people/{id}/merge`, `POST /organizations/{id}/merge` and `POST /clients/{id}/merge` with `{ "mergeIds": [...] }` keep the record in the path (MCP: `merge_people`, `merge_organizations`, `merge_clients`; the agent asks you to confirm first, and background runs can't merge).

## The cleanup script

`pnpm run dedupe` finds duplicate organizations and people and merges each group into one record, then makes sure each organization has one client. Run it whenever duplicates may have come in: after the Pipedrive import, and again after the final one. A second run only touches new duplicates; when there are none it changes nothing.

### Run it

Same settings as the [Pipedrive import](PIPEDRIVE-IMPORT.md): with `DATABASE_URL` in `.env.local` it works on that database, without it on the local one in `.data/` (stop `pnpm dev` first).

```bash
pnpm run dedupe
```

Shows every group it found and what it would do, and writes the full list to `.data/dedupe-<time>-preview.csv` (one row per record: kept, merged or deleted, with how many people, clients and activities each has). Nothing changes. Check the list, then:

```bash
pnpm run dedupe --yes
```

| Option | What it does |
| --- | --- |
| `--yes` | Merge and delete. Without it, nothing is written |
| `--only=organizations` | Only organizations (`--only=people`, `--only=clients` for only those) |
| `--max-group=25` | Merge groups of people up to this size. Bigger groups are listed and skipped (10 by default): a safety net, since even with the same name, ten records sharing a number are more likely a shared line than one person |
| `--verbose` | List every group on screen, not just the first 25 |
| `--as=you@company.com` | Record the merges as this teammate instead of the owner |

Organizations go first, then people, then clients, so each step finds the records the one before kept (the preview groups clients as they'll be once organizations and people are merged). Each group merges in one transaction: if something fails, that group is left as it was and running again picks it up.

Take a backup first (in Neon, create a branch), since merges can't be undone from the app.

### What counts as a duplicate

- **Organizations** whose whole names match, ignoring capitals (and spaces at either end). "acme" and "Acme" are duplicates; "Acme" and "Acme Inc" aren't. The kept organization keeps its own spelling.
- **People** with the same name (first and last, ignoring capitals and extra spaces) who share an email address (ignoring capitals) or a phone number (the last 10 digits, however it was typed, so "(303) 555-0123" and "+1 303 555 0123" match). Their other emails and phones count too, and it chains: if two Ada Lovelaces share an email and one of them shares a phone with a third Ada Lovelace, all three are one person. The name is what keeps an office's main line or a shared inbox from merging different people: "Ada Lovelace" and "Bob Smith" on the same switchboard number stay apart, and so do "Ada Lovelace" and "A. Lovelace" (merge those by hand if they're the same person). Numbers under 7 digits are never compared.

### What happens to each group

1. **The record kept** is the oldest one that has anything on it. A record with nothing on it, meaning no people (for organizations), no organization (for people), no notes, tasks, meetings, calls, emails or texts, no clients and no files, is simply deleted. When nobody in the group has anything, the oldest is kept.
2. **Its details stay**, and any blank ones are filled from the others: first from duplicates that have notes, activity or other records on them, newest first, and only then from empty duplicates, newest first. So a website missing from the kept record comes from the newer, active duplicate rather than an empty one. This covers website, phone, address, industry, owner and custom fields for organizations; last name, job title, owner and custom fields for people. Tags are combined.
3. **Everything moves to it**: people, clients, notes, tasks, meetings, calls, emails, texts, inbox conversations, synced mail, files and history. Clients keep their organization and contact, now the kept one. Saved audiences and campaign filters that named a duplicate name the kept record instead.
4. **People keep every email and phone.** The kept record's email and phone stay the primary ones (the composer, calls, texts and campaigns use those); every other address and number goes into **Other emails** and **Other phones** on the person's page, where any of them can be made primary (the old primary moves into the list), removed, or added to. Mail, calls and texts from any of them land on the person, and a STOP from any of their numbers opts them out (only a START from the main number opts them back in, since texts go there).
5. **People keep every organization.** The kept record's organization stays their main one; the others the duplicates were at are listed under **Also at** on the person's page, and the person shows on each of those organizations' pages.
6. **Opt-outs win.** If any duplicate unsubscribed from campaigns, opted out or replied STOP, the merged person has too.
7. **The duplicates are deleted**, and the kept record's history says what was merged into it.

### Clients

Once duplicate organizations are merged, their clients belong to the same organization. Each organization ends up with **one client**, as the Pipedrive import builds them; for clients with no organization, each person does. This applies to any organization with more than one client, not only merged ones.

- **The client kept** is one that isn't archived, then the one furthest along (current, then past, then prospective, the same ranking the import uses for deals; among prospects, the one in the stage with the higher win probability, so a prospect in negotiation beats a new lead), then the oldest. Its category, pipeline, stage and name stay.
- **Its blanks are filled** from the others, newest first: Stripe customer, contact, owner and custom fields from any of them; value, expected close, health, end date and churn reason only from clients in the same category, since a prospect's expected value means nothing on a current client. "Client since" becomes the earliest start date of any of them, and tags are combined.
- **Everything moves to it**: services (current and ended), performance metrics, notes, tasks, meetings, emails, calls, texts, files and history.

### With the Pipedrive import

Each duplicate's link to its Pipedrive record moves to the kept record, so running `pnpm import:pipedrive` again updates the kept record instead of bringing the duplicates back. For a merged record, Pipedrive only fills its blanks (several Pipedrive records now stand for it, and they would otherwise overwrite each other); new emails, phones and organizations from Pipedrive are added to its lists. Notes, activities and email that are new in Pipedrive land on the kept record. A merged client's Pipedrive deals are planned together, as one client, so its category and stage come from the furthest of all of them.

So the order for the final move is:

```bash
pnpm import:pipedrive
```

```bash
pnpm run dedupe
```

```bash
pnpm run dedupe --yes
```
