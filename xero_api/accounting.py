"""
Xero Accounting API — invoices, bills, contacts, journals, bank transactions, and reports.
"""

from xero_api.base import BaseAPI
from xero_api.config import XERO_ACCOUNTING_URL


class AccountingAPI(BaseAPI):
    """Access Xero Accounting endpoints for financial data extraction and reporting."""

    def __init__(self, auth):
        super().__init__(auth, XERO_ACCOUNTING_URL)

    # -------------------------------------------------------------------------
    # Invoices
    # -------------------------------------------------------------------------

    def get_invoices(self, status: str = None, date_from: str = None, date_to: str = None,
                     contact_id: str = None, page: int = None) -> list:
        """
        Get invoices with optional filters.

        Args:
            status: Filter by status — DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED.
            date_from: Filter invoices dated on or after (YYYY-MM-DD).
            date_to: Filter invoices dated on or before (YYYY-MM-DD).
            contact_id: Filter by contact UUID.
            page: Page number (100 per page). If None, fetches all pages.
        """
        params = {}
        where_clauses = []

        if status:
            where_clauses.append(f'Status=="{status}"')
        if date_from:
            where_clauses.append(f'Date>=DateTime({_xero_date(date_from)})')
        if date_to:
            where_clauses.append(f'Date<=DateTime({_xero_date(date_to)})')
        if contact_id:
            where_clauses.append(f'Contact.ContactID==Guid("{contact_id}")')

        if where_clauses:
            params["where"] = " AND ".join(where_clauses)

        if page is not None:
            params["page"] = page
            return self._get("Invoices", params).get("Invoices", [])

        return self._get_all("Invoices", params)

    def get_invoice(self, invoice_id: str) -> dict:
        """Get a single invoice by ID."""
        data = self._get(f"Invoices/{invoice_id}")
        invoices = data.get("Invoices", [])
        return invoices[0] if invoices else {}

    # -------------------------------------------------------------------------
    # Bills (Accounts Payable invoices where Type == ACCPAY)
    # -------------------------------------------------------------------------

    def get_bills(self, status: str = None, date_from: str = None, date_to: str = None) -> list:
        """Get bills (supplier invoices). Same structure as invoices but Type=ACCPAY."""
        params = {}
        where_clauses = ['Type=="ACCPAY"']

        if status:
            where_clauses.append(f'Status=="{status}"')
        if date_from:
            where_clauses.append(f'Date>=DateTime({_xero_date(date_from)})')
        if date_to:
            where_clauses.append(f'Date<=DateTime({_xero_date(date_to)})')

        params["where"] = " AND ".join(where_clauses)
        return self._get_all("Invoices", params)

    # -------------------------------------------------------------------------
    # Contacts
    # -------------------------------------------------------------------------

    def get_contacts(self, is_customer: bool = None, is_supplier: bool = None,
                     search: str = None) -> list:
        """Get contacts with optional filters."""
        params = {}
        where_clauses = []

        if is_customer is not None:
            where_clauses.append(f"IsCustomer=={str(is_customer).lower()}")
        if is_supplier is not None:
            where_clauses.append(f"IsSupplier=={str(is_supplier).lower()}")
        if search:
            params["searchTerm"] = search

        if where_clauses:
            params["where"] = " AND ".join(where_clauses)

        return self._get_all("Contacts", params)

    def get_contact(self, contact_id: str) -> dict:
        """Get a single contact by ID."""
        data = self._get(f"Contacts/{contact_id}")
        contacts = data.get("Contacts", [])
        return contacts[0] if contacts else {}

    # -------------------------------------------------------------------------
    # Bank Transactions
    # -------------------------------------------------------------------------

    def get_bank_transactions(self, date_from: str = None, date_to: str = None,
                              bank_account_id: str = None) -> list:
        """Get bank transactions with optional filters."""
        params = {}
        where_clauses = []

        if date_from:
            where_clauses.append(f'Date>=DateTime({_xero_date(date_from)})')
        if date_to:
            where_clauses.append(f'Date<=DateTime({_xero_date(date_to)})')
        if bank_account_id:
            where_clauses.append(f'BankAccount.AccountID==Guid("{bank_account_id}")')

        if where_clauses:
            params["where"] = " AND ".join(where_clauses)

        return self._get_all("BankTransactions", params)

    # -------------------------------------------------------------------------
    # Journals
    # -------------------------------------------------------------------------

    def get_journals(self, offset: int = 0) -> list:
        """Get manual journals. Offset is the journal number to start from."""
        params = {"offset": offset}
        return self._get("Journals", params).get("Journals", [])

    def get_manual_journals(self) -> list:
        """Get all manual journals."""
        return self._get_all("ManualJournals")

    # -------------------------------------------------------------------------
    # Accounts (Chart of Accounts)
    # -------------------------------------------------------------------------

    def get_accounts(self, account_type: str = None) -> list:
        """Get chart of accounts, optionally filtered by type (REVENUE, EXPENSE, etc.)."""
        params = {}
        if account_type:
            params["where"] = f'Type=="{account_type}"'
        return self._get("Accounts", params).get("Accounts", [])

    # -------------------------------------------------------------------------
    # Tracking Categories (used for regions, cost centres, etc.)
    # -------------------------------------------------------------------------

    def get_tracking_categories(self) -> list:
        """Get all tracking categories and their options."""
        return self._get("TrackingCategories").get("TrackingCategories", [])

    # -------------------------------------------------------------------------
    # Reports — P&L, Balance Sheet, Trial Balance, Budget Summary
    # -------------------------------------------------------------------------

    def get_profit_and_loss(self, from_date: str = None, to_date: str = None,
                            tracking_category_id: str = None,
                            tracking_option_id: str = None,
                            periods: int = None, timeframe: str = None) -> dict:
        """
        Get Profit and Loss report.

        Args:
            from_date: Start date (YYYY-MM-DD).
            to_date: End date (YYYY-MM-DD).
            tracking_category_id: Filter by tracking category.
            tracking_option_id: Filter by tracking option (e.g. a specific region).
            periods: Number of periods to compare.
            timeframe: MONTH, QUARTER, or YEAR.
        """
        params = {}
        if from_date:
            params["fromDate"] = from_date
        if to_date:
            params["toDate"] = to_date
        if tracking_category_id:
            params["trackingCategoryID"] = tracking_category_id
        if tracking_option_id:
            params["trackingOptionID"] = tracking_option_id
        if periods:
            params["periods"] = periods
        if timeframe:
            params["timeframe"] = timeframe

        return self._get("Reports/ProfitAndLoss", params)

    def get_balance_sheet(self, date: str = None, tracking_category_id: str = None,
                          tracking_option_id: str = None) -> dict:
        """Get Balance Sheet report."""
        params = {}
        if date:
            params["date"] = date
        if tracking_category_id:
            params["trackingCategoryID"] = tracking_category_id
        if tracking_option_id:
            params["trackingOptionID"] = tracking_option_id

        return self._get("Reports/BalanceSheet", params)

    def get_trial_balance(self, date: str = None) -> dict:
        """Get Trial Balance report."""
        params = {}
        if date:
            params["date"] = date
        return self._get("Reports/TrialBalance", params)

    def get_budget_summary(self, date_from: str = None, date_to: str = None,
                           periods: int = None) -> dict:
        """Get Budget Summary report."""
        params = {}
        if date_from:
            params["dateFrom"] = date_from
        if date_to:
            params["dateTo"] = date_to
        if periods:
            params["periods"] = periods
        return self._get("Reports/BudgetSummary", params)

    def get_aged_receivables(self, date: str = None, contact_id: str = None) -> dict:
        """Get Aged Receivables report."""
        params = {}
        if date:
            params["date"] = date
        if contact_id:
            params["contactID"] = contact_id
        return self._get("Reports/AgedReceivablesByContact", params)

    def get_aged_payables(self, date: str = None, contact_id: str = None) -> dict:
        """Get Aged Payables report."""
        params = {}
        if date:
            params["date"] = date
        if contact_id:
            params["contactID"] = contact_id
        return self._get("Reports/AgedPayablesByContact", params)

    # -------------------------------------------------------------------------
    # Credit Notes
    # -------------------------------------------------------------------------

    def get_credit_notes(self, status: str = None) -> list:
        """Get credit notes, optionally filtered by status."""
        params = {}
        if status:
            params["where"] = f'Status=="{status}"'
        return self._get_all("CreditNotes", params)

    # -------------------------------------------------------------------------
    # Payments
    # -------------------------------------------------------------------------

    def get_payments(self, date_from: str = None, date_to: str = None) -> list:
        """Get payments with optional date filters."""
        params = {}
        where_clauses = []

        if date_from:
            where_clauses.append(f'Date>=DateTime({_xero_date(date_from)})')
        if date_to:
            where_clauses.append(f'Date<=DateTime({_xero_date(date_to)})')

        if where_clauses:
            params["where"] = " AND ".join(where_clauses)

        return self._get_all("Payments", params)

    # -------------------------------------------------------------------------
    # Organisation
    # -------------------------------------------------------------------------

    def get_organisation(self) -> dict:
        """Get organisation details."""
        data = self._get("Organisation")
        orgs = data.get("Organisations", [])
        return orgs[0] if orgs else {}


def _xero_date(date_str: str) -> str:
    """Convert YYYY-MM-DD to Xero DateTime format: year,month,day."""
    parts = date_str.split("-")
    return f"{parts[0]},{parts[1]},{parts[2]}"
