import { randomBytes } from "node:crypto";
import {
  close, closeSync, constants, fstatSync, fsync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, write,
  type BigIntStats,
} from "node:fs";
import { lstat, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

export const SPEC_URLS = {
  v2: "https://developer.clickup.com/openapi/clickup-api-v2-reference.json",
  v3: "https://developer.clickup.com/openapi/ClickUp_PUBLIC_API_V3.yaml",
} as const;

export type ApiVersion = keyof typeof SPEC_URLS;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | Array<string | number | boolean>;
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UploadFile {
  path: string;
  field?: string;
  content_type?: string;
}

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  files?: UploadFile[];
  cwd?: string;
  timeout_ms?: number;
}

export interface ApiResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export interface RequestOptions {
  token?: string;
  signal?: AbortSignal;
  fetchImpl?: Fetcher;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface OpenApiOperation {
  version: ApiVersion;
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: unknown[];
  requestBody?: unknown;
  responseCodes: string[];
  raw: Record<string, unknown>;
  spec: Record<string, unknown>;
}

export class ClickUpApiError extends Error {
  readonly status: number;
  readonly response: string;

  constructor(status: number, message: string, response: string) {
    super(message);
    this.name = "ClickUpApiError";
    this.status = status;
    this.response = response;
  }
}

export interface PaginateOptions {
  max_pages?: number;
  max_items?: number;
  max_duration_ms?: number;
}

export interface PaginationRecord {
  pages: number;
  items: number;
  merged_field: string | null;
  stopped_by: "last_page" | "short_page" | "empty_page" | "no_cursor" | "max_pages" | "max_items" | "deadline" | "error";
  next_page?: number;
  next_cursor?: string | null;
  overflowed_by?: number;
  error?: string;
}

export interface PaginatedResult extends ApiResult {
  paginated: PaginationRecord;
}

// Exact hosts or anchored patterns, compared against URL.hostname. Unknown media hosts fail closed.
export const ATTACHMENT_HOSTS: ReadonlyArray<string | RegExp> = [
  "attachments.clickup.com",
  "attachments-public.clickup.com",
  "attachments2.clickup.com",
  /^t\d+\.p\.clickup-attachments\.com$/,
];

export interface DownloadRequest {
  url: string;
  path?: string;
  overwrite?: boolean;
  max_bytes?: number;
  timeout_ms?: number;
  cwd?: string;
}

export interface DownloadOptions {
  signal?: AbortSignal;
  fetchImpl?: Fetcher;
  confirm?: (target: { host: string; destination: string; overwrite: boolean }) => Promise<boolean>;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  content_type: string | null;
}

export async function getToken(tokenPath = resolve(homedir(), ".config/cu/token")): Promise<string> {
  const token = process.env.CLICKUP_API_TOKEN ?? process.env.CLICKUP_TOKEN;
  if (token?.trim()) return token.trim();

  try {
    const saved = (await readFile(tokenPath, "utf8")).trim();
    if (saved) return saved;
  } catch {
    // The setup error below is clearer than a filesystem error.
  }

  const legacyToken = process.env.CLICKUP_API_KEY;
  if (legacyToken?.trim()) return legacyToken.trim();
  throw new Error("ClickUp token not configured. Run `cu token` locally or set CLICKUP_API_TOKEN.");
}

export function normalizeApiPath(input: string): string {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) throw new Error("Use a ClickUp API path, not a full URL.");
  if (path.includes("?") || path.includes("#")) throw new Error("Put query parameters in the query object.");
  if (!path.startsWith("/")) path = `/${path}`;
  if (/^\/v[23](\/|$)/.test(path)) path = `/api${path}`;
  if (!/^\/api\/v[23](\/|$)/.test(path)) throw new Error("Path must begin with /api/v2/ or /api/v3/.");
  return path;
}

export function buildUrl(path: string, query: Record<string, QueryValue> = {}): URL {
  const normalized = normalizeApiPath(path);
  if (/%(?:2e|2f|5c)/i.test(normalized)) throw new Error("Encoded path traversal characters are not allowed.");
  const url = new URL(normalized, "https://api.clickup.com");
  if (url.origin !== "https://api.clickup.com" || !/^\/api\/v[23](\/|$)/.test(url.pathname)) {
    throw new Error("Resolved path must remain under https://api.clickup.com/api/v2 or /api/v3.");
  }
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, item === null ? "" : String(item));
  }
  return url;
}

