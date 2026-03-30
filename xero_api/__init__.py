"""
Xero API Integration for Bohemia Canvas
========================================
Python client for Xero Accounting, Projects, and Payroll APIs.
Focused on data extraction, reporting, and cost analysis.

Usage:
    from xero_api import XeroClient

    client = XeroClient()
    client.authenticate()

    # Get all invoices
    invoices = client.accounting.get_invoices()

    # Get P&L report
    pnl = client.accounting.get_profit_and_loss()

    # Get all projects
    projects = client.projects.get_projects()
"""

from xero_api.client import XeroClient

__all__ = ["XeroClient"]
__version__ = "1.0.0"
