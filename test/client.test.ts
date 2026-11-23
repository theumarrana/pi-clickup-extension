import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClickUpApiError,
  buildUrl,
  downloadAttachment,
  extractOperations,
  getToken,
  normalizeApiPath,
  operationDetail,
  paginateClickUp,
  requestClickUp,
  searchOperations,
  type Fetcher,
  type PaginateOptions,
  type QueryValue,
} from "../client.ts";

test("normalizes only ClickUp v2/v3 API paths and serializes arrays", async () => {
  assert.equal(normalizeApiPath("v2/team"), "/api/v2/team");
  assert.equal(normalizeApiPath("/api/v3/workspaces/1/docs"), "/api/v3/workspaces/1/docs");
  assert.throws(() => normalizeApiPath("https://evil.test/api/v2/team"));
  assert.throws(() => normalizeApiPath("/api/v4/team"));
  assert.throws(() => buildUrl("/api/v2/../../secret"));
  assert.throws(() => buildUrl("/api/v2/%2e%2e/%2e%2e/secret"));
  assert.throws(() => buildUrl("/api/v2/foo%2f..%2f..%2fsecret"));
  assert.throws(() => buildUrl("/api/v2\\..\\..\\secret"));
  assert.equal(buildUrl("/v2/team/1/task", { "statuses[]": ["open", "done"], archived: false }).toString(),
    "https://api.clickup.com/api/v2/team/1/task?statuses%5B%5D=open&statuses%5B%5D=done&archived=false");

  let fetched = false;
  await assert.rejects(requestClickUp({ method: "GET", path: "/api/v2/../../secret" }, {
    token: "secret",
    fetchImpl: async () => {
      fetched = true;
      return new Response("{}");
    },
  }));
  assert.equal(fetched, false);
});

test("prefers the owner-only token file over the legacy API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-clickup-token-test-"));
  const path = join(directory, "token");
  await writeFile(path, "file-token\n", { mode: 0o600 });
  const previous = process.env.CLICKUP_API_KEY;
  process.env.CLICKUP_API_KEY = "stale-legacy-token";
  try {
    assert.equal(await getToken(path), "file-token");
  } finally {
    if (previous === undefined) delete process.env.CLICKUP_API_KEY;
    else process.env.CLICKUP_API_KEY = previous;
  }
});

