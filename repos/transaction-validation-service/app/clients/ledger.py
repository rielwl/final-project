"""Read-only client for ledger-service."""
from __future__ import annotations

import httpx

TIMEOUT_SECONDS = 0.8


class LedgerClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def balance_minor(self, account: str) -> int | None:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.get(f"{self.base_url}/v1/accounts/{account}/balance")
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()["balanceMinor"]

    async def daily_total_minor(self, account: str) -> int:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.get(f"{self.base_url}/v1/accounts/{account}/daily-total")
            response.raise_for_status()
            return response.json()["totalMinor"]