export async function requestClickUp(input: ApiRequest, options: RequestOptions = {}): Promise<ApiResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const token = options.token ?? await getToken();
  const url = buildUrl(input.path, input.query);
  const attempts = 3;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const headers = new Headers({ Accept: "application/json", Authorization: token });
    const body = await makeBody(input, headers);
    const timeout = AbortSignal.timeout(input.timeout_ms ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    // A followed redirect would carry the token off /api/v2|v3 and skip eligibility checks.
    const response = await fetchImpl(url, { method: input.method, headers, body, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      const target = redirectHost(response, url);
      throw new ClickUpApiError(response.status, `ClickUp API redirect ${response.status}${target ? ` to ${target}` : ""} refused; credentialed requests never follow redirects.`, "");
    }
    const text = await response.text();

    if (attempt < attempts - 1 && response.status === 429) {
      await sleepImpl(rateLimitDelay(response.headers, attempt), options.signal);
      continue;
    }

    if (attempt < attempts - 1 && input.method === "GET" && [502, 503, 504].includes(response.status)) {
      await sleepImpl(500 * 2 ** attempt, options.signal);
      continue;
    }

    if (!response.ok) {
      const excerpt = text.length > 8_000 ? `${text.slice(0, 8_000)}…` : text;
      throw new ClickUpApiError(response.status, `ClickUp API ${response.status} ${response.statusText}`, excerpt);
    }

    return {
      status: response.status,
      data: parseResponse(text, response.headers.get("content-type")),
      headers: Object.fromEntries(response.headers.entries()),
    };
  }

  throw new Error("ClickUp request failed after retries.");
}

