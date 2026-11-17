# Merging duplicates

`pnpm dedupe` finds duplicate organizations and people and merges each group into one record. Run it whenever duplicates may have come in: after the Pipedrive import, and again after the final one. A second run only touches new duplicates; when there are none it changes nothing.

## Run it

Same settings as the [Pipedrive import](PIPEDRIVE-IMPORT.md): with `DATABASE_URL` in `.env.local` it works on that database, without it on the local one in `.data/` (stop `pnpm dev` first).

```bash
pnpm dedupe
```

Shows every group it found and what it would do, and writes the full list to `.data/dedupe-<time>-preview.csv` (one row per record: kept, merged or deleted, with how many people, clients and activities each has). Nothing changes. Check the list, then:

```bash
pnpm dedupe --yes
```

| Option | What it does |
| --- | --- |
| `--yes` | Merge and delete. Without it, nothing is written |
| `--only=organizations` | Only organizations (`--only=people` for only people) |
| `--max-group=25` | Merge groups of people up to this size. Bigger groups are listed and skipped (10 by default): they usually mean a shared line or inbox, like a switchboard or info@, rather than one person |
| `--verbose` | List every group on screen, not just the first 25 |
| `--as=you@company.com` | Record the merges as this teammate instead of the owner |

Organizations go first, so the people merged next already point at the organizations that were kept. Each group merges in one transaction: if something fails, that group is left as it was and running again picks it up.

Take a backup first (in Neon, create a branch), since merges can't be undone from the app.

## What counts as a duplicate

- **Organizations** whose whole names match, ignoring capitals (and spaces at either end). "acme" and "Acme" are duplicates; "Acme" and "Acme Inc" aren't. The kept organization keeps its own spelling.
- **People** who share an email address (ignoring capitals) or a phone number (the last 10 digits, however it was typed, so "(303) 555-0123" and "+1 303 555 0123" match). Their other emails and phones count too, and it chains: if A shares an email with B and B a phone with C, all three are one person. Numbers under 7 digits are never compared.

## What happens to each group

1. **The record kept** is the oldest one that has anything on it. A record with nothing on it, meaning no people (for organizations), no organization (for people), no notes, tasks, meetings, calls, emails or texts, no clients and no files, is simply deleted. When nobody in the group has anything, the oldest is kept.
2. **Its details stay**, and any blank ones are filled from the others: first from duplicates that have notes, activity or other records on them, newest first, and only then from empty duplicates, newest first. So a website missing from the kept record comes from the newer, active duplicate rather than an empty one. This covers website, phone, address, industry, owner and custom fields for organizations; last name, job title, owner and custom fields for people. Tags are combined.
3. **Everything moves to it**: people, clients, notes, tasks, meetings, calls, emails, texts, inbox conversations, synced mail, files and history. Clients keep their organization and contact, now the kept one. Saved audiences and campaign filters that named a duplicate name the kept record instead.
4. **People keep every email and phone.** The kept record's email and phone stay the main ones (campaigns, texts and the composer use those); every other address and number goes into **Other emails** and **Other phones**, shown and editable on the person's page. Mail, calls and texts from any of them land on the person, and a STOP from any of their numbers opts them out (only a START from the main number opts them back in, since texts go there).
5. **People keep every organization.** The kept record's organization stays their main one; the others the duplicates were at are listed under **Also at** on the person's page, and the person shows on each of those organizations' pages.
6. **Opt-outs win.** If any duplicate unsubscribed from campaigns, opted out or replied STOP, the merged person has too.
7. **The duplicates are deleted**, and the kept record's history says what was merged into it.

## With the Pipedrive import

Each duplicate's link to its Pipedrive record moves to the kept record, so running `pnpm import:pipedrive` again updates the kept record instead of bringing the duplicates back. For a merged record, Pipedrive only fills its blanks (several Pipedrive records now stand for it, and they would otherwise overwrite each other); new emails, phones and organizations from Pipedrive are added to its lists. Notes, activities and email that are new in Pipedrive land on the kept record.

So the order for the final move is:

```bash
pnpm import:pipedrive
```

```bash
pnpm dedupe
```

```bash
pnpm dedupe --yes
```
