# [discover](https://discover.brine.dev)

**Curated RSS discovery. Federation by fork. No algorithm. No dependencies.**

Discover is hand-picked playlists of RSS/Atom feeds, organised by vibe. Browse, follow, read inline, export to your reader. Runs on Cloudflare Workers' free tier. Forever.

**But this is the point**: anyone can fork this, stand up their own instance, and curate their own playlists with _their_ taste. Bigger directories are welcome to steal the idea too! Curate _your_ corner of the web. Just you, some RSS feeds, and a $0 bill from Cloudflare.

Authors don't sign up, don't federate, don't install anything, and don't even need to know you exist. They just keep blogging like it's 2005 and a discover instance picks them up.

## Features

- **Browse** — curated playlists with tag filtering, search, random shuffle, and a "new" view of recently-added sources
- **Feed** — follow playlists or individual sources, read posts inline, export/import OPML, add any RSS URL directly
- **Suggest a feed** — public submission form on `/about`; server-side validation rejects click-through and invalid feeds before they hit the queue
- **Webmentions via RSS** — every source gets a `/api/mentions/{id}.xml` feed. When other sources in the directory link to it, a mention appears. Subscribe in any RSS reader to find out when someone cites your work
- **PWA** — installable, dark/light theme, works offline for cached views
- **Analytics** — privacy-friendly, no third parties. Tracks hits, top paths, countries, and RSS playlist subscribers. No cookies, no JS fingerprinting

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
wrangler kv namespace create DISCOVER_KV
```

Paste the KV namespace `id` into `wrangler.toml`. Create an R2 bucket in the Cloudflare dashboard and paste its name in too. Set your `name` and `DOMAIN_NAME`, then:

```bash
wrangler deploy
```

Go to `/admin`, enter a passphrase, copy your pubkey, paste it into `wrangler.toml` as `OWNER`, redeploy. Done.

## Admin

`/admin` — manage playlists, sources, and content moderation.

- **Playlists** — create and edit themed groups of RSS sources
- **Sources** — add RSS/Atom feed URLs; the cron fetches on a rolling schedule (8–48h depending on post frequency) and builds the link graph for webmentions
- **Pending** — review suggested feeds; approve into a playlist or reject
- **Batch validate** — paste multiple URLs, validate in bulk, add directly or queue to pending
- **Blocked domains** — hostname blocklist; exact match or subdomain (`example.com` blocks `sub.example.com` but not `notexample.com`)
- **Analytics** — hit counts, top paths, countries

## Seeding

To seed a fresh instance with playlists, paste `scripts/seed-discover.js` into the browser console while signed in at `/admin`.

## Deployment

```bash
wrangler deploy           # production → discover.brine.dev
wrangler deploy --env dev # staging → test.discover.brine.dev
```

Custom domains are set in the Cloudflare dashboard, not `wrangler.toml`.

## Local dev

```bash
npx wrangler dev
```

## Tests

```bash
npm test          # full suite
npm run test:unit # unit only
```

AGPL · brine
