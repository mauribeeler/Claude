"""
Xero Payroll API (UK) — employees, pay runs, payslips, timesheets, and leave.
Used for extracting wages data to allocate to jobs via Xero Projects.
"""

from xero_api.base import BaseAPI
from xero_api.config import XERO_PAYROLL_UK_URL


class PayrollAPI(BaseAPI):
    """Access Xero Payroll UK endpoints for wages and employee data."""

    def __init__(self, auth):
        super().__init__(auth, XERO_PAYROLL_UK_URL)

    # -------------------------------------------------------------------------
    # Employees
    # -------------------------------------------------------------------------

    def get_employees(self, status: str = None) -> list:
        """
        Get all employees.

        Args:
            status: Filter by status — ACTIVE, TERMINATED.
        """
        params = {}
        if status:
            params["where"] = f'Status=="{status}"'
        return self._get("Employees", params).get("Employees", [])

    def get_employee(self, employee_id: str) -> dict:
        """Get a single employee by ID."""
        data = self._get(f"Employees/{employee_id}")
        employees = data.get("Employees", [])
        return employees[0] if employees else {}

    # -------------------------------------------------------------------------
    # Pay Runs
    # -------------------------------------------------------------------------

    def get_pay_runs(self, status: str = None) -> list:
        """
        Get pay runs.

        Args:
            status: Filter — DRAFT, POSTED.
        """
        params = {}
        if status:
            params["where"] = f'Status=="{status}"'
        return self._get("PayRuns", params).get("PayRuns", [])

    def get_pay_run(self, pay_run_id: str) -> dict:
        """Get a single pay run with payslip details."""
        data = self._get(f"PayRuns/{pay_run_id}")
        pay_runs = data.get("PayRuns", [])
        return pay_runs[0] if pay_runs else {}

    # -------------------------------------------------------------------------
    # Payslips
    # -------------------------------------------------------------------------

    def get_payslip(self, payslip_id: str) -> dict:
        """Get a single payslip with full earnings/deductions breakdown."""
        data = self._get(f"Payslips/{payslip_id}")
        payslips = data.get("Payslips", [])
        return payslips[0] if payslips else {}

    # -------------------------------------------------------------------------
    # Timesheets
    # -------------------------------------------------------------------------

    def get_timesheets(self, employee_id: str = None, status: str = None) -> list:
        """
        Get timesheets.

        Args:
            employee_id: Filter by employee UUID.
            status: Filter — DRAFT, APPROVED, COMPLETED.
        """
        params = {}
        where_clauses = []

        if employee_id:
            where_clauses.append(f'EmployeeID==Guid("{employee_id}")')
        if status:
            where_clauses.append(f'Status=="{status}"')

        if where_clauses:
            params["where"] = " AND ".join(where_clauses)

        return self._get("Timesheets", params).get("Timesheets", [])

    # -------------------------------------------------------------------------
    # Leave Applications
    # -------------------------------------------------------------------------

    def get_leave_applications(self, employee_id: str = None) -> list:
        """Get leave applications, optionally filtered by employee."""
        params = {}
        if employee_id:
            params["where"] = f'EmployeeID==Guid("{employee_id}")'
        return self._get("LeaveApplications", params).get("LeaveApplications", [])

    # -------------------------------------------------------------------------
    # Pay Items (earnings types, deduction types, etc.)
    # -------------------------------------------------------------------------

    def get_pay_items(self) -> dict:
        """Get all pay item types (earnings rates, deduction types, etc.)."""
        return self._get("PayItems")

    # -------------------------------------------------------------------------
    # Settings
    # -------------------------------------------------------------------------

    def get_settings(self) -> dict:
        """Get payroll settings (pay calendars, categories, etc.)."""
        return self._get("Settings")

    def get_calendars(self) -> list:
        """Get payroll calendars."""
        return self._get("Calendars").get("Calendars", [])