export async function paginateClickUp(
  input: ApiRequest,
  paginate: PaginateOptions,
  getOperations: () => Promise<OpenApiOperation[]>,
  options: RequestOptions = {},
): Promise<PaginatedResult> {
  if (input.method !== "GET") throw new Error(PAGINATE_GET_ONLY);
  const maxPages = positive(paginate.max_pages, 5, 20, "max_pages");
  const maxItems = positive(paginate.max_items, 500, 5_000, "max_items");
  const maxDuration = positive(paginate.max_duration_ms, 60_000, 120_000, "max_duration_ms");
  const rawPage = input.query?.page;
  const startPage = rawPage === undefined ? 0
    : typeof rawPage === "number" ? rawPage
    : typeof rawPage === "string" && /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
  // Every page the loop may request must stay exactly representable, or increment repeats a page.
  if (!Number.isSafeInteger(startPage) || startPage < 0 || !Number.isSafeInteger(startPage + maxPages)) {
    throw new Error("query.page must be a non-negative integer within the safe integer range.");
  }

  // The budget starts before the spec lookup so a cold cache cannot outlive it or the caller's signal.
  const deadline = AbortSignal.timeout(maxDuration);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let operations: OpenApiOperation[];
  try {
    signal.throwIfAborted(); // never start a lookup nobody will await
    operations = await untilAborted(getOperations(), signal);
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw new Error("Pagination max_duration_ms elapsed while loading the ClickUp specification.");
    throw error;
  }
  const path = buildUrl(input.path).pathname;
  const operation = operations
    .filter(item => item.method === "GET" && templatePattern(requestTemplate(item)).test(path))
    .sort((a, b) => a.path.split("{").length - b.path.split("{").length)[0];
  const mode = operation && pagingParameter(operation);
  if (!mode) {
    const capable = operations.filter(item => item.method === "GET" && pagingParameter(item)).map(item => `GET ${requestTemplate(item)}`);
    const reason = operation ? `${operation.id} declares no page or cursor query parameter` : `no documented GET operation matches ${path}`;
    throw new Error(`Cannot paginate: ${reason}. Paging-capable operations:\n${capable.join("\n")}`);
  }

  let position: number | string | undefined = mode === "page" ? startPage : input.query?.cursor as string | undefined;
  let fetchedPage = startPage; // last page received, merged or not
  let first: unknown;
  let last: ApiResult | undefined;
  let key: string | null = null;
  const merged: unknown[] = [];
  let previousSize: number | undefined;
  const record: PaginationRecord = { pages: 0, items: 0, merged_field: null, stopped_by: "error" };

  for (;;) {
    let response: ApiResult;
    try {
      const query = position === undefined ? input.query : { ...input.query, [mode]: position };
      response = await requestClickUp({ ...input, query }, { ...options, signal });
    } catch (error) {
      // A caller abort and any first-page failure propagate; only later pages return a labelled partial.
      if (options.signal?.aborted || record.pages === 0) throw error;
      record.stopped_by = deadline.aborted ? "deadline" : "error";
      if (!deadline.aborted) record.error = requestErrorMessage(error);
      break;
    }

    if (typeof position === "number") fetchedPage = position;
    const body = response.data;
    if (record.pages === 0) key = mergeKey(body);
    const items = pageItems(body, key);
    if (record.pages > 0 && record.items + items.length > maxItems) {
      record.stopped_by = "max_items";
      break;
    }
    if (record.pages === 0) {
      first = body;
      if (items.length > maxItems) record.overflowed_by = items.length - maxItems;
    }
    merged.push(...items);
    last = response;
    record.pages++;
    record.items += items.length;

    let next: number | string | undefined;
    if (mode === "page") {
      const lastPage = isRecord(body) ? body.last_page : undefined;
      if (lastPage !== undefined) {
        if (lastPage === true) record.stopped_by = "last_page";
      } else if (previousSize !== undefined && items.length < previousSize) record.stopped_by = "short_page";
      else if (items.length === 0) record.stopped_by = "empty_page";
      next = (position as number) + 1;
    } else {
      const cursor = isRecord(body) ? body.next_cursor : undefined;
      if (typeof cursor === "string" && cursor !== "" && cursor !== position) next = cursor;
      else record.stopped_by = "no_cursor";
    }
    if (next === undefined || record.stopped_by === "last_page" || record.stopped_by === "short_page" || record.stopped_by === "empty_page") break;

    previousSize = items.length;
    position = next;
    if (record.items >= maxItems) record.stopped_by = "max_items";
    else if (record.pages >= maxPages) record.stopped_by = "max_pages";
    else if (deadline.aborted) record.stopped_by = "deadline";
    else continue;
    break;
  }

  if (["max_pages", "max_items", "deadline", "error"].includes(record.stopped_by)) {
    if (mode === "page") record.next_page = position as number;
    else record.next_cursor = (position as string | undefined) ?? null;
  }
  record.merged_field = key;

  let data: unknown = merged;
  if (key !== null) {
    // Page-1 metadata plus the merged array only; other page-1 arrays would masquerade as merged results.
    const object: Record<string, unknown> = Object.fromEntries(Object.entries(first as Record<string, unknown>)
      .filter(([name, value]) => name === key || !Array.isArray(value))
      .map(([name, value]) => [name, name === key ? merged : value]));
    if (mode === "page") {
      object.page = fetchedPage;
      object.last_page = record.stopped_by === "last_page";
    }
    delete object.cursor;
    delete object.next_cursor;
    data = object;
  }
  return { status: last!.status, headers: last!.headers, data, paginated: record };
}

export const PAGINATE_GET_ONLY = "paginate is only supported for GET; mutations are never replayed.";

