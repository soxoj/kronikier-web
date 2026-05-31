// kronikier (web) — Wayback contact miner running in the browser.
//
// Reduced-functionality JS port of the kronikier CLI. The two heavy bits ride
// on libphonenumber-js (loaded as a global) and the browser's own DOMParser
// for HTML parsing.

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";

// The Wayback Machine's CDX and playback endpoints do not serve CORS
// headers, so a browser refuses to expose their responses to JS here.
// All upstream URLs are routed through the local launcher's /proxy endpoint
// (see web/server.py). Set to "" to talk to IA directly — only works if you
// run an external CORS proxy or open this page from the same origin.
const PROXY_PREFIX = "/proxy?url=";

function viaProxy(url) {
  return PROXY_PREFIX ? PROXY_PREFIX + encodeURIComponent(url) : url;
}

// Subset of the CLI's _TLD_TO_REGION. Used to pick a default region for
// libphonenumber-js so that an unprefixed Russian number on a .ru domain
// doesn't get claimed by the US, and vice versa.
const TLD_TO_REGION = {
  ru: "RU", by: "BY", ua: "UA", kz: "KZ", md: "MD", uz: "UZ", tj: "TJ",
  kg: "KG", tm: "TM", am: "AM", az: "AZ", ge: "GE",
  uk: "GB", gb: "GB", ie: "IE", de: "DE", at: "AT", ch: "CH", fr: "FR",
  be: "BE", lu: "LU", nl: "NL", it: "IT", es: "ES", pt: "PT", gr: "GR",
  pl: "PL", cz: "CZ", sk: "SK", hu: "HU", ro: "RO", bg: "BG", hr: "HR",
  si: "SI", rs: "RS", ba: "BA", mk: "MK", al: "AL", ee: "EE", lv: "LV",
  lt: "LT",
  se: "SE", no: "NO", fi: "FI", dk: "DK", is: "IS",
  us: "US", ca: "CA", au: "AU", nz: "NZ", za: "ZA",
  tr: "TR", il: "IL", ae: "AE", sa: "SA", qa: "QA", kw: "KW", bh: "BH",
  om: "OM", jo: "JO", lb: "LB", eg: "EG",
  jp: "JP", cn: "CN", hk: "HK", tw: "TW", kr: "KR", sg: "SG", my: "MY",
  th: "TH", vn: "VN", id: "ID", ph: "PH", in: "IN", pk: "PK", bd: "BD",
  lk: "LK",
  mx: "MX", br: "BR", ar: "AR", cl: "CL", pe: "PE", ve: "VE", uy: "UY",
  py: "PY", bo: "BO", ec: "EC",
  ng: "NG", ke: "KE", gh: "GH", ma: "MA", tn: "TN", dz: "DZ",
  // Generic TLDs default to US (matches the CLI's rationale).
  com: "US", org: "US", net: "US", io: "US", co: "US", app: "US",
  ai: "US", dev: "US", tech: "US", info: "US", biz: "US", xyz: "US",
};

// ASCII contact slugs — baked into the CDX urlkey filter so the server
// already trims big domains down to plausible contact pages. Subset of the
// CLI's _HIGH_VALUE_SLUGS (ASCII only — cyrillic slugs are %-encoded in
// urlkeys, awkward to regex on server-side).
const CONTACT_SLUGS = [
  "contact", "contacts", "contact-us", "contactus", "about", "about-us",
  "aboutus", "company", "team", "staff", "people", "leadership",
  "management", "imprint", "impressum", "legal", "footer", "support",
  "help", "kontakt", "kontakty", "kontakti", "o-nas", "onas", "o-kompanii",
  "rekvizity", "ueber-uns", "ueberuns", "nous-contacter", "a-propos",
  "contacto", "contatti", "chi-siamo", "quienes-somos",
];

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".css", ".js", ".ico", ".woff",
  ".woff2", ".ttf", ".pdf", ".zip", ".xml", ".svg", ".webp", ".mp4",
]);

const EMAIL_FP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js",
  ".woff", ".woff2", ".ttf", ".ico",
]);

// Pragmatic email regex — permissive on purpose; junk gets filtered after.
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-/])([A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,24})(?![A-Za-z0-9])/g;

// [at] / (at) / { at } / " at " — second pass for obfuscated emails.
const AT_OBF_RE = /\s*[\[\(\{]\s*(?:at|@|собака|sobaka)\s*[\]\)\}]\s*|\s+(?:at|@|собака|sobaka)\s+/gi;
const DOT_OBF_RE = /\s*[\[\(\{]\s*(?:dot|\.|точка|tochka)\s*[\]\)\}]\s*|\s+(?:dot|точка|tochka)\s+/gi;

