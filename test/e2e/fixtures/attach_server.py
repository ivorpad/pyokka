"""An authenticated server already running when VS Code attaches."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import debugpy


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = self.path
        allowed = self.headers.get("X-Test-Auth") == os.environ["TEST_AUTH"]
        body = json.dumps({"pid": os.getpid(), "route": route}).encode()  # attach breakpoint
        self.send_response(200 if allowed else 401)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    host, debug_port = debugpy.listen(("127.0.0.1", 0))
    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(json.dumps({"debugPort": debug_port, "httpPort": server.server_port, "pid": os.getpid()}), flush=True)
    server.serve_forever()