test("sends authenticated JSON and parses responses", async () => {
  let request: RequestInit | undefined;
  const fetchImpl: Fetcher = async (_url, init) => {
    request = init;
    return new Response('{"id":"task-1"}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await requestClickUp({ method: "POST", path: "/v2/list/1/task", body: { name: "Test" } }, { token: "secret", fetchImpl });
  const headers = new Headers(request?.headers);
  assert.equal(headers.get("authorization"), "secret");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(request?.body, '{"name":"Test"}');
  assert.deepEqual(result.data, { id: "task-1" });
});

test("retries rate limits but does not retry a mutating 503", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetchImpl: Fetcher = async () => {
    calls++;
    return calls === 1
      ? new Response("limited", { status: 429, headers: { "retry-after": "0" } })
      : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await requestClickUp({ method: "GET", path: "/v2/team" }, {
    token: "secret",
    fetchImpl,
    sleepImpl: async ms => { delays.push(ms); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [0]);

  const unavailable: Fetcher = async () => new Response("down", { status: 503, statusText: "Unavailable" });
  await assert.rejects(
    requestClickUp({ method: "POST", path: "/v2/list/1/task", body: {} }, { token: "secret", fetchImpl: unavailable }),
    (error: unknown) => error instanceof ClickUpApiError && error.status === 503,
  );
});

test("builds ClickUp multipart uploads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-clickup-test-"));
  await writeFile(join(directory, "note.txt"), "hello");
  let form: FormData | undefined;
  const fetchImpl: Fetcher = async (_url, init) => {
    form = init?.body as FormData;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await requestClickUp({
    method: "POST",
    path: "/v2/task/1/attachment",
    cwd: directory,
    body: { custom_task_ids: true },
    files: [{ path: "note.txt" }],
  }, { token: "secret", fetchImpl });
  assert.equal(form?.get("custom_task_ids"), "true");
  assert.equal((form?.get("attachment[0]") as File).name, "note.txt");
});

test("searches both specifications and resolves request schema references", () => {
  const specs = {
    v2: {
      paths: {
        "/v2/task/{task_id}": {
          put: {
            operationId: "UpdateTask",
            summary: "Update Task",
            tags: ["Tasks"],
            requestBody: { $ref: "#/components/requestBodies/Update" },
            responses: { "200": {} },
          },
        },
      },
      components: { requestBodies: { Update: { content: { "application/json": { schema: { type: "object" } } } } } },
    },
    v3: {
      paths: {
        "/api/v3/workspaces/{workspace_id}/docs": {
          get: { operationId: "searchDocsPublic", summary: "Search Docs", tags: ["Docs"], responses: { "200": {} } },
        },
      },
    },
  };
  const operations = extractOperations(specs);
  assert.equal(operations.length, 2);
  assert.equal(searchOperations(operations, "docs")[0].id, "searchDocsPublic");
  assert.deepEqual(operationDetail(searchOperations(operations, "UpdateTask")[0]).request_body,
    { content: { "application/json": { schema: { type: "object" } } } });
});

// --- Pagination -----------------------------------------------------------------------------

// Spec shapes mirror the live ClickUp specs: v2 paths omit the `/api` server base, v3 paths include it.
const pagingOperations = extractOperations({
  v2: {
    servers: [{ url: "https://api.clickup.com/api" }],
    paths: {
      "/v2/list/{list_id}/task": { get: { operationId: "GetTasks", parameters: [{ $ref: "#/components/parameters/Page" }] } },
      "/v2/list/{list_id}/{other}": { get: { operationId: "Shadow", parameters: [] } },
      "/v2/task/{task_id}": { get: { operationId: "GetTask", parameters: [] } },
    },
    components: { parameters: { Page: { name: "page", in: "query" } } },
  },
  v3: {
    servers: [{ url: "https://api.clickup.com/" }],
    paths: {
      "/api/v3/workspaces/{workspace_id}/docs": {
        get: { operationId: "searchDocsPublic", parameters: [{ name: "cursor", in: "query" }, { name: "limit", in: "query" }] },
      },
    },
  },
});

const tasks = (count: number, prefix = "t") => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));

// Serves bodies keyed by the page/cursor query value; a Response value is returned as-is.
// Like the real API, `limit` caps every array of objects in the page.
function pagedFetch(bodies: Record<string, unknown>, calls: string[]): Fetcher {
  return async (url) => {
    const params = new URL(String(url)).searchParams;
    const key = params.get("page") ?? params.get("cursor") ?? "";
    calls.push(key);
    const body = bodies[key];
    if (body instanceof Response) return body;
    const limit = Number(params.get("limit") ?? Infinity);
    return Response.json(Object.fromEntries(Object.entries(body as object)
      .map(([name, value]) => [name, Array.isArray(value) ? value.slice(0, limit) : value])));
  };
}

function paginate(path: string, bodies: Record<string, unknown>, options: PaginateOptions = {}, query?: Record<string, QueryValue>) {
  const calls: string[] = [];
  const result = paginateClickUp({ method: "GET", path, query }, options, async () => pagingOperations, {
    token: "secret",
    fetchImpl: pagedFetch(bodies, calls),
  });
  return { calls, result };
}