// Calendar dates with a 4-digit year look like phones to libphonenumber.
const DATE_LIKE_RE = /^\s*(?:\d{1,2}[./\-]\d{1,2}[./\-]\d{4}|\d{4}[./\-]\d{1,2}[./\-]\d{1,2})\s*$/;

// Google tracking IDs (UA-XXX-X, AW-XXX, DC-XXX). libphonenumber-js parses
// their digit runs as Ukrainian phones when the default region is UA.
// Blanking with same-length whitespace neutralises them without disturbing
// surrounding match spans.
const TRACKING_ID_RE = /\b(?:UA|AW|DC)-\d{2,}(?:-\d+)?\b/g;

// Geo coordinates (``37.476600``, ``-122.144000``, ``51.5074``). Lookarounds
// keep dot-formatted US phones (``555.123.4567``) untouched.
const COORD_RE = /(?<![\d.])-?\d{1,3}\.\d{4,}(?![\d.])/g;

// Calendar date + optional clock suffix, or a standalone clock. Year is
// pinned to 19xx/20xx to avoid swallowing phone digit groups like the BY
// trunk pattern ``8-0162-51-12-54`` where ``0162-51-12`` would otherwise
// look like a YYYY-MM-DD. The ``\s*`` slots between digit groups and
// separators tolerate dates that the HTML chopped across inline elements
// (the DOM walker emits them as ``2020 / 06 / 19`` after separator
// injection — the strict form would miss those).
const DATETIME_RE = /\b(?:\d{1,2}\s*[./\-]\s*\d{1,2}\s*[./\-]\s*(?:19|20)\d{2}|(?:19|20)\d{2}\s*[./\-]\s*\d{1,2}\s*[./\-]\s*\d{1,2})(?:\s*[T,;/\-]?\s*\d{1,2}\s*[:.]\s*\d{2}(?:\s*[:.]\s*\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

// ``(75) 2018`` — parenthesised 1-3 digit token + year cluster.
const PAREN_YEAR_RE = /\(\s*\d{1,3}\s*\)\s*(?:19|20)\d{2}\b/g;

// ``2012 2012`` — a year repeated.
const REPEATED_YEAR_RE = /\b((?:19|20)\d{2})\s+\1\b/g;

// ``596/2014`` — case-number / Aktenzeichen style. MUST be blanked before
// the phone-slash bridge below.
const CASE_NUMBER_RE = /\b\d{1,6}\s*\/\s*(?:19|20)\d{2}\b/g;

// ``2020 19`` / ``2020 06 19`` — a year leading a short-number cluster
// (typical of URL paths surviving tag-stripping without their slashes).
const YEAR_NUM_CLUSTER_RE = /\b(?:19|20)\d{2}(?:\s+\d{1,2}){1,3}\b/g;

// Phone numbers written with ``/`` as a digit-group separator (a real
// German convention, e.g. ``+49175/5604673``). Two passes — international
// form (``+``-anchored), then bare digit clusters with a phone-shaped
// split. Bare bridge is intentionally shape-strict so it can't capture
// fractions or short ratios. Order-dependent: runs AFTER reg-number /
// case-number / date blanking.
const PHONE_SLASH_BRIDGE_RE = /\+\d[\d\s\-()/]{6,}\d/g;
const PHONE_SLASH_BRIDGE_BARE_RE = /(?<!\d)\d{2,4}\s*\/\s*\d{6,}(?!\d)/g;

// Business-registration / tax / VAT markers — labels followed by a digit
// run we should never claim as a phone. Same shape as Python's
// ``_REG_NUM_RE``. False positives are cheap (text → spaces), the
// alternative is leaking identifiers as phones.
// JS ``\b`` is ASCII-only, so Unicode markers like ``ИНН`` won't get the
// boundary check we need. Use ``\p{L}`` lookarounds with the ``u`` flag.
const REG_NUM_RE = new RegExp(
  "(?<![\\p{L}\\d_])(?:" +
    "UEN|ACRA" +
    "|(?:Co(?:mpany)?[.\\s]*)?Reg(?:istration)?[.\\s]*(?:No|Number)?" +
    "|Co(?:mpany)?[.\\s]+(?:No|Number)" +
    "|HR[BA]|Handelsregister" +
    "|VAT(?:[.\\s]*(?:No|Number|Id))?" +
    "|USt[\\s.\\-]?Id(?:Nr|N)?" +
    "|INN|ИНН|ОГРН|КПП|ОКПО|БИК" +
    "|Tax\\s*ID" +
    "|EIN|CIN|BRN|ISIN|WKN|CUSIP|SEDOL|FIGI" +
    "|NIF|CIF|CNPJ|CPF" +
    "|I[ČC]O|DI[ČC]" +
    "|NIP|REGON|KvK" +
    "|СНИЛС" +
  ")[\\s.:№#\\-]*(?:[A-Z]{2,3})?[\\s.:№#\\-]*\\d{6,}[A-Z]?(?![\\p{L}\\d_])",
  "giu"
);

// Bare ISIN (``DE0007472060``) — 2 letters + 9 alphanumerics + 1 digit.
const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}\d\b/g;

// German address ``35 85609 Aschheim`` — house number, 5-digit PLZ,
// capitalised city. libphonenumber claims the digit pair as a German
// landline; the city name is what distinguishes it from a phone.
const GERMAN_POSTAL_ADDR_RE = /\b\d{1,4}\s+\d{5}\b(?=\s+[A-ZÄÖÜ])/g;

// Element types whose textContent we never want fed to the phone matcher
// (script/style/svg/noscript bodies carry coordinate sequences, analytics
// IDs, CSS numbers — none of which are real contact data).
const DROP_SELECTORS = "script, style, svg, noscript";

// CDX urlkey-filter regex built once.
const CDX_URLKEY_FILTER = ".*(?:" + CONTACT_SLUGS.map(escapeRegex).join("|") + ").*";

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }


