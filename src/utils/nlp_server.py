#!/usr/bin/env python3
"""
Lightweight high-performance HTTP Daemon for spaCy NLP processing.
Keeps the en_core_web_sm model resident in RAM to eliminate cold-start overhead (1500ms -> ~20ms).
Uses Python's built-in http.server (no extra third-party dependencies required).
"""
import sys
import os
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# Add directory to sys.path so we can import nlp_processor
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import nlp_processor

def get_port():
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        return int(sys.argv[1])
    return int(os.environ.get("NLP_PORT", 5005))

PORT = get_port()
HOST = os.environ.get("NLP_HOST", "127.0.0.1")

# Preload model at startup
nlp_instance, preload_error = nlp_processor.get_nlp()
if nlp_instance is not None:
    print(f"[NLP Daemon] spaCy en_core_web_sm loaded successfully into RAM.", flush=True)
else:
    print(f"[NLP Daemon] Warning: spaCy model could not be preloaded: {preload_error}", file=sys.stderr, flush=True)

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in separate threads for concurrency."""
    daemon_threads = True

class NLPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health" or self.path == "/":
            response = {
                "status": "ok",
                "service": "lexigrow-nlp-daemon",
                "model_loaded": nlp_instance is not None,
                "error": preload_error
            }
            body = json.dumps(response).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/analyze":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_len).decode("utf-8")
                payload = json.loads(raw_body) if raw_body else {}
                text = payload.get("text", "")

                result = nlp_processor.analyze_text(text, nlp_instance=nlp_instance)
                body = json.dumps(result).encode("utf-8")

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                err_data = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(err_data)))
                self.end_headers()
                self.wfile.write(err_data)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # Only log if DEBUG_NLP is enabled
        if os.environ.get("DEBUG_NLP"):
            super().log_message(format, *args)

def main():
    server = ThreadedHTTPServer((HOST, PORT), NLPRequestHandler)
    print(f"[NLP Daemon] Serving on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[NLP Daemon] Shutting down...", flush=True)
        server.server_close()

if __name__ == "__main__":
    main()
