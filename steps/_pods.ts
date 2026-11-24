/**
 * What every step of the package shares (PLAN.md §8): a call to the pods
 * service, the job's pod from its hold, a command run in the pod, git's
 * credential for one command, a workspace and its repositories from the
 * graph, and the workspace's `.pod/`, which strut keeps on its node.
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
  /** Set when the run is a strut TRIAL (strut's `RunTrial`): nothing it
   *  starts may outlast it, so its pod gets a workspace of its own. */
  trial?: { case: string; claims: string[] };
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
      /** `links`: more addresses on the hold by name, each the job's
       *  `urls.<name>` (stakwork/strut, `JobHold.links`). A strut from
       *  before them keeps `url` alone. */
      hold(job: string, hold: { id: string; kind: string; release: { type: string; input: unknown }; note?: string; url?: string; links?: Record<string, string> }): Promise<void>;
      release(job: string, id: string): Promise<void>;
      holds(job: string): Promise<Array<{ id: string; kind: string; note?: string; url?: string; links?: Record<string, string>; release?: { type: string; input: unknown } }>>;
      /** One file of the job's directory, as strut's `job/read` reads it. */
      read?(job: string, path: string, opts?: { maxChars?: number }): Promise<{ text?: string } | null>;
    };
    /** Files a package keeps on a node (strut `plans/package-seams.md` §1,
     *  stakwork/strut#851): this package's own folder on it, a version at
     *  each write. `read` takes the caller's own folder and its latest
     *  version by default, and is null when the node holds none; `write`
     *  needs a live node. Absent on a strut from before them. */
    nodeFiles?: {
      read(ref_id: string, opts?: { package?: string; version?: number }): Promise<{ package: string; version: number; files: Record<string, Uint8Array> } | null>;
      write(ref_id: string, files: Record<string, Uint8Array | string>, opts?: { note?: string }): Promise<{ version: number }>;
    };
  };
  /** The run's input: what strut hands a check (`job`), or an `on:`
   *  workflow (`ref_id`, `type`, `op`, `by`). */
  input?: unknown;
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

/** A workspace's name, as the service takes it. */
export const WORKSPACE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface Held {
  pod: string;
  /** The workspace the pod is for: its repositories and its page. */
  workspace: string;
  /** The link the job's checks open, `{{ urls.pod }}`. */
  url?: string;
  /** Links to the pod's other frontends by name, each `{{ urls.<name> }}`
   *  and a row of its own on the person's job card. */
  links?: Record<string, string>;
  /** A trial's pod: the workspace of its own it is under, named after
   *  the job, whose images `release` deletes (`trialWorkspace`). */
  own?: string;
}

function jobsOf(ctx: Ctx) {
  const jobs = ctx.services.jobs;
  if (!ctx.job || !jobs) throw new Error("pods: a pod belongs to a job, and this run has none. Launch it as a job");
  return { job: ctx.job, jobs };
}

/** The job's pod, or the pod `id` the job holds, from its hold, or none.
 *  `own` is read from the hold's release, which only `hold` writes, never
 *  from what an agent passes, and is only ever the job's own name. */
export async function held(ctx: Ctx, id?: string): Promise<Held | undefined> {
  const { job, jobs } = jobsOf(ctx);
  const h = (await jobs.holds(job)).find((x) => x.kind === KIND && (id === undefined || x.id === id));
  if (!h) return undefined;
  const own = (h.release?.input as { own?: unknown } | undefined)?.own;
  return {
    pod: h.id,
    workspace: h.note ?? "",
    ...(h.url ? { url: h.url } : {}),
    ...(h.links && Object.keys(h.links).length ? { links: h.links } : {}),
    ...(typeof own === "string" && own === job ? { own } : {}),
  };
}

/**
 * The workspace of a trial's own (strut's `ctx.trial`, whose contract is
 * that nothing a trial starts leaves it): its job's id, which strut makes
 * for each sample. A pod under it starts bare, never from the named
 * workspace's image; its bakes go under it, never the named workspace's;
 * and `release` deletes them once the job is closed. Undefined outside a
 * trial.
 */
export function trialWorkspace(ctx: Ctx): string | undefined {
  if (!ctx.trial) return undefined;
  if (!ctx.job || !WORKSPACE.test(ctx.job)) {
    throw new Error(`pods: a trial's pod is under a workspace named after its job, and ${JSON.stringify(ctx.job ?? "")} can't name one`);
  }
  return ctx.job;
}

/** The job's pod, or an error saying to claim one. */
export async function pod(ctx: Ctx): Promise<Held> {
  const h = await held(ctx);
  if (!h) throw new Error("this job has no pod yet: call claim with the workspace first");
  return h;
}

