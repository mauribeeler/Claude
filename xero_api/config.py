"""
Configuration for Xero API integration.
Loads credentials from environment variables or .env file.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env file from project root
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)


# Xero OAuth2 Configuration
XERO_CLIENT_ID = os.getenv("XERO_CLIENT_ID", "")
XERO_CLIENT_SECRET = os.getenv("XERO_CLIENT_SECRET", "")
XERO_REDIRECT_URI = os.getenv("XERO_REDIRECT_URI", "http://localhost:8080/callback")

# Xero API endpoints
XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize"
XERO_TOKEN_URL = "https://login.xero.com/identity/connect/token"
XERO_CONNECTIONS_URL = "https://api.xero.com/connections"
XERO_ACCOUNTING_URL = "https://api.xero.com/api.xro/2.0"
XERO_PROJECTS_URL = "https://api.xero.com/projects.xro/2.0"
XERO_PAYROLL_UK_URL = "https://api.xero.com/payroll.xro/2.0"

# OAuth2 scopes — everything available
XERO_SCOPES = " ".join([
    "openid",
    "profile",
    "email",
    "offline_access",
    "accounting.transactions.read",
    "accounting.reports.read",
    "accounting.contacts.read",
    "accounting.settings.read",
    "accounting.journals.read",
    "accounting.attachments.read",
    "projects.read",
    "payroll.employees.read",
    "payroll.payruns.read",
    "payroll.payslip.read",
    "payroll.timesheets.read",
    "payroll.settings.read",
])

# Token storage path
TOKEN_STORAGE_PATH = Path(__file__).resolve().parent.parent / ".xero_tokens.json"