test("v2 pagination stops on last_page, which alone decides when present", async () => {
  const { calls, result } = paginate("/v2/list/1/task", {
    0: { tasks: tasks(3, "a"), last_page: false },
    1: { tasks: tasks(1, "b"), last_page: false }, // short page must not stop while last_page is present
    2: { tasks: tasks(2, "c"), last_page: true },
  });
  const { data, paginated } = await result;
  assert.deepEqual(calls, ["0", "1", "2"]);
  assert.deepEqual(paginated, { pages: 3, items: 6, merged_field: "tasks", stopped_by: "last_page" });
  assert.equal((data as { tasks: unknown[] }).tasks.length, 6);
  assert.equal((data as { last_page: boolean }).last_page, true);
});

test("v2 pagination applies short-page and empty-page rules only when last_page is absent", async () => {
  const short = paginate("/v2/list/1/task", { 0: { tasks: tasks(3) }, 1: { tasks: tasks(3) }, 2: { tasks: tasks(1) } });
  assert.deepEqual((await short.result).paginated, { pages: 3, items: 7, merged_field: "tasks", stopped_by: "short_page" });
  const empty = paginate("/v2/list/1/task", { 0: { tasks: [] } });
  assert.deepEqual((await empty.result).paginated, { pages: 1, items: 0, merged_field: "tasks", stopped_by: "empty_page" });
});

test("max_items never partially merges a page and points next_page at it", async () => {
  const { calls, result } = paginate("/v2/list/1/task", { 0: { tasks: tasks(3) }, 1: { tasks: tasks(3) } }, { max_items: 5 });
  const { data, paginated } = await result;
  assert.deepEqual(calls, ["0", "1"]);
  assert.deepEqual(paginated, { pages: 1, items: 3, merged_field: "tasks", stopped_by: "max_items", next_page: 1 });
  assert.equal((data as { tasks: unknown[] }).tasks.length, 3);
});

test("an oversized first page is returned whole with overflowed_by", async () => {
  const { calls, result } = paginate("/v2/list/1/task", { 0: { tasks: tasks(4) } }, { max_items: 2 });
  const { data, paginated } = await result;
  assert.deepEqual(paginated,
    { pages: 1, items: 4, merged_field: "tasks", stopped_by: "max_items", next_page: 1, overflowed_by: 2 });
  assert.deepEqual((data as { tasks: unknown[] }).tasks, tasks(4));
  assert.deepEqual(calls, ["0"]);
});

test("paging fields track the last fetched page, are added when absent, and only the merged array is carried", async () => {
  // Page 1 is fetched but rejected by max_items: page must say 1, next_page must point at it.
  const { calls, result } = paginate("/v2/list/1/task", {
    0: { tasks: tasks(3), members: [{ id: "m" }], count: 3 },
    1: { tasks: tasks(3), last_page: true },
  }, { max_items: 5 });
  const { data, paginated } = await result;
  assert.deepEqual(calls, ["0", "1"]);
  assert.deepEqual(paginated, { pages: 1, items: 3, merged_field: "tasks", stopped_by: "max_items", next_page: 1 });
  assert.deepEqual(data, { tasks: tasks(3), count: 3, page: 1, last_page: false });
});

test("max_pages stops between pages, resumes from query.page, and rewrites paging fields", async () => {
  const { calls, result } = paginate("/v2/list/1/task", {
    1: { page: 1, tasks: tasks(2), last_page: false, next_cursor: "stale" },
    2: { page: 2, tasks: tasks(2), last_page: false },
  }, { max_pages: 2 }, { page: "1" });
  const { data, paginated } = await result;
  assert.deepEqual(calls, ["1", "2"]);
  assert.deepEqual(paginated, { pages: 2, items: 4, merged_field: "tasks", stopped_by: "max_pages", next_page: 3 });
  assert.deepEqual(data, { page: 2, tasks: [...tasks(2), ...tasks(2)], last_page: false });
});

