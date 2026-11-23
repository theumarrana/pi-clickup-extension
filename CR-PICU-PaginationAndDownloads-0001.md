---
type: change-request
status: draft
created: 2026-11-22
updated: 2026-11-22
project: pi-clickup
author: pi session (drafter)
document_adversary: claude-code/claude-opus-5-5 (document review, rounds 1-3)
code_author: claude-code/claude-opus-5-5
code_reviewer_of_record: gpt-6.2-sol via Codex CLI (holds merge authority for this cycle)
---

# CR-PICU — Pagination and attachment download

## 1. Problem

`pi-clickup` already covers every documented operation through `clickup_docs` + `clickup_api`, so
endpoint coverage is not the gap. Two capability gaps remain, verified against the live
specifications and live responses on 2026-11-22:

1. **Collections are paginated and the extension cannot page.** `GetTasks` documents
   "Responses are limited to 100 tasks per page" with a `page` parameter plus a `last_page` field
   in the response; v3 collection endpoints (`getParentEntityAttachments`, chat, docs) take
   `limit` (max 100) plus an opaque `cursor`. An agent asking for "all open tasks" must hand-roll
   a loop and re-read the schema every round.
2. **Attachments can be uploaded but not fetched.** `clickup_api` confines requests to
   `https://api.clickup.com/api/v2|v3` — deliberately. `GetTask` returns attachment URLs on other
   hosts, so an agent can see a file exists and cannot open it. `read_url_content` cannot help: it
   sends no credentials.

## 2. Evidence gathered before design (not assumed)

- `GET /api/v2/team` → the Workspace avatar URL is
  `https://attachments2.clickup.com/team_avatars/…?Expires=…&Key-Pair-Id=…&Signature=…`, i.e. a
  **CloudFront presigned** URL.
- `https://attachments.clickup.com/profilePictures/<id>.jpg` probed with and without
  `Authorization`: **both 200**, `server: AmazonS3`, `content-length: 35637`, **zero redirects**.
- Conclusion: ClickUp media is served from S3/CloudFront under `attachments*.clickup.com`, and
  those URLs are public or self-authenticating (presigned). The token is **not** required and must
  not be sent.
- A live scan of the first lists in this Workspace found **no task attachments** to probe
  end-to-end, so task-attachment hosts and Workspace "Private Attachment Links" remain
  **unverified**. Consequence: no token is ever sent to an attachment host; a `401/403` is surfaced
  as a clear failure, and an unknown host is refused with the host name reported. The PR carries a
  manual verification checklist (§8.5) to collect that evidence at integration time.

## 3. Goals

- **G1** `clickup_api` pages a collection in one call, gated by what the runtime spec declares,
  with hard caps and a resumable position.
- **G2** a new `clickup_download` tool saves a ClickUp attachment URL to disk **without ever
  sending the token anywhere except `api.clickup.com`**.
- **G3** no regression: existing tools, confirmations, truncation, temp-file spill, and the
  runtime-spec design unchanged; `npm run verify` green.

## 4. Non-goals

OAuth/refresh tokens · webhook receiver or signature verification · a `clickup_batch` multi-call
tool · response field projection · custom-task-ID conveniences · `start`/`start_id` paging
(comments) — rejected explicitly, see §5.1.

## 5. Design

### 5.1 `clickup_api` — `paginate` (G1)

```ts
paginate?: { max_pages?: number; max_items?: number; max_duration_ms?: number }
// defaults 5 / 500 / 60000; hard caps 20 / 5000 / 120000
```

**Eligibility is decided by the spec, not by the caller.** Before any request the extension
matches `method + path` against the operations loaded from the runtime spec. v2 spec paths are
written without the server base (`/v2/list/{list_id}/task` under server `…/api`), so each template
is normalised to its request form first: `servers[0].url`'s path component is prefixed, giving
`/api/v2/list/{list_id}/task`. The template becomes an anchored regex (`{param}` → `[^/]+`, literal
segments escaped); when several templates match, the one with the fewest parameters wins. The call
proceeds only when the matched operation declares a `page` or `cursor` query parameter; otherwise
it is rejected with the reason and the list of paging-capable operations. Non-GET plus `paginate`
is rejected before eligibility checking — this tool never replays a mutation. A supplied
`query.page` must be a non-negative integer, else the call is rejected before any fetch.

**Loops.**
- v2 (`page` declared): request with `page` as a **number**, from `query.page ?? 0`, incrementing
  by one. When the body has `last_page`, that field alone decides: stop on `true`. Only when
  `last_page` is absent does the short-page rule apply (a page with fewer items than the previous
  page), then the empty-page rule.