// ---------- URL ranking (port of classifier.score_url) ---------------------

const HIGH_VALUE_SET = new Set(CONTACT_SLUGS);
const LOW_VALUE_SET = new Set([
  "tag", "tags", "category", "categories", "search", "feed", "rss",
  "comments", "trackback", "page", "wp-content", "wp-admin", "wp-includes",
  "static", "assets", "media", "img", "images", "css", "js",
]);

function scoreUrl(url) {
  let path;
  try { path = decodeURIComponent(new URL(url).pathname || "/"); }
  catch { return 0; }
  if (!path || path === "/") return 5;
  const segments = path.split("/").map(s => s.toLowerCase()).filter(Boolean);
  if (!segments.length) return 5;
  const last = segments[segments.length - 1];
  if (last.includes(".")) {
    const ext = "." + last.split(".").pop();
    if (ASSET_EXTENSIONS.has(ext)) return 0;
  }
  let score = 0;
  const lowered = "/" + segments.join("/");
  if (CONTACT_SLUGS.some(slug => new RegExp(`(?:^|[/_\\-])${escapeRegex(slug)}(?:$|[/_.\\-])`).test(lowered))) {
    score += 10;
  }
  if (segments.some(s => LOW_VALUE_SET.has(s))) score -= 5;
  if (segments.length <= 2) score += 3;
  return score;
}


// ---------- HTML normalization & extraction --------------------------------

function decodeCfEmail(token) {
  try {
    const key = parseInt(token.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < token.length; i += 2) {
      out += String.fromCharCode(parseInt(token.slice(i, i + 2), 16) ^ key);
    }
    return out.includes("@") ? out : null;
  } catch { return null; }
}

function normalizeHtml(html) {
  // Browser DOMParser is the BeautifulSoup replacement; gives us the same
  // visible-text view, plus easy attribute access for mailto: / tel: hrefs
  // and Cloudflare-protected <span data-cfemail="..."> nodes.
  let doc;
  try { doc = new DOMParser().parseFromString(html, "text/html"); }
  catch { return html; }

  const extra = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    const lower = href.toLowerCase();
    if (lower.startsWith("mailto:")) extra.push(href.slice(7).split("?", 1)[0]);
    else if (lower.startsWith("tel:")) extra.push(href.slice(4));
  }
  for (const node of doc.querySelectorAll("[data-cfemail]")) {
    const decoded = decodeCfEmail(node.getAttribute("data-cfemail") || "");
    if (decoded) extra.push(decoded);
  }

  // Drop subtrees whose textContent is pure noise for contact extraction.
  for (const node of doc.querySelectorAll(DROP_SELECTORS)) node.remove();

  // Walk the DOM ourselves and join text nodes with a single space. Plain
  // ``textContent`` concatenates without any separator, which glues the
  // tail of one element to the head of the next ("info" + "@example.com" +
  // "Company N" → "info@example.comCompany N") — the email regex then
  // greedily extends the TLD into the trailing word. BS4's
  // ``get_text(separator=" ")`` already does this on the Python side; the
  // walker brings the JS path to parity.
  const root = doc.body || doc.documentElement;
  let text = collectTextJoinedWithSpaces(root);

  // Fullwidth normalization — common obfuscation in scraped contact pages.
  text = text.replace(/＠/g, "@").replace(/．/g, ".");
  // Collapse whitespace (newlines from block-level elements, NBSP) to a
  // single space so phones split across <br>/<span> tags reunite before
  // libphonenumber runs. Email matching is unaffected.
  text = text.replace(/\s+/g, " ");

  // Blank out tracking IDs, datetime stamps, year-clusters, case-numbers,
  // and geo coordinates — same length-preserving substitution keeps phone
  // span-dedup valid. Order matters: ``CASE_NUMBER_RE`` runs BEFORE the
  // slash bridge so case-numbers have already been removed by then.
  const blank = m => " ".repeat(m.length);
  text = text.replace(TRACKING_ID_RE, blank);
  text = text.replace(DATETIME_RE, blank);
  text = text.replace(PAREN_YEAR_RE, blank);
  text = text.replace(REPEATED_YEAR_RE, blank);
  text = text.replace(CASE_NUMBER_RE, blank);
  text = text.replace(YEAR_NUM_CLUSTER_RE, blank);
  text = text.replace(COORD_RE, blank);
  text = text.replace(REG_NUM_RE, blank);
  text = text.replace(ISIN_RE, blank);
  text = text.replace(GERMAN_POSTAL_ADDR_RE, blank);

  // Bridge ``/`` separators in phone-shaped substrings. Two passes — the
  // ``+``-anchored international form, then the bare phone-shaped split.
  // Both run AFTER reg-number / case-number / date blanking.
  const slashToSpace = m => m.replace(/\//g, " ");
  text = text.replace(PHONE_SLASH_BRIDGE_RE, slashToSpace);
  text = text.replace(PHONE_SLASH_BRIDGE_BARE_RE, slashToSpace);

  if (extra.length) text += "\n" + extra.join("\n");
  return text;
}

