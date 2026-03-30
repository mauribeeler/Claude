"""
Base API client with shared request logic, pagination, and rate limiting.
"""

import time

import requests


class BaseAPI:
    """Base class for all Xero API modules. Handles headers, pagination, and rate limits."""

    def __init__(self, auth, base_url: str):
        self.auth = auth
        self.base_url = base_url.rstrip("/")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.auth.get_access_token()}",
            "Xero-Tenant-Id": self.auth.get_tenant_id(),
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, endpoint: str, params: dict = None, json_body: dict = None) -> dict:
        """Make an API request with automatic rate-limit retry."""
        url = f"{self.base_url}/{endpoint.lstrip('/')}"

        for attempt in range(3):
            response = requests.request(
                method,
                url,
                headers=self._headers(),
                params=params,
                json=json_body,
            )

            if response.status_code == 429:
                # Rate limited — wait and retry
                retry_after = int(response.headers.get("Retry-After", 5))
                print(f"Rate limited. Waiting {retry_after}s...")
                time.sleep(retry_after)
                continue

            response.raise_for_status()
            return response.json() if response.content else {}

        raise RuntimeError(f"Request to {url} failed after 3 rate-limit retries.")

    def _get(self, endpoint: str, params: dict = None) -> dict:
        return self._request("GET", endpoint, params=params)

    def _get_all(self, endpoint: str, params: dict = None, page_key: str = "page") -> list:
        """Paginate through all results. Works for APIs that use page-based pagination."""
        all_items = []
        page = 1
        params = dict(params or {})

        while True:
            params[page_key] = page
            data = self._get(endpoint, params)

            # Xero APIs return data under different keys — find the list
            items = None
            for key, value in data.items():
                if isinstance(value, list):
                    items = value
                    break

            if not items:
                break

            all_items.extend(items)

            # If we got fewer items than a full page, we're done
            if len(items) < 100:
                break

            page += 1

        return all_items