test("v3 pagination follows next_cursor, removes cursor fields, and stops on null, empty, or echo", async () => {
  // The fake honours limit (3 docs served, 2 kept), so every request must carry the caller's limit.
  const { calls, result } = paginate("/v3/workspaces/9/docs", {
    "": { docs: tasks(3, "a"), cursor: "", next_cursor: "c1" },
    c1: { docs: tasks(3, "b"), cursor: "c1", next_cursor: "c2" },
    c2: { docs: tasks(3, "c"), cursor: "c2", next_cursor: null },
  }, {}, { limit: 2 });
  const { data, paginated } = await result;
  assert.deepEqual(calls, ["", "c1", "c2"]);
  assert.deepEqual(paginated, { pages: 3, items: 6, merged_field: "docs", stopped_by: "no_cursor" });
  assert.deepEqual(data, { docs: [...tasks(2, "a"), ...tasks(2, "b"), ...tasks(2, "c")] });

  for (const terminal of ["", "c1"]) {
    const echo = paginate("/v3/workspaces/9/docs", { c1: { docs: tasks(1), next_cursor: terminal } }, {}, { cursor: "c1" });
    assert.equal((await echo.result).paginated.stopped_by, "no_cursor");
    assert.deepEqual(echo.calls, ["c1"]);
  }

  // A stale cursor with no next_cursor stops; cursor is never used as a fallback and is stripped.
  const stale = paginate("/v3/workspaces/9/docs", { "": { docs: tasks(1), cursor: "stale" }, stale: { docs: tasks(1, "x") } });
  const staleResult = await stale.result;
  assert.deepEqual(stale.calls, [""]);
  assert.deepEqual(staleResult.paginated, { pages: 1, items: 1, merged_field: "docs", stopped_by: "no_cursor" });
  assert.deepEqual(staleResult.data, { docs: tasks(1) });

  const capped = paginate("/v3/workspaces/9/docs", { "": { docs: tasks(1), next_cursor: "c1" } }, { max_pages: 1 });
  assert.deepEqual((await capped.result).paginated,
    { pages: 1, items: 1, merged_field: "docs", stopped_by: "max_pages", next_cursor: "c1" });
});

test("pagination is gated by the spec, GET-only, and validates query.page before any fetch", async () => {
  let loaded = false;
  let fetched = false;
  const options = { token: "secret", fetchImpl: (async () => { fetched = true; return Response.json({}); }) as Fetcher };
  const load = async () => { loaded = true; return pagingOperations; };

  await assert.rejects(paginateClickUp({ method: "POST", path: "/v2/list/1/task" }, {}, load, options), /only supported for GET/);
  assert.equal(loaded, false);
  await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/task/abc" }, {}, load, options),
    (error: Error) => /GetTask declares no page or cursor/.test(error.message)
      && error.message.includes("GET /api/v2/list/{list_id}/task")
      && error.message.includes("GET /api/v3/workspaces/{workspace_id}/docs"));
  await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/user" }, {}, load, options), /no documented GET operation/);
  for (const page of [-1, 1.5, "abc", "", true, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 3, "9007199254740993", 1e300]) {
    await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/list/1/task", query: { page } }, {}, load, options), /non-negative integer/);
  }
  assert.equal(fetched, false);
});

test("pagination fails on merge-field mismatch or no mergeable array on page 1", async () => {
  const mismatch = paginate("/v2/list/1/task", { 0: { tasks: tasks(2) }, 1: { items: tasks(2) } });
  await assert.rejects(mismatch.result, /same "tasks" array/);
  const none = paginate("/v2/list/1/task", { 0: { count: 2, names: ["a", "b"] } });
  await assert.rejects(none.result, /no array of objects/);
  assert.deepEqual(none.calls, ["0"]);
});

