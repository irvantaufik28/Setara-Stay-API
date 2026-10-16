# AI chat

`POST /api/v1/admin/ai/chat` sends general questions to OpenRouter. It requires an authenticated admin session. Access to application data follows the caller's role permissions: dashboard requires `dashboard.view`; revenue and room performance require `reports.view_revenue`; reservations reporting requires `reports.view_reservations`; room status requires `rooms.view_numbers`; reservation views use their existing `reservations.view*` permissions; room types, room numbers, maintenance blocks, and prices/stocks use `rooms.view_types`, `rooms.view_numbers`, and `prices_stocks.view` respectively; master data and reservation settings require `master.view`; cancellation policies, campaigns, and experiences require their corresponding `.view` permissions. Configured OpenRouter models are tried in priority order. The model that answers is returned as `modelUsed`. Model IDs may be free or paid.

Request:

```json
{ "message": "Halo" }
```

Success (`200`):

```json
{
  "answer": "...",
  "modelUsed": "...",
  "dataSource": "model",
  "conversationId": "uuid",
  "userMessage": { "id": "uuid", "role": "user", "content": "Halo", "modelUsed": null, "dataSource": null, "createdAt": "..." },
  "assistantMessage": { "id": "uuid", "role": "assistant", "content": "...", "modelUsed": "...", "dataSource": "model", "createdAt": "..." }
}
```

Pass `conversationId` with the next message to append to that conversation. Omit it to create a new conversation. The ID must belong to the authenticated user; an unknown or other user's ID returns `404 NOT_FOUND`. For short follow-up questions, the server may include at most two recent user questions (each capped at 180 characters) to resolve references. It never reuses prior answers as current facts; authorized data tools are called again. The question and answer are inserted atomically only after the model succeeds, so failed attempts do not create incomplete exchanges.

`GET /api/v1/admin/ai/conversations?offset=0&limit=50` returns `{ items, hasMore }` for the logged-in user, newest first. Each item has `id`, `title`, `createdAt`, and `updatedAt`. `GET /api/v1/admin/ai/conversations/:id?limit=50` returns `{ conversation, messages, hasMore, nextBefore }` with the latest messages in chronological order. Pass `before=<nextBefore>` to load older messages. Both endpoints require authentication and return `Cache-Control: no-store`; conversation ownership is checked on every read.

`DELETE /api/v1/admin/ai/conversations/:id` permanently removes one conversation and its messages for the authenticated owner. It returns `204` with no body, or `404 NOT_FOUND` if the ID is unknown or belongs to another user. No additional role permission is required beyond authentication because a user can delete only their own chat history. Deletion does not revoke any CSV file already downloaded.

General questions go directly to the model without tools. Questions requesting actual hotel revenue are routed to the read-only report tool automatically and require a model that supports tool calling:

```json
{ "message": "Berapa pendapatan bulan ini dibanding bulan lalu?" }
```

For those questions, `dataSource` is `revenue_report`. The tool can request totals, breakdowns by booking source or payment method, or reservation rows. Row data is paged at 50 per tool call; all report filters supported by the existing revenue API are available. Current room-status questions use `room_status`:

```json
{ "message": "Berapa kamar yang sedang cleaning?" }
```

The room-status tool returns current operational status counts and at most 100 matching physical room numbers, optionally filtered by room number, room type name, or status. It counts active rooms by default and can query inactive rooms explicitly. It never returns guest or reservation data. It does not answer future-date availability.

Dashboard questions use `dataSource: "dashboard"` and share the exact calculation service behind `GET /api/v1/admin/dashboard`. The model can request one section (`summary`, `today_activity`, `recent_reservations`, or `today_availability`) or `all` for a full overview:

```json
{ "message": "Ringkas dashboard operasional hari ini" }
```

Reservations reporting uses `dataSource: "reservations_report"` with `summary`, `financial`, `items`, or `all`. Rows are paged at 50 per call. Requests for arrivals in the next seven days use check-in dates from the current Jakarta date through six days later, inclusive. Room performance uses `dataSource: "room_performance_report"` and reads the existing seven-day actual or projected report:

```json
{ "message": "Berapa total reservasi bulan ini?" }
```

```json
{ "message": "Bagaimana okupansi dan ARR kamar minggu ini?" }
```

