"""Debugger e2e target: a threaded HTTP server with a breakpointable handler.

Port 0 lets the OS pick, and the port is printed so the spec can reach it through the session's
output. The handler does a little work before it answers, so a breakpoint on `total` has `path`
in scope.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path
        total = len(path)
        body = ("ok %d" % total).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return None


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print("listening on %d" % server.server_address[1], flush=True)
server.serve_forever()
