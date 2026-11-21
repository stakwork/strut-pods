/**
 * What every step of the package shares (PLAN.md §8): a call to the pods
 * service, the job's pod from its hold, a command run in the pod, git's
 * credential for one command, and a workspace's repositories from the
 * graph.
 *
 * The service is at `PODS_URL`, with the box's tenant token in
 * `PODS_TOKEN`. A pod's podd is behind the service, at
 * `/pods/<pod>/podd/...` (pod/README.md has podd's routes).
 */

export const RELEASE = "stadeum/pods/release";
const KIND = "pod";

interface StepDef {
  input: { parse(v: unknown): unknown };
  run(cfg: unknown, ctx: unknown): Promise<unknown>;
}

export interface Ctx {
  job?: string;
  /** The run's person: whose tokens `secrets.git` reads. */
  actor?: string;
  principal?: string;
  control?: { state?: string };
  /** Strut's steps, `graph/*` among them, run with this step's context. */
  registry?: Record<string, StepDef | undefined>;
  services: {
    http: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: unknown; timeout?: number }) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: unknown }>;
    /** `git(url)`: the run's token for the repository's host (strut's map
     *  by host), there because strut.yaml says `requires.git: true`. */
    secrets: { get(name: string): Promise<string | undefined>; git?(url: string): Promise<string | undefined> };
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

// ── git ───────────────────────────────────────────────────────────────────

/** The helper git runs for a credential, as strut's own does (its
 *  src/steps/lib/git/_shared.ts): on `get`, it reads the request's `host=`
 *  line and answers only when that is the token's host, with the token from
 *  the command's environment. So the token is never in the command, a
 *  remote's URL or the pod's disk, and a redirect to another host gets
 *  nothing. `x-access-token` is the user name GitHub takes with a token;
 *  GitLab and Forgejo take any. */
const HELPER =
  '!f() { test "$1" = get || return 0; h=; ' +
  'while IFS= read -r l; do case "$l" in host=*) h="${l#host=}";; esac; done; ' +
  `test "$(printf %s "$h" | tr '[:upper:]' '[:lower:]')" = "$POD_GIT_HOST" || return 0; ` +
  'echo username=x-access-token; echo "password=$POD_GIT_TOKEN"; }; f';

/** The host a token for `url` would serve (`github.com`,
 *  `git.acme.com:3000`), when it is an https address. Never plain http: a
 *  pod's `localhost` is the pod, not strut's machine. */
export function httpsHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** git's credential for one command on the repository at `url`. */
export interface GitAuth {
  /** git's options, before its command: every helper of the pod's dropped,
   *  token or not, so none answers or keeps one; with a token, the one
   *  that answers its host alone. */
  config: string;
  /** The command's own environment: no prompt, and the token for the helper. */
  env: Record<string, string>;
  /** The host a token would serve, with one or without. */
  host?: string;
  token: boolean;
  /** `s` with the token cut out. */
  hide(s: string): string;
}

/** The run's token for `url`'s host (`secrets.git`: the person's own, by
 *  strut's map of hosts), for one git command. None for a host the person
 *  has none for, or an address that isn't https. */
export async function gitAuth(ctx: Ctx, url: string | undefined): Promise<GitAuth> {
  const host = url ? httpsHost(url) : undefined;
  const token = host ? await ctx.services.secrets.git?.(url!) : undefined;
  const base = { config: "-c credential.helper= ", env: { GIT_TERMINAL_PROMPT: "0" }, ...(host ? { host } : {}) };
  if (!token || !host) return { ...base, token: false, hide: (s) => s };
  return {
    config: `${base.config}-c ${quote(`credential.helper=${HELPER}`)} `,
    env: { ...base.env, POD_GIT_TOKEN: token, POD_GIT_HOST: host },
    host,
    token: true,
    hide: (s) => s.split(token).join("***"),
  };
}