test("a first-page error throws; a later-page error returns a sanitized partial", async () => {
  const first = paginate("/v2/list/1/task", { 0: new Response("secret-body", { status: 500, statusText: "Server Error" }) });
  await assert.rejects(first.result, (error: unknown) => error instanceof ClickUpApiError && error.status === 500);

  const later = paginate("/v2/list/1/task", {
    0: { tasks: tasks(2), last_page: false },
    1: new Response("secret-body", { status: 500, statusText: "Server Error" }),
  });
  const { paginated } = await later.result;
  assert.deepEqual(paginated, {
    pages: 1, items: 2, merged_field: "tasks", stopped_by: "error", next_page: 1, error: "ClickUp API returned HTTP 500.",
  });
});

test("partial-error details use fixed wording, never status text, parser output, or body", async () => {
  const failures = [
    new Response("BODY-SECRET", { status: 500, statusText: "STATUS-SECRET" }),
    new Response("{MALFORMED-SECRET", { headers: { "content-type": "application/json" } }),
  ];
  for (const failure of failures) {
    const later = paginate("/v2/list/1/task", { 0: { tasks: tasks(1), last_page: false }, 1: failure });
    const result = await later.result;
    assert.equal(result.paginated.stopped_by, "error");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test("credentialed requests refuse redirects, so the target never receives the token", async () => {
  const requested: string[] = [];
  // Emulates fetch: anything but redirect "manual" would follow Location with the same headers.
  const fetchImpl: Fetcher = async (url, init) => {
    requested.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
    const response = new Response(null, { status: 307, headers: { location: "https://api.clickup.com/elsewhere?sig=LOCATION-SECRET" } });
    if (init?.redirect === "manual") return response;
    requested.push("https://api.clickup.com/elsewhere secret");
    return Response.json({ tasks: tasks(1) });
  };
  await assert.rejects(requestClickUp({ method: "GET", path: "/v2/team" }, { token: "secret", fetchImpl }),
    (error: unknown) => error instanceof ClickUpApiError && error.status === 307
      && /redirect 307 to api\.clickup\.com refused/.test(error.message) && !error.message.includes("LOCATION-SECRET"));
  assert.deepEqual(requested, ["https://api.clickup.com/api/v2/team secret"]);

  // A redirect on a later page is a labelled partial, never merged.
  const later = paginate("/v2/list/1/task", {
    0: { tasks: tasks(1), last_page: false },
    1: new Response(null, { status: 302, headers: { location: "/api/v2/list/1/task?page=9" } }),
  });
  const { data, paginated } = await later.result;
  assert.deepEqual(paginated, { pages: 1, items: 1, merged_field: "tasks", stopped_by: "error", next_page: 1, error: "ClickUp API returned HTTP 302." });
  assert.deepEqual((data as { tasks: unknown[] }).tasks, tasks(1));
});

test("the pagination budget covers the spec lookup; a caller abort during it rethrows", async () => {
  let fetched = false;
  const options = { token: "secret", fetchImpl: (async () => { fetched = true; return Response.json({}); }) as Fetcher };
  // A slow cold-cache lookup; without the budget it would resolve and the pager would fetch.
  const never = () => new Promise<typeof pagingOperations>(resolve => setTimeout(() => resolve(pagingOperations), 300));
  await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/list/1/task" }, { max_duration_ms: 30 }, never, options),
    /max_duration_ms elapsed while loading/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/list/1/task" }, {}, never, { ...options, signal: controller.signal }),
    (error: Error) => error.name === "AbortError");
  assert.equal(fetched, false);
});

test("an already-aborted call never starts the spec lookup and leaves no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let looked = false;
    const failing = async () => { looked = true; throw new Error("spec lookup failed"); };
    await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/list/1/task" }, {}, failing,
      { token: "secret", signal: AbortSignal.abort() }), (error: Error) => error.name === "AbortError");
    assert.equal(looked, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the deadline bounds 429 backoff sleeps; a caller abort rethrows", async () => {
  // Page 1 asks for a 60 s backoff; the 50 ms deadline must cut the real sleep short.
  const started = Date.now();
  const deadline = paginate("/v2/list/1/task", {
    0: { tasks: tasks(2), last_page: false },
    1: new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
  }, { max_duration_ms: 50 });
  assert.deepEqual((await deadline.result).paginated,
    { pages: 1, items: 2, merged_field: "tasks", stopped_by: "deadline", next_page: 1 });
  assert.ok(Date.now() - started < 5_000);

  const controller = new AbortController();
  let calls = 0;
  const fetchImpl: Fetcher = async (_url, init) => {
    if (calls++ === 0) return Response.json({ tasks: tasks(2), last_page: false });
    controller.abort();
    throw init?.signal?.reason;
  };
  await assert.rejects(paginateClickUp({ method: "GET", path: "/v2/list/1/task" }, {}, async () => pagingOperations,
    { token: "secret", fetchImpl, signal: controller.signal }), (error: Error) => error.name === "AbortError");
});

