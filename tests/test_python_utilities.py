"""Exercise packaged response handling without loading browser or HTTP clients."""

import ast
import json
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]


class PythonUtilitiesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with ZipFile(ROOT / "extensions/utilities.sflx") as archive:
            tree = ast.parse(archive.read("signed_session_mobile.py"))
        names = {"_requests_dolby_atmos", "perform_signed_fetch"}
        functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        self.assertEqual({node.name for node in functions}, names)
        module = ast.parse("from __future__ import annotations\n")
        module.body.extend(functions)
        self.namespace = {
            "json": json, "time": time, "logger": Mock(),
            "_download_timeout_key": Mock(return_value="request"),
            "_clear_download_timeout": Mock(),
            "retry_after_header_seconds": lambda value: int(value or 0),
            "parse_session_error": Mock(return_value=None),
            "httpx": SimpleNamespace(TimeoutException=TimeoutError),
        }
        exec(compile(module, "packaged signed response handling", "exec"), self.namespace)

    async def fetch(self, body, status=502):
        response = SimpleNamespace(
            status_code=status, headers={"Retry-After": "60"},
            content=b"temporary failure", text="temporary failure",
            url="https://api.example.test/dl/media",
        )
        client = SimpleNamespace(
            authenticated=True, namespace="generic-media",
            request=AsyncMock(return_value=response),
        )
        result = await self.namespace["perform_signed_fetch"](
            client, "POST", "/dl/media", body, {},
        )
        client.request.assert_awaited_once()
        return result

    async def test_atmos_502_matches_the_tidal_fallback_contract(self):
        for body in [{"formats": ["EAC3_JOC"]}, {"quality": "DOLBY_ATMOS"}, '{"formats":"EAC3_JOC"}']:
            with self.subTest(body=body):
                self.assertEqual(await self.fetch(body), {
                    "error": "Dolby Atmos unavailable (HTTP 502 Bad Gateway)",
                    "code": "ATMOS_UNAVAILABLE", "retryable": False,
                    "retryMode": "none", "statusCode": 502, "status": 502,
                })

    async def test_other_502_responses_keep_their_retry_information(self):
        result = await self.fetch({"quality": "LOSSLESS"})
        self.assertNotIn("code", result)
        self.assertEqual(result["statusCode"], 502)
        self.assertEqual(result["retryAfterSeconds"], 60)
        self.assertEqual(result["body"], "temporary failure")

    async def test_atmos_rate_limits_are_not_reported_as_unavailable(self):
        result = await self.fetch({"formats": ["EAC3_JOC"]}, status=429)
        self.assertNotIn("code", result)
        self.assertEqual(result["statusCode"], 429)
        self.assertEqual(result["retryAfterSeconds"], 60)