/** What git says when a remote asks for a sign-in it didn't get. */
const SIGN_IN = /could not read (Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied/i;

/** A git command's failure said for the person, when the remote asked for a
 *  sign-in and the run had no token for its host: whose account isn't
 *  connected, for which host. Undefined for any other failure. */
export function signIn(ctx: Ctx, url: string, auth: GitAuth, output: string): string | undefined {
  if (auth.token || !auth.host || !SIGN_IN.test(output)) return undefined;
  const who = ctx.principal ?? ctx.actor ?? "the person running this job";
  return `${url} asks for a sign-in (it is private, or not there), and no account on ${auth.host} is connected for ${who}: connect one, then try again.`;
}

// ── a workspace's repositories ────────────────────────────────────────────

/** A repository of a workspace, as the graph holds it. */
export interface Repository {
  url: string;
  name: string;
}

/** A repository's folder under /workspaces: one plain name. */
export const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Strut's own `graph/<step>`, run with this step's context so its rules
 *  hold as for any other caller. Undefined when this strut has no graph. A
 *  graph step answers a failure as text. */
async function graph<T>(ctx: Ctx, step: string, config: Record<string, unknown>): Promise<T | string | undefined> {
  const def = ctx.registry?.[`graph/${step}`];
  return def ? ((await def.run(def.input.parse(config), ctx)) as T | string) : undefined;
}

interface Found {
  ref_id: string;
  properties: Record<string, unknown>;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The workspace's repositories, its main one first, then by name, as
 * stadeum/code keeps them (its `Repositories` page has the contract): a
 * `Workspace` by `name`, whose `main` is a repository's `url`, and
 * `Workspace -[INCLUDES]-> Repository`. Read if they are there, never
 * required: none when the box has no such workspace, no such types (the
 * package isn't installed) or no graph.
 */
export async function repositories(ctx: Ctx, workspace: string): Promise<Repository[]> {
  const found = await graph<{ nodes: Found[] }>(ctx, "find", { node_type: "Workspace", where: { name: workspace }, limit: 1 });
  if (found === undefined || (typeof found === "string" && /unknown node type/.test(found))) return [];
  if (typeof found === "string") throw new Error(`reading the workspace ${workspace}: ${found}`);
  const space = found.nodes[0];
  if (!space) return [];
  const near = await graph<Array<{ ref_id: string; direction: string }>>(ctx, "graph-neighbors", { ref_id: space.ref_id, edge_type: ["INCLUDES"], node_type: ["Repository"] });
  if (typeof near === "string") throw new Error(`reading the workspace ${workspace}'s repositories: ${near}`);
  const ids = (near ?? []).filter((n) => n.direction === "forward").map((n) => n.ref_id);
  if (!ids.length) return [];
  const repos = await graph<{ nodes: Found[] }>(ctx, "find", { node_type: "Repository", where: { ref_id: { in: ids } }, limit: 500 });
  if (typeof repos === "string") throw new Error(`reading the workspace ${workspace}'s repositories: ${repos}`);
  const main = text(space.properties["main"]);
  return (repos?.nodes ?? [])
    .map((n) => ({ url: text(n.properties["url"]), name: text(n.properties["name"]) }))
    .filter((r) => r.url)
    .sort((a, b) => (a.url === main ? -1 : b.url === main ? 1 : a.name.localeCompare(b.name) || a.url.localeCompare(b.url)));
}

// ── the workspace's page ──────────────────────────────────────────────────

/** One of the workspace's images, as the service lists them, newest first. */
export interface Image {
  workspace: string;
  image: number;
  state: string;
  reason?: string;
  current?: boolean;
  /** The pod it was baked from. */
  from_pod?: string | null;
}

/** What the page is to say: its whole text when it has none yet, or
 *  changes to it, each quoting the text it changes. */
export interface PageChange {
  page?: string;
  edits?: Array<{ old: string; new: string }>;
}

export interface PageResult {
  name: string;
  state: "written" | "waiting" | "not written";
  note: string;
}

/** The workspace's page. The bare name is its main repository's page. */
export const pageName = (workspace: string) => `${workspace} workspace`;
/** Where jobs kept what they learned before: folded into the page, then deleted. */
const OLD_PAGE = (workspace: string) => `${workspace} pod`;
/** The page's parents: this package's `Pod`, and `Codebase` on a box that has it. */
const PARENTS = ["Pod", "Codebase"];

/** A graph step that must succeed: its answer, or an error with its words. */
async function mustGraph<T>(ctx: Ctx, step: string, config: Record<string, unknown>): Promise<T> {
  const out = await graph<T>(ctx, step, config);
  if (out === undefined) throw new Error("this strut has no graph");
  if (typeof out === "string") throw new Error(out);
  return out;
}

/** The live Concept page of that name, or none. */
async function concept(ctx: Ctx, name: string): Promise<Found | undefined> {
  const { nodes } = await mustGraph<{ nodes: Found[] }>(ctx, "find", { node_type: "Concept", where: { name }, limit: 1 });
  return nodes[0];
}

/**
 * Writes the workspace's page (PLAN.md §3, "Remember"): its systems and how
 * they connect, and how to run them. Only once this pod's newest image is
 * ready, because that is when the page is proven: `pod check` passed in the
 * build and on a machine started from the image. While it builds, or after
 * it failed, nothing is written.
 *
 * The page is changed in place, so its claims and history stay with it:
 * `page` is its first text, and `edits` change it after that (strut's
 * `graph/edit-node` refuses a whole new text for a page that has one, so a
 * line the writer forgot to copy isn't lost). Then it is linked under each
 * parent the box has. Last, the old `<workspace> pod` page is deleted: the
 * agent read it and folded what matters into the page.
 */
export async function writePage(ctx: Ctx, h: Held, images: Image[], change: PageChange): Promise<PageResult> {
  const name = pageName(h.workspace);
  const not = (note: string): PageResult => ({ name, state: "not written", note });
  const mine = images.find((i) => i.from_pod === h.pod);
  if (!mine) return not("This pod has baked no image. The page is written once its bake is ready.");
  if (mine.state === "building") {
    return { name, state: "waiting", note: `Not written yet: image ${mine.image} is still building. Pass the page again with \`status: true\` once it's ready.` };
  }
  if (mine.state !== "ready") return not(`Image ${mine.image} ${mine.state}${mine.reason ? `: ${mine.reason}` : ""}. The page waits for a bake that's ready.`);

  let ref: string;
  try {
    const found = await concept(ctx, name);
    if (found) {
      ref = found.ref_id;
      await mustGraph(ctx, "edit-node", { ref_id: ref, ...(change.edits?.length ? { edits: change.edits } : { node_data: { docs: change.page } }) });
    } else if (change.page?.trim()) {
      const description = `The systems of the workspace ${h.workspace}, how they connect, and how to run them: written by its bakes.`;
      ref = (await mustGraph<{ ref_id: string }>(ctx, "create-node", { node_type: "Concept", node_data: { name, description, docs: change.page } })).ref_id;
    } else {
      return not(`${name} doesn't exist yet: pass \`page\`, its whole text.`);
    }
  } catch (e) {
    return not(e instanceof Error ? e.message : String(e));
  }

  const said = [`${name} is written, from image ${mine.image}.`];
  try {
    const under: string[] = [];
    for (const parent of PARENTS) {
      const p = await concept(ctx, parent);
      if (!p) continue;
      await mustGraph(ctx, "create-triplet", { source_ref_id: p.ref_id, target_ref_id: ref, edge_type: "PARENT_OF" });
      under.push(parent);
    }
    if (under.length) said.push(`It is under ${under.join(" and ")}.`);
    const old = await concept(ctx, OLD_PAGE(h.workspace));
    if (old && old.ref_id !== ref) {
      await mustGraph(ctx, "delete-node", { ref_id: old.ref_id, reason: `folded into ${name}` });
      said.push(`${OLD_PAGE(h.workspace)} is deleted.`);
    }
  } catch (e) {
    said.push(`Then: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { name, state: "written", note: said.join(" ") };
}