// --- Attachment download ------------------------------------------------------------------------

const ATTACHMENT = "https://attachments.clickup.com/abc/report.pdf?Expires=1&Signature=SIGNED-SECRET";

async function workdir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "pi-clickup-download-test-")));
}

test("downloads an allowlisted attachment anonymously to a 0600 file", async () => {
  const cwd = await workdir();
  let request: RequestInit | undefined;
  const fetchImpl: Fetcher = async (_url, init) => {
    request = init;
    return new Response("hello", { headers: { "content-type": 'Application/PDF; name="x?Signature=HEADER-SECRET"' } });
  };
  // A configured token must still never reach the attachment host.
  const previous = process.env.CLICKUP_API_TOKEN;
  process.env.CLICKUP_API_TOKEN = "FAKE-TOKEN";
  let result;
  try {
    result = await downloadAttachment({ url: ATTACHMENT, path: "out.pdf", cwd }, { fetchImpl });
  } finally {
    if (previous === undefined) delete process.env.CLICKUP_API_TOKEN;
    else process.env.CLICKUP_API_TOKEN = previous;
  }
  assert.equal(new Headers(request?.headers).has("authorization"), false);
  assert.ok(!JSON.stringify(request).includes("FAKE-TOKEN"));
  assert.equal(request?.redirect, "manual");
  assert.deepEqual(result, { path: join(cwd, "out.pdf"), bytes: 5, content_type: "application/pdf" });
  assert.equal(await readFile(result.path, "utf8"), "hello");
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes("SIGNED-SECRET"));

  const temp = await downloadAttachment({ url: "https://t9012.p.clickup-attachments.com/x/a b.txt" }, { fetchImpl });
  assert.match(temp.path, /pi-clickup-download-[^/]+\/a_20b\.txt$/); // URL pathname stays percent-encoded, then sanitized

  // attachments-public.clickup.com is the most-referenced host in the official v2 spec.
  const bad: Fetcher = async () => new Response("x", { headers: { "content-type": "text/html\"BAD" } });
  const publicHost = await downloadAttachment({ url: "https://attachments-public.clickup.com/a/b.png" }, { fetchImpl: bad });
  assert.equal(publicHost.content_type, null);
});

test("rejects non-allowlisted, look-alike, non-https, userinfo, and non-default-port URLs before fetching", async () => {
  let fetched = false;
  const fetchImpl: Fetcher = async () => { fetched = true; return new Response("x"); };
  for (const url of [
    "https://api.clickup.com/api/v2/team",
    "https://developer.clickup.com/x",
    "https://app.clickup.com/x",
    "https://evilclickup.com/x",
    "https://attachments.clickup.com.evil.test/x",
    "https://attachments.clickup.com./x",
    "https://t1.p.clickup-attachments.com.evil.test/x",
    "https://xt1.p.clickup-attachments.com/x",
    "https://user:pw@attachments.clickup.com/x",
    "http://attachments.clickup.com/x",
    "https://attachments.clickup.com:8443/x",
    "not a url",
  ]) {
    await assert.rejects(downloadAttachment({ url }, { fetchImpl }), /not allowed|https|valid URL/, url);
  }
  assert.equal(fetched, false);
});

