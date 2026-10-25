"""Run: python -m unittest test_codekit_logging.py  (standard library only)."""

import asyncio
import io
import json
import re
import unittest

import codekit_logging as cl


class LoggingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.out = io.StringIO()
        cl.configure_logging("orders", pretty=False, stream=self.out)
        self.log = cl.get_logger("orders.service")

    def entries(self):
        return [json.loads(line) for line in self.out.getvalue().splitlines() if line]

    def test_required_fields(self):
        with cl.correlation_scope("abc-123-correlation"):
            self.log.info(["auth", "login"], "Login success", {"user_id": 42, "duration_ms": 12})
        e = self.entries()[0]
        self.assertEqual(e["service"], "orders")
        self.assertEqual(e["correlationId"], "abc-123-correlation")
        self.assertEqual(e["tags"], ["auth", "login"])
        self.assertEqual(e["message"], "Login success")
        self.assertEqual(e["context"], {"user_id": 42})
        self.assertEqual(e["durationMs"], 12)
        self.assertEqual(e["level"], "info")
        self.assertRegex(e["timestamp"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

    def test_tags_are_mandatory(self):
        with self.assertRaises(ValueError):
            self.log.info([], "no tags")
        with self.assertRaises(ValueError):
            self.log.info("auth", "a string is not a list")  # type: ignore[arg-type]

    def test_errors(self):
        try:
            raise RuntimeError("card declined")
        except RuntimeError as exc:
            self.log.error(["payment"], "Charge failed", exc, {"order_id": "o-1"})
        e = self.entries()[0]
        self.assertEqual(e["level"], "error")
        self.assertEqual(e["error"]["type"], "RuntimeError")
        self.assertIn("card declined", e["error"]["stack"])

    def test_logger_field(self):
        self.log.info(["order"], "Order placed")
        self.assertEqual(self.entries()[0]["logger"], "orders.service")

    def test_context_redacted_and_bounded_and_cause_chain(self):
        try:
            try:
                raise ConnectionError("connection refused")
            except ConnectionError as cause:
                raise RuntimeError("could not load order") from cause
        except RuntimeError as exc:
            self.log.error(["db"], "Query failed (chain test)", exc, {
                "password": "hunter2", "auth_token": "abc", "note": "x" * 2000,
                "ids": list(range(50)), "deep": {"a": {"b": {"c": {"d": 1}}}},
            })
        e = self.entries()[0]
        self.assertEqual(e["context"]["password"], "[redacted]")
        self.assertEqual(e["context"]["auth_token"], "[redacted]")
        self.assertTrue(e["context"]["note"].endswith("…(+1500)"))
        self.assertEqual(len(e["context"]["ids"]), 21)
        self.assertEqual(e["context"]["deep"]["a"]["b"], "[object]")
        self.assertIn("ConnectionError: connection refused", e["error"]["stack"])

    def test_repeated_errors_collapse(self):
        for _ in range(50):
            self.log.error(["external-api"], "Rates API down (repeat test)", RuntimeError("503"))
        self.assertEqual(len(self.entries()), 1)

    def test_debug_off_by_default(self):
        self.log.debug(["job"], "noise")
        self.assertEqual(self.entries(), [])

    def test_pretty_format(self):
        line = cl.format_pretty({"timestamp": "2026-10-25T09:12:03.120Z", "level": "info", "correlationId": "0190aaaa-7f3a91c2", "tags": ["auth", "login"], "message": "Login success", "context": {"user_id": 42}, "durationMs": 12})
        self.assertEqual(line, "09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success user_id=42 (12ms)")

    def test_uuid7(self):
        a, b = cl.uuid7(1_700_000_000_000), cl.uuid7(1_700_000_000_001)
        self.assertRegex(a, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        self.assertLess(a, b)

    def test_asgi_middleware(self):
        seen = {}

        async def app(scope, receive, send):
            seen["cid"] = cl.current_correlation_id()
            seen["headers"] = cl.correlation_headers()
            await send({"type": "http.response.start", "status": 201, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        mw = cl.CorrelationIdMiddleware(app)
        sent = []

        async def send(message):
            sent.append(message)

        async def receive():
            return {"type": "http.request"}

        asyncio.run(mw({"type": "http", "method": "POST", "path": "/orders", "headers": [(b"x-correlation-id", b"given-id-12345")]}, receive, send))
        self.assertEqual(seen["cid"], "given-id-12345")
        self.assertEqual(seen["headers"], {"X-Correlation-Id": "given-id-12345"})
        self.assertIn((b"x-correlation-id", b"given-id-12345"), sent[0]["headers"])

        asyncio.run(mw({"type": "http", "method": "GET", "path": "/x", "headers": []}, receive, send))
        self.assertTrue(re.match(r"^[0-9a-f-]{36}$", seen["cid"]))
        finished = [e for e in self.entries() if e["message"] == "Request finished"]
        self.assertEqual([e["context"]["status"] for e in finished], [201, 201])
        self.assertTrue(all(e["tags"] == ["http"] and isinstance(e["durationMs"], int) for e in finished))
        self.assertIsNone(cl.current_correlation_id())


if __name__ == "__main__":
    unittest.main()