// Status text and parser messages are server-controlled, so details only ever carry fixed wording.
function requestErrorMessage(error: unknown): string {
  if (error instanceof ClickUpApiError) return `ClickUp API returned HTTP ${error.status}.`;
  if (error instanceof SyntaxError) return "ClickUp returned a response that is not valid JSON.";
  return "Request failed.";
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    // Attach first so a lookup rejecting after an abort is still handled.
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function redirectHost(response: Response, base: URL): string | undefined {
  const location = response.headers.get("location");
  if (!location) return undefined;
  try {
    return new URL(location, base).hostname || undefined;
  } catch {
    return undefined; // never echo the raw Location: it may carry a signed query
  }
}

function positive(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return Math.min(value, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// v2 spec paths omit the server base (`/v2/...` under `.../api`); prefix it to get the request form.
function requestTemplate(operation: OpenApiOperation): string {
  const server = (operation.spec.servers as Array<{ url?: string }> | undefined)?.[0]?.url;
  return (server ? new URL(server, "https://api.clickup.com").pathname.replace(/\/$/, "") : "") + operation.path;
}

function templatePattern(template: string): RegExp {
  return new RegExp(`^${template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
}

function pagingParameter(operation: OpenApiOperation): "page" | "cursor" | undefined {
  const names = (resolveLocalRefs(operation.parameters, operation.spec) as unknown[])
    .filter(isRecord).filter(parameter => parameter.in === "query").map(parameter => parameter.name);
  return names.includes("page") ? "page" : names.includes("cursor") ? "cursor" : undefined;
}

function mergeKey(body: unknown): string | null {
  if (Array.isArray(body)) return null;
  if (isRecord(body)) {
    for (const [key, value] of Object.entries(body)) if (Array.isArray(value) && value.every(isRecord)) return key;
  }
  throw new Error("Cannot paginate: the first page has no array of objects to merge.");
}

function pageItems(body: unknown, key: string | null): unknown[] {
  const items = key === null ? body : isRecord(body) ? body[key] : undefined;
  if (!Array.isArray(items) || (key !== null && !items.every(isRecord))) {
    throw new Error(`Cannot paginate: a page does not expose the same ${key === null ? "array body" : `"${key}" array of objects`} as page 1.`);
  }
  return items;
}

export function attachmentUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Attachment URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new Error("Attachment URL must use https on the default port without userinfo.");
  }
  if (!ATTACHMENT_HOSTS.some(host => typeof host === "string" ? host === url.hostname : host.test(url.hostname))) {
    throw new Error(`Attachment host is not allowed: ${url.hostname}`);
  }
  return url;
}

// Never receives or sends a ClickUp token: attachment hosts are fetched anonymously.
export async function downloadAttachment(input: DownloadRequest, options: DownloadOptions = {}): Promise<DownloadResult> {
  const url = attachmentUrl(input.url);
  const host = url.hostname;
  const maxBytes = positive(input.max_bytes, 25 * 1024 * 1024, 100 * 1024 * 1024, "max_bytes");
  const timeoutMs = positive(input.timeout_ms, 30_000, 120_000, "timeout_ms");
  const overwrite = input.overwrite === true;

  let directory: string;
  let name: string;
  if (input.path === undefined) {
    directory = await realpath(await mkdtemp(join(tmpdir(), "pi-clickup-download-")));
    name = safeName(basename(url.pathname));
  } else {
    const cwd = input.cwd ?? process.cwd();
    const root = await realpath(cwd);
    const target = resolve(cwd, input.path);
    directory = await realpath(dirname(target)).catch(() => {
      throw new Error("Destination directory does not exist.");
    });
    if (directory !== root && !directory.startsWith(root + sep)) throw new Error("Destination must be inside the working directory.");
    name = safeName(basename(target));
  }
  const pinned = await stat(directory, { bigint: true });
  const destination = join(directory, name);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing && !overwrite) {
    throw new Error(`Destination already exists${existing.isSymbolicLink() ? " as a symlink" : ""}; pass overwrite: true to replace it.`);
  }
  if (options.confirm && !await options.confirm({ host, destination, overwrite })) {
    throw new Error("ClickUp download cancelled; explicit interactive confirmation is required.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  // Overwrite stages beside the destination and renames over it only once the whole body passed every check.
  // The staging name ignores the destination so a 255-byte legal name cannot overflow the component limit.
  const file = overwrite ? join(directory, `.pi-clickup-${randomBytes(8).toString("hex")}.part`) : destination;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fd: number | undefined;
  let created: BigIntStats | undefined;
  try {
    response = await fetchImpl(url, { redirect: "manual", signal });
    const { status } = response;
    if (status >= 300 && status < 400) {
      const target = redirectHost(response, url);
      throw new ClickUpApiError(status, `Redirect refused: ${host} returned ${status}${target ? ` to ${target}` : ""}.`, "");
    }
    if (status === 401 || status === 403) {
      throw new ClickUpApiError(status, `Attachment host ${host} returned ${status}; the URL needs credentials that pi-clickup will not send.`, "");
    }
    if (!response.ok) throw new ClickUpApiError(status, `Attachment host ${host} returned ${status}.`, "");
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new ClickUpApiError(status, `Attachment from ${host} exceeds max_bytes (${maxBytes}).`, "");
    }

    // shortcut: Node exposes no openat/fchdir, so path operations re-verify the pinned directory synchronously
    // right before each syscall; the residual race is syscall-wide. Upgrade when Node gains dirfd-relative ops.
    assertDirectory(directory, pinned);
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = fstatSync(fd, { bigint: true });
    assertOwnFile(directory, pinned, file, created);
    let bytes = 0;
    reader = response.body?.getReader();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      signal.throwIfAborted();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new ClickUpApiError(status, `Attachment from ${host} exceeds max_bytes (${maxBytes}).`, "");
      for (let offset = 0; offset < chunk.value.byteLength;) offset += (await writeAsync(fd, chunk.value, offset)).bytesWritten;
    }
    await fsyncAsync(fd);
    const closing = fd;
    fd = undefined;
    await closeAsync(closing);
    // Synchronous from here to the commit: the timer may not have fired yet, so compare the clock too.
    signal.throwIfAborted();
    if (performance.now() - started >= timeoutMs) throw new DOMException("Download deadline elapsed.", "TimeoutError");
    if (overwrite) {
      assertOwnFile(directory, pinned, file, created);
      renameSync(file, destination); // replaces a symlink itself, never its target
    }
    created = undefined;
    return { path: destination, bytes, content_type: mediaType(response.headers.get("content-type")) };
  } catch (error) {
    await (reader ?? response?.body)?.cancel().catch(() => {});
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        assertOwnFile(directory, pinned, file, created);
        unlinkSync(file);
      } catch {
        // Never unlink a path that no longer resolves to the file this call created.
      }
    }
    // Never surface the response body or the signed query string; status and host only.
    if (error instanceof ClickUpApiError || error instanceof DestinationChanged) throw error;
    const errno = (error as NodeJS.ErrnoException | undefined)?.code; // DOMException.code is numeric
    const code = typeof errno === "string" ? errno : error instanceof Error ? error.name : "error";
    throw new Error(`Attachment download from ${host} failed (${code}).`);
  }
}

const writeAsync = promisify(write);
const fsyncAsync = promisify(fsync);
const closeAsync = promisify(close);

class DestinationChanged extends Error {
  constructor() {
    super("Destination directory changed after it was verified; the download was abandoned.");
  }
}

function assertDirectory(directory: string, pinned: BigIntStats): void {
  const now = statSync(directory, { bigint: true });
  if (realpathSync(directory) !== directory || now.dev !== pinned.dev || now.ino !== pinned.ino) throw new DestinationChanged();
}

function assertOwnFile(directory: string, pinned: BigIntStats, file: string, created: BigIntStats): void {
  assertDirectory(directory, pinned);
  const now = lstatSync(file, { bigint: true });
  if (now.dev !== created.dev || now.ino !== created.ino) throw new DestinationChanged();
}

// Content-Type parameters can carry signed values; return only a well-formed type/subtype.
function mediaType(header: string | null): string | null {
  const type = header?.split(";")[0].trim().toLowerCase();
  return type && type.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : null;
}

function safeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.*$/.test(clean) ? "download" : clean;
}

async function makeBody(input: ApiRequest, headers: Headers): Promise<BodyInit | undefined> {
  if (input.files?.length) {
    const form = new FormData();
    appendFormValues(form, input.body);
    for (const [index, file] of input.files.entries()) {
      const path = resolve(input.cwd ?? process.cwd(), file.path.replace(/^@/, ""));
      form.append(
        file.field ?? `attachment[${index}]`,
        new Blob([await readFile(path)], file.content_type ? { type: file.content_type } : undefined),
        basename(path),
      );
    }
    return form;
  }

  if (input.body === undefined) return undefined;
  headers.set("Content-Type", "application/json");
  return JSON.stringify(input.body);
}

function appendFormValues(form: FormData, body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== "object" || Array.isArray(body)) throw new Error("Multipart body must be an object.");
  for (const [key, value] of Object.entries(body)) {
    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function parseResponse(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.includes("json")) return JSON.parse(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function rateLimitDelay(headers: Headers, attempt: number): number {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(60_000, Math.max(100, reset * 1_000 - Date.now() + 100));
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(60_000, retryAfter * 1_000);
  return 1_000 * 2 ** attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function loadOpenApiSpecs(fetchImpl: Fetcher = fetch): Promise<Record<ApiVersion, Record<string, unknown>>> {
  const [v2Response, v3Response] = await Promise.all([fetchImpl(SPEC_URLS.v2), fetchImpl(SPEC_URLS.v3)]);
  if (!v2Response.ok) throw new Error(`Could not load ClickUp v2 specification (${v2Response.status}).`);
  if (!v3Response.ok) throw new Error(`Could not load ClickUp v3 specification (${v3Response.status}).`);
  return {
    v2: await v2Response.json() as Record<string, unknown>,
    v3: parseYaml(await v3Response.text()) as Record<string, unknown>,
  };
}

export function extractOperations(specs: Record<ApiVersion, Record<string, unknown>>): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const version of ["v2", "v3"] as const) {
    const spec = specs[version];
    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"] as const) {
        const raw = pathItem[method] as Record<string, unknown> | undefined;
        if (!raw) continue;
        operations.push({
          version,
          id: String(raw.operationId ?? `${method}-${path}`),
          method: method.toUpperCase() as HttpMethod,
          path,
          summary: String(raw.summary ?? ""),
          description: String(raw.description ?? ""),
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
          parameters: [...((pathItem.parameters as unknown[] | undefined) ?? []), ...((raw.parameters as unknown[] | undefined) ?? [])],
          requestBody: raw.requestBody,
          responseCodes: Object.keys((raw.responses as Record<string, unknown> | undefined) ?? {}),
          raw,
          spec,
        });
      }
    }
  }
  return operations;
}

export function searchOperations(operations: OpenApiOperation[], query: string, version: ApiVersion | "all" = "all"): OpenApiOperation[] {
  const needle = query.trim().toLowerCase();
  return operations
    .filter(operation => version === "all" || operation.version === version)
    .map(operation => ({ operation, score: operationScore(operation, needle) }))
    .filter(match => !needle || match.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id))
    .map(match => match.operation);
}

export function operationDetail(operation: OpenApiOperation): Record<string, unknown> {
  return {
    version: operation.version,
    operation_id: operation.id,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description,
    tags: operation.tags,
    parameters: resolveLocalRefs(operation.parameters, operation.spec),
    request_body: resolveLocalRefs(operation.requestBody, operation.spec),
    response_codes: operation.responseCodes,
  };
}

function operationScore(operation: OpenApiOperation, needle: string): number {
  if (!needle) return 1;
  const id = operation.id.toLowerCase();
  const path = operation.path.toLowerCase();
  if (id === needle) return 1_000;
  if (path === needle) return 900;
  let score = id.includes(needle) ? 100 : 0;
  if (path.includes(needle)) score += 80;
  if (operation.summary.toLowerCase().includes(needle)) score += 60;
  if (operation.tags.some(tag => tag.toLowerCase().includes(needle))) score += 40;
  if (operation.description.toLowerCase().includes(needle)) score += 10;
  return score;
}

function resolveLocalRefs(value: unknown, spec: Record<string, unknown>, depth = 0, seen = new Set<string>()): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => resolveLocalRefs(item, spec, depth + 1, new Set(seen)));

  const object = value as Record<string, unknown>;
  if (typeof object.$ref === "string" && object.$ref.startsWith("#/")) {
    if (seen.has(object.$ref)) return { $ref: object.$ref, circular: true };
    const target = object.$ref.slice(2).split("/").reduce<unknown>((current, key) =>
      current && typeof current === "object" ? (current as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
    spec);
    if (target === undefined) return object;
    const nextSeen = new Set(seen).add(object.$ref);
    return resolveLocalRefs(target, spec, depth + 1, nextSeen);
  }

  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveLocalRefs(item, spec, depth + 1, new Set(seen))]));
}