test("refuses redirects and credential-requiring URLs without leaking the query or body", async () => {
  const cwd = await workdir();
  const redirect: Fetcher = async () => new Response(null, { status: 302, headers: { location: "https://evil.test/steal?sig=SIGNED-SECRET" } });
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "r.pdf", cwd }, { fetchImpl: redirect }),
    (error: Error) => error.message.includes("302") && error.message.includes("evil.test") && !error.message.includes("SIGNED-SECRET"));
  await assert.rejects(lstat(join(cwd, "r.pdf")));
  const noLocation: Fetcher = async () => new Response(null, { status: 301 });
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "r.pdf", cwd }, { fetchImpl: noLocation }),
    (error: Error) => error.message === "Redirect refused: attachments.clickup.com returned 301.");

  for (const status of [401, 403]) {
    const denied: Fetcher = async () => new Response(`denied ${ATTACHMENT}`, { status });
    await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "d.pdf", cwd }, { fetchImpl: denied }),
      (error: Error) => error.message.includes(String(status)) && error.message.includes("attachments.clickup.com")
        && /credentials that pi-clickup will not send/.test(error.message) && !error.message.includes("SIGNED-SECRET"));
  }
});

test("enforces max_bytes from Content-Length before reading and while streaming", async () => {
  const cwd = await workdir();
  let pulled = false;
  const declared: Fetcher = async () => new Response(
    new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 }),
    { headers: { "content-length": "100" } },
  );
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "big.pdf", cwd, max_bytes: 10 }, { fetchImpl: declared }), /max_bytes/);
  assert.equal(pulled, false);
  await assert.rejects(lstat(join(cwd, "big.pdf")));

  const streamed: Fetcher = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.enqueue(new Uint8Array(10));
      controller.close();
    },
  }));
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "stream.pdf", cwd, max_bytes: 15 }, { fetchImpl: streamed }), /max_bytes/);
  await assert.rejects(lstat(join(cwd, "stream.pdf")));
});

test("confines destinations to the working directory and never follows symlinks", async () => {
  const cwd = await workdir();
  const outside = await workdir();
  let fetched = false;
  const fetchImpl: Fetcher = async () => { fetched = true; return new Response("new"); };

  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "../escape.pdf", cwd }, { fetchImpl }), /inside the working directory/);
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: join(outside, "abs.pdf"), cwd }, { fetchImpl }), /inside the working directory/);
  await symlink(outside, join(cwd, "linkdir"));
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "linkdir/x.pdf", cwd }, { fetchImpl }), /inside the working directory/);

  await writeFile(join(outside, "target.txt"), "keep");
  await symlink(join(outside, "target.txt"), join(cwd, "link.pdf"));
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "link.pdf", cwd }, { fetchImpl }), /exists as a symlink/);
  await writeFile(join(cwd, "existing.pdf"), "old");
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "existing.pdf", cwd }, { fetchImpl }), /already exists/);
  assert.equal(fetched, false);

  const replaced = await downloadAttachment({ url: ATTACHMENT, path: "link.pdf", cwd, overwrite: true }, { fetchImpl });
  assert.equal((await lstat(replaced.path)).isSymbolicLink(), false);
  assert.equal(await readFile(replaced.path, "utf8"), "new");
  assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "keep");
  assert.equal((await stat(replaced.path)).mode & 0o777, 0o600);

  // A 254-byte destination name is legal; the staging name must not grow past the 255-byte component limit.
  const long = `${"a".repeat(250)}.pdf`;
  await writeFile(join(cwd, long), "old");
  const longReplaced = await downloadAttachment({ url: ATTACHMENT, path: long, cwd, overwrite: true }, { fetchImpl });
  assert.equal(await readFile(longReplaced.path, "utf8"), "new");

  await mkdir(join(cwd, "sub"));
  const nested = await downloadAttachment({ url: ATTACHMENT, path: "sub/my file?.pdf", cwd }, { fetchImpl });
  assert.equal(nested.path, join(cwd, "sub", "my_file_.pdf"));
});

