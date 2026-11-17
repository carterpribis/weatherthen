"""Local preview server: site/ at /, built map data (data/out/) at /data/.

Never lets the browser cache, so code changes show on reload.
Usage:  python3 serve.py [port] [folder] [remote]
        default 8788 and site/, bound to 127.0.0.1; "remote" passes /data/ through
        to the live archive (the bucket only lets localhost:8788 read it directly)
"""

import http.server
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
DATA = ROOT / "data" / "out"
ARCHIVE = "https://data.weather.prib.is/"
PASS_THROUGH = False


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def translate_path(self, path):
        clean = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if clean.startswith("/data/"):
            rel = os.path.normpath(clean[len("/data/"):]).lstrip("/")
            if rel.startswith(".."):
                return str(DATA / "__forbidden__")
            return str(DATA / rel)
        return super().translate_path(path)

    def do_GET(self):
        clean = urllib.parse.urlsplit(self.path).path
        if not (PASS_THROUGH and clean.startswith("/data/")) or ".." in clean:
            return super().do_GET()
        try:
            req = urllib.request.Request(ARCHIVE + clean[len("/data/"):],
                                         headers={"User-Agent": "weatherthen-preview", "Origin": "http://localhost:8788"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body, kind = r.read(), r.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            return self.send_error(e.code)
        except OSError:
            return self.send_error(502)
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    if len(sys.argv) > 2:
        SITE = ROOT / sys.argv[2]
    PASS_THROUGH = "remote" in sys.argv[3:]
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"Serving {SITE} at http://localhost:{port} (map data from {DATA})")
        httpd.serve_forever()
