"""Local preview server: site/ at /, built map data (data/out/) at /data/.

Never lets the browser cache, so code changes show on reload.
Usage:  python3 serve.py [port]     (default 8788, bound to 127.0.0.1)
"""

import http.server
import os
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
DATA = ROOT / "data" / "out"


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

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"Serving {SITE} at http://localhost:{port} (map data from {DATA})")
        httpd.serve_forever()