/** Records the job's hold on its pod: `{ pod, workspace }`, a link to its
 *  app for the job's checks, and links to its other frontends by name.
 *  Never a secret: the agent can read holds. */
export async function hold(ctx: Ctx, h: Held): Promise<void> {
  const { job, jobs } = jobsOf(ctx);
  await jobs.hold(job, {
    id: h.pod,
    kind: KIND,
    release: { type: RELEASE, input: { pod: h.pod, ...(h.own ? { own: h.own } : {}) } },
    note: h.workspace,
    ...(h.url ? { url: h.url } : {}),
    ...(h.links && Object.keys(h.links).length ? { links: h.links } : {}),
  });
}

/** Each job's change to its hold in flight, so the next waits for it. */
const changing = new Map<string, Promise<unknown>>();

/** Changes the job's hold on pod `p`: read afresh and written back, one
 *  change at a time for each job. A turn's tool calls can run at once, and
 *  two `url` calls that each wrote back the hold they read before asking
 *  the service for links lost one of the links (2026-11-24). Strut runs a
 *  job's turns in one process, so a lock here is enough. */
export async function changeHold(ctx: Ctx, p: string, change: (h: Held) => Held): Promise<void> {
  const { job } = jobsOf(ctx);
  const mine = (changing.get(job) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const h = await held(ctx, p);
      if (!h) throw new Error(`this job no longer holds the pod ${p}: claim it again`);
      await hold(ctx, change(h));
    });
  changing.set(job, mine);
  try {
    await mine;
  } finally {
    if (changing.get(job) === mine) changing.delete(job);
  }
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
  opts: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number; keepChars?: number } = {},
): Promise<Ran> {
  const timeout = opts.timeoutSeconds ?? 300;
  const keep = opts.keepChars ?? KEEP_CHARS;
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
    if (output.length > keep) {
      cut += output.length - keep;
      output = output.slice(-keep);
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

// ── GitHub's pull requests ────────────────────────────────────────────────

/** `owner/repo` of a GitHub remote, https or ssh. */
export function githubRepo(remote: string): { owner: string; repo: string } | undefined {
  const m = /github\.com[/:]([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

export const githubHeaders = (token: string | undefined): Record<string, string> => ({
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  accept: "application/vnd.github+json",
  "user-agent": "stadeum-pods",
});

/** The open pull request from the branch `head`, as GitHub says: its
 *  address, number and the commit its branch is at. Throws when GitHub
 *  won't say (a private repository the token can't see). */
export async function openPull(
  c: Ctx,
  token: string | undefined,
  where: { owner: string; repo: string; head: string },
): Promise<{ url: string; number: number; sha: string } | undefined> {
  const api = `https://api.github.com/repos/${where.owner}/${where.repo}/pulls?state=open&per_page=1&head=${encodeURIComponent(`${where.owner}:${where.head}`)}`;
  const r = await c.services.http(api, { headers: githubHeaders(token), timeout: 30_000 });
  if (!r.ok || !Array.isArray(r.body)) throw new Error(`GitHub answered ${r.status} for ${where.owner}/${where.repo}'s pull requests`);
  const p = r.body[0] as { html_url: string; number: number; head: { sha: string } } | undefined;
  return p && { url: p.html_url, number: p.number, sha: p.head.sha };
}

// ── a workspace ───────────────────────────────────────────────────────────

/** A repository of a workspace, as the graph holds it. */
export interface Repository {
  url: string;
  name: string;
}

/** A workspace the box keeps: its node, and its repositories by name. */
export interface Space {
  ref_id: string;
  repositories: Repository[];
}

/** A repository's folder under /workspaces: one plain name. */
export const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A markdown file of the job, `uploads/<name>`, written over the one of
 * that name: where a trial keeps what its pod did that leaves no trace
 * elsewhere, for the trial's judge, which reads the work's files (strut's
 * `context/work-file`). Its path, or undefined where this strut keeps no
 * file in a job.
 */
export async function jobFile(ctx: Ctx, name: string, text: string): Promise<string | undefined> {
  const job = ctx.job;
  if (!job) return undefined;
  const path = `uploads/${name}`;
  if (await ctx.services.jobs?.read?.(job, path, { maxChars: 1 })) await strutStep(ctx, "job/delete-upload", { job, path });
  const saved = await strutStep<{ path: string }>(ctx, "job/upload", { job, name, mediaType: "text/markdown", data: Buffer.from(text).toString("base64") });
  return saved?.path;
}

/** One of strut's own steps, run with this step's context so its rules
 *  hold as for any other caller. Undefined when this strut has none. */
export async function strutStep<T>(ctx: Ctx, type: string, config: Record<string, unknown>): Promise<T | undefined> {
  const def = ctx.registry?.[type];
  return def ? ((await def.run(def.input.parse(config), ctx)) as T) : undefined;
}

/** Strut's own `graph/<step>`. Undefined when this strut has no graph. A
 *  graph step answers a failure as text. */
const graph = <T>(ctx: Ctx, step: string, config: Record<string, unknown>) => strutStep<T | string>(ctx, `graph/${step}`, config);

interface Found {
  ref_id: string;
  properties: Record<string, unknown>;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The workspace as stadeum/code keeps it (its `Repositories` page has the
 * contract): a `Workspace` by `name`, and `Workspace -[INCLUDES]->
 * Repository`, ordered by name. A workspace has no main repository: its
 * setup is its own `.pod/` (PLAN.md §1). Read if it is there, never
 * required: none when the box has no such workspace, no such types (the
 * package isn't installed) or no graph.
 */
export async function workspaceOf(ctx: Ctx, workspace: string): Promise<Space | undefined> {
  const found = await graph<{ nodes: Found[] }>(ctx, "find", { node_type: "Workspace", where: { name: workspace }, limit: 1 });
  if (found === undefined || (typeof found === "string" && /unknown node type/.test(found))) return undefined;
  if (typeof found === "string") throw new Error(`reading the workspace ${workspace}: ${found}`);
  const space = found.nodes[0];
  if (!space) return undefined;
  const near = await graph<Array<{ ref_id: string; direction: string }>>(ctx, "graph-neighbors", { ref_id: space.ref_id, edge_type: ["INCLUDES"], node_type: ["Repository"] });
  if (typeof near === "string") throw new Error(`reading the workspace ${workspace}'s repositories: ${near}`);
  const ids = (near ?? []).filter((n) => n.direction === "forward").map((n) => n.ref_id);
  if (!ids.length) return { ref_id: space.ref_id, repositories: [] };
  const repos = await graph<{ nodes: Found[] }>(ctx, "find", { node_type: "Repository", where: { ref_id: { in: ids } }, limit: 500 });
  if (typeof repos === "string") throw new Error(`reading the workspace ${workspace}'s repositories: ${repos}`);
  const repositories = (repos?.nodes ?? [])
    .map((n) => ({ url: text(n.properties["url"]), name: text(n.properties["name"]) }))
    .filter((r) => r.url)
    .sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));
  return { ref_id: space.ref_id, repositories };
}

/** A node by its ref_id, a deleted one too: its name, and its `note`
 *  when it has one (a Workspace stadeum/code's Set Up wrote), or undefined
 *  when it is gone for good or the box has no graph. */
export async function nodeOf(ctx: Ctx, ref_id: string): Promise<{ name?: string; note?: string } | undefined> {
  const got = await graph<{ properties?: Record<string, unknown> }>(ctx, "graph-get", { ref_id, include_deleted: true });
  if (!got || typeof got === "string") return undefined;
  const name = text(got.properties?.["name"]);
  const note = text(got.properties?.["note"]).trim();
  return { ...(name ? { name } : {}), ...(note ? { note } : {}) };
}

/** A node's name by its ref_id, a deleted one's too. */
export const nodeName = async (ctx: Ctx, ref_id: string) => (await nodeOf(ctx, ref_id))?.name;

// ── the workspace's `.pod/` ───────────────────────────────────────────────

/** Where the workspace's `.pod/` is in a pod, beside its repositories. */
export const STACK = "/workspaces/.pod";

/** A version of the workspace's `.pod/` as strut keeps it, each file by
 *  its path in `.pod/`. */
export interface Stack {
  version: number;
  files: Record<string, Buffer>;
}

/** The latest `.pod/` strut keeps on the workspace's node (this package's
 *  files on it), or undefined when it keeps none, its latest is empty (one
 *  `forgetStack` wrote), or this strut keeps no files on a node. */
export async function storedStack(ctx: Ctx, ref_id: string): Promise<Stack | undefined> {
  const nf = ctx.services.nodeFiles;
  if (!nf) return undefined;
  const got = await nf.read(ref_id);
  if (!got || !Object.keys(got.files).length) return undefined;
  return { version: got.version, files: Object.fromEntries(Object.entries(got.files).map(([k, v]) => [k, Buffer.from(v)])) };
}

/**
 * Forgets the `.pod/` strut keeps on a workspace's node: its next version
 * is empty, which `storedStack` reads as none. The version forgotten, or
 * undefined when it kept none. For a deleted workspace made again with its
 * name: strut restores the node, and a soft delete keeps a node's files,
 * while a deleted node takes no write, so the stack can't go with the
 * images (`drop-images`) and goes when the workspace comes back (`setup`).
 */
export async function forgetStack(ctx: Ctx, ref_id: string): Promise<number | undefined> {
  const stored = await storedStack(ctx, ref_id);
  if (!stored) return undefined;
  await ctx.services.nodeFiles!.write(ref_id, {}, { note: "no stack: the workspace was deleted" });
  return stored.version;
}

/** A path in `.pod/` that stays in it: relative, plain segments. */
const STACK_PATH = (p: string) => !!p && !p.startsWith("/") && p.split("/").every((s) => s && s !== "." && s !== "..");

/** How much of a command a write sends at once: podd takes a request of
 *  up to 2 MB. A multiple of 4, so each piece of base64 decodes alone. */
const PIECE = 1_000_000;

/**
 * Writes `files` to the pod's `/workspaces/.pod`, unless it has one: a pod
 * claimed again keeps what the agent changed. In a folder beside it first,
 * moved into place once whole. Base64 through bash, so a binary file
 * comes through as it is. `kept` when the pod had one.
 */
export async function writeStack(ctx: Ctx, p: string, files: Record<string, Buffer>): Promise<"written" | "kept"> {
  const must = async (cmd: string) => {
    const r = await run(ctx, p, cmd);
    if (r.exit_code !== 0) throw new Error(r.output.trim().split("\n").slice(-3).join(" ").slice(0, 500) || `bash failed (${r.exit_code ?? "killed"})`);
    return r.output.trim();
  };
  if ((await must("if test -e .pod; then echo kept; else rm -rf .pod.new && mkdir .pod.new && echo new; fi")) === "kept") return "kept";
  let cmd = "";
  const send = async () => {
    if (cmd) await must(`set -e\ntest -d .pod.new\n${cmd}`);
    cmd = "";
  };
  for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!STACK_PATH(path)) throw new Error(`${JSON.stringify(path.slice(0, 100))} can't be a path in .pod/`);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const to = quote(`.pod.new/${path}`);
    cmd += `${dir ? `mkdir -p ${quote(`.pod.new/${dir}`)}\n` : ""}: > ${to}\n`;
    const b64 = bytes.toString("base64");
    for (let at = 0; at < b64.length; at += PIECE) {
      const piece = `base64 -d >> ${to} <<'POD_FILE'\n${b64.slice(at, at + PIECE).replace(/(.{76})/g, "$1\n")}\nPOD_FILE\n`;
      if (cmd.length + piece.length > PIECE * 1.1) await send();
      cmd += piece;
    }
  }
  await send();
  await must("mv .pod.new .pod");
  return "written";
}

/**
 * The pod's `/workspaces/.pod`, each file by its path in it, or undefined
 * when the pod has none. One command: each file's path and bytes in
 * base64, a line each, so any name and any bytes come through.
 */
export async function readStack(ctx: Ctx, p: string): Promise<Record<string, Buffer> | undefined> {
  const r = await run(
    ctx,
    p,
    "test -d .pod || { echo none; exit 0; }; cd .pod && find . -type f -print0 | while IFS= read -r -d '' f; do " +
      `printf '%s' "\${f#./}" | base64 | tr -d '\\n'; printf ' '; base64 < "$f" | tr -d '\\n'; echo; done`,
    { keepChars: 16_000_000 },
  );
  if (r.exit_code !== 0) throw new Error(`reading ${STACK}: ${r.output.trim().slice(-500)}`);
  if (r.cut) throw new Error(`${STACK} is too big to keep in strut`);
  if (r.output.trim() === "none") return undefined;
  const files: Record<string, Buffer> = {};
  for (const line of r.output.split("\n")) {
    const [path, bytes = ""] = line.split(" ");
    if (path) files[Buffer.from(path, "base64").toString()] = Buffer.from(bytes, "base64");
  }
  return files;
}

/** Whether two versions of `.pod/` hold the same files, byte for byte. */
export function sameStack(a: Record<string, Buffer>, b: Record<string, Buffer>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k]!.equals(b[k]!));
}

export interface StackResult {
  state: "saved" | "unchanged" | "waiting" | "not saved";
  version?: number;
  note: string;
}

/**
 * Saves the pod's `/workspaces/.pod` to strut as the next version of the
 * workspace's (PLAN.md §3, "Bake"), once this pod's newest image is ready:
 * so later bakes, and every bare pod, start from what was baked. Nothing is
 * kept while the image builds or after it failed, nor in a trial, which
 * leaves nothing behind. A version is made only when `.pod/` changed.
 * Undefined on a strut that keeps no files on a node, where `.pod/` is
 * kept as before, and for a pod that baked nothing.
 */
export async function saveStack(ctx: Ctx, h: Held, images: Image[]): Promise<StackResult | undefined> {
  const nf = ctx.services.nodeFiles;
  const mine = images.find((i) => i.from_pod === h.pod);
  if (!nf || !mine) return undefined;
  const not = (note: string): StackResult => ({ state: "not saved", note });
  if (mine.state === "building") return { state: "waiting", note: `${STACK} is saved to strut once image ${mine.image} is ready: call bake with \`status: true\` then.` };
  if (mine.state !== "ready") return not(`Image ${mine.image} ${mine.state}: ${STACK} is saved from a bake that's ready.`);
  if (h.own) return not(`A strut trial keeps no ${STACK} in strut.`);
  try {
    const space = await workspaceOf(ctx, h.workspace);
    if (!space) return not(`The box keeps no workspace named ${h.workspace}, so there is nowhere to keep ${STACK}.`);
    const files = await readStack(ctx, h.pod);
    if (!files || !Object.keys(files).length) return not(`The pod has no ${STACK}, or nothing in it: the stack is the workspace's, at ${STACK}.`);
    const stored = await storedStack(ctx, space.ref_id);
    if (stored && sameStack(stored.files, files)) return { state: "unchanged", version: stored.version, note: `${STACK} is as strut keeps it, version ${stored.version}.` };
    const { version } = await nf.write(space.ref_id, files, { note: `baked into image ${mine.image} from ${h.pod}` });
    return { state: "saved", version, note: `${STACK} is saved to strut as version ${version}, from image ${mine.image}: every bare pod of ${h.workspace} starts with it.` };
  } catch (e) {
    return not(e instanceof Error ? e.message : String(e));
  }
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

/** The workspace's page. The bare name is a repository's page. */
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
 * it failed, nothing is written. A trial's pod writes it to its job's files
 * instead (`trialPage`).
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
  if (h.own) {
    try {
      return await trialPage(ctx, name, mine.image, change);
    } catch (e) {
      return not(e instanceof Error ? e.message : String(e));
    }
  }

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

/** `edits` applied in order, each quoting text that occurs once, as
 *  strut's `graph/edit-node` applies them; or what's wrong. */
function edited(text: string, edits: Array<{ old: string; new: string }>): string | Error {
  for (const [i, e] of edits.entries()) {
    const at = text.indexOf(e.old);
    if (!e.old || at === -1) return new Error(`edit ${i + 1}: no match for the text to replace: quote the page exactly`);
    if (text.indexOf(e.old, at + 1) !== -1) return new Error(`edit ${i + 1}: the text to replace occurs more than once: quote more of it`);
    text = text.slice(0, at) + e.new + text.slice(at + e.old.length);
  }
  return text;
}

/**
 * A trial's page: what the bake would write, as a file of the trial's job,
 * `uploads/<name>.md`, where strut's judge of the trial reads the work's
 * files (`context/work-file`). Never the graph: a page written there and
 * deleted after would leave a deleted Concept and its history, and stand
 * under `Pod` while the trial runs. As on the graph, `page` is the first
 * text and `edits` change it after that, the text being this job's file,
 * or else the live page.
 */
async function trialPage(ctx: Ctx, name: string, image: number, change: PageChange): Promise<PageResult> {
  const job = ctx.job!;
  const path = `uploads/${name}.md`;
  const file = await ctx.services.jobs?.read?.(job, path, { maxChars: 1_000_000 });
  const base = file?.text ?? text((await concept(ctx, name))?.properties["docs"]);
  let docs: string;
  if (base && change.edits?.length) {
    const out = edited(base, change.edits);
    if (out instanceof Error) throw out;
    docs = out;
  } else if (base) {
    throw new Error(`${name} has a page already: change it with \`edits\``);
  } else if (change.page?.trim()) {
    docs = change.page;
  } else {
    throw new Error(`${name} doesn't exist yet: pass \`page\`, its whole text.`);
  }
  const saved = await jobFile(ctx, `${name}.md`, docs);
  if (!saved) throw new Error("this strut can't keep a file in a job");
  return {
    name,
    state: "written",
    note: `${name} is written, from image ${image}, to this trial's job as ${saved}, where the trial's judge reads it. A trial writes no page to the graph.`,
  };
}
