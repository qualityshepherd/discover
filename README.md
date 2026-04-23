# [discover](https://discover.brine.dev)

**Curated RSS discovery. No algorithm. No ads.**

Discover is a curated RSS discovery app hand-picked playlists of RSS/Atom feeds, organized by vibe. Browse, follow, and export your reading list. Runs on Cloudflare Workers' free tier.

## Requirements
- Node.js
- [Cloudflare](https://cloudflare.com) account (free tier)
- A domain/subdomain (optional but recommended)

## Setup

```bash
git clone https://github.com/qualityshepherd/feedi
cd feedi
npm install
wrangler login
wrangler kv namespace create DISCOVER_KV
```

Paste the KV namespace `id` into `wrangler.toml`, then:

```bash
wrangler deploy
```

Go to `/admin`, enter a passphrase, copy your pubkey, paste it into `wrangler.toml` as `OWNER`, redeploy. Done.

## Admin

`/admin` — manage playlists, sources, analytics, and curators.

- **Playlists** — group RSS sources by theme/vibe
- **Sources** — add RSS/Atom feed URLs; the cron fetches them every ~23h
- **Analytics** — privacy-friendly, no third parties. Tracks hits, top paths, countries. No cookies.

## Discover (`/discover`)

Browse curated playlists, follow feeds, read posts inline. Tag filtering and search. Random and recently-added views.

## My Feed (`/feed`)

Merged post stream from followed playlists and individual sources. Playlist filter strip. OPML export. Think of it as a cart — browse discover, follow what looks good, export when ready.

## Seeding

To seed a fresh instance with playlists, paste `scripts/seed-discover.js` into the browser console while signed in at `/admin`.

## Local dev

```bash
npx wrangler dev
```

## Tests

```bash
npm test          # full suite (e2e + unit)
npm run test:unit # unit only
```

AGPL · brine
