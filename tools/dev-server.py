"""FiveRealms local development server with explicit no-cache responses."""

import argparse
import json
import os
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
HISTORY_DATA_PATH = ROOT / "history_data.json"
MAX_HISTORY_BYTES = 1024 * 1024
HISTORY_FILE_LOCK = Lock()


def write_history_atomically(target_path, content):
    """Write a complete archive beside its target and atomically replace the old file."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target_path.name}.", suffix=".tmp", dir=target_path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as temporary_file:
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, target_path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


class NoCacheStaticHandler(SimpleHTTPRequestHandler):
    """Serve repository files while preventing browser cache reuse in development."""

    history_data_path = HISTORY_DATA_PATH

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        request_path = urlsplit(self.path).path
        if request_path == "/api/history/health":
            self._send_json(200, {"ok": True})
            return
        if request_path != "/api/history":
            return super().do_GET()
        if not self.history_data_path.exists():
            self._send_json(404, {"error": "history archive not found"})
            return
        try:
            body = self.history_data_path.read_bytes()
        except OSError as error:
            self._send_json(500, {"error": str(error)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        if urlsplit(self.path).path != "/api/history":
            self._send_json(404, {"error": "unknown endpoint"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "invalid content length"})
            return
        if length <= 0 or length > MAX_HISTORY_BYTES:
            self._send_json(413, {"error": "history payload size rejected"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid history json"})
            return
        required_keys = {"version", "summary", "characters", "teams", "records"}
        if not isinstance(payload, dict) or payload.get("version") != 1 or not required_keys.issubset(payload):
            self._send_json(400, {"error": "unsupported history schema"})
            return
        serialized = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        create_only = self.headers.get("If-None-Match", "").strip() == "*"
        try:
            with HISTORY_FILE_LOCK:
                if create_only and self.history_data_path.exists():
                    self._send_json(412, {"error": "history archive already exists"})
                    return
                write_history_atomically(self.history_data_path, serialized)
        except OSError as error:
            self._send_json(500, {"error": str(error)})
            return
        self._send_json(200, {"ok": True})


def main():
    parser = argparse.ArgumentParser(description="Serve FiveRealms for local browser development.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    handler = partial(NoCacheStaticHandler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"FiveRealms dev server listening at http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
