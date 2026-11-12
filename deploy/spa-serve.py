# Serves a built SPA the way production's nginx does: a path with no file behind it gets
# index.html — python's own http.server answers 404 there, which hides real-path links
# such as /splits/join/<token>.
# usage: python3 spa-serve.py <port> <dir>
import http.server
import os
import sys

PORT = int(sys.argv[1])
ROOT = os.path.abspath(sys.argv[2])


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        if not os.path.exists(self.translate_path(self.path)):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("", PORT), SpaHandler).serve_forever()
