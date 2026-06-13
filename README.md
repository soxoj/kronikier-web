# kronikier-web

🗄️ Get historical phone numbers and email addresses for a website by mining
[web.archive.org](https://web.archive.org) snapshots — entirely from your
browser.

Sibling project of the [kronikier CLI](https://github.com/soxoj/kronikier);
shares the same extraction logic (libphonenumber, Cloudflare cfemail decode,
`[at]/[dot]` deobfuscation, business-registration / ISIN / postal-address
filtering, ccTLD-prioritised phone regions) ported to JavaScript.

## Quick start

```
git clone https://github.com/soxoj/kronikier-web
cd kronikier-web
python3 server.py
```

Open `http://localhost:8765/` in any browser. Type a domain, hit **Start**.

The only runtime dependency is the Python `requests` package (`pip install
requests` if you don't have it).

## What it does

For a domain (or single URL), it:

1. Asks the Wayback Machine's CDX index for every captured page on the host,
   pre-filtered to likely contact pages (`/contact`, `/about`, `/impressum`, …).
2. Additionally probes a small list of well-known contact paths — including
   Cyrillic ones (`/контакты`, `/о-нас`, `/реквизиты`) that the server-side
   CDX filter can't reach.
3. Fetches the top snapshots one at a time, with automatic rate-limiting and
   backoff on rate-limit signals from archive.org.
4. Extracts phones (libphonenumber-js) and emails (regex + Cloudflare
   `data-cfemail` decode + `[at]`/`[dot]` deobfuscation).
5. Deduplicates across snapshots, shows first / last sighting per contact
   value with a link to the actual capture, and offers a CSV download.

## Modes

- **Domain** (default) — rank likely contact pages on the host, fetch the
  top N.
- **Single URL** — walk every archived snapshot of one specific page, most
  recent first. Useful when you already know the page that carried the
  contact info.

## Why does it need a local Python launcher?

Browsers refuse to expose `web.archive.org` responses to JS running on any
other origin because IA's CDX and playback endpoints don't serve CORS
headers. `server.py` is a stdlib-only static server with a built-in
`/proxy?url=…` endpoint that:

- talks to archive.org server-side and replies with permissive CORS;
- mirrors the kronikier CLI's HTTP behaviour byte-for-byte (one shared
  `requests.Session()`, identical retry policy on 404/408/429/5xx,
  same User-Agent) so the Wayback Machine treats it the same as the CLI;
- caches every successful response on disk (`~/.cache/kronikier-web/`) so
  re-runs are instant — archived snapshots are immutable, no expiry needed;
- locks the upstream allow-list to `web.archive.org` and `archive.org`, so
  the proxy can't be turned into an open relay by accident.

If port 8765 is taken: `python3 server.py 9000`.

To clear the cache: `rm -rf ~/.cache/kronikier-web` (or override the path
via `KRONIEKER_WEB_CACHE_DIR`).

## How it differs from the CLI

The CLI ([github.com/soxoj/kronikier](https://github.com/soxoj/kronikier))
has a calibrated time-budget planner, persistent snapshot cache, hundreds of
well-known paths, and scales to very large sites with adaptive concurrency.
The web build is intentionally minimal — sequential fetching with a small
well-known probe list — but covers the same extraction edge cases (Google
tracking IDs, business-registration markers, ISIN values, geo coordinates,
German postal-address fragments, date / time stamps, etc.).

For deep scans of large sites, use the CLI.

## Files

- `index.html` — page + inline CSS
- `app.js` — CDX query, snapshot fetch, phone / email extraction, UI
- `server.py` — static server + CORS proxy + disk cache

## Reporting bugs

If you spot an extraction error (a missed contact, a false positive, garbled
output), email **kronikier@soxoj.com** or open an issue at
[github.com/soxoj/kronikier/issues](https://github.com/soxoj/kronikier/issues).
Include the archived URL and the exact value that came out wrong.

## SOWEL classification

OSINT techniques used:
  - [SOTL-7.1. Check Archives](https://sowel.soxoj.com/check-archives)
  - [SOTL-22.5. Extract Contacts From Page Text](https://sowel.soxoj.com/page-text-contacts)

## License

MIT.