// Collect text nodes in document order, joining them with a single space.
// Mirrors BeautifulSoup's ``get_text(separator=" ")``. We use a recursive
// walker rather than ``createTreeWalker`` because text-node-only walkers
// can't see the element boundaries we want to insert a separator at.
function collectTextJoinedWithSpaces(root) {
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3) {                  // TEXT_NODE
      if (node.nodeValue) parts.push(node.nodeValue);
      return;
    }
    if (node.childNodes) {
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(root);
  return parts.join(" ");
}

function deobfuscateAtDot(text) {
  return text.replace(AT_OBF_RE, "@").replace(DOT_OBF_RE, ".");
}

function looksLikeEmail(addr) {
  const lower = addr.toLowerCase();
  const at = lower.indexOf("@");
  if (at <= 0 || at === lower.length - 1) return false;
  // Reject ``user@www.host.tld`` — always an artifact of the at-deobfuscator
  // turning prose ("Archive at www.dgap.de") into a pseudo-email. Real
  // mailboxes aren't published on ``www.`` subdomains.
  if (lower.slice(at + 1).startsWith("www.")) return false;
  for (const ext of EMAIL_FP_EXTENSIONS) if (lower.endsWith(ext)) return false;
  if (/\bu003[ec]\b|\\x/.test(lower)) return false;
  return true;
}

function extractEmails(html) {
  const text = normalizeHtml(html);
  const seen = new Set();
  const out = [];
  for (const pass of [text, deobfuscateAtDot(text)]) {
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(pass)) !== null) {
      const raw = m[1];
      const canonical = raw.toLowerCase().replace(/[.,;:]+$/, "");
      if (seen.has(canonical)) continue;
      if (!looksLikeEmail(canonical)) continue;
      seen.add(canonical);
      out.push({ kind: "email", value: canonical, raw });
    }
  }
  return out;
}

function regionsForDomain(host, defaults) {
  const tld = host.toLowerCase().split(".").pop();
  const primary = TLD_TO_REGION[tld];
  const seen = new Set();
  const out = [];
  if (primary) { out.push(primary); seen.add(primary); }
  for (const r of defaults) if (!seen.has(r)) { out.push(r); seen.add(r); }
  return out;
}

function extractPhones(html, host) {
  const lp = window.libphonenumber;
  if (!lp || !lp.findPhoneNumbersInText) return [];
  const text = normalizeHtml(html);
  const seen = new Set();
  const emittedSpans = [];
  const out = [];

  function overlaps(start, end) {
    for (const [s, e] of emittedSpans) if (s < end && start < e) return true;
    return false;
  }

  // Pass 1 — only matches whose raw substring carries a literal "+".
  // Calling with no defaultCountry surfaces international-format numbers;
  // the explicit "+" check is the same intent signal the CLI uses to keep
  // "(855) 843-7200" from being mis-claimed as RU.
  try {
    for (const m of lp.findPhoneNumbersInText(text)) {
      const raw = text.slice(m.startsAt, m.endsAt);
      if (!raw.includes("+")) continue;
      if (DATE_LIKE_RE.test(raw)) continue;
      const e164 = m.number.number;
      if (seen.has(e164)) continue;
      seen.add(e164);
      emittedSpans.push([m.startsAt, m.endsAt]);
      out.push({ kind: "phone", value: e164, raw });
    }
  } catch (e) { /* libphonenumber bailing out on weird input is non-fatal */ }

  // Pass 2 — try each region in ccTLD-priority order. Span-dedup ensures
  // the first region that claims a substring wins (RU before US for an
  // 8-863-… string on a .ru domain).
  const regions = regionsForDomain(host, ["RU", "US", "GB", "DE", "FR"]);
  for (const region of regions) {
    try {
      for (const m of lp.findPhoneNumbersInText(text, region)) {
        const raw = text.slice(m.startsAt, m.endsAt);
        if (DATE_LIKE_RE.test(raw)) continue;
        if (overlaps(m.startsAt, m.endsAt)) continue;
        const e164 = m.number.number;
        emittedSpans.push([m.startsAt, m.endsAt]);
        if (seen.has(e164)) continue;
        seen.add(e164);
        out.push({ kind: "phone", value: e164, raw });
      }
    } catch (e) { /* same as above */ }
  }
  return out;
}


