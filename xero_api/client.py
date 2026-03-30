"""
Main Xero API Client — single entry point for all API modules.
"""

from xero_api.accounting import AccountingAPI
from xero_api.auth import XeroAuth
from xero_api.payroll import PayrollAPI
from xero_api.projects import ProjectsAPI


class XeroClient:
    """
    Unified Xero API client.

    Usage:
        client = XeroClient()
        client.authenticate()  # Only needed first time or when tokens expire

        # Accounting
        invoices = client.accounting.get_invoices(status="PAID", date_from="2025-04-01")
        pnl = client.accounting.get_profit_and_loss(from_date="2025-04-01", to_date="2025-10-31")

        # Projects (job costing)
        projects = client.projects.get_projects(status="INPROGRESS")
        time_entries = client.projects.get_time_entries(project_id="xxx")

        # Payroll
        employees = client.payroll.get_employees(status="ACTIVE")
        pay_runs = client.payroll.get_pay_runs()
    """

    def __init__(self):
        self.auth = XeroAuth()
        self.accounting = AccountingAPI(self.auth)
        self.projects = ProjectsAPI(self.auth)
        self.payroll = PayrollAPI(self.auth)

    def authenticate(self):
        """Run OAuth2 flow. Only needed on first use or when refresh token expires."""
        self.auth.authenticate()

    def is_authenticated(self) -> bool:
        """Check if client has valid/refreshable tokens."""
        return self.auth.is_authenticated()
