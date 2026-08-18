"""Smoke tests for the canonical FiveRealms development server."""

import importlib.util
import threading
import unittest
import urllib.request
from functools import partial
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "tools" / "dev-server.py"
SPEC = importlib.util.spec_from_file_location("five_realms_dev_server", SERVER_PATH)
DEV_SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEV_SERVER)


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


if __name__ == "__main__":
    unittest.main()