- v3 (`cursor` declared): pass the previous body's `next_cursor`; keep the caller's `limit`.
  Stop when `next_cursor` is missing, `null`, `""`, or equal to the cursor just used (echo).
  There is no `cursor` fallback field.
- **No page is ever partially merged.** `max_pages` and `max_duration_ms` stop between pages.
  `max_items` is evaluated after each page arrives: if `items_so_far + page_size > max_items`,
  the page is not merged and the result points `next_page`/`next_cursor` at it, so resuming cannot
  skip items. The single exception is a **first** page whose own size exceeds `max_items`: it is
  returned whole and the result reports `overflowed_by`, because returning nothing would be worse
  than returning one oversized page.
- The deadline is a single `AbortSignal.timeout(max_duration_ms)` combined into every request
  signal with `AbortSignal.any`, so a 429 backoff sleep cannot outlive it. A **caller** abort
  rethrows the abort error; only the internal deadline produces `stopped_by: "deadline"`.

**Merge.** If the page body is an array, elements are concatenated and `merged_field` is `null`.
If it is an object, the merge key is fixed from **page 1**: the first array-valued property whose
elements are objects, evaluated even when the array is empty; if page 1 has no such property the
call fails before page 2 with an explicit error (nothing is merged blindly). Every later page must
expose the same key with the same element shape, else the call fails. Non-array properties come
from page 1, **except paging fields**, which are rewritten to the final position:
`page` = last page fetched, `last_page` = `stopped_by === "last_page"`, and `cursor`/`next_cursor`
are removed so a caller cannot resume from stale values.

**Result.** Existing truncation, temp-file spill and output shape are otherwise unchanged, and one
record is added **twice**: as the first line of the returned text (so truncation cannot cut it off)
and in `details`. The first line has this exact, single-line format, asserted by a test:

```
[paginated pages=<int> items=<int> merged_field=<key|none> stopped_by=<reason>]
```

```ts
paginated: {
  pages: number; items: number; merged_field: string | null;
  stopped_by: "last_page" | "short_page" | "empty_page" | "no_cursor" | "max_pages"
            | "max_items" | "deadline" | "error";
  next_page?: number; next_cursor?: string | null; overflowed_by?: number; error?: string;
}
```

**Failures.** An error on the first page throws. An error after at least one page returns the
partial merge with `stopped_by: "error"` and a sanitized message — the summary line makes the
partial state visible at the top of the response, not at the bottom of a truncated blob.

### 5.2 `clickup_download` (G2)

```ts
{ url: string; path?: string; overwrite?: boolean; max_bytes?: number; timeout_ms?: number }
// max_bytes default 25 MB / cap 100 MB; timeout_ms default 30000 / cap 120000
```

**No credential code path.** `clickup_download` imports neither `getToken` nor `requestClickUp`;
the download path is a separate `downloadAttachment()` in `client.ts` that never receives a token,
and a test asserts that no `Authorization` header is produced. The tool also requires
`ctx.hasUI`, refusing outright when confirmations cannot be shown.

- **Trust boundary.** The token is attached **only** for `api.clickup.com`. Attachment hosts are
  fetched **anonymously** — justified by §2. A `401/403` reports that the URL needs credentials the
  extension will not send. The AGENTS.md security line is amended to say exactly this (§10), so
  contract and code agree.
- **Host allowlist** (exported constant, anchored, compared against `URL.hostname` after parsing):
  `attachments.clickup.com`, `attachments-public.clickup.com` (added in review round 1: referenced 95 times
  in the official v2 spec), `attachments2.clickup.com`, and
  `^t\d+\.p\.clickup-attachments\.com$`. Requires `https:`, default port, no userinfo, no query
  rewriting. `api.clickup.com`, `developer.clickup.com`, `*.clickup.com` and look-alikes
  (`evilclickup.com`, `clickup.com.evil.test`, trailing dot) are rejected.
- **Redirects refused** (`redirect: "manual"`): a 3xx fails the call and reports the target host.
- **Size cap** from `Content-Length` when present and by counting streamed bytes; a partial file is
  removed on overflow, abort or redirect.
- **Path safety**: two allowed roots only — `process.cwd()` and the tool's own
  `mkdtemp(join(tmpdir(), "pi-clickup-download-"))` directory. A `path` outside both, absolute or
  relative, is rejected (so `~/.ssh/…` cannot be targeted by `overwrite`). `realpath` is applied to
  the parent directory before the containment check, a symlinked destination is refused, the file
  is opened with `flag: "wx"` and mode `0600`, and the basename is sanitized to `[A-Za-z0-9._-]`.
  `overwrite: true` stages the body in a sibling `0600` file and renames it over the destination only
  after a complete, size-checked, uncancelled write (review round 1: the original survives
  overflow/abort; the verified directory is re-checked by identity before every file operation).
