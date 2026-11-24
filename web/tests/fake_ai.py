"""A stand-in AI service for the tests (a copy of Odin's page-src/tests/fake_ai.py): it answers like an OpenAI-style service (/v1/chat/completions, as
Ollama, LM Studio, Groq, OpenRouter and OpenAI do), like Claude (/v1/messages) and like Gemini
(/v1beta/models/<model>:generateContent), with made-up passages and questions in the shape Odin asks for.
It keeps every request it gets (GET /requests), so a test can check what was sent and that no student's name was.
A key of "bad-key" is refused (401). Browsers may call it from a page (it answers CORS preflights).
    python3 fake_ai.py [port]        (default 8099)"""
import json, re, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REQUESTS = []
WORDS = "the sun was warm and the kids went out to play in the park near the pond where ducks swim each day".split()


def passage(user):
    lo = int((re.search(r"between (\d+) and", user) or [0, 100])[1])
    hi = int((re.search(r"and (\d+) words", user) or [0, 120])[1])
    n, words = (lo + hi) // 2, []
    while len(words) < n:
        words += WORDS
    words = words[:n]
    sents = [" ".join(words[i:i + 10]).capitalize() + "." for i in range(0, n, 10)]
    half = len(sents) // 2 or 1
    topic = (re.search(r"Topic: ([^.]+)\.", user) or [0, "a day at the park"])[1]
    return {"title": f"A Story About {topic.title()}"[:50], "text": " ".join(sents[:half]) + "\n\n" + " ".join(sents[half:])}


def questions(user):
    n = int((re.search(r"Write (\d+) multiple-choice", user) or [0, 6])[1])
    k = int((re.search(r"exactly (\d) answer choices", user) or [0, 4])[1])
    hint = "hint" in user
    qs = []
    for i in range(n):
        a = 2 + i
        ch = [str(a + d) for d in range(k)]
        right = i % k
        ch[right], ch[0] = ch[0], ch[right]
        q = {"question": f"What is {a} + 0? (question {i + 1})", "choices": ch, "answer": "ABCDE"[right]}
        if hint:
            q["hint"] = "Adding zero keeps the number the same."
        qs.append(q)
    out = {"title": "Practice with adding zero", "questions": qs}
    if "First write one short" in user:
        out["passage"] = {"title": "Zero Friends", "text": "Zero is a number. When you add zero to a number, the number stays the same.\n\nTry it with blocks: add none, and count again."}
    return out


def answer(user):
    if "fluency practice" in user:
        return passage(user)
    if "multiple-choice" in user:
        return questions(user)
    return {"ok": True}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path == "/requests":
            return self.send(200, REQUESTS)
        if self.path == "/clear":
            REQUESTS.clear()
            return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        key = self.headers.get("x-api-key") or self.headers.get("x-goog-api-key") or (self.headers.get("Authorization") or "").replace("Bearer ", "")
        REQUESTS.append({"path": self.path, "key": key, "body": body})
        if key == "bad-key":
            return self.send(401, {"error": {"message": "invalid key"}})
        if self.path.endswith("/chat/completions"):
            user = body["messages"][-1]["content"]
            return self.send(200, {"choices": [{"message": {"role": "assistant", "content": "```json\n" + json.dumps(answer(user)) + "\n```"}}]})
        if self.path.endswith("/messages"):
            if not key:
                return self.send(401, {"error": {"message": "x-api-key header is required"}})
            return self.send(200, {"content": [{"type": "text", "text": json.dumps(answer(body["messages"][-1]["content"]))}]})
        if ":generateContent" in self.path:
            if not key:
                return self.send(403, {"error": {"message": "API key not valid"}})
            return self.send(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(answer(body["contents"][-1]["parts"][0]["text"]))}]}}]})
        self.send(404, {"error": {"message": "model not found"}})


def start(port=8099):
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()
