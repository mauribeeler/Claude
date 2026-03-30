"""
Xero Projects API — projects, tasks, time entries, and project expenses.
Critical for job costing and profitability analysis at Bohemia Canvas.
"""

from xero_api.base import BaseAPI
from xero_api.config import XERO_PROJECTS_URL


class ProjectsAPI(BaseAPI):
    """Access Xero Projects for job-level cost tracking and profitability."""

    def __init__(self, auth):
        super().__init__(auth, XERO_PROJECTS_URL)

    # -------------------------------------------------------------------------
    # Projects
    # -------------------------------------------------------------------------

    def get_projects(self, status: str = None) -> list:
        """
        Get all projects.

        Args:
            status: Filter by status — INPROGRESS, CLOSED, or PENDING.
        """
        params = {}
        if status:
            params["states"] = status
        return self._get_all_projects("Projects", params)

    def get_project(self, project_id: str) -> dict:
        """Get a single project by ID with full details."""
        return self._get(f"Projects/{project_id}")

    # -------------------------------------------------------------------------
    # Tasks
    # -------------------------------------------------------------------------

    def get_tasks(self, project_id: str) -> list:
        """Get all tasks for a project."""
        return self._get_all_projects(f"Projects/{project_id}/Tasks")

    def get_task(self, project_id: str, task_id: str) -> dict:
        """Get a single task."""
        return self._get(f"Projects/{project_id}/Tasks/{task_id}")

    # -------------------------------------------------------------------------
    # Time Entries
    # -------------------------------------------------------------------------

    def get_time_entries(self, project_id: str, user_id: str = None,
                         date_from: str = None, date_to: str = None) -> list:
        """
        Get time entries for a project.

        Args:
            project_id: The project UUID.
            user_id: Filter by user UUID.
            date_from: Filter from date (YYYY-MM-DD).
            date_to: Filter to date (YYYY-MM-DD).
        """
        params = {}
        if user_id:
            params["userId"] = user_id
        if date_from:
            params["dateAfterUtc"] = f"{date_from}T00:00:00Z"
        if date_to:
            params["dateBeforeUtc"] = f"{date_to}T23:59:59Z"

        return self._get_all_projects(f"Projects/{project_id}/Time", params)

    # -------------------------------------------------------------------------
    # Project Users
    # -------------------------------------------------------------------------

    def get_project_users(self) -> list:
        """Get all users available for projects."""
        return self._get_all_projects("ProjectsUsers")

    # -------------------------------------------------------------------------
    # Pagination helper (Projects API uses different pagination than Accounting)
    # -------------------------------------------------------------------------

    def _get_all_projects(self, endpoint: str, params: dict = None) -> list:
        """
        Paginate through Projects API results.
        Projects API uses pageSize and page parameters.
        """
        all_items = []
        page = 1
        page_size = 50
        params = dict(params or {})
        params["pageSize"] = page_size

        while True:
            params["page"] = page
            data = self._get(endpoint, params)

            # Projects API may return items directly as a list or nested
            if isinstance(data, list):
                items = data
            elif "items" in data:
                items = data["items"]
            else:
                # Find the list in the response
                items = None
                for value in data.values():
                    if isinstance(value, list):
                        items = value
                        break
                if items is None:
                    break

            if not items:
                break

            all_items.extend(items)

            if len(items) < page_size:
                break

            page += 1

        return all_items