- **Confirmation** on every call, `executionMode: "sequential"` (same dialog-race fix as
  `f8ed446`). Dialog shows: **host**, resolved absolute destination, and whether it overwrites.
- **Errors are sanitized**: status code and host only — never the response body (which can repeat
  the signed URL) and never the query string. The same rule applies to output and thrown messages.
- Returns `{ path, bytes, content_type }`.

## 6. Review response ledger (rounds 1-2 → resolution)

| # | Severity | Resolution |
|---|---|---|
| 1 | blocker | Rule amended explicitly, not reinterpreted — single canonical wording in §10, owner approval recorded there |
| 2 | blocker | Exact hosts + anchored regex; `api.clickup.com` and all other ClickUp hosts rejected; tests for look-alikes, userinfo, `http:`, trailing dot |
| 3 | blocker | Avatars probed live (§2); task-attachment hosts remain unverified and are handled by fail-closed refusal plus the §8.5 manual verification checklist in the PR |
| 4 | blocker | Pagination gated by the runtime spec declaring `page`/`cursor`; `start`/`start_id` rejected explicitly (§5.1) |
| 5 | major | Stops on `last_page === true`, then on a short page; `stopped_by` distinguishes `last_page`/`short_page` |
| 6 | major | `next_cursor` only; stops on missing/`null`/`""`/echo; no `cursor` fallback |
| 7 | major | Mid-page dropping removed: caps stop before the page, so `next_page`/`next_cursor` is exact; a single oversized page reports `overflowed_by` |
| 8 | major | First-page error throws; later errors return a labelled partial; deadline signal threaded into every request and 429 sleep; downloads gain `timeout_ms` |
| 9 | major | Merge key fixed from page 1 (array body → `merged_field: null`); no suitable key on page 1 fails before page 2; later-page mismatch fails |
| 10 | major | Two allowed roots (`cwd` and the tool's `mkdtemp`), `realpath` parent check, `wx` + `0600`, sanitized basename, symlink refusal |
| 11 | major | `executionMode: "sequential"` on the new tool, plus a test in `tools.test.ts` |
| 12 | major | Dialog shows host, absolute destination, overwrite flag |
| 13 | major | PR base `development`. AGENTS.md's stale "Opus 4.8 QA" line is replaced by the reviewer-of-record for this cycle: GPT-6.2 (Sol) via the Codex CLI, which **holds merge authority**; a different model family from the Opus 5.5 author. Owner exception to the default Astra pairing recorded in §10 |
| 14 | minor | Deadline is an `AbortSignal` combined into every request and its 429 sleep, so backoff cannot outlive the budget; rate-limit claim corrected to "plan-dependent" |
| 15 | minor | Response bodies are never echoed from attachment hosts; status and host only; query string stripped everywhere; tested |
| 16 | minor | Snapshot test for non-paginated output; `page` coerced to number before increment |
| 17 | minor | Third tool justified here; exact AGENTS.md wording given in §10 and applied with README/PROJECT_STATUS/handoff edits in the same PR |

### 6.1 Round-2 findings and their mechanisms

- **v2 spec-path mismatch** — templates are normalised with the server base path before matching
  (§5.1); tested against the real `/v2/...` spec form.
- **`paginated` record lost to truncation** — emitted as the first line of the returned text and in
  `details`; tested with an oversized response.
- **Stale paging fields in the merged body** — rewritten to the final position, cursors removed
  (§5.1); tested.
- **Short-page rule stopping early** — applies only when `last_page` is absent (§5.1).
- **Abort reported as a partial error** — caller aborts rethrow; only the deadline yields
  `stopped_by: "deadline"`.
- **Download could reach the token path** — separate `downloadAttachment()` with no token
  parameter, plus a test asserting no `Authorization` header, and `ctx.hasUI` required.
- **Invalid `page` values** — must be a non-negative integer before paging starts.

## 7. Test plan (injected fakes, no network)

**Pagination** — v2 `last_page` stop; v2 short-page stop when `last_page` is absent; `max_items`
stop with `next_page` pointing at the unmerged page; first-page `overflowed_by`; `max_pages` stop
with `next_page`; summary line matching `^\[paginated pages=\d+ items=\d+ merged_field=\S+ stopped_by=[a-z_]+\]$` as the **first** line of text under an oversized response; v3 cursor follow; v3 stop on
`null`/`""`/echo; eligibility rejection for an operation without `page`/`cursor`; rejection for
non-GET; merge-field mismatch fails; first-page error throws; later-page error returns
`stopped_by: "error"`; deadline stop; non-paginated call output unchanged (snapshot).

**Download** — allowlisted host with no token sent (assert absence of `Authorization`); look-alike
hosts rejected before any fetch; 302 refused and reported; `Content-Length` over cap aborts before
reading the body; streamed overflow removes the partial file; `../` escape rejected; symlinked
destination rejected; existing file without `overwrite` refused; `overwrite` unlinks an existing **symlink** without
following it; mode `0600` on the written file; `http:` and non-default-port URLs rejected;
`401/403` message names the host and states that credentials will not be sent; query string absent
from result and errors; `executionMode: "sequential"` declared; confirmation content includes
host, absolute destination and the overwrite flag.

**Regression** — the entire existing suite passes unchanged.

## 8. Acceptance criteria

1. `npm run verify` green, new tests covering §7.
2. `clickup_api` with `paginate` returns merged items plus the `paginated` record; without it,
   output is unchanged (snapshot test).
3. `clickup_download` saves an allowlisted URL and refuses every other host; no `Authorization`
   header is ever sent outside `api.clickup.com` (asserted in tests).
4. README/AGENTS/HANDOFF/PROJECT_STATUS document both, including caps and the credential-free
   download boundary.

### 8.5 Manual verification checklist carried in the PR

1. With a real task attachment URL, record host, status with and without `Authorization`, and
   whether a redirect occurs. If the host needs credentials, the tool must report the refusal —
   record that outcome rather than widening the allowlist.
2. Repeat for a Workspace with "Private Attachment Links" enabled, if one is available.
3. Record both results in the PR body so the allowlist decision is evidence-backed.

## 9. Risks

- **Presigned URL expiry** — a URL captured from a task can expire before download; the failure is
  a clear 403, not a silent empty file.
- **Merge heuristic** — mitigated by fixing the field on page 1 and reporting `merged_field`.
- **Allowlist drift** — a new ClickUp media host fails closed; one exported constant + one test
  makes the fix a one-line change.
- **Third tool** — grows the prompt surface; justified because the alternative is granting generic
  credentialed fetching, which is strictly worse.
- **Directory-swap window in `clickup_download`** (reviewer finding 1) — the parent directory's
  identity is re-verified synchronously immediately before each `open`/`rename`, leaving a
  syscall-wide window: an attacker who can rename directories inside the destination directory's
  parent (i.e. who already acts with this user's privileges) could redirect the write. Node offers
  no `openat`/`fchdir`, so the only alternative is a `chdir` child process, rejected for
  portability (Pi may run as a Bun binary). The code carries a `shortcut:` comment naming the
  limit and the upgrade trigger.

  **Owner ruling, Umar 2026-11-22: accepted.** Rationale: the threat requires a second local
  principal with write access to a shared parent directory, on a single-user workstation whose
  repositories live under the user's home. Recorded here because the author and the reviewer
  deadlocked after three cycles and neither may close it alone.

## 10. Contract amendments (exact wording)

`AGENTS.md`, Security section — replaces "API requests must remain restricted to
`https://api.clickup.com/api/v2|v3`":

> Credentialed API requests remain restricted to `https://api.clickup.com/api/v2|v3`.
> `clickup_download` fetches attachment URLs **without credentials**, only from the exported
> attachment-host allowlist, refuses redirects, and caps size to disk.

`AGENTS.md`, Branches section — replaces "The Opus 4.8 QA Pi is reviewer-of-record and holds
merge authority":

> Reviewer-of-record for this extension holds merge authority and must be a session on a different
> model family from the author. As of 2026-11-22 that is GPT-6.2 (Sol), run as
> `codex exec -m gpt-6.2-sol`. It reviews and merges; it does not author.

Approvals, recorded before launch:

- Umar, 2026-11-22 (this task's instruction): add pagination and credential-free attachment
  download; author the code on Opus 5.5; review on GPT-6.2 Sol; accept the amended `AGENTS.md`
  wording above.
- The GPT-6.2 choice is an **owner exception** to the default Opus 5.5 → GPT-6 Astra pairing in
  the global policy. It is recorded here before launch, as that policy requires, and independence
  still holds: author Opus 5.5 and reviewer GPT-6.2 are different model families.

## 11. Rollout

Branch `feat/pagination-and-downloads` from `development` → PR into `development` → reviewer
merge → normal `staging`/`production` promotion. Version `0.2.0` (additive). Docs updated in the
same PR; review capture recorded in the PR body.
