# Night audit MVP

An Owner or Manager sets the first required business date once. Close always processes the current business date and advances it by exactly one day. Dates cannot be skipped. Close is permitted only from 06:00 Asia/Jakarta on the next calendar day onward. Older overdue dates can be closed in order.

- `GET /api/v1/admin/night-audit/state` requires `night_audit.view`. It reports setup state, active date, time gate, and whether manual recovery is required.
- `POST /api/v1/admin/night-audit/setup` requires `night_audit.close` and an Owner or Manager. Body: `{ "startDate": "YYYY-MM-DD", "confirm": true }`. It is a one-time operation and is rejected when snapshots already exist without setup.
- `GET /api/v1/admin/night-audit/preview` requires `night_audit.view`. It returns blockers, warnings, summary, close time, and `previewToken` for the active date only.
- `POST /api/v1/admin/night-audit/close` requires `night_audit.close` and an Owner or Manager. Body: `{ "businessDate": "YYYY-MM-DD", "previewToken": "...", "confirm": true, "warningReason": "..." }`. `warningReason` is required when warnings exist.
- `GET /api/v1/admin/night-audit/history?page=1&limit=20` and `GET /api/v1/admin/night-audit/history/YYYY-MM-DD` require `night_audit.view` and return closed snapshots read-only.

Close rechecks the active date, time gate, and preview inside a transaction. Blockers, changed preview, duplicate close, or a skipped date return HTTP 409. No charges, reservation statuses, payments, or refunds are modified by this operation.

Apply migrations `0026_colorful_harpoon.sql` and `0027_jazzy_ultragirl.sql` manually before using the feature. Migration 0026 also grants permissions to existing Owner and Manager roles. Do not rerun the general seed on a live database to obtain these permissions.

If snapshot rows already exist without a setup row, state reports `recoveryReason: "missing_setup"`. When all existing snapshot dates are consecutive, an Owner or Manager may confirm setup using exactly the first closed date; existing snapshots remain untouched. They must first verify that no earlier date still needs an audit. Gaps or a start-date mismatch remain blocked with `recoveryReason: "date_gap"` or `"start_date_mismatch"` and require manual reconciliation. This MVP does not switch legacy dashboard, arrivals, departures, or check-out logic from calendar date to business date and does not prevent backdated postings after close. Its snapshot is a point-in-time record, not a full accounting lock.

## Manual checks on demo data

1. Set start date to day 1. Preview must show day 1. A close request for day 3 must return `BUSINESS_DATE_CHANGED`.
2. A close request for today's business date before 06:00 WIB tomorrow must return `AUDIT_TOO_EARLY`.
3. Resolve blockers, refresh preview, close day 1, then confirm state advances to day 2. Repeating the day 1 close must return HTTP 409.
4. Open day 1 from history and verify the stored numbers, warnings, reason, closer, and timestamp remain unchanged after later PMS activity.
5. If consecutive legacy snapshot rows exist without setup, state must report `recoveryReason: "missing_setup"`; setup using the first closed date must succeed without modifying those rows. An earlier or later start date must be rejected.
6. If legacy snapshots have a date gap, state must report `recoveryReason: "date_gap"`; setup and close must remain blocked without modifying those rows.
