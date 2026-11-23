# Pi ClickUp Extension

Global [Pi](https://pi.dev) tools for direct, full-control access to ClickUp's Public API without depending on MCP.

The extension reads ClickUp's official OpenAPI specifications at runtime. It currently exposes all **172 documented operations** across API v2 and v3 through two generic tools instead of maintaining a large, fragile set of endpoint wrappers, plus a credential-free attachment downloader.

## Tools

### `clickup_docs`

Searches the official ClickUp v2 and v3 OpenAPI specifications by operation ID, path, category, or phrase. Exact matches return parameters and the resolved request-body schema.

### `clickup_api`

Calls any authenticated ClickUp API v2 or v3 endpoint with:

- GET, POST, PUT, PATCH, and DELETE
- Query parameters and arrays
- Arbitrary JSON request bodies
- Multipart file attachments
- 429 rate-limit handling
- Safe GET retries for transient 502/503/504 responses
- Cancellation and per-attempt timeouts
- 50 KB / 2,000-line output truncation
- Optional `paginate` for GET collections

DELETE requests and local-file uploads require interactive confirmation.

#### Pagination

`paginate: { max_pages?, max_items?, max_duration_ms? }` (defaults 5 / 500 / 60000; hard caps 20 / 5000 / 120000) fetches a collection across pages in one call. It is allowed only for GET operations whose official spec declares a `page` (v2, e.g. Get Tasks) or `cursor` (v3, e.g. Docs, Chat, attachments) query parameter; `start`/`start_id` comment paging is not supported. A supplied `query.page` must be a non-negative integer that stays within the safe integer range across `max_pages`. `paginate` on a non-GET call is rejected before any confirmation dialog, and the time budget covers the specification lookup as well as the page requests.

- v2 stops on `last_page: true`; only when `last_page` is absent does a shorter-than-previous or empty page stop it.
- v3 follows `next_cursor` and stops when it is missing, `null`, `""`, or repeats the cursor just used.
- A page is never partially merged. When a cap stops paging, `next_page` / `next_cursor` points at the first unmerged page so resuming skips nothing. A single first page larger than `max_items` is returned whole with `overflowed_by`.
- Items merge into the first array-of-objects property on page 1 (or the body itself when it is an array). The merged object keeps that array plus page 1's non-array fields; v2 `page` is set to the last page fetched and `last_page` to whether paging ended on `last_page: true`; cursors are removed.
- An error on the first page throws; a later error returns the partial merge with `stopped_by: "error"` and a fixed-wording `error` (HTTP status only, never status text or body).

The first line of the output is always a summary, so truncation cannot hide a partial result:

```text
[paginated pages=<int> items=<int> merged_field=<key|none> stopped_by=<reason>]
```

`merged_field` is shown as a bounded token (non `[A-Za-z0-9_.-]` characters percent-escaped, at most 64 characters then `…`); the exact key is in `details.paginated.merged_field`, alongside the rest of the record.

### `clickup_download`

Saves a ClickUp attachment URL to disk **without sending any credentials**. Parameters: `url`, optional `path`, `overwrite`, `max_bytes` (default 25 MB, cap 100 MB) and `timeout_ms` (default 30000, cap 120000). Returns `{ path, bytes, content_type }`, where `content_type` is the bare media type (parameters stripped) or `null` when malformed.

- Only `https` URLs on the default port, without userinfo, on `attachments.clickup.com`, `attachments-public.clickup.com`, `attachments2.clickup.com`, or `t<digits>.p.clickup-attachments.com`. Every other host, including `api.clickup.com`, is refused.
- Redirects are refused and reported by target host. A `401`/`403` means the URL needs credentials the extension will not send.
- `path` must resolve inside the working directory; without it the file goes into a new private temporary directory. Existing files and symlinks are refused unless `overwrite: true`. With `overwrite`, the body is staged in a `0600` sibling file and renamed over the destination (replacing a symlink itself, never its target) only after it was fully written, size-checked and not cancelled; overflow, abort or error leave the original untouched. Without it, the destination is created exclusively with mode `0600`. The verified destination directory is re-checked by identity immediately before every file operation, so a directory swapped after confirmation aborts the download.
- Errors report status and host only, never the response body or the signed query string.
- Every download requires interactive confirmation showing host, absolute destination and the overwrite flag.

## Requirements

- Node.js 22.19 or newer
- Pi 0.80.6 or newer
- A ClickUp personal API token

## Install

```bash
pi install git:github.com/umar-rana/pi-clickup-extension
```

Restart Pi or run `/reload` after installation.

For local development:

```bash
git clone https://github.com/umar-rana/pi-clickup-extension.git
cd pi-clickup-extension
npm install
pi -e ./index.ts
```

## Configure authentication securely

Generate a personal API token in ClickUp: **Avatar → Settings → Apps → API Token → Generate**. Personal use does not require ClickUp's OAuth access-token endpoint.

Never paste a ClickUp token into Pi, source code, issues, logs, screenshots, or commits. The extension does not include a token; every user supplies their own locally.

### macOS

Copy the token from ClickUp, then run:

```zsh
mkdir -p ~/.config/cu
pbpaste > ~/.config/cu/token
chmod 600 ~/.config/cu/token
: | pbcopy
```

The last command clears the clipboard. Verify owner-only permissions:

```zsh
ls -l ~/.config/cu/token
```

The permissions should begin with `-rw-------`.

### Linux with Bash

```bash
mkdir -p "$HOME/.config/cu"
read -r -s -p "ClickUp personal token: " clickup_token; echo
printf '%s' "$clickup_token" > "$HOME/.config/cu/token"
unset clickup_token
chmod 600 "$HOME/.config/cu/token"
```

### Token lookup order

1. `CLICKUP_API_TOKEN`
2. `CLICKUP_TOKEN`
3. `~/.config/cu/token`
4. Legacy fallback: `CLICKUP_API_KEY`

Environment variables are useful when supplied by a trusted secret manager. Do not commit them in `.env` files.

The token is sent only in the `Authorization` header to paths that resolve beneath:

- `https://api.clickup.com/api/v2/`
- `https://api.clickup.com/api/v3/`

Credentialed requests never follow redirects: a `3xx` from the API fails the call, so the token cannot be forwarded off `/api/v2|v3`. `clickup_download` never reads or sends the token.

## Usage

Ask Pi naturally:

```text
List my ClickUp workspaces.
Find the API operation for creating a task, then create it in list 123.
Show open tasks assigned to me across the workspace.
Attach ./report.pdf to task abc123.
Update this task's custom field.
Create a ClickUp Doc page from this Markdown.
List every open task in list 123.
Download the attachments on task abc123.
```

Pi should use `clickup_docs` when it does not know an endpoint's current request shape, then call `clickup_api`.

## API coverage

Coverage follows ClickUp's official specifications, including:

- Workspaces, Spaces, Folders, Lists, Tasks, subtasks, templates, and task relationships
- Comments, checklists, tags, custom fields, custom task types, members, guests, users, and groups
- Goals, views, time tracking, webhooks, attachments, and audit logs
- API v3 Docs, Chat, privacy/access controls, task moves, and per-user estimates

Availability still depends on the ClickUp Workspace plan and the authenticated user's permissions. ClickUp v3 Chat endpoints are experimental.

## Security model

- Fixed ClickUp API host and post-normalization v2/v3 path confinement
- Rejection of URL, query-string, fragment, and encoded traversal input in API paths
- No token logging or inclusion in tool output
- Interactive confirmation for DELETE, file uploads and attachment downloads
- Attachment downloads are anonymous, allowlisted by host, redirect-free, size-capped and confined to the working directory or a private temporary directory
- Pagination never replays mutations and is bounded by page, item and time caps
- Mutating 5xx requests are not retried, preventing accidental duplicate writes
- ClickUp content is treated as untrusted data, not agent instructions
- Oversized responses are written to private temporary files with mode `0600`

This extension has full access to the ClickUp resources permitted by its token. Review requested mutations before approving them.

## Development

```bash
npm run verify
```

This runs strict TypeScript checking and the Node test suite.

Branch flow:

```text
development → staging → production
```

Authors do not merge their own changes. A separate reviewer approves and merges into `staging`; tested releases are then promoted to `production`.

## Documentation sources

- [ClickUp authentication](https://developer.clickup.com/docs/authentication)
- [ClickUp API reference](https://developer.clickup.com/reference)
- [ClickUp OpenAPI specifications](https://developer.clickup.com/docs/open-api-spec)
- [ClickUp rate limits](https://developer.clickup.com/docs/rate-limits)