Reservation questions use `dataSource: "reservations"`. The read-only tool accesses the existing admin GET routes for list, detail, history, arrivals today, in-house, departures today, and room rack. The list view now accepts `roomAssignment=unassigned` to find reservations with at least one room lacking a physical room number; without a status filter this includes all reservation statuses. Each internal request repeats the same bearer authentication and route-level permission check. List views are paged at 50 per call. The model cannot choose an arbitrary URL or HTTP method:

```json
{ "message": "Cari reservasi atas nama Budi dan tampilkan statusnya" }
```

Room catalog and inventory questions use `dataSource: "room_catalog"`. The tool reads existing admin GET views for room types, room numbers, maintenance blocks, and prices/stocks, with the same bearer token and route-level permission checks. Room type and number lists are paged at up to 100 rows; prices/stocks is paged at up to 30 dates. Maintenance requires a range of 1–366 nights; prices/stocks accepts one date or a range of up to 366 inclusive dates and a room type ID or name. Stock without a date defaults to today in Jakarta. The `prices_stocks_all` view reads stock for all active room types on one date. Name resolution is internal, while stock access still requires `prices_stocks.view`; ambiguous names are not guessed. The model cannot choose an arbitrary URL or HTTP method:

```json
{ "message": "Tampilkan harga dan stok tipe kamar Deluxe untuk minggu depan" }
```

```json
{ "message": "Cek stok semua kamar tanggal 20" }
```

Master-data questions use `dataSource: "master_data"`. The tool reads one master category (`amenities`, `bed-types`, `meal-types`, `room-view-types`, `floor`, `experience-categories`, `ota-channels`, `payment-methods`, or `cancellation-policy-types`), capacity patterns, or reservation settings through their existing admin GET routes. The original bearer token is forwarded so the route repeats its `master.view` check. Master item lists include inactive rows; this tool does not edit settings or master data:

```json
{ "message": "Apa saja metode pembayaran yang terdaftar?" }
```

Cancellation policy, campaign, and experience questions use `dataSource: "commercial_data"`. The tool reads their existing admin GET list and detail routes with the caller's bearer token and route-level permission check (`cancellation_policies.view`, `campaigns.view`, or `experiences.view`). Lists are paginated at up to 100 items per call. It cannot edit these records or choose an arbitrary URL:

```json
{ "message": "Tampilkan campaign aktif untuk website" }
```

Guest questions use `dataSource: "guests"` for list, detail, and stay history. The list requires `guests.view`; detail requires both `guests.view` and `guests.view_stay_history`; stay history requires `guests.view_stay_history`. Payment questions use `dataSource: "payments"` for the payment overview, transactions, refunds, and outstanding, all requiring `payments.view`. Both use the existing GET routes and paginated results:

```json
{ "message": "Cari tamu Budi dan tampilkan riwayat menginapnya" }
```

```json
{ "message": "Tampilkan transaksi pembayaran yang gagal bulan ini" }
```

User and role questions use `dataSource: "admin_users"`. Your own profile only needs authentication. Lists and details of other users, roles, and permissions require `master.view` and the existing Owner guard. `GET /api/v1/admin/users/:id` provides a read-only user detail with the same Owner restriction as the users list. The AI returns no password hashes. Lists are filtered and paginated before being sent to the model:

```json
{ "message": "Tampilkan profil pengguna bernama Taufik" }
```

`POST /api/v1/admin/ai/export` accepts `{ "message": "...", "conversationId": "optional-uuid" }` and responds with a UTF-8 CSV download, not a chat JSON answer. If `conversationId` is omitted, the server creates a new conversation. Successful exports store the request and a short status message in that user's chat history, but not the CSV contents. The response includes `X-AI-Conversation-Id` and `X-Export-Row-Count` headers. For example:

```json
{ "message": "Export daftar tamu aktif ke CSV" }
```

The model selects one dataset and optional filters, but receives no exported records. The server reads only allowlisted admin GET routes using the caller's bearer token, so each route rechecks its normal permission and Owner restriction. Supported tabular datasets are reservations, reservation and revenue report rows, guests, payment overview/transactions/refunds/outstanding, room types/numbers/maintenance blocks/prices-stocks, cancellation policies, campaigns, experiences, users, roles, master items, capacity patterns, and reservation settings. A prices/stocks export needs a room type UUID and start/end dates; maintenance blocks need start/end dates; master items need a category. The download fails with `413 EXPORT_TOO_LARGE` rather than silently truncating above 10,000 rows or 20 MB. CSV cells are escaped against spreadsheet formulas. The endpoint is limited to two requests per minute per client. A failed export does not create a chat exchange.

