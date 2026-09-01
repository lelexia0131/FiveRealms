"""Smoke tests for the canonical FiveRealms development server."""

import importlib.util
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "tools" / "dev-server.py"


def load_dev_server_module():
    """Load the canonical server module after proving its import spec is complete."""
    spec = importlib.util.spec_from_file_location("five_realms_dev_server", SERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load FiveRealms development server: {SERVER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DEV_SERVER = load_dev_server_module()


class DevServerTest(unittest.TestCase):
    def test_repo_resources_use_no_store(self):
        handler = partial(DEV_SERVER.NoCacheStaticHandler, directory=str(DEV_SERVER.ROOT))
        server = DEV_SERVER.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        resources = (
            ("/", "index.html"),
            ("/js/main.js", "js/main.js"),
            ("/css/theme.css", "css/theme.css"),
        )
        try:
            for request_path, file_path in resources:
                with urllib.request.urlopen(base + request_path, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("no-store", response.headers.get("Cache-Control", ""))
                    self.assertEqual(response.read(), (DEV_SERVER.ROOT / file_path).read_bytes())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_history_api_creates_and_persists_only_the_configured_archive(self):
        with tempfile.TemporaryDirectory(prefix="fr-history-server-") as directory:
            history_path = Path(directory) / "history_data.json"

            class TestHistoryHandler(DEV_SERVER.NoCacheStaticHandler):
                history_data_path = history_path

            handler = partial(TestHistoryHandler, directory=str(DEV_SERVER.ROOT))
            server = DEV_SERVER.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_address[1]}/api/history"
            payload = b'{"version":1,"summary":{},"characters":{},"teams":{},"records":[]}'
            try:
                with self.assertRaises(urllib.error.HTTPError) as missing:
                    urllib.request.urlopen(url, timeout=5)
                self.assertEqual(missing.exception.code, 404)
                request = urllib.request.Request(
                    url,
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="PUT",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("no-store", response.headers.get("Cache-Control", ""))
                with urllib.request.urlopen(url, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), history_path.read_bytes())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
