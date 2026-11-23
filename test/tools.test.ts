import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import clickupExtension from "../index.ts";
import { SPEC_URLS } from "../client.ts";

type AnyTool = ToolDefinition<any, any, any>;

function tools(): Record<string, AnyTool> {
  const registered: Record<string, AnyTool> = {};
  clickupExtension({ registerTool: (tool: AnyTool) => { registered[tool.name] = tool; } } as unknown as ExtensionAPI);
  return registered;
}

test("declares sequential execution so concurrent confirmations cannot race the dialog", async () => {
  // clickup_api opens a blocking ctx.ui.confirm() dialog for every DELETE and file upload.
  // Pi's agent loop runs same-turn tool calls in parallel unless a tool declares
  // executionMode "sequential" - without that flag, two concurrent mutating/upload calls
  // in one turn could race the same TUI dialog and stall with no visible prompt, exactly
  // as observed and fixed in the sibling pi-teamwork extension. Guard the declaration
  // directly, since a full replay of Pi's parallel scheduler is out of scope here.
  assert.equal(tools().clickup_api.executionMode, "sequential");
});

test("clickup_download also declares sequential execution", () => {
  assert.equal(tools().clickup_download.executionMode, "sequential");
});

test("clickup_download requires a UI and confirms host, absolute destination, and overwrite flag", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-clickup-tool-test-")));
  const prompts: string[] = [];
  const ctx = (hasUI: boolean) => ({ hasUI, cwd, ui: { confirm: async (title: string, body: string) => { prompts.push(`${title}\n${body}`); return false; } } });
  const params = { url: "https://attachments.clickup.com/a/file.pdf?Signature=SIGNED-SECRET", path: "file.pdf" };
  const download = tools().clickup_download;

  await assert.rejects(download.execute("1", params, undefined, undefined, ctx(false) as any), /requires interactive confirmation/);
  assert.equal(prompts.length, 0);
  await assert.rejects(download.execute("2", params, undefined, undefined, ctx(true) as any), /cancelled/);
  assert.equal(prompts[0], `Download ClickUp attachment?\nHost: attachments.clickup.com\nDestination: ${join(cwd, "file.pdf")}\nOverwrite: no`);
  await assert.rejects(download.execute("3", { ...params, overwrite: true }, undefined, undefined, ctx(true) as any), /cancelled/);
  assert.equal(prompts[1], `Download ClickUp attachment?\nHost: attachments.clickup.com\nDestination: ${join(cwd, "file.pdf")}\nOverwrite: yes`);
});