For general conversation, `dataSource` is `model`.

The chat and export request bodies accept `message` (1–1000 characters) and optional `conversationId`. Most questions are processed independently; short contextual follow-ups receive only recent user questions, not prior model answers or tool results. The single-hotel database has no reservation-level hotel ID. For hotel revenue questions, revenue defaults to payment dates and means payments minus refunds. A question may explicitly request booking-date or check-in-date revenue instead. The AI report can query a requested date range or all-time data; row results are paged. One question can cause up to three read-only report calls per model attempt.

Errors use `{ "error": { "code": "...", "message": "..." } }`:

- `400`: invalid body
- `401`: no valid admin session
- `404`: conversation ID does not exist or belongs to another user
- `403`: the caller's role lacks the permission required by the requested data tool (`dashboard.view`, `reports.view_revenue`, `reports.view_reservations`, `rooms.view_types`, `rooms.view_numbers`, `prices_stocks.view`, `master.view`, `cancellation_policies.view`, `campaigns.view`, `experiences.view`, `guests.view`, `guests.view_stay_history`, `payments.view`, or the reservation view's permission); other-user and role views additionally require Owner
- `429`: more than 10 requests per minute from one client
- `503 AI_NOT_CONFIGURED`: missing OpenRouter configuration
- `503 AI_UNAVAILABLE`: all configured models failed to produce an answer

In development, `AI_UNAVAILABLE` also returns `diagnostics` with the attempt number, failed stage, safe reason, and HTTP status when available. The same fields appear in the API warning log. Model IDs, prompts, API keys, and provider response bodies are excluded from diagnostics.

To test manually, apply the generated migration `drizzle/0025_high_boomer.sql` in your deployment process, then start the API with `npm run dev` and obtain an access token from `POST /api/v1/admin/auth/login`. Send `POST /api/v1/admin/ai/chat` with `Authorization: Bearer <accessToken>` and `Content-Type: application/json`. Use its `conversationId` in a second chat request, then confirm both exchanges in `GET /api/v1/admin/ai/conversations/:id`. A different account must receive `404` for that ID and must not see it in its conversation list. Compare a dashboard answer with `GET /api/v1/admin/dashboard`. Compare a payment-date answer with `GET /api/v1/admin/reports/revenue?dateBy=payment&from=YYYY-MM-DD&to=YYYY-MM-DD` using the same date range and its `totals.netCollected` field. Compare reservations and room performance answers with `GET /api/v1/admin/reports/reservations` and `GET /api/v1/admin/reports/room-performance?from=YYYY-MM-DD`. Compare a reservation answer with the matching `GET /api/v1/admin/reservations` view. Compare room-status answers with `GET /api/v1/admin/room-numbers` using the same search or status filter. Compare catalog answers with `GET /api/v1/admin/room-types`, `GET /api/v1/admin/room-numbers`, `GET /api/v1/admin/room-maintenance-blocks`, or `GET /api/v1/admin/prices-stocks` using the same filters. Compare a master answer with `GET /api/v1/admin/master/payment-methods`, `GET /api/v1/admin/master/capacity-patterns`, or `GET /api/v1/admin/settings/reservations` as appropriate. Compare commercial answers with `GET /api/v1/admin/cancellation-policies`, `GET /api/v1/admin/campaigns`, or `GET /api/v1/admin/experiences` with matching filters. Compare guest, payment, and user answers with their matching GET endpoints. For CSV, send the same bearer header and JSON body to `POST /api/v1/admin/ai/export`, save the response as `.csv`, and check `X-Export-Row-Count` and `Content-Disposition`.

To verify deletion manually, create a conversation, call `DELETE /api/v1/admin/ai/conversations/:id` as its owner, and expect `204` without a body. The conversation must disappear from the list and a subsequent GET must return `404`; its messages are removed by the existing foreign-key cascade. A different user's DELETE for the same ID must return `404` and leave the owner's conversation intact.
