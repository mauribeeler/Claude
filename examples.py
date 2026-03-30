"""
Xero API Usage Examples — Bohemia Canvas
=========================================
Practical examples for extracting data and generating reports.

Setup:
    1. Copy .env.example to .env and add your Xero credentials
    2. pip install -r requirements.txt
    3. python examples.py
"""

from xero_api import XeroClient
from xero_api.reports import ReportBuilder


def main():
    # Initialise client
    client = XeroClient()

    # Authenticate (opens browser on first run, then uses stored tokens)
    if not client.is_authenticated():
        print("First-time setup — authenticating with Xero...")
        client.authenticate()
    else:
        print("Using stored Xero credentials.")

    # Set up the report builder for high-level reports
    reports = ReportBuilder(client)

    # -------------------------------------------------------------------------
    # 1. Organisation Info
    # -------------------------------------------------------------------------
    print("\n--- Organisation ---")
    org = client.accounting.get_organisation()
    print(f"Connected to: {org.get('Name', 'Unknown')}")
    print(f"Base currency: {org.get('BaseCurrency', 'GBP')}")

    # -------------------------------------------------------------------------
    # 2. Profit & Loss — Current Season
    # -------------------------------------------------------------------------
    print("\n--- P&L: 2025 Summer Season ---")
    pnl = client.accounting.get_profit_and_loss(
        from_date="2025-04-15",
        to_date="2025-10-15",
    )
    print_report(pnl)

    # -------------------------------------------------------------------------
    # 3. Season Comparison (YoY)
    # -------------------------------------------------------------------------
    print("\n--- Season Comparison: 2024 vs 2025 ---")
    comparison = reports.season_comparison(2024, 2025)
    for year, data in comparison.items():
        if year == "change":
            print(f"  YoY Change: Income {data['income_change_pct']:+.1f}%, Profit {data['profit_change_pct']:+.1f}%")
        else:
            print(f"  {year}: Income {data['total_income']:,.2f} | Expenses {data['total_expenses']:,.2f} | Net {data['net_profit']:,.2f}")

    # -------------------------------------------------------------------------
    # 4. Project Profitability — Worst Performers First
    # -------------------------------------------------------------------------
    print("\n--- Project Profitability (sorted by margin %) ---")
    project_summary = reports.project_profitability_summary()
    print(f"{'Project':<40} {'Invoiced':>12} {'Cost':>12} {'Margin':>12} {'%':>6}")
    print("-" * 85)
    for p in project_summary[:20]:  # Top 20
        print(f"{p['name']:<40} {p['total_invoiced']:>12,.2f} {p['total_cost']:>12,.2f} {p['margin']:>12,.2f} {p['margin_pct']:>5.1f}%")

    # -------------------------------------------------------------------------
    # 5. Invoices — Last 30 Days
    # -------------------------------------------------------------------------
    print("\n--- Recent Invoices (last 30 days) ---")
    from datetime import datetime, timedelta
    date_from = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    invoices = client.accounting.get_invoices(date_from=date_from)
    for inv in invoices[:10]:
        contact = inv.get("Contact", {}).get("Name", "Unknown")
        total = inv.get("Total", 0)
        status = inv.get("Status", "")
        print(f"  {contact:<30} {total:>10,.2f}  [{status}]")
    print(f"  ... {len(invoices)} invoices total")

    # -------------------------------------------------------------------------
    # 6. Aged Receivables
    # -------------------------------------------------------------------------
    print("\n--- Aged Receivables ---")
    aged = client.accounting.get_aged_receivables()
    print_report(aged)

    # -------------------------------------------------------------------------
    # 7. Tracking Categories (regions, cost centres)
    # -------------------------------------------------------------------------
    print("\n--- Tracking Categories ---")
    categories = client.accounting.get_tracking_categories()
    for cat in categories:
        options = [o["Name"] for o in cat.get("Options", [])]
        print(f"  {cat['Name']}: {', '.join(options)}")

    # -------------------------------------------------------------------------
    # 8. Active Employees
    # -------------------------------------------------------------------------
    print("\n--- Active Employees ---")
    employees = client.payroll.get_employees(status="ACTIVE")
    for emp in employees:
        name = f"{emp.get('FirstName', '')} {emp.get('LastName', '')}"
        print(f"  {name}")
    print(f"  Total active: {len(employees)}")

    # -------------------------------------------------------------------------
    # 9. Revenue by Month
    # -------------------------------------------------------------------------
    print("\n--- Monthly Revenue 2025 ---")
    monthly = reports.revenue_by_month(2025)
    for month, amount in monthly.items():
        print(f"  {month:<20} {amount:>12,.2f}")

    print("\nDone!")


def print_report(report_data: dict):
    """Simple helper to print a Xero report."""
    reports = report_data.get("Reports", [])
    if not reports:
        print("  No report data.")
        return

    report = reports[0]
    print(f"  {report.get('ReportName', 'Report')}")
    for row in report.get("Rows", []):
        title = row.get("Title", "")
        if title:
            print(f"\n  {title}")
        for sub_row in row.get("Rows", []):
            cells = sub_row.get("Cells", [])
            values = [c.get("Value", "") for c in cells]
            print(f"    {values[0]:<40} {' | '.join(values[1:])}")


if __name__ == "__main__":
    main()