test("clickup_download replaces an existing file after an approved overwrite confirmation", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-clickup-tool-test-")));
  await writeFile(join(cwd, "file.pdf"), "old");
  const prompts: string[] = [];
  const uiCtx = { hasUI: true, cwd, ui: { confirm: async (_title: string, body: string) => { prompts.push(body); return true; } } } as any;
  const previousFetch = globalThis.fetch;
  let authorization: string | null = "unset";
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("new", { headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  let result;
  try {
    result = await tools().clickup_download.execute("1",
      { url: "https://attachments.clickup.com/a/file.pdf?Signature=SIGNED-SECRET", path: "file.pdf", overwrite: true },
      undefined, undefined, uiCtx);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Overwrite: yes$/);
  assert.equal(authorization, null);
  assert.deepEqual(result.details, {});
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text),
    { path: join(cwd, "file.pdf"), bytes: 3, content_type: "application/pdf" });
  assert.equal(await readFile(join(cwd, "file.pdf"), "utf8"), "new");
  assert.equal((await stat(join(cwd, "file.pdf"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(cwd), ["file.pdf"]);
});

test("clickup_api rejects non-GET paginate before any confirmation or request", async () => {
  const prompts: string[] = [];
  const uiCtx = { hasUI: true, cwd: process.cwd(), ui: { confirm: async (title: string) => { prompts.push(title); return true; } } } as any;
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => { fetched = true; return Response.json({}); }) as typeof fetch;
  try {
    for (const params of [
      { method: "DELETE", path: "/v2/task/1", paginate: {} },
      { method: "POST", path: "/v2/task/1/attachment", files: [{ path: "package.json" }], paginate: {} },
    ]) {
      await assert.rejects(tools().clickup_api.execute("1", params, undefined, undefined, uiCtx), /only supported for GET/);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(prompts, []);
  assert.equal(fetched, false);
});

// Swap the global fetch and token for fakes; requestClickUp and loadOpenApiSpecs resolve both at call time.
async function withFakeClickUp<T>(handler: (url: URL) => Response, run: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.CLICKUP_API_TOKEN;
  process.env.CLICKUP_API_TOKEN = "test-token";
  globalThis.fetch = (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CLICKUP_API_TOKEN;
    else process.env.CLICKUP_API_TOKEN = previousToken;
  }
}

const ctx = { hasUI: false, cwd: process.cwd() } as any;

test("clickup_api output without paginate is unchanged", async () => {
  const result = await withFakeClickUp(
    () => Response.json({ id: "task-1" }, { headers: { "x-ratelimit-remaining": "99" } }),
    () => tools().clickup_api.execute("1", { method: "GET", path: "/v2/task/task-1" }, undefined, undefined, ctx),
  );
  assert.deepEqual(result, {
    content: [{ type: "text", text: '{\n  "id": "task-1"\n}' }],
    details: { status: 200, rate_limit: undefined, rate_limit_remaining: "99", rate_limit_reset: undefined },
  });
});

test("clickup_api paginate puts the summary on the first line even when the output is truncated", async () => {
  const v2Spec = {
    servers: [{ url: "https://api.clickup.com/api" }],
    paths: { "/v2/list/{list_id}/task": { get: { operationId: "GetTasks", parameters: [{ name: "page", in: "query" }] } } },
  };
  const page = (index: number) => Array.from({ length: 150 }, (_, item) => ({ id: `${index}-${item}`, name: "x".repeat(400) }));
  const result = await withFakeClickUp((url) => {
    if (url.href === SPEC_URLS.v2) return Response.json(v2Spec);
    if (url.href === SPEC_URLS.v3) return new Response("paths: {}\n");
    const index = Number(url.searchParams.get("page"));
    return Response.json({ tasks: page(index), last_page: index === 1 });
  }, () => tools().clickup_api.execute("1", { method: "GET", path: "/v2/list/1/task", paginate: {} }, undefined, undefined, ctx));

  const text = (result.content[0] as { text: string }).text;
  const firstLine = text.split("\n")[0];
  assert.match(firstLine, /^\[paginated pages=\d+ items=\d+ merged_field=\S+ stopped_by=[a-z_]+\]$/);
  assert.equal(firstLine, "[paginated pages=2 items=300 merged_field=tasks stopped_by=last_page]");
  assert.match(text, /\[Output truncated: /);
  assert.deepEqual(result.details.paginated, { pages: 2, items: 300, merged_field: "tasks", stopped_by: "last_page" });
  assert.ok(result.details.full_output);
});

test("clickup_api escapes and bounds a response-controlled merge key in the summary line", async () => {
  const v2Spec = {
    servers: [{ url: "https://api.clickup.com/api" }],
    paths: { "/v2/list/{list_id}/task": { get: { operationId: "GetTasks", parameters: [{ name: "page", in: "query" }] } } },
  };
  for (const key of ["my tasks\n[paginated pages=99]", "k".repeat(5_000)]) {
    const result = await withFakeClickUp((url) => {
      if (url.href === SPEC_URLS.v2) return Response.json(v2Spec);
      if (url.href === SPEC_URLS.v3) return new Response("paths: {}\n");
      return Response.json({ [key]: [{ id: 1 }], last_page: true });
    }, () => tools().clickup_api.execute("1", { method: "GET", path: "/v2/list/1/task", paginate: {} }, undefined, undefined, ctx));
    const firstLine = (result.content[0] as { text: string }).text.split("\n")[0];
    assert.match(firstLine, /^\[paginated pages=1 items=1 merged_field=\S{1,200} stopped_by=last_page\]$/);
    assert.equal(result.details.paginated.merged_field, key);
  }
});