test("a directory swapped for a symlink after verification is detected and nothing escapes the root", async () => {
  for (const phase of ["confirm", "fetch"] as const) {
    for (const overwrite of [true, false]) {
      const cwd = await workdir();
      const outside = await workdir();
      await mkdir(join(cwd, "sub"));
      if (overwrite) {
        await writeFile(join(cwd, "sub", "f.pdf"), "inside");
        await writeFile(join(outside, "f.pdf"), "keep");
      }
      const swap = async () => {
        await rename(join(cwd, "sub"), join(cwd, "sub-real"));
        await symlink(outside, join(cwd, "sub"));
      };
      const fetchImpl: Fetcher = async () => {
        if (phase === "fetch") await swap();
        return new Response("evil");
      };
      const confirm = async () => {
        if (phase === "confirm") await swap();
        return true;
      };
      await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "sub/f.pdf", cwd, overwrite }, { fetchImpl, confirm }),
        /changed after it was verified/, `${phase} overwrite=${overwrite}`);
      assert.deepEqual(await readdir(outside), overwrite ? ["f.pdf"] : []);
      assert.deepEqual(await readdir(join(cwd, "sub-real")), overwrite ? ["f.pdf"] : []);
      if (overwrite) {
        assert.equal(await readFile(join(outside, "f.pdf"), "utf8"), "keep");
        assert.equal(await readFile(join(cwd, "sub-real", "f.pdf"), "utf8"), "inside");
      }
    }
  }
});

test("overwrite keeps the original intact on overflow and abort, and replaces it only after a full write", async () => {
  const cwd = await workdir();
  await writeFile(join(cwd, "keep.pdf"), "original");
  const chunks = (onLast: () => void, close = true): Fetcher => async () => {
    let pulls = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) return controller.enqueue(new Uint8Array(4));
        onLast();
        if (close) controller.close();
        else controller.enqueue(new Uint8Array(4));
      },
    }, { highWaterMark: 0 }));
  };
  const attempt = (fetchImpl: Fetcher, extra: { max_bytes?: number; signal?: AbortSignal } = {}) =>
    downloadAttachment({ url: ATTACHMENT, path: "keep.pdf", cwd, overwrite: true, max_bytes: extra.max_bytes }, { fetchImpl, signal: extra.signal });

  await assert.rejects(attempt(chunks(() => {}, false), { max_bytes: 6 }), /max_bytes/);
  for (const close of [false, true]) {
    // Abort mid-stream (write boundary) and after the final chunk (finalisation boundary).
    const controller = new AbortController();
    await assert.rejects(attempt(chunks(() => controller.abort(), close), { signal: controller.signal }), /failed \(AbortError\)/);
  }
  assert.equal(await readFile(join(cwd, "keep.pdf"), "utf8"), "original");
  assert.deepEqual(await readdir(cwd), ["keep.pdf"]);

  // A stream that blocks the event loop past the deadline must not commit, even if the timer has not fired.
  const busy = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end); };
  await assert.rejects(downloadAttachment({ url: ATTACHMENT, path: "keep.pdf", cwd, overwrite: true, timeout_ms: 30 },
    { fetchImpl: chunks(() => busy(60)) }), /failed \(TimeoutError\)/);
  assert.equal(await readFile(join(cwd, "keep.pdf"), "utf8"), "original");
  assert.deepEqual(await readdir(cwd), ["keep.pdf"]);

  const done = await attempt(chunks(() => {}));
  assert.equal(done.bytes, 4);
  assert.equal((await readFile(join(cwd, "keep.pdf"))).length, 4);
  assert.deepEqual(await readdir(cwd), ["keep.pdf"]);
});
