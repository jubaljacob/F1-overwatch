"""Unit tests for the OpenF1 HTTP client.

No live calls — we stub the underlying httpx.Client so these run offline and
fast. The goal is to cover retry behaviour, error mapping, and the
round-number → session-key resolution logic.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from traceline.services.openf1_client import (
    OpenF1Client,
    OpenF1Error,
    resolve_session_key,
)


class _StubTransport(httpx.BaseTransport):
    """Drop-in transport that replays a queue of responses per URL path."""

    def __init__(self, responses: dict[str, list[httpx.Response]]) -> None:
        self._responses = {k: list(v) for k, v in responses.items()}

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        queue = self._responses.get(request.url.path)
        if not queue:
            return httpx.Response(404, request=request)
        resp = queue.pop(0)
        resp._request = request
        return resp


def _client(responses: dict[str, list[httpx.Response]]) -> OpenF1Client:
    client = OpenF1Client(max_retries=3)
    client._client = httpx.Client(
        base_url="https://example.test", transport=_StubTransport(responses)
    )
    return client


def _ok(body: list[dict[str, Any]]) -> httpx.Response:
    return httpx.Response(200, json=body)


def _server_error() -> httpx.Response:
    return httpx.Response(503, json={"detail": "upstream busy"})


def test_get_retries_on_server_error_then_succeeds() -> None:
    with _client({"/meetings": [_server_error(), _ok([{"meeting_key": 1}])]}) as c:
        data = c.get("/meetings", year=2024)
        assert data == [{"meeting_key": 1}]


def test_get_gives_up_after_max_retries() -> None:
    with (
        _client({"/laps": [_server_error(), _server_error(), _server_error()]}) as c,
        pytest.raises(OpenF1Error),
    ):
        c.get("/laps", session_key=42)


def test_get_drops_none_params() -> None:
    captured: list[httpx.Request] = []

    class CapturingTransport(httpx.BaseTransport):
        def handle_request(self, request: httpx.Request) -> httpx.Response:
            captured.append(request)
            return httpx.Response(200, json=[])

    c = OpenF1Client()
    c._client = httpx.Client(base_url="https://x.test", transport=CapturingTransport())
    c.get("/drivers", session_key=10, driver_number=None)
    assert "driver_number" not in str(captured[0].url)
    assert "session_key=10" in str(captured[0].url)


def test_get_raises_on_non_array_body() -> None:
    with (
        _client({"/sessions": [httpx.Response(200, json={"not": "a list"})]}) as c,
        pytest.raises(OpenF1Error, match="non-array"),
    ):
        c.get("/sessions")


def test_resolve_session_key_picks_round_by_date_order() -> None:
    meetings = [
        {"meeting_key": 200, "date_start": "2024-03-02T00:00:00+00:00", "meeting_name": "Bahrain"},
        {
            "meeting_key": 100,
            "date_start": "2024-02-29T00:00:00+00:00",
            "meeting_name": "Australia",
        },
        {"meeting_key": 300, "date_start": "2024-03-09T00:00:00+00:00", "meeting_name": "Jeddah"},
    ]
    sessions_for_200 = [{"session_key": 9999, "session_name": "Race"}]
    with _client(
        {
            "/meetings": [_ok(meetings)],
            "/sessions": [_ok(sessions_for_200)],
        }
    ) as c:
        # Round 2 by date is Bahrain (meeting_key 200).
        key, meeting = resolve_session_key(c, year=2024, round_=2)
        assert key == 9999
        assert meeting["session_name"] == "Race"


def test_resolve_session_key_rejects_out_of_range_round() -> None:
    with (
        _client({"/meetings": [_ok([{"meeting_key": 1, "date_start": "2024-01-01"}])]}) as c,
        pytest.raises(OpenF1Error, match="out of range"),
    ):
        resolve_session_key(c, year=2024, round_=5)


def test_resolve_session_key_errors_when_no_matching_session() -> None:
    with (
        _client(
            {
                "/meetings": [_ok([{"meeting_key": 1, "date_start": "2024-01-01"}])],
                "/sessions": [_ok([])],  # no Race session
            }
        ) as c,
        pytest.raises(OpenF1Error, match="no session named"),
    ):
        resolve_session_key(c, year=2024, round_=1)
