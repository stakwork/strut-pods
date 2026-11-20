/**
 * What every step of the package shares (PLAN.md §8): a call to the pods
 * service, the job's pod from its hold, and a command run in the pod.
 *
 * The service is at `PODS_URL`, with the box's tenant token in
 * `PODS_TOKEN`. A pod's podd is behind the service, at
 * `/pods/<pod>/podd/...` (pod/README.md has podd's routes).
 */

export const RELEASE = "stadeum/pods/release";
const KIND = "pod";

export interface Ctx {
  job?: string;
  control?: { state?: string };
  services: {
    http: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: unknown; timeout?: number }) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: unknown }>;
    secrets: { get(name: string): Promise<string | undefined> };
    jobs?: {
      hold(job: string, hold: { id: string; kind: string; release: { type: string; input: unknown }; note?: string; url?: string }): Promise<void>;
      release(job: string, id: string): Promise<void>;
      holds(job: string): Promise<Array<{ id: string; kind: string; note?: string; url?: string }>>;
    };
  };
}

export interface Reply {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

/** A call to the pods service. Never throws for an HTTP status. */
export async function call(ctx: Ctx, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Reply> {
  const base = await ctx.services.secrets.get("PODS_URL");
  const token = await ctx.services.secrets.get("PODS_TOKEN");
  if (!base || !token) throw new Error("pods: PODS_URL and PODS_TOKEN aren't set on this strut");
  return ctx.services.http(`${base.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body }),
    timeout: timeoutMs,
  });
}

/** The service's error, in a line. */
export function problem(what: string, r: Reply): Error {
  const b = r.body as { error?: string } | string | undefined;
  const text = typeof b === "string" ? b : b?.error ?? JSON.stringify(b);
  return new Error(`${what}: ${r.status} ${String(text).slice(0, 500)}`);
}

/** A call that must succeed: its body, or an error naming what failed. */
export async function must<T = unknown>(ctx: Ctx, what: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const r = await call(ctx, method, path, body, timeoutMs);
  if (!r.ok) throw problem(what, r);
  return r.body as T;
}

export interface Held {
  pod: string;
  workspace: string;
  url?: string;
}

function jobsOf(ctx: Ctx) {
  const jobs = ctx.services.jobs;
  if (!ctx.job || !jobs) throw new Error("pods: a pod belongs to a job, and this run has none. Launch it as a job");
  return { job: ctx.job, jobs };
}

/** The job's pod, from its hold, or none. */
export async function held(ctx: Ctx): Promise<Held | undefined> {
  const { job, jobs } = jobsOf(ctx);
  const h = (await jobs.holds(job)).find((x) => x.kind === KIND);
  return h ? { pod: h.id, workspace: h.note ?? "", ...(h.url ? { url: h.url } : {}) } : undefined;
}

/** The job's pod, or an error saying to claim one. */
export async function pod(ctx: Ctx): Promise<Held> {
  const h = await held(ctx);
  if (!h) throw new Error("this job has no pod yet: call claim with the workspace first");
  return h;
}

/** Records the job's hold on its pod: `{ pod, workspace }` and a link to
 *  its app for the job's checks. Never a secret: the agent can read holds. */
export async function hold(ctx: Ctx, h: Held): Promise<void> {
  const { job, jobs } = jobsOf(ctx);
  await jobs.hold(job, {
    id: h.pod,
    kind: KIND,
    release: { type: RELEASE, input: { pod: h.pod } },
    note: h.workspace,
    ...(h.url ? { url: h.url } : {}),
  });
}

/** `/pods/<pod>/podd<path>`. */
export const podd = (p: string, path: string) => `/pods/${encodeURIComponent(p)}/podd${path}`;

/** An absolute path in the pod: as given, or under `/workspaces`. */
export function inPod(path: string): string {
  const p = path.startsWith("/") ? path : `/workspaces/${path}`;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** podd's files route for a path, each segment encoded. */
export const filesPath = (p: string, path: string) =>
  podd(p, `/files${inPod(path).split("/").map(encodeURIComponent).join("/")}`);

export interface Ran {
  output: string;
  exit_code: number | null;
  signal: number | null;
  timed_out: boolean;
  killed: boolean;
  cancelled: boolean;
  /** Characters cut from the start of `output`. */
  cut: number;
}

/** Keeps the end of a long output. */
const KEEP_CHARS = 60_000;

/**
 * Runs `cmd` with bash in the pod and waits for it, following its output.
 * `env` is for this command alone. A run that's cancelling kills it.
 */
export async function run(
  ctx: Ctx,
  p: string,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } = {},
): Promise<Ran> {
  const timeout = opts.timeoutSeconds ?? 300;
  const started = await must<{ id: string }>(ctx, "exec in the pod", "POST", podd(p, "/exec"), {
    cmd,
    cwd: inPod(opts.cwd ?? "/workspaces"),
    timeout,
    ...(opts.env ? { env: opts.env } : {}),
  });
  let output = "";
  let cut = 0;
  let offset = 0;
  let cancelled = false;
  for (;;) {
    if (!cancelled && ctx.control?.state === "cancelling") {
      cancelled = true;
      await call(ctx, "POST", podd(p, `/exec/${started.id}/kill`));
    }
    const r = await call(ctx, "GET", `${podd(p, `/exec/${started.id}`)}?offset=${offset}&wait=20`, undefined, 40_000);
    if (!r.ok) {
      // A long poll that timed out on the way is read again.
      if (r.status === 0 || r.status === 502 || r.status === 504) continue;
      throw problem("reading the command's output", r);
    }
    const o = r.body as { output: string; next: number; running: boolean; exit_code: number | null; signal: number | null; timed_out: boolean; killed: boolean };
    output += o.output;
    if (output.length > KEEP_CHARS) {
      cut += output.length - KEEP_CHARS;
      output = output.slice(-KEEP_CHARS);
    }
    offset = o.next;
    if (!o.running) {
      return { output, exit_code: o.exit_code, signal: o.signal, timed_out: o.timed_out, killed: o.killed, cancelled, cut };
    }
  }
}

/** A command's result as strut's own `bash` gives it. */
export function shown(r: Ran, timeoutSeconds: number): string {
  const out = (r.cut ? `[... ${r.cut} earlier characters cut ...]\n` : "") + r.output;
  if (r.cancelled) return `Command cancelled: the run is being cancelled${out ? `\n${out}` : ""}`;
  if (r.timed_out) return `Command execution failed: Error: Command timed out after ${timeoutSeconds}s (its process group was killed)${out ? `\n${out}` : ""}`;
  if (r.exit_code === 0) return out;
  if (r.exit_code === 1 && !out) return "No matches found";
  const how = r.exit_code === null ? `killed by signal ${r.signal ?? "?"}` : String(r.exit_code);
  return `Command execution failed: Error: Command failed (${how}): ${out || "Unknown error"}`;
}

/** Single-quotes a word for bash. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
