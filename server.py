"""Local launcher for the kronikier web build.

The Wayback Machine's CDX and playback endpoints do NOT serve
``Access-Control-Allow-Origin`` headers, which means a browser refuses to
expose their responses to JS running on any other origin (including
``file://`` and ``http://localhost``). This script works around that by
serving the static ``web/`` directory AND proxying upstream IA fetches
with permissive CORS headers.

The proxy makes its HTTP calls identical to what the kronikier CLI does:

  * one shared ``requests.Session()`` (persistent TCP/TLS keep-alive — IA is
    measurably happier with reused connections than with fresh ones);
  * same ``User-Agent`` string;
  * same server-side retry policy with backoff on retryable statuses
    (404, 408, 429, 500, 502, 503, 504) — most transient IA hiccups never
    reach the browser.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

DEFAULT_PORT = 8765
ALLOWED_UPSTREAM_HOSTS = {"web.archive.org", "archive.org"}
UPSTREAM_TIMEOUT = 30  # match kronikier CLI default

UPSTREAM_USER_AGENT = "kronikier-web/0.1 (+https://github.com/soxoj/kronikier)"

# Mirrors kronikier.fetcher._RETRYABLE_STATUSES.
RETRYABLE_STATUSES = frozenset({404, 408, 429, 500, 502, 503, 504})
MAX_RETRIES = 3  # 1 initial + 3 retries, like CLI default

WEB_DIR = Path(__file__).resolve().parent


def _default_cache_dir() -> Path:
    env = os.environ.get("KRONIEKER_WEB_CACHE_DIR")
    if env:
        return Path(env).expanduser()
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "kronikier-web"


CACHE_DIR = _default_cache_dir()
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Single session reused for every proxied request, exactly like the CLI's
# scan_domain() creates one Session and threads it through every CDX +
# playback call.
_session = requests.Session()
_session.headers["User-Agent"] = UPSTREAM_USER_AGENT

# Hit/miss accounting for the periodic log line. Lock guards counters,
# not file writes (writes are atomic via tmp+rename).
_cache_stats = {"hits": 0, "misses": 0, "stores": 0}
_cache_lock = threading.Lock()


# ---------------------------------------------------------------------------
# On-disk cache
# ---------------------------------------------------------------------------
#
# Wayback snapshot bytes are immutable once captured, and the CDX/availability
# responses change rarely enough that within an analyst's session they're
# effectively static. Caching every 200 response keeps re-runs snappy and
# stops re-issuing requests to IA the moment we've already paid for them.
#
# Layout (under ``CACHE_DIR``):
#   <sha1-of-url>.meta  — JSON: {"status":200,"ct":"...","url":"..."}
#   <sha1-of-url>.body  — raw response bytes
#
# Atomic stores: write to <name>.tmp, fsync, rename. Readers either see the
# old contents or the new contents, never a partial blob.

def _cache_key(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def _cache_paths(url: str) -> tuple[Path, Path]:
    key = _cache_key(url)
    return CACHE_DIR / f"{key}.meta", CACHE_DIR / f"{key}.body"


def _cache_get(url: str) -> tuple[bytes, str, int] | None:
    meta_path, body_path = _cache_paths(url)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        body = body_path.read_bytes()
    except (FileNotFoundError, OSError, ValueError):
        return None
    return body, meta.get("ct", "application/octet-stream"), int(meta.get("status", 200))


def _cache_put(url: str, body: bytes, content_type: str, status: int) -> None:
    # Cache only successful, stable responses. Errors (incl. 502/429) can
    # be transient — letting them flow through forces a real retry next time.
    if status != 200:
        return
    meta_path, body_path = _cache_paths(url)
    tmp_meta = meta_path.with_suffix(".meta.tmp")
    tmp_body = body_path.with_suffix(".body.tmp")
    try:
        tmp_body.write_bytes(body)
        tmp_meta.write_text(
            json.dumps({"status": status, "ct": content_type, "url": url}),
            encoding="utf-8",
        )
        os.replace(tmp_body, body_path)
        os.replace(tmp_meta, meta_path)
        with _cache_lock:
            _cache_stats["stores"] += 1
    except OSError:
        # Best-effort cache — a write failure must never break the request.
        for p in (tmp_meta, tmp_body):
            try: p.unlink()
            except OSError: pass


def _fetch_with_retries(url: str):
    """Mirror ``kronikier.fetcher._fetch_one_attempts``: retry on the same
    statuses with the same backoff so the JS layer sees a clean 200 (or a
    real, persistent error) instead of bouncing on transient IA hiccups.
    """
    last_err: str | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = _session.get(url, timeout=UPSTREAM_TIMEOUT, allow_redirects=True)
            if resp.status_code == 200:
                return (
                    resp.content,
                    resp.headers.get("Content-Type", "application/octet-stream"),
                    resp.status_code,
                    None,
                )
            last_err = f"HTTP {resp.status_code}"
            if resp.status_code in RETRYABLE_STATUSES and attempt < MAX_RETRIES:
                # CLI uses 3.0 for 404 (often transient on IA), 1.5 for the rest.
                backoff = 3.0 if resp.status_code == 404 else 1.5
                time.sleep(backoff * (attempt + 1))
                continue
            # Non-retryable non-200 — surface to the browser as-is so the
            # client can decide what to do.
            return (
                resp.content,
                resp.headers.get("Content-Type", "application/octet-stream"),
                resp.status_code,
                None,
            )
        except requests.RequestException as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < MAX_RETRIES:
                time.sleep(1.5 * (attempt + 1))
                continue
    return None, None, None, last_err


class Handler(SimpleHTTPRequestHandler):
    # Serve from the web/ directory regardless of where the script is invoked.
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    # Quieter access log (one line per request, no HTTP version noise);
    # tags proxy hits with HIT/MISS so the user can eyeball the cache.
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401, N802
        tag = ""
        if self.path.startswith("/proxy"):
            with _cache_lock:
                hits, misses = _cache_stats["hits"], _cache_stats["misses"]
            tag = f" [cache hits={hits} misses={misses}]"
        sys.stderr.write(f"  {self.address_string()} - {fmt % args}{tag}\n")

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/proxy?") or self.path.startswith("/proxy/"):
            self._handle_proxy()
            return
        super().do_GET()

    # ------------------------------------------------------------------
    # Proxy
    # ------------------------------------------------------------------
    def _handle_proxy(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        upstream_list = qs.get("url") or []
        if not upstream_list:
            self._send_error(HTTPStatus.BAD_REQUEST, "missing ?url=")
            return
        upstream = upstream_list[0]

        try:
            upstream_parsed = urllib.parse.urlparse(upstream)
        except ValueError:
            self._send_error(HTTPStatus.BAD_REQUEST, "malformed url")
            return

        if upstream_parsed.scheme not in ("http", "https"):
            self._send_error(HTTPStatus.BAD_REQUEST, "scheme must be http/https")
            return
        if upstream_parsed.hostname not in ALLOWED_UPSTREAM_HOSTS:
            self._send_error(
                HTTPStatus.FORBIDDEN,
                f"upstream host not allowed: {upstream_parsed.hostname}",
            )
            return

        cached = _cache_get(upstream)
        from_cache = cached is not None
        if from_cache:
            body, content_type, status = cached
            with _cache_lock:
                _cache_stats["hits"] += 1
        else:
            with _cache_lock:
                _cache_stats["misses"] += 1
            body, content_type, status, err = _fetch_with_retries(upstream)
            if err is not None:
                self._send_error(HTTPStatus.BAD_GATEWAY, f"upstream error: {err}")
                return
            _cache_put(upstream, body, content_type, status)

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Kronieker-Cache", "HIT" if from_cache else "MISS")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, msg: str) -> None:
        payload = msg.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Usage: {sys.argv[0]} [port]", file=sys.stderr)
            return 2

    url = f"http://localhost:{port}/"
    print(f"kronikier (web) — serving {WEB_DIR} at {url}")
    print(f"Proxying upstream requests to: {', '.join(sorted(ALLOWED_UPSTREAM_HOSTS))}")
    print(f"Caching successful responses to: {CACHE_DIR}")
    print("Open the URL above in your browser, then leave this tab — restarts")
    print("of this script don't require reopening it. Press Ctrl+C to stop.")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
