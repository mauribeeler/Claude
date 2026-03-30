"""
Xero OAuth2 Authentication.
Handles the full OAuth2 flow: authorize, token exchange, refresh, and storage.
"""

import hashlib
import json
import secrets
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import requests

from xero_api.config import (
    TOKEN_STORAGE_PATH,
    XERO_AUTH_URL,
    XERO_CLIENT_ID,
    XERO_CLIENT_SECRET,
    XERO_CONNECTIONS_URL,
    XERO_REDIRECT_URI,
    XERO_SCOPES,
    XERO_TOKEN_URL,
)


class XeroAuth:
    """Manages Xero OAuth2 authentication with PKCE and token persistence."""

    def __init__(self):
        self.client_id = XERO_CLIENT_ID
        self.client_secret = XERO_CLIENT_SECRET
        self.redirect_uri = XERO_REDIRECT_URI
        self.tokens = None
        self.tenant_id = None
        self._load_tokens()

    def _load_tokens(self):
        """Load stored tokens from disk if they exist."""
        if TOKEN_STORAGE_PATH.exists():
            with open(TOKEN_STORAGE_PATH) as f:
                data = json.load(f)
                self.tokens = data.get("tokens")
                self.tenant_id = data.get("tenant_id")

    def _save_tokens(self):
        """Persist tokens to disk."""
        with open(TOKEN_STORAGE_PATH, "w") as f:
            json.dump(
                {"tokens": self.tokens, "tenant_id": self.tenant_id},
                f,
                indent=2,
            )

    def is_authenticated(self) -> bool:
        """Check if we have valid (or refreshable) tokens."""
        return self.tokens is not None and "refresh_token" in self.tokens

    def get_access_token(self) -> str:
        """Return a valid access token, refreshing if needed."""
        if not self.tokens:
            raise RuntimeError(
                "Not authenticated. Call authenticate() first."
            )

        # Refresh if token is expired or about to expire (60s buffer)
        expires_at = self.tokens.get("expires_at", 0)
        if time.time() >= expires_at - 60:
            self._refresh_token()

        return self.tokens["access_token"]

    def get_tenant_id(self) -> str:
        """Return the Xero tenant ID."""
        if not self.tenant_id:
            self._fetch_tenant_id()
        return self.tenant_id

    def authenticate(self):
        """Run the full OAuth2 authorization code flow with PKCE."""
        if not self.client_id:
            raise RuntimeError(
                "XERO_CLIENT_ID not set. Copy .env.example to .env and fill in your credentials.\n"
                "See: https://developer.xero.com/app/manage"
            )

        # Generate PKCE code verifier and challenge
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = (
            hashlib.sha256(code_verifier.encode())
            .digest()
        )
        import base64
        code_challenge = base64.urlsafe_b64encode(code_challenge).rstrip(b"=").decode()

        # Build authorization URL
        state = secrets.token_urlsafe(32)
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": XERO_SCOPES,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        auth_url = f"{XERO_AUTH_URL}?{urllib.parse.urlencode(params)}"

        # Start local callback server to capture the authorization code
        auth_code = [None]
        received_state = [None]

        class CallbackHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                query = urllib.parse.urlparse(self.path).query
                qs = urllib.parse.parse_qs(query)
                auth_code[0] = qs.get("code", [None])[0]
                received_state[0] = qs.get("state", [None])[0]

                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<html><body><h2>Authenticated with Xero!</h2>"
                    b"<p>You can close this window and return to your terminal.</p>"
                    b"</body></html>"
                )

            def log_message(self, format, *args):
                pass  # Suppress server logs

        # Parse port from redirect URI
        parsed = urllib.parse.urlparse(self.redirect_uri)
        port = parsed.port or 8080

        server = HTTPServer(("localhost", port), CallbackHandler)
        server_thread = Thread(target=server.handle_request, daemon=True)
        server_thread.start()

        print(f"\nOpening browser for Xero authorization...")
        print(f"If the browser doesn't open, visit:\n{auth_url}\n")
        webbrowser.open(auth_url)

        # Wait for the callback
        server_thread.join(timeout=120)
        server.server_close()

        if not auth_code[0]:
            raise RuntimeError("Authorization failed — no code received.")

        if received_state[0] != state:
            raise RuntimeError("State mismatch — possible CSRF attack.")

        # Exchange authorization code for tokens
        self._exchange_code(auth_code[0], code_verifier)
        self._fetch_tenant_id()
        self._save_tokens()

        print("Successfully authenticated with Xero!")

    def _exchange_code(self, code: str, code_verifier: str):
        """Exchange authorization code for access and refresh tokens."""
        response = requests.post(
            XERO_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.client_id,
                "code_verifier": code_verifier,
            },
            auth=(self.client_id, self.client_secret) if self.client_secret else None,
        )
        response.raise_for_status()
        self.tokens = response.json()
        self.tokens["expires_at"] = time.time() + self.tokens.get("expires_in", 1800)

    def _refresh_token(self):
        """Refresh the access token using the refresh token."""
        response = requests.post(
            XERO_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.tokens["refresh_token"],
                "client_id": self.client_id,
            },
            auth=(self.client_id, self.client_secret) if self.client_secret else None,
        )
        response.raise_for_status()
        self.tokens = response.json()
        self.tokens["expires_at"] = time.time() + self.tokens.get("expires_in", 1800)
        self._save_tokens()

    def _fetch_tenant_id(self):
        """Fetch the Xero tenant (organisation) ID."""
        response = requests.get(
            XERO_CONNECTIONS_URL,
            headers={"Authorization": f"Bearer {self.tokens['access_token']}"},
        )
        response.raise_for_status()
        connections = response.json()

        if not connections:
            raise RuntimeError("No Xero organisations connected to this app.")

        # Use the first connected organisation
        self.tenant_id = connections[0]["tenantId"]
        tenant_name = connections[0].get("tenantName", "Unknown")
        print(f"Connected to Xero organisation: {tenant_name}")
