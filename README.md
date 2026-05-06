# [discover](https://discover.brine.dev)

**Curated RSS discovery. Federation by fork. No algorithm. No platform.**

Authors don't sign up, don't federate, don't install anything. They just keep blogging like it's 2005 and a discover instance picks them up.

Hand-picked playlists of RSS/Atom feeds, organized by vibe. Browse, follow, read inline, export to your reader. Runs on Cloudflare Workers + D1.

Anyone can fork this, stand up their own instance, and curate their own playlists to _their_ taste. Your corner of the web for the low, low price of $0.

## Features

- **Browse** — curated playlists with tag filtering, full-text search (returns individual blogs, not playlists), random shuffle, and a "new" view of recently-added sources
- **Feed** — follow playlists or individual sources, read posts inline, export/import OPML, add any RSS URL directly
- **Suggest a feed** — public submission form on `/about`; server-side validation rejects click-through and invalid feeds before they hit the queue
- **Webmentions via RSS** — when sources in the directory link to each other, the cited author gets a mention feed at `/api/mentions/{domain}.xml` (e.g. `/api/mentions/gordonmclean.co.uk.xml`). Delivered the same way authors read everything else: their RSS reader
- **PWA** — installable, dark/light theme, works offline for cached views
- **Analytics** — privacy-friendly, no third parties. Tracks hits, top paths, countries, and RSS feed subscribers. No cookies, no JS fingerprinting

## Requirements

- Node.js
- [Cloudflare](https://cloudflare.com) account (free tier)
- A domain/subdomain (optional but recommended)

## Setup

```bash
git clone https://github.com/qualityshepherd/discover
cd discover
npm install
cp wrangler.example.toml wrangler.toml
wrangler login
wrangler d1 create discover
wrangler r2 bucket create discover
```

Paste the D1 database `id` and R2 bucket name into `wrangler.toml`. Set your `name` and `DOMAIN_NAME`, then run the migrations:

```bash
wrangler d1 execute discover --remote --file migrations/0001_init.sql
wrangler d1 execute discover --remote --file migrations/0002_fts.sql
wrangler d1 execute discover --remote --file migrations/0003_source_title.sql
wrangler d1 execute discover --remote --file migrations/0004_backfill_source_title.sql
wrangler deploy
```

Go to `/admin`, enter a passphrase, copy your pubkey, paste it into `wrangler.toml` as `OWNER`, redeploy. Done.

## Admin

`/admin` — manage playlists, sources, and content moderation.

- **Playlists** — create and edit themed groups of RSS sources
- **Sources** — add RSS/Atom feed URLs; the cron fetches all sources every run and builds the link graph for webmentions. Filter by status: ok, warning, error, stale, dead, never fetched
- **Curate** — review suggested feed candidates mined from link content; approve, dismiss, or block. Use "rebuild mentions" to regenerate the webmentions graph on demand
- **Batch validate** — paste multiple URLs, validate in bulk, add directly or queue to pending
- **Blocked domains** — hostname blocklist; exact match or subdomain (`example.com` blocks `sub.example.com` but not `notexample.com`)
- **Analytics** — hit counts, top paths, countries

## Deployment

```bash
wrangler deploy
```

Custom domains are set in the Cloudflare dashboard, not `wrangler.toml`.

## Local dev

```bash
npx wrangler dev
```

## Tests

```bash
npm test
```

AGPL · brine