// ---------- CDX ------------------------------------------------------------

function buildCdxUrl({ target, mode, fromYear, toYear, limit }) {
  const params = new URLSearchParams();
  params.set("url", target);
  params.set("output", "json");
  params.set("matchType", mode === "single" ? "exact" : "domain");
  params.append("filter", "statuscode:200");
  params.append("filter", "mimetype:text/html");
  if (mode === "domain") {
    params.set("collapse", "urlkey");
    params.append("filter", `urlkey:${CDX_URLKEY_FILTER}`);
  }
  if (fromYear) params.set("from", `${fromYear}0101000000`);
  if (toYear) params.set("to", `${toYear}1231235959`);
  if (limit) params.set("limit", String(limit));
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

async function queryCdx(opts, signal) {
  const url = buildCdxUrl(opts);
  const resp = await fetch(viaProxy(url), { signal });
  if (!resp.ok) throw new Error(`CDX HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length < 2) return [];
  const header = data[0];
  const idx = {
    timestamp: header.indexOf("timestamp"),
    original: header.indexOf("original"),
    urlkey: header.indexOf("urlkey"),
    statuscode: header.indexOf("statuscode"),
    mimetype: header.indexOf("mimetype"),
  };
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    out.push({
      timestamp: row[idx.timestamp],
      original: row[idx.original],
      urlkey: row[idx.urlkey] || "",
    });
  }
  return out;
}

function playbackUrl(snap) {
  return `https://web.archive.org/web/${snap.timestamp}id_/${snap.original}`;
}


// ---------- Well-known contact-path probing -------------------------------
//
// The CDX server-side urlkey-filter sees URLs in percent-encoded form, so
// cyrillic paths like ``/контакты`` never match an ASCII regex. The CLI
// covers that gap by probing a fixed list of contact-page paths through the
// availability API. We do the same here — kept small because each path is a
// network round-trip on the same rate-limited link as the playback fetches.

const WELL_KNOWN_PATHS = [
  "/",
  // Cyrillic — guaranteed CDX urlkey miss.
  "/контакты", "/контакт",
  "/о-нас", "/о_нас", "/о-компании", "/о_компании",
  "/реквизиты", "/связь", "/обратная-связь",
  // Transliterated Russian that the CLI also probes — usually but not
  // always caught by the urlkey filter.
  "/svyaz", "/obratnaya-svyaz",
];

const PROBE_TIMESTAMP = "20100101";  // mid-era of typical pre-2015 captures

function _sourceFromPlayback(playbackUrl) {
  const m = (playbackUrl || "").match(/^https?:\/\/web\.archive\.org\/web\/\d{14}[a-z_]*\/(.+)$/i);
  return m ? m[1] : null;
}

async function probeWellKnown(host, signal, gate, onProbeStatus) {
  const found = [];
  let i = 0;
  await runSequential(WELL_KNOWN_PATHS, async path => {
    i++;
    onProbeStatus?.(i, WELL_KNOWN_PATHS.length, path);
    const target = `http://${host}${path}`;
    const url = `https://archive.org/wayback/available?url=${encodeURIComponent(target)}&timestamp=${PROBE_TIMESTAMP}`;
    try {
      const resp = await fetch(viaProxy(url), { signal });
      if (!resp.ok) return { status: resp.status };
      const data = await resp.json();
      const closest = data?.archived_snapshots?.closest;
      if (closest && closest.available) {
        const original = _sourceFromPlayback(closest.url) || target;
        found.push({ timestamp: closest.timestamp, original, urlkey: "" });
      }
      return { status: 200 };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      return { status: 0 };
    }
  }, { signal, gate });
  return found;
}


// ---------- Sequential fetcher with auto rate-limiting --------------------
//
// The Wayback Machine drops TCP connections (no 429, just RST) when an IP
// hits its hidden rate-limit. We stay below it by:
//
//   * fetching strictly one URL at a time (no concurrency knob);
//   * keeping a minimum gap of BASE_GAP_MS between fetches;
//   * on a rate-limit-looking failure, sleeping for an exponentially-growing
//     pause and retrying the same URL up to BACKOFF_PAUSES.length times;
//   * after backoff, slowly relaxing the gap back toward the base.
//
// The whole thing is abortable via the AbortSignal threaded through every
// fetch + sleep call.

const BASE_GAP_MS = 800;             // 1 req / ~1.25s steady-state ceiling
const BACKOFF_PAUSES = [5_000, 15_000, 45_000];  // 3 retries then give up

function isRateLimitFailure(err, status) {
  if (status === 429 || status === 503) return true;
  if (status === 502) return true;  // proxy turning an upstream RST into 502
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return msg.includes("failed to fetch")
      || msg.includes("network")
      || msg.includes("load failed");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createRateGate() {
  return { nextAllowedAt: 0, currentGap: BASE_GAP_MS };
}

async function runSequential(items, fetcher, { signal, onBackoff, onResume, gate }) {
  gate = gate || createRateGate();

  for (const item of items) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    // Honour the steady-state gap.
    const waitMs = gate.nextAllowedAt - performance.now();
    if (waitMs > 0) await sleep(waitMs, signal);

    // Try the fetch with exponential backoff on rate-limit signals.
    let attempt = 0;
    let succeeded = false;
    while (true) {
      let status = 0;
      let err = null;
      try {
        const result = await fetcher(item);  // result === { status, ... } | null
        status = result?.status || 0;
        succeeded = result !== null;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        err = e;
      }

      if (succeeded || (!isRateLimitFailure(err, status) && status !== 0)) {
        // Either the fetch worked or it failed for a non-rate-limit reason
        // (404 etc) — both count as "move on". Relax the gap a notch.
        gate.currentGap = Math.max(BASE_GAP_MS, Math.round(gate.currentGap * 0.75));
        gate.nextAllowedAt = performance.now() + gate.currentGap;
        break;
      }

      // Rate-limited (or network drop). Back off and retry, unless we've
      // exhausted the budget.
      if (attempt >= BACKOFF_PAUSES.length) {
        gate.nextAllowedAt = performance.now() + gate.currentGap;
        break;
      }
      const pauseMs = BACKOFF_PAUSES[attempt];
      onBackoff?.(pauseMs, attempt + 1, BACKOFF_PAUSES.length);
      await sleep(pauseMs, signal);
      onResume?.();
      // Each backoff also lifts the steady-state gap so the next request
      // doesn't go right back into the wall.
      gate.currentGap = Math.min(10_000, gate.currentGap * 2);
      attempt++;
    }
  }
}


// ---------- Aggregation ----------------------------------------------------

function aggregate(sightings) {
  // sightings: [{kind, value, raw, timestamp, snapshotUrl}, ...]
  const byValue = new Map();
  for (const s of sightings) {
    if (!byValue.has(s.value)) byValue.set(s.value, []);
    byValue.get(s.value).push(s);
  }
  const rows = [];
  for (const [value, group] of byValue) {
    group.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const first = group[0], last = group[group.length - 1];
    const variants = [];
    for (const s of group) {
      const r = (s.raw || "").trim();
      if (r && !variants.includes(r)) variants.push(r);
    }
    rows.push({
      kind: first.kind,
      value,
      valueHuman: first.kind === "phone" ? formatPhoneHuman(value) : value,
      valueRaw: variants.join(" | "),
      firstTs: first.timestamp,
      lastTs: last.timestamp,
      sightings: group.length,
      firstUrl: first.snapshotUrl,
      lastUrl: last.snapshotUrl,
    });
  }
  rows.sort((a, b) => (a.firstTs < b.firstTs ? -1 : 1));
  return rows;
}

function formatPhoneHuman(e164) {
  try {
    const lp = window.libphonenumber;
    const num = (lp.parsePhoneNumberFromString || lp.parsePhoneNumber)(e164);
    return num.formatInternational();
  } catch { return e164; }
}

function humanDate(ts) {
  if (!ts || ts.length < 8) return ts || "";
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}


// ---------- CSV ------------------------------------------------------------

function rowsToCsv(rows) {
  const headers = ["kind", "value", "value_human", "value_raw", "first_seen",
    "last_seen", "sightings_count", "first_archive_url", "last_archive_url"];
  const escape = v => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["﻿" + headers.join(",")]; // BOM so Excel reads UTF-8
  for (const r of rows) {
    lines.push([r.kind, r.value, r.valueHuman, r.valueRaw, humanDate(r.firstTs),
      humanDate(r.lastTs), r.sightings, r.firstUrl, r.lastUrl].map(escape).join(","));
  }
  return lines.join("\n");
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}


// ---------- UI plumbing ----------------------------------------------------

const ui = {
  form: document.getElementById("form"),
  target: document.getElementById("target"),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  fromYear: document.getElementById("from-year"),
  toYear: document.getElementById("to-year"),
  maxSnapshots: document.getElementById("max-snapshots"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  download: document.getElementById("download"),
  summary: document.getElementById("summary"),
  bar: document.getElementById("bar"),
  stage: document.getElementById("stage"),
  counters: document.getElementById("counters"),
  results: document.querySelector("#results tbody"),
  contactsCount: document.getElementById("contacts-count"),
  errors: document.getElementById("errors"),
};

let currentAbort = null;
let currentCsv = null;
let currentCsvName = null;

function setStage(msg) { ui.stage.textContent = msg; }
function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  ui.bar.style.width = pct + "%";
  ui.counters.textContent = total > 0 ? `${done}/${total} (${pct}%)` : "";
}
function logError(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  ui.errors.textContent += line;
}

function renderRows(rows) {
  ui.contactsCount.textContent = `${rows.length} distinct`;
  if (!rows.length) {
    ui.results.innerHTML = `<tr><td colspan="5" class="empty">No contacts found yet.</td></tr>`;
    return;
  }
  const html = rows.map(r => `
    <tr>
      <td class="kind">${r.kind}</td>
      <td class="value">${escapeHtml(r.valueHuman)}<br><small style="color:var(--muted)">${escapeHtml(r.valueRaw)}</small></td>
      <td><a href="${escapeAttr(r.firstUrl)}" target="_blank" rel="noopener">${humanDate(r.firstTs)}</a></td>
      <td><a href="${escapeAttr(r.lastUrl)}" target="_blank" rel="noopener">${humanDate(r.lastTs)}</a></td>
      <td>${r.sightings}</td>
    </tr>`).join("");
  ui.results.innerHTML = html;
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function escapeAttr(s) { return String(s).replace(/["&<>]/g, c => ({'"':"&quot;","&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }


// ---------- Target normalization ------------------------------------------

function normalizeTarget(raw, mode) {
  const trimmed = raw.trim();
  if (mode === "single") {
    // Single URL must have a scheme; default to https://.
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let host;
    try { host = new URL(withScheme).hostname; }
    catch { throw new Error(`Cannot parse URL: ${trimmed}`); }
    return { target: withScheme, host };
  }
  // Domain mode: strip scheme + path, keep host.
  let host = trimmed.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  if (!host) throw new Error(`Cannot parse domain: ${trimmed}`);
  return { target: host, host };
}


// ---------- Main scan loop -------------------------------------------------

async function runScan(opts, signal) {
  const { target, host } = normalizeTarget(opts.raw, opts.mode);
  const limit = Math.max(1, opts.maxSnapshots);

  setStage(`Querying CDX index for ${target}…`);
  let snapshots;
  try {
    snapshots = await queryCdx({
      target,
      mode: opts.mode,
      fromYear: opts.fromYear,
      toYear: opts.toYear,
      // Pull oversample for domain mode so we can rank then truncate.
      // Single mode: just take the most recent N.
      limit: opts.mode === "domain" ? Math.max(limit * 8, 200) : limit * 4,
    }, signal);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error(`CDX failed: ${e.message}`);
  }
  if (!snapshots.length) {
    setStage("CDX returned 0 snapshots — nothing to fetch.");
    setProgress(0, 0);
    return { rows: [], host, target };
  }

  let chosen;
  const gate = createRateGate();

  if (opts.mode === "domain") {
    // One snapshot per URL is already enforced by collapse=urlkey on the
    // server. Score + truncate locally.
    const scored = snapshots.map(s => ({ ...s, _score: scoreUrl(s.original) }));
    scored.sort((a, b) => b._score - a._score || (a.timestamp < b.timestamp ? 1 : -1));
    chosen = scored.slice(0, limit);

    // Probe well-known contact paths (mostly cyrillic — what the CDX urlkey
    // filter misses). Sharing ``gate`` keeps the rate-limit state continuous
    // across probe + fetch so the steady-state pause doesn't reset.
    setStage(`Probing ${WELL_KNOWN_PATHS.length} well-known contact paths…`);
    const probed = await probeWellKnown(host, signal, gate, (i, n) => {
      setStage(`Probing well-known contact paths (${i}/${n})…`);
    });
    if (probed.length) {
      const seen = new Set(chosen.map(s => s.original));
      const extra = probed.filter(s => !seen.has(s.original));
      if (extra.length) {
        // Probed paths are precisely the ones CDX missed → high signal.
        // Put them at the head of the queue.
        chosen = extra.concat(chosen).slice(0, limit);
        logError(`Probe added ${extra.length} snapshot(s) CDX missed.`);
      }
    }
  } else {
    // Single URL: most recent first is friendlier (contact info is more
    // likely on a populated page than on an empty 1998 placeholder).
    snapshots.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    chosen = snapshots.slice(0, limit);
  }

  setStage(`Fetching ${chosen.length} of ${snapshots.length.toLocaleString()} candidate snapshot${snapshots.length === 1 ? "" : "s"}…`);

  const sightings = [];
  let done = 0;
  const total = chosen.length;
  setProgress(0, total);

  await runSequential(chosen, async snap => {
    const url = playbackUrl(snap);
    let result = null;
    try {
      const resp = await fetch(viaProxy(url), { signal });
      result = { status: resp.status };
      if (!resp.ok) {
        logError(`HTTP ${resp.status} ${url}`);
        return result;
      }
      const html = await resp.text();
      const found = [...extractEmails(html), ...extractPhones(html, host)];
      for (const c of found) {
        sightings.push({ ...c, timestamp: snap.timestamp, snapshotUrl: url });
      }
      return result;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      logError(`${url} — ${e.message}`);
      throw e;
    } finally {
      done++;
      setProgress(done, total);
      if (done % 2 === 0 || done === total) {
        renderRows(aggregate(sightings));
      }
    }
  }, {
    signal,
    gate,
    onBackoff: (ms, n, max) => {
      setStage(`Rate-limited by archive.org — pausing ${Math.round(ms / 1000)}s before retry ${n}/${max}…`);
    },
    onResume: () => {
      setStage(`Fetching ${chosen.length} snapshots… (${done}/${total} done)`);
    },
  });

  const rows = aggregate(sightings);
  renderRows(rows);
  return { rows, host, target };
}


// ---------- Form glue ------------------------------------------------------

ui.form.addEventListener("submit", async e => {
  e.preventDefault();
  if (currentAbort) return;

  const mode = [...ui.modeRadios].find(r => r.checked).value;
  const opts = {
    raw: ui.target.value,
    mode,
    fromYear: parseInt(ui.fromYear.value, 10) || null,
    toYear: parseInt(ui.toYear.value, 10) || null,
    maxSnapshots: parseInt(ui.maxSnapshots.value, 10) || 60,
  };

  // Reset state.
  ui.errors.textContent = "";
  ui.results.innerHTML = `<tr><td colspan="5" class="empty">Scanning…</td></tr>`;
  ui.contactsCount.textContent = "";
  ui.summary.textContent = "";
  ui.download.hidden = true;
  currentCsv = null;
  setProgress(0, 0);

  currentAbort = new AbortController();
  ui.start.disabled = true;
  ui.stop.hidden = false;
  const t0 = performance.now();

  try {
    const { rows, target } = await runScan(opts, currentAbort.signal);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const fetched = ui.counters.textContent.split("/")[0] || "?";
    setStage(`Done. Fetched ${fetched} snapshots in ${elapsed}s; ${rows.length} distinct contacts.`);
    ui.summary.textContent = `${rows.length} contacts • ${elapsed}s`;
    if (rows.length) {
      currentCsv = rowsToCsv(rows);
      const safeName = target.replace(/[^A-Za-z0-9_.\-]+/g, "_").slice(0, 80);
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      currentCsvName = `${safeName}_${stamp}.csv`;
      ui.download.hidden = false;
    }
  } catch (e) {
    if (e.name === "AbortError") {
      setStage("Scan stopped.");
    } else {
      setStage(`Error: ${e.message}`);
      logError(e.message);
    }
  } finally {
    currentAbort = null;
    ui.start.disabled = false;
    ui.stop.hidden = true;
  }
});

ui.stop.addEventListener("click", () => {
  if (currentAbort) currentAbort.abort();
});

ui.download.addEventListener("click", () => {
  if (currentCsv && currentCsvName) downloadCsv(currentCsvName, currentCsv);
});

// Example chips below the URL field — clicking one fills the input and,
// for the single-URL example, toggles the matching mode radio.
for (const btn of document.querySelectorAll(".examples button[data-example]")) {
  btn.addEventListener("click", () => {
    ui.target.value = btn.dataset.example;
    const mode = btn.dataset.mode || "domain";
    const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    ui.target.focus();
  });
}

// libphonenumber-js loads async — surface that to the user if it never
// arrives (e.g. CDN blocked).
window.addEventListener("load", () => {
  if (!window.libphonenumber || !window.libphonenumber.findPhoneNumbersInText) {
    setStage("Warning: libphonenumber-js failed to load — phone extraction will be skipped.");
  } else {
    setStage("Ready. Enter a domain or URL and press Start.");
  }
});
