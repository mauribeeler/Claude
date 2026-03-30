"""
High-level reporting helpers for Bohemia Canvas.
Combines data from Accounting, Projects, and Payroll APIs
to produce the reports Mario needs most.
"""

from datetime import datetime


class ReportBuilder:
    """
    Pre-built reports tailored to Bohemia Canvas operations.
    Uses the XeroClient to pull and combine data.
    """

    def __init__(self, client):
        self.client = client

    # -------------------------------------------------------------------------
    # Revenue Analysis
    # -------------------------------------------------------------------------

    def revenue_by_month(self, year: int) -> dict:
        """
        Get monthly revenue breakdown for a given year using P&L reports.
        Returns dict: {month_name: revenue_amount}.
        """
        pnl = self.client.accounting.get_profit_and_loss(
            from_date=f"{year}-01-01",
            to_date=f"{year}-12-31",
            periods=11,
            timeframe="MONTH",
        )
        return _extract_report_rows(pnl, section_title="Income")

    def revenue_year_on_year(self, years: list[int]) -> dict:
        """
        Compare total revenue across multiple years.
        Returns dict: {year: total_revenue}.
        """
        results = {}
        for year in years:
            pnl = self.client.accounting.get_profit_and_loss(
                from_date=f"{year}-01-01",
                to_date=f"{year}-12-31",
            )
            total = _extract_total(pnl, "Total Income")
            results[year] = total
        return results

    # -------------------------------------------------------------------------
    # Project Profitability
    # -------------------------------------------------------------------------

    def project_profitability_summary(self, status: str = None) -> list[dict]:
        """
        Get profitability summary for all projects.
        Returns list of dicts with project name, total invoiced, total cost, and margin.
        """
        projects = self.client.projects.get_projects(status=status)
        summary = []

        for project in projects:
            total_invoiced = _safe_float(project.get("totalInvoiced", {}).get("value", 0))
            total_cost = (
                _safe_float(project.get("totalExpense", {}).get("value", 0))
                + _safe_float(project.get("totalTimeCost", {}).get("value", 0))
            )
            margin = total_invoiced - total_cost
            margin_pct = (margin / total_invoiced * 100) if total_invoiced else 0

            summary.append({
                "project_id": project.get("projectId", ""),
                "name": project.get("name", "Unknown"),
                "status": project.get("status", ""),
                "total_invoiced": total_invoiced,
                "total_cost": total_cost,
                "margin": margin,
                "margin_pct": round(margin_pct, 1),
                "deadline": project.get("deadlineUtc", ""),
            })

        # Sort by margin % ascending so worst performers are at the top
        summary.sort(key=lambda x: x["margin_pct"])
        return summary

    def project_cost_breakdown(self, project_id: str) -> dict:
        """
        Get detailed cost breakdown for a single project.
        Combines time entries, tasks, and expenses.
        """
        project = self.client.projects.get_project(project_id)
        tasks = self.client.projects.get_tasks(project_id)
        time_entries = self.client.projects.get_time_entries(project_id)

        total_hours = sum(
            _safe_float(t.get("duration", 0)) / 60
            for t in time_entries
        )
        total_time_cost = sum(
            _safe_float(t.get("cost", {}).get("value", 0))
            for t in time_entries
        )

        return {
            "project_name": project.get("name", ""),
            "status": project.get("status", ""),
            "total_invoiced": _safe_float(project.get("totalInvoiced", {}).get("value", 0)),
            "total_expense": _safe_float(project.get("totalExpense", {}).get("value", 0)),
            "total_time_cost": total_time_cost,
            "total_hours": round(total_hours, 1),
            "tasks": [
                {
                    "name": t.get("name", ""),
                    "status": t.get("status", ""),
                    "estimated_minutes": t.get("estimateMinutes", 0),
                    "actual_minutes": t.get("totalMinutes", 0),
                    "cost": _safe_float(t.get("totalAmount", {}).get("value", 0)),
                }
                for t in tasks
            ],
            "time_entry_count": len(time_entries),
        }

    # -------------------------------------------------------------------------
    # Season Comparison
    # -------------------------------------------------------------------------

    def season_comparison(self, year1: int, year2: int,
                          season_start: str = "04-15", season_end: str = "10-15") -> dict:
        """
        Compare two summer seasons side by side.

        Args:
            year1: First year to compare.
            year2: Second year to compare.
            season_start: Season start as MM-DD (default mid-April).
            season_end: Season end as MM-DD (default mid-October).
        """
        results = {}
        for year in [year1, year2]:
            from_date = f"{year}-{season_start}"
            to_date = f"{year}-{season_end}"
            pnl = self.client.accounting.get_profit_and_loss(
                from_date=from_date, to_date=to_date
            )
            results[year] = {
                "period": f"{from_date} to {to_date}",
                "total_income": _extract_total(pnl, "Total Income"),
                "total_expenses": _extract_total(pnl, "Total Operating Expenses"),
                "net_profit": _extract_total(pnl, "Net Profit"),
            }

        # Calculate YoY changes
        if results.get(year1, {}).get("total_income") and results.get(year2, {}).get("total_income"):
            y1_income = results[year1]["total_income"]
            y2_income = results[year2]["total_income"]
            results["change"] = {
                "income_change_pct": round((y2_income - y1_income) / y1_income * 100, 1) if y1_income else 0,
                "profit_change_pct": round(
                    (results[year2]["net_profit"] - results[year1]["net_profit"])
                    / abs(results[year1]["net_profit"]) * 100, 1
                ) if results[year1]["net_profit"] else 0,
            }

        return results

    # -------------------------------------------------------------------------
    # Payroll Summary
    # -------------------------------------------------------------------------

    def payroll_cost_summary(self) -> dict:
        """Get summary of active employees and recent pay run totals."""
        employees = self.client.payroll.get_employees(status="ACTIVE")
        pay_runs = self.client.payroll.get_pay_runs(status="POSTED")

        # Get the most recent pay runs (last 4)
        recent_runs = sorted(
            pay_runs,
            key=lambda r: r.get("PayRunPeriodEndDate", ""),
            reverse=True,
        )[:4]

        return {
            "active_employees": len(employees),
            "recent_pay_runs": [
                {
                    "period_end": r.get("PayRunPeriodEndDate", ""),
                    "total_pay": _safe_float(r.get("Wages", 0)),
                    "total_tax": _safe_float(r.get("Tax", 0)),
                    "status": r.get("PayRunStatus", ""),
                }
                for r in recent_runs
            ],
        }


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _safe_float(value) -> float:
    """Safely convert a value to float."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _extract_report_rows(report_data: dict, section_title: str) -> dict:
    """Extract row data from a Xero report response for a given section."""
    results = {}
    reports = report_data.get("Reports", [])
    if not reports:
        return results

    report = reports[0]
    for row in report.get("Rows", []):
        if row.get("Title") == section_title:
            for sub_row in row.get("Rows", []):
                cells = sub_row.get("Cells", [])
                if len(cells) >= 2:
                    label = cells[0].get("Value", "")
                    value = _safe_float(cells[-1].get("Value", 0))
                    results[label] = value
    return results


def _extract_total(report_data: dict, row_title: str) -> float:
    """Extract a total value from a Xero report by row title."""
    reports = report_data.get("Reports", [])
    if not reports:
        return 0.0

    report = reports[0]
    for row in report.get("Rows", []):
        for sub_row in row.get("Rows", []):
            cells = sub_row.get("Cells", [])
            if cells and cells[0].get("Value") == row_title:
                return _safe_float(cells[-1].get("Value", 0))
        # Check section-level totals too
        if row.get("RowType") == "SummaryRow":
            cells = row.get("Cells", [])
            if cells and cells[0].get("Value") == row_title:
                return _safe_float(cells[-1].get("Value", 0))
    return 0.0
