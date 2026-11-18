# Example: Recruiting Insight website

> **Deployment-specific.** This page is for the Recruiting Insight deployment of the CRM only. It isn't needed to run the CRM or to connect a knowledge source of your own; see [KNOWLEDGE.md](../KNOWLEDGE.md) for that. It's kept here as a worked example of a website API that fits the knowledge source well.

Recruiting Insight's website (`recruitinginsight.net`) has a JSON API with two parts: **Content** (`/api/content`: blog posts, search by meaning, the resource library, page text and company facts) and **CRM** (`/api/crm`: contacts and leads). The CRM connects only the Content part, with the **read key**, as its [knowledge source](../KNOWLEDGE.md).

## Configuration

```bash
KNOWLEDGE_API_URL=https://recruitinginsight.net/api/content
KNOWLEDGE_API_KEY=…            # the website's read key; mark it Sensitive
KNOWLEDGE_NAME="Recruiting Insight website"
KNOWLEDGE_DESCRIPTION="Recruiting Insight's services (TalentScout, CoRecruit, ThirdPool), team, philosophy, blog posts and resource library. /site: company facts (phone, email, address, stats, each solution in a line, blog topics). /pages: the text of the home, product, about, consult, contact, guide and legal pages; path=/corecruit for one page, kind=company|product|contact|guide|legal for a group. /search?q=…: live posts closest in meaning, best first (limit up to 20). /posts?q=…&topic=…: posts by words or topic, newest first, in full (use title=… for one post). /resources: the resource library. Add fields=summary when only titles and links are needed. Link pages, posts and resources by their url."
KNOWLEDGE_FIXED_QUERY="/posts?status=live"
KNOWLEDGE_BLOCKED_PATHS="/posts/*"
```

**Published posts only.** The read key can also see scheduled and draft posts, so the last two lines keep them out: every `/posts` request asks for `status=live` whatever the caller sends, and `/posts/{id or slug}` (which returns a post of any status) is refused. One post in full comes from `/posts?title=…` or `/search` instead. `/search` only ever returns live posts.

Why the base is `/api/content`: every request the CRM makes stays under it, so `/api/crm` (contacts and leads, which hold personal data) can't be reached through the tool even though the read key could read it. The CRM never writes to the website, so the write key isn't used.

## The Content API, in short

From the website's own API guide. Every request is `GET`, authenticated with `Authorization: Bearer <read key>`, and answers JSON. Paths below are relative to `/api/content`, as the `get_knowledge` tool takes them.

| Path | Returns | Options |
| --- | --- | --- |
| `/` | Every endpoint, a good first call | None |
| `/site` | Company facts: phone, email, address, stats, the solutions with a one-line summary each, and the blog topics | None |
| `/pages` | The text of the home, product (TalentScout, CoRecruit, ThirdPool), about, consult, contact, ultimate guide and legal pages, with headings kept | `path` (e.g. `/corecruit`) for one page; `kind` = `company`, `product`, `contact`, `guide` or `legal` |
| `/resources` | The resource library: title, subtitle, description, image and `url` (the resource's own page, with its sign-up form when gated). Gated files are never included | None |
| `/posts` | Posts, newest first, in full (`html` and plain `text`), with topics, dates, image and `url` | `q`, `title`, `topic` (slug), `status` (always `live` with this deployment's config), `since` and `until` (YYYY-MM-DD), `page`, `limit` (max 50), `fields=summary` |
| `/posts/{id or slug}` | One post, of any status. **Blocked** by this deployment's config | None |
| `/search?q=…` | Live posts closest in meaning to a phrase, most similar first, each with `similarity` from 0 to 1 | `limit` (default 5, max 20), `topic`, `fields=summary` |

Lists return `total`, `page` and `pages`. Content may be a few minutes old, page text a few hours. Search by meaning allows 5,000 searches a day (`429` after that: use `q` on `/posts` instead) and can briefly fail with `502`. The whole API can be turned off from the website's admin, which answers `503`: the CRM reports that as "turned off or not ready", and the key doesn't need changing.

The website's guide suggests the same order the CRM's agent follows: `/` to learn the endpoints and `/site` for company facts; `/pages` for services, team and philosophy; `/search` for the firm's view on a topic, quoting and linking the posts it returns; and resources by their `url`.

## Not used

- **The CRM part** (`/api/crm/contacts`, `/api/crm/leads`) and every `POST`, `PATCH` and `DELETE`. Syncing website leads into the CRM would be a separate integration with the write key; it isn't part of the knowledge source.
