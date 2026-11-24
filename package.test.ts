/**
 * stadeum/pods on a strut server, the way it runs on a box: installed from
 * this directory (`file:`) into a strut started in this process from a
 * checkout of stakwork/strut's main (`STRUT_DIR`, default `../../strut`,
 * with its install), on a LadybugDB file. Its steps run as a job's run
 * does, as a person, under a job. `stadeum/code` is installed from its
 * checkout (`STRUT_CODE_DIR`, default `../../strut-code`) partway, so the
 * same strut is seen without it and with it; the workspaces are written as
 * its nodes, through strut's graph steps.
 *
 * Stand-ins, all on this machine, so nothing reaches a network:
 *
 * - the pods service: an HTTP server answering what the package calls
 *   (`POST /pods`, `DELETE /pods/:pod`, a bake, the images and deleting
 *   them, podd's `exec` and `ready`). Its
 *   exec runs the command with bash in a folder that stands for the pod's
 *   `/workspaces`, and records what it was sent. A pod "from an image"
 *   starts with the image's folder copied in. A bake stays `building`
 *   until a test sets its state;
 * - two forges: https servers, one at `127.0.0.1`, one at `localhost`,
 *   each its own host, serving bare repositories over git's plain http
 *   protocol. A private one answers only its own forge's token, and each
 *   forge records every password it was sent;
 * - a forge package (`acme/forges`) that serves each host with a secret
 *   (`provides.git`), as a GitLab or Forgejo package would. The tokens are
 *   made up for this run, and nobody's;
 * - files on a node (`ctx.services.nodeFiles`, strut `plans/package-seams.md`
 *   §1), with that plan's API, where this strut doesn't keep them itself
 *   (before stakwork/strut#851). A strut that refuses `on:` (the same plan,
 *   §2) gets the package without it: its workflows are run here directly;
 * - strut's `conversation/start` (the same plan, §7), with that plan's API,
 *   in place of whatever this strut has, and taken away to see `setup` on
 *   a strut without it. A `stadeum/code` whose `Workspace` has no `note`
 *   yet is installed from a copy that declares it;
 * - GitHub's `GET /user`, in strut's `http`: it answers cat's made-up
 *   token with cat's account, and counts what it was asked. Every other
 *   address goes where it says.
 *
 *   STRUT_DIR=../../strut STRUT_CODE_DIR=../../strut-code npm test
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STRUT = resolve(process.env["STRUT_DIR"] ?? "../../strut");
const CODE = resolve(process.env["STRUT_CODE_DIR"] ?? "../../strut-code");
const from = async <T>(path: string): Promise<T> => (await import(pathToFileURL(join(STRUT, "src", path)).href)) as T;
const HERE = resolve(".");

const PODS_TOKEN = `pods-${randomBytes(8).toString("hex")}`;
/** Each forge's token, as ada connected it. Nobody's. */
const ONE = `one-${randomBytes(12).toString("hex")}`;
const TWO = `two-${randomBytes(12).toString("hex")}`;
/** cat's GitHub token, made up for this run: GitHub's stand-in answers it alone. */
const GH = `gh-${randomBytes(12).toString("hex")}`;
const TOKENS = [ONE, TWO, GH];
/** cat's GitHub account, as the stand-in says it. */
const CAT = { login: "cat-gh", id: 4242, name: "Cat Hub" };
const CAT_IDENTITY = "Cat Hub <4242+cat-gh@users.noreply.github.com>";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } }).trim();

// ── a forge ───────────────────────────────────────────────────────────────

interface Forge {
  /** `127.0.0.1:<port>`: what a token for it serves. */
  host: string;
  url: (path: string) => string;
  /** Every password it was sent, in order. */
  sent: string[];
  /** A repository at `<owner>/<name>`, one commit in it; private answers its token only. */
  repo(path: string, opts: { private: boolean }): Promise<void>;
  /** A new commit on `path`'s main: its id. */
  commit(path: string): string;
  /** `path` answers with a redirect to `to`, another forge's repository. */
  move(path: string, to: string): void;
  close(): Promise<void>;
}

async function forge(dir: string, hostname: string, token: string, tls: { key: Buffer; cert: Buffer }): Promise<Forge> {
  const privates = new Set<string>();
  const moved = new Map<string, string>();
  const sent: string[] = [];
  const work = (p: string) => join(dir, "work", p);
  const bare = (p: string) => join(dir, "bare", `${p}.git`);
  const server = createHttps(tls, async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const m = /^\/([^/]+\/[^/]+)\/(.+)$/.exec(path);
    if (!m || m[2]!.split("/").includes("..")) return void res.writeHead(404).end();
    const to = moved.get(m[1]!);
    if (to) return void res.writeHead(301, { location: `${to}/${m[2]}${(req.url ?? "").slice(path.length)}` }).end();
    const auth = req.headers.authorization ?? "";
    const password = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : undefined;
    if (password !== undefined) sent.push(password);
    if (privates.has(m[1]!) && password !== token) {
      return void res.writeHead(401, { "www-authenticate": 'Basic realm="forge"' }).end();
    }
    try {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(await readFile(join(bare(m[1]!), m[2]!)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const host = `${hostname}:${(server.address() as { port: number }).port}`;
  const serve = (p: string) => git(bare(p), "update-server-info");
  return {
    host,
    url: (p) => `https://${host}/${p}`,
    sent,
    async repo(p, opts) {
      await mkdir(work(p), { recursive: true });
      git(work(p), "init", "-q");
      await writeFile(join(work(p), "README.md"), `${p}\n`);
      git(work(p), "add", ".");
      git(work(p), "commit", "-qm", "first");
      await mkdir(dirname(bare(p)), { recursive: true });
      git(dir, "clone", "-q", "--bare", work(p), bare(p));
      serve(p);
      if (opts.private) privates.add(p);
    },
    commit(p) {
      git(work(p), "commit", "-q", "--allow-empty", "-m", "next");
      git(work(p), "push", "-q", bare(p), "main");
      serve(p);
      return git(work(p), "rev-parse", "HEAD");
    },
    move: (p, to) => void moved.set(p, to),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

// ── the pods service ──────────────────────────────────────────────────────

interface Exec {
  pod: string;
  cmd: string;
  cwd: string;
  env: Record<string, string>;
}

interface Pods {
  url: string;
  /** Every exec, in order. */
  execs: Exec[];
  /** The folder that stands for a pod's `/workspaces`. */
  workspaces(pod: string): string;
  /** Workspaces with an image: what a pod from it starts with. */
  images: Map<string, { image: number; from: string }>;
  /** Each workspace's bakes, oldest first: a test moves one on by setting its state. */
  bakes: Map<string, Bake[]>;
  /** Every claim it was sent, in order. */
  claims: Array<{ workspace: string; job: string }>;
  /** Each workspace whose images it was asked to delete, in order. */
  deleted: string[];
  close(): Promise<void>;
}

interface Bake {
  workspace: string;
  image: number;
  state: string;
  reason?: string;
  from_pod: string;
}

async function pods(dir: string, cainfo: string): Promise<Pods> {
  const byJob = new Map<string, { pod: string; workspace: string; image: number | null }>();
  const execs: Exec[] = [];
  const images = new Map<string, { image: number; from: string }>();
  const bakes = new Map<string, Bake[]>();
  const claims: Array<{ workspace: string; job: string }> = [];
  const deleted: string[] = [];
  const runs =new Map<string, { output: string; done: boolean; code: number | null; signal: number | null; child: ChildProcess; waiters: Array<() => void> }>();
  const workspaces = (pod: string) => join(dir, pod, "workspaces");
  const body = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  };
  const json = (res: ServerResponse, status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
  let n = 0;
  const server: Server = createHttp(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${PODS_TOKEN}`) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "POST" && path === "/pods") {
      const { workspace, job } = await body(req);
      claims.push({ workspace, job });
      let p = byJob.get(job);
      if (!p) {
        const image = images.get(workspace);
        p = { pod: `pod-${++n}`, workspace, image: image?.image ?? null };
        await mkdir(workspaces(p.pod), { recursive: true });
        if (image) await cp(image.from, workspaces(p.pod), { recursive: true });
        byJob.set(job, p);
        return json(res, 201, { ...p, state: "running" });
      }
      return json(res, 200, { ...p, state: "running" });
    }
    const bake = /^\/pods\/([^/]+)\/bake$/.exec(path);
    if (req.method === "POST" && bake) {
      const p = [...byJob.values()].find((x) => x.pod === bake[1]);
      if (!p) return json(res, 404, { error: "no such pod" });
      const list = bakes.get(p.workspace) ?? [];
      bakes.set(p.workspace, list);
      const b: Bake = { workspace: p.workspace, image: list.length + 1, state: "building", from_pod: p.pod };
      list.push(b);
      return json(res, 202, { image: b.image, state: b.state });
    }
    const link = /^\/pods\/([^/]+)\/links$/.exec(path);
    if (req.method === "POST" && link) {
      if (![...byJob.values()].some((x) => x.pod === link[1])) return json(res, 404, { error: "no such pod" });
      const { port, path: at, minutes } = (await body(req)) as { port: number; path?: string; minutes?: number };
      const ttl = (minutes ?? 10) * 60_000;
      return json(res, 201, { url: `https://${link[1]}-${port}.pods.test/_pods/open/${randomBytes(4).toString("hex")}${at ?? ""}`, name: `${link[1]}-${port}.pods.test`, expires: Date.now() + ttl });
    }
    const gone = /^\/pods\/([^/]+)$/.exec(path);
    if (req.method === "DELETE" && gone) {
      const job = [...byJob].find(([, x]) => x.pod === gone[1])?.[0];
      if (job === undefined) return json(res, 404, { error: "no such pod" });
      byJob.delete(job);
      return json(res, 200, { pod: gone[1], state: "gone" });
    }
    const listed = /^\/workspaces\/([^/]+)\/images$/.exec(path);
    if (req.method === "DELETE" && listed) {
      const workspace = decodeURIComponent(listed[1]!);
      deleted.push(workspace);
      const n = bakes.get(workspace)?.length ?? 0;
      bakes.delete(workspace);
      images.delete(workspace);
      return json(res, 200, { workspace, deleted: n });
    }
    if (req.method === "GET" && listed) {
      const list = [...(bakes.get(decodeURIComponent(listed[1]!)) ?? [])].reverse();
      const current = list.find((b) => b.state === "ready")?.image;
      return json(res, 200, list.map((b) => ({ ...b, current: b.image === current })));
    }
    const m = /^\/pods\/([^/]+)\/podd(\/.*)$/.exec(path);
    if (!m) return json(res, 404, { error: "not found" });
    const [, pod, rest] = m as unknown as [string, string, string];
    if (rest === "/ready") return json(res, 200, { ready: true });
    if (req.method === "POST" && rest === "/exec") {
      const e = (await body(req)) as { cmd: string; cwd: string; timeout: number; env?: Record<string, string> };
      if (e.cwd !== "/workspaces" && !e.cwd.startsWith("/workspaces/")) return json(res, 400, { error: "a cwd under /workspaces" });
      execs.push({ pod, cmd: e.cmd, cwd: e.cwd, env: e.env ?? {} });
      const id = `x${execs.length}`;
      // The pod's machine: root's home with nothing in it, and the forges'
      // certificate trusted, as a pod trusts a forge's real one.
      const home = join(dir, pod, "root");
      await mkdir(home, { recursive: true });
      const child = spawn("bash", ["-c", e.cmd], {
        cwd: join(workspaces(pod), e.cwd.slice("/workspaces".length)),
        env: { PATH: process.env["PATH"] ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_SSL_CAINFO: cainfo, ...(e.env ?? {}) },
      });
      const r = { output: "", done: false, code: null as number | null, signal: null as number | null, child, waiters: [] as Array<() => void> };
      runs.set(id, r);
      const add = (b: Buffer) => (r.output += b.toString());
      child.stdout!.on("data", add);
      child.stderr!.on("data", add);
      child.on("close", (code) => {
        Object.assign(r, { done: true, code });
        for (const w of r.waiters.splice(0)) w();
      });
      return json(res, 200, { id });
    }
    const x = /^\/exec\/([^/]+)(\/kill)?$/.exec(rest);
    const r = x ? runs.get(x[1]!) : undefined;
    if (!r) return json(res, 404, { error: "no such exec" });
    if (x![2]) {
      r.child.kill("SIGKILL");
      return json(res, 200, {});
    }
    if (!r.done) await new Promise<void>((ok) => r.waiters.push(ok));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return json(res, 200, { output: r.output.slice(offset), next: r.output.length, running: false, exit_code: r.code, signal: r.signal, timed_out: false, killed: false });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    execs,
    workspaces,
    images,
    bakes,
    claims,
    deleted,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

/** Every file under `dir` that holds one of `needles`. */
async function holding(dir: string, needles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const text = (await readFile(file)).toString("latin1");
    if (needles.some((t) => text.includes(t))) out.push(file);
  }
  return out;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Files a package keeps on a node, as strut `plans/package-seams.md` §1
 *  has them: one folder on each node, a version at each write. Only this
 *  package writes here, so one folder a node. */
function nodeFilesStandIn() {
  const kept = new Map<string, Array<{ version: number; files: Record<string, Uint8Array>; note?: string }>>();
  return {
    async read(ref_id: string, opts: { package?: string; version?: number } = {}) {
      const all = kept.get(ref_id) ?? [];
      const v = opts.version === undefined ? all.at(-1) : all.find((x) => x.version === opts.version);
      return v ? { package: "stadeum/pods", version: v.version, files: { ...v.files } } : null;
    },
    async write(ref_id: string, files: Record<string, Uint8Array | string>, opts: { note?: string } = {}) {
      const all = kept.get(ref_id) ?? [];
      kept.set(ref_id, all);
      const version = all.length + 1;
      all.push({ version, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])), ...(opts.note ? { note: opts.note } : {}) });
      return { version };
    },
    async list(ref_id: string) {
      return (kept.get(ref_id) ?? []).map((v) => ({ package: "stadeum/pods", version: v.version, paths: Object.keys(v.files) }));
    },
  };
}

// ── the tests ─────────────────────────────────────────────────────────────

describe("stadeum/pods on strut", { timeout: 300_000 }, () => {
  let root = "";
  let strut: any;
  let store: any;
  let a: Forge; // 127.0.0.1
  let b: Forge; // localhost
  let service: Pods;
  /** Everything strut logged while the tests ran. */
  const logged: string[] = [];
  const console0 = { ...console };
  let n = 0;

  /** One of the package's steps, run as a job's run runs it: as `actor`, under `job`, and in a trial with `trial`. */
  const step = async (type: string, config: Record<string, unknown>, actor: string, job: string, trial?: { case: string; claims: string[] }) => {
    const name = `test/s${++n}`;
    await strut.workspace.publishWorkflowByContent(name, `steps:\n  - id: s\n    type: ${type}\n    config: ${JSON.stringify(config)}\n`);
    const run = (await strut.run(name, {}, { actor, principal: actor, job, ...(trial ? { trial } : {}) })) as { status: string; output: any; error?: unknown };
    // A one-step run's output is its step's.
    return { status: run.status, error: run.error, out: run.output?.s ?? run.output };
  };
  const claim = async (workspace: string, actor: string, job: string) => {
    const run = await step("stadeum/pods/claim", { workspace }, actor, job);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return run.out;
  };
  /** Written as stadeum/code writes it, through strut's graph steps. */
  const node = async (type: string, data: Record<string, string>) => {
    const run = await step("graph/create-node", { node_type: type, node_data: data }, "root", `graph-${++n}`);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    assert.equal(run.out.status, "Success", JSON.stringify(run.out));
    return run.out.ref_id as string;
  };
  /** One node per repository, however many workspaces it is in. */
  const repoNodes = new Map<string, string>();
  const workspace = async (name: string, repos: Array<{ url: string; name: string }>) => {
    const space = await node("Workspace", { name });
    for (const r of repos) {
      const repo = repoNodes.get(r.url) ?? (await node("Repository", r));
      repoNodes.set(r.url, repo);
      const run = await step("graph/create-triplet", { source_ref_id: space, target_ref_id: repo, edge_type: "INCLUDES" }, "root", `graph-${++n}`);
      assert.equal(run.status, "success", JSON.stringify(run.error));
    }
    return space;
  };
  const installing = (dir: string) =>
    strut.app.request("/packages/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-strut-actor": "root" },
      body: JSON.stringify({ ref: `file:${dir}` }),
    });
  const install = async (dir: string) => {
    const res = await installing(dir);
    assert.equal(res.status, 201, JSON.stringify(await res.json()));
  };
  /** stadeum/code, its `Workspace` with the `note` its Set Up writes
   *  (stadeum `plans/software.md` row 26). One from before the note is
   *  installed from a copy that declares it. */
  const codeWithNote = async () => {
    const yaml = await readFile(join(CODE, "graph", "Workspace.yaml"), "utf8");
    if (/^\s+note:/m.test(yaml)) return CODE;
    const copy = join(root, "code-package");
    await cp(CODE, copy, { recursive: true, filter: (src) => !src.includes("node_modules") });
    await writeFile(join(copy, "graph", "Workspace.yaml"), yaml.replace(/^attributes:\n/m, "attributes:\n  note: ?string\n"));
    return copy;
  };
  /** Whether this strut took the package's `on:` (strut#851): then strut
   *  runs `setup` and `drop-images` on the graph's writes itself. */
  let takesOn = false;

  const put = async (path: string, value: string) => {
    const res = await strut.app.request(path, { method: "PUT", headers: { "content-type": "application/json", "x-strut-actor": "root" }, body: JSON.stringify({ value }) });
    assert.ok(res.ok, `${path}: ${res.status}`);
  };
  /** The token in nothing the package wrote, said or ran as a command. */
  const clean = (what: string, v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    for (const t of TOKENS) assert.ok(!text.includes(t), `a token in ${what}`);
  };
  const execsOf = (pod: string) => service.execs.filter((e) => e.pod === pod);
  /** What GitHub's stand-in was asked for /user. */
  let githubAsked = 0;
  /** The pod `shop` was cloned into. */
  let shopPod = "";

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    root = await mkdtemp(join(tmpdir(), "strut-pods-test-"));
    for (const k of ["log", "info", "warn", "error", "debug"] as const) {
      console[k] = (...args: unknown[]) => {
        logged.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
        console0[k](...args);
      };
    }

    // The forges' certificate: for 127.0.0.1 and localhost.
    const tls = join(root, "tls");
    await mkdir(tls);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { cwd: tls, stdio: "ignore" });
    const keys = { key: await readFile(join(tls, "key.pem")), cert: await readFile(join(tls, "cert.pem")) };
    a = await forge(join(root, "forge-a"), "127.0.0.1", ONE, keys);
    b = await forge(join(root, "forge-b"), "localhost", TWO, keys);
    await a.repo("acme/web", { private: true });
    await a.repo("acme/docs", { private: false });
    await b.repo("acme/api", { private: true });
    service = await pods(join(root, "pods"), join(tls, "cert.pem"));

    store = new (await from<any>("store.ts")).MemoryRunStore();
    const { createStrut } = await from<any>("createStrut.ts");
    const { openGraphBackend } = await from<any>("graph/backend.ts");
    const { PRIVATE_NAMESPACE } = await from<any>("graph/ladybug/namespaces.ts");
    const { GraphWorkspaceStore } = await from<any>("graph/workspace-store.ts");
    const { kitForTests } = await from<any>("test-util/app-kit.ts");
    const graph = await openGraphBackend({ kind: "ladybug", path: join(root, "graph.lbug"), namespace: PRIVATE_NAMESPACE }, { embeddings: false });
    // A strut that keeps files on a node builds them into its bag; a host's
    // own would win over them, so the stand-in comes only without them.
    const keepsFiles = (await readFile(join(STRUT, "src", "createStrut.ts"), "utf8")).includes("nodeFiles");
    const { httpCapability } = await from<any>("capabilities.ts");
    const http = httpCapability(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url !== "https://api.github.com/user") return fetch(url, init as RequestInit);
      githubAsked++;
      const ok = new Headers(init?.headers).get("authorization") === `Bearer ${GH}`;
      return new Response(JSON.stringify(ok ? CAT : { message: "Bad credentials" }), { status: ok ? 200 : 401, headers: { "content-type": "application/json" } });
    });
    strut = await createStrut({
      services: { http, ...(keepsFiles ? {} : { nodeFiles: nodeFilesStandIn() }) },
      workspace: new GraphWorkspaceStore(graph, { materializeDir: join(root, "steps"), appsDir: join(root, "apps") }),
      dataDir: root,
      store,
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      autoResume: false,
      orchestrator: false,
      builder: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      views: false,
      concepts: { personal: false, claims: false },
      stt: false,
      jamie: false,
      earnings: false,
      staff: false,
      worker: false,
    });

    await put("/secrets/PODS_URL", service.url);
    await put("/secrets/PODS_TOKEN", PODS_TOKEN);
    const res = await installing(HERE);
    takesOn = res.status === 201;
    if (!takesOn) {
      // A strut from before `on:` refuses the key, and only it: the package
      // without it, its workflows run directly below.
      const why = (await res.json()).error;
      assert.match(why, /Unrecognized key: "on"$/, why);
      const copy = join(root, "pods-package");
      await cp(HERE, copy, { recursive: true, filter: (src) => !src.includes("node_modules") });
      const yaml = await readFile(join(copy, "strut.yaml"), "utf8");
      await writeFile(join(copy, "strut.yaml"), yaml.slice(0, yaml.indexOf("\non:\n") + 1));
      await install(copy);
    }
    // A forge package: each forge's host served by its own secret.
    const forges = join(root, "acme-forges");
    await mkdir(join(forges, "steps"), { recursive: true });
    await writeFile(
      join(forges, "strut.yaml"),
      [
        "package: acme/forges",
        "version: 0.1.0",
        "requires:",
        "  optional: [ONE_TOKEN, TWO_TOKEN]",
        "provides:",
        "  git:",
        `    - { host: "${a.host}", secret: ONE_TOKEN }`,
        `    - { host: "${b.host}", secret: TWO_TOKEN }`,
        "",
      ].join("\n"),
    );
    await writeFile(
      join(forges, "steps", "noop.ts"),
      'import { z, defineStep } from "strut";\nexport default defineStep({ type: "acme/forges/noop", description: "Nothing.", input: z.object({}), output: z.object({}), async run() { return {}; } });\n',
    );
    await install(forges);
    // ada connected both forges; bob connected none.
    await put("/actors/ada/secrets/ONE_TOKEN", ONE);
    await put("/actors/ada/secrets/TWO_TOKEN", TWO);
    // cat connected GitHub.
    await put("/actors/cat/secrets/GITHUB_TOKEN", GH);
  });

  after(async () => {
    Object.assign(console, console0);
    await strut?.close?.().catch(() => {});
    await Promise.all([a?.close(), b?.close(), service?.close()]);
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("installs asking for git tokens by host, and naming no forge's secret", async () => {
    const { packages } = await (await strut.app.request("/packages")).json();
    const pkg = packages.find((p: any) => p.package === "stadeum/pods");
    assert.ok(pkg, "installed");
    assert.equal(pkg.git, true, "requires.git");
    assert.ok(!JSON.stringify(pkg).includes("GITHUB_TOKEN"), JSON.stringify(pkg));
  });

  const TODAY = /^A bare pod: no image of this workspace yet\. Clone its repositories with git/;

  it("Pod Setup's claim about the bake is judged by the service, and none says .pod/ goes in a pull request", async () => {
    const claims = await strut.claims.claimsFor({ kind: "concept", name: "Pod Setup" });
    const checked = async (start: string) => {
      const claim = claims.find((c: any) => c.claim_text.startsWith(start));
      assert.ok(claim, JSON.stringify(claims.map((c: any) => c.claim_text)));
      assert.equal(claim.speaker_name, "stadeum/pods");
      return (await strut.claims.checksFor(claim.id)).map((k: any) => k.step_type);
    };
    assert.deepEqual(await checked("The work leaves a ready image"), ["stadeum/pods/baked"]);
    assert.ok(!claims.some((c: any) => /pull request|committed/.test(c.claim_text)), JSON.stringify(claims.map((c: any) => c.claim_text)));
  });

  it("claims as today on a box without stadeum/code: no repositories, nothing run in the pod", async () => {
    const out = await claim("hive", "ada", "job-no-code");
    assert.equal(out.image, null);
    assert.equal(out.repositories, undefined);
    assert.match(out.note, TODAY);
    assert.deepEqual(execsOf(out.pod), []);
  });

  it("claims as today a workspace stadeum/code doesn't know", async () => {
    await install(await codeWithNote());
    const out = await claim("nowhere", "ada", "job-unknown");
    assert.equal(out.repositories, undefined);
    assert.match(out.note, TODAY);
    assert.deepEqual(execsOf(out.pod), []);
  });

  it("a commit in the pod is the person's, as GitHub says, over a name a command sets, and the token is in none of it", async () => {
    const asked = githubAsked;
    const out = await claim("nowhere", "cat", "job-cat");
    // What job a39dbcf8's agent ran, in a pod with no identity.
    const commit =
      "git init -q who && cd who && git -c user.name=strut -c user.email=strut@users.noreply.github.com commit -q --allow-empty -m one && git log -1 --format='%an <%ae>|%cn <%ce>'";
    const run = await step("stadeum/pods/bash", { command: commit }, "cat", "job-cat");
    assert.equal(run.status, "success", JSON.stringify(run.error));
    assert.equal(run.out.trim(), `${CAT_IDENTITY}|${CAT_IDENTITY}`);
    // GitHub is asked once, however many commands.
    assert.equal((await step("stadeum/pods/bash", { command: "true" }, "cat", "job-cat")).status, "success");
    assert.equal(githubAsked - asked, 1);
    // Nothing written to the pod's home, and the token in no command and on no disk.
    assert.equal(await exists(join(root, "pods", out.pod, "root", ".gitconfig")), false);
    assert.deepEqual(await holding(join(root, "pods", out.pod), TOKENS), []);
    for (const e of execsOf(out.pod)) clean("a command", e);
  });

  it("a person with no GitHub account connected gets no identity, and GitHub isn't asked", async () => {
    const asked = githubAsked;
    const out = await claim("nowhere", "bob", "job-bob-who");
    assert.equal((await step("stadeum/pods/bash", { command: "true" }, "bob", "job-bob-who")).status, "success");
    const execs = execsOf(out.pod);
    assert.equal(execs.length, 1);
    assert.equal(execs[0]!.env["GIT_AUTHOR_NAME"], undefined);
    assert.equal(githubAsked, asked);
  });

  /** shop's Workspace node. */
  let shopNode = "";

  it("clones a workspace's repositories into a bare pod by name, each with its own host's token and no other", async () => {
    shopNode = await workspace("shop", [
      { url: a.url("acme/web"), name: "web" },
      { url: b.url("acme/api"), name: "api" },
    ]);
    const sentA = a.sent.length;
    const sentB = b.sent.length;
    const out = await claim("shop", "ada", "job-shop");
    shopPod = out.pod;
    assert.deepEqual(out.repositories, [
      { url: b.url("acme/api"), path: "/workspaces/api", state: "cloned" },
      { url: a.url("acme/web"), path: "/workspaces/web", state: "cloned" },
    ]);
    assert.equal(out.stack, undefined, "strut keeps no .pod/ for shop yet");
    assert.match(out.note, /^A bare pod: no image of this workspace yet\. Its repositories are cloned under \/workspaces\. Run `pod survey` with bash, write the workspace's stack in \/workspaces\/\.pod/);

    // One command each, in order, each with its own host's token alone.
    const [api, web, ...more] = execsOf(out.pod);
    assert.equal(more.length, 0);
    assert.match(web!.cmd, /clone --quiet -- 'https:\/\/127\.0\.0\.1:\d+\/acme\/web' 'web'/);
    assert.deepEqual([web!.env["POD_GIT_HOST"], web!.env["POD_GIT_TOKEN"]], [a.host, ONE]);
    assert.match(api!.cmd, /clone --quiet -- 'https:\/\/localhost:\d+\/acme\/api' 'api'/);
    assert.deepEqual([api!.env["POD_GIT_HOST"], api!.env["POD_GIT_TOKEN"]], [b.host, TWO]);
    // Each forge was sent its own token, and never the other's.
    assert.ok(a.sent.slice(sentA).includes(ONE) && !a.sent.includes(TWO), "127.0.0.1 got its token alone");
    assert.ok(b.sent.slice(sentB).includes(TWO) && !b.sent.includes(ONE), "localhost got its token alone");

    // In the pod: both, at their remotes' plain addresses, and no token on its disk.
    const ws = service.workspaces(out.pod);
    assert.equal(git(join(ws, "web"), "remote", "get-url", "origin"), a.url("acme/web"));
    assert.equal(git(join(ws, "api"), "remote", "get-url", "origin"), b.url("acme/api"));
    assert.deepEqual(await holding(join(root, "pods", out.pod), TOKENS), []);
    for (const e of execsOf(out.pod)) clean("a command", e.cmd);
    clean("claim's output", out);
  });

  it("fetches in a pod from an image and leaves the pull to the agent", async (t) => {
    // The image: the repositories as the last pod had them.
    service.images.set("shop", { image: 7, from: service.workspaces(shopPod) });
    t.after(() => void service.images.delete("shop"));
    const head = a.commit("acme/web");
    const out = await claim("shop", "ada", "job-shop-image");
    assert.equal(out.image, 7);
    assert.deepEqual(
      out.repositories.map((r: any) => [r.path, r.state]),
      [["/workspaces/api", "fetched"], ["/workspaces/web", "fetched"]],
    );
    assert.match(out.note, /^From image 7, its stack up\. Run `git pull` with git/);
    assert.equal(out.removed, undefined, "the image has only shop's repositories");
    // First the look for checkouts shop no longer has, with no token.
    const [prune, api, web, ...more] = execsOf(out.pod);
    assert.equal(more.length, 0);
    assert.match(prune!.cmd, /^keep=\('api' 'web'\); /);
    assert.deepEqual(prune!.env, {});
    assert.match(web!.cmd, /git -C 'web' -c credential\.helper= -c '.*' fetch --quiet origin/);
    assert.equal(web!.env["POD_GIT_TOKEN"], ONE);
    assert.equal(api!.env["POD_GIT_TOKEN"], TWO);
    const repo = join(service.workspaces(out.pod), "web");
    assert.equal(git(repo, "rev-parse", "origin/main"), head, "fetched");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), head, "not pulled");
  });

  it("a pod launched from an image loses its checkouts of repositories not in the workspace, and a later claim removes nothing", async (t) => {
    // An image baked when shop also had `old`: its checkout, a folder that
    // isn't one, and .pod, even one that looks like a checkout.
    const image = join(root, "image-shop-old");
    await cp(service.workspaces(shopPod), image, { recursive: true });
    for (const d of ["old", ".pod"]) {
      await mkdir(join(image, d));
      git(join(image, d), "init", "-q");
    }
    await writeFile(join(image, ".pod", "compose.yml"), "services: {}\n");
    await mkdir(join(image, "notes"));
    await writeFile(join(image, "notes", "todo.md"), "mine\n");
    service.images.set("shop", { image: 8, from: image });
    t.after(() => void service.images.delete("shop"));

    const job = "job-shop-pruned";
    const out = await claim("shop", "ada", job);
    assert.equal(out.image, 8);
    assert.deepEqual(out.removed, ["/workspaces/old"]);
    assert.match(out.note, / Removed the image's checkouts of repositories not in the workspace: \/workspaces\/old\.$/);
    assert.deepEqual(
      out.repositories.map((r: any) => [r.path, r.state]),
      [["/workspaces/api", "fetched"], ["/workspaces/web", "fetched"]],
    );
    const ws = service.workspaces(out.pod);
    assert.equal(await exists(join(ws, "old")), false, "old's checkout is gone");
    for (const kept of ["api/.git", "web/.git", ".pod/.git", ".pod/compose.yml", "notes/todo.md"]) {
      assert.ok(await exists(join(ws, kept)), `${kept} stays`);
    }

    // The agent clones something on purpose; claiming the pod again keeps it.
    await mkdir(join(ws, "scratch"));
    git(join(ws, "scratch"), "init", "-q");
    const ran = execsOf(out.pod).length;
    const again = await claim("shop", "ada", job);
    assert.equal(again.pod, out.pod);
    assert.equal(again.removed, undefined);
    assert.ok(await exists(join(ws, "scratch", ".git")), "what the agent cloned stays");
    assert.ok(!execsOf(out.pod).slice(ran).some((e) => e.cmd.startsWith("keep=")), "no look for checkouts to remove");
  });

  it("clones a public repository with no token, and says plainly whose account isn't connected for a private one", async () => {
    await workspace("mixed", [
      { url: a.url("acme/docs"), name: "docs" },
      { url: b.url("acme/api"), name: "api" },
    ]);
    const out = await claim("mixed", "bob", "job-bob");
    assert.deepEqual(out.repositories, [
      {
        url: b.url("acme/api"),
        path: "/workspaces/api",
        state: "failed",
        problem: `${b.url("acme/api")} asks for a sign-in (it is private, or not there), and no account on ${b.host} is connected for bob: connect one, then try again.`,
      },
      { url: a.url("acme/docs"), path: "/workspaces/docs", state: "cloned" },
    ]);
    assert.match(out.note, /Some of its repositories aren't here: each one's problem says why\.$/);
    for (const e of execsOf(out.pod)) {
      assert.equal(e.env["POD_GIT_TOKEN"], undefined, "bob has no token");
      // Every helper of the pod's dropped, token or not.
      assert.match(e.cmd, /git (-C 'docs' )?-c credential\.helper= (clone|fetch)/);
    }
    assert.ok(await exists(join(service.workspaces(out.pod), "docs", ".git")));
  });

  it("checks a repository's name before it is a folder, and runs nothing for one that can't be", async () => {
    await workspace("odd", [
      { url: a.url("acme/docs"), name: "docs" },
      { url: a.url("acme/odd"), name: "../../etc" },
      { url: a.url("acme/dot"), name: ".pod" },
    ]);
    const out = await claim("odd", "ada", "job-odd");
    const failed = out.repositories.filter((r: any) => r.state === "failed");
    assert.deepEqual(failed, [
      { url: a.url("acme/odd"), path: "", state: "failed", problem: `its name "../../etc" can't be a folder's` },
      { url: a.url("acme/dot"), path: "", state: "failed", problem: "its name is the workspace's /workspaces/.pod" },
    ]);
    assert.equal(execsOf(out.pod).length, 1, "only docs ran");
  });

  it("runs the git tool with the token for its remote's host alone, hidden from its output", async () => {
    const job = "job-shop"; // the pod `web` and `api` were cloned into
    const fetch = await step("stadeum/pods/git", { args: "fetch origin", repo: "web" }, "ada", job);
    assert.equal(fetch.status, "success", JSON.stringify(fetch.error));
    assert.equal(fetch.out.ok, true, fetch.out.output);
    const clone = await step("stadeum/pods/git", { args: `clone ${b.url("acme/api")} api-2` }, "ada", job);
    assert.equal(clone.out.ok, true, clone.out.output);
    const echo = await step("stadeum/pods/git", { args: `ls-remote ${a.url("acme/web")} && echo $POD_GIT_TOKEN` }, "ada", job);
    assert.equal(echo.out.ok, true, echo.out.output);
    assert.match(echo.out.output, /\*\*\*/, "the token, hidden");
    const ran = execsOf(shopPod).filter((e) => e.env["POD_GIT_TOKEN"]);
    const byHost = (cmd: RegExp) => ran.find((e) => cmd.test(e.cmd));
    assert.equal(byHost(/fetch origin$/)?.env["POD_GIT_TOKEN"], ONE, "origin's host: web's");
    assert.equal(byHost(/clone https:\/\/localhost/)?.env["POD_GIT_TOKEN"], TWO, "the address's host");
    for (const r of [fetch, clone, echo]) clean("the git tool's output", r.out);

    // A remote that sends git to another host: its token stays with its own.
    a.move("acme/moved", b.url("acme/api"));
    const sentB = b.sent.length;
    const moved = await step("stadeum/pods/git", { args: `ls-remote ${a.url("acme/moved")}` }, "ada", job);
    assert.equal(moved.out.ok, false, moved.out.output);
    assert.match(moved.out.output, /could not read Username for 'https:\/\/localhost/);
    assert.ok(!b.sent.slice(sentB).includes(ONE), "127.0.0.1's token never went to localhost");

    // bob, with none: the plain sentence after git's own words.
    const denied = await step("stadeum/pods/git", { args: `ls-remote ${b.url("acme/api")}` }, "bob", "job-bob");
    assert.equal(denied.out.ok, false);
    assert.match(denied.out.output, new RegExp(`no account on ${b.host} is connected for bob: connect one, then try again\\.$`));
  });

  // ── the workspace's page ────────────────────────────────────────────────

  /** The live Concept page of that name. */
  const concept = async (name: string): Promise<{ ref_id: string; properties: Record<string, unknown> } | undefined> => {
    const run = await step("graph/find", { node_type: "Concept", where: { name }, limit: 1 }, "root", `graph-${++n}`);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return run.out.nodes[0];
  };
  const parentsOf = async (ref: string): Promise<string[]> => {
    const run = await step("graph/graph-neighbors", { ref_id: ref, edge_type: ["PARENT_OF"] }, "root", `graph-${++n}`);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return (run.out as Array<{ name: string; direction: string }>).filter((x) => x.direction === "reverse").map((x) => x.name).sort();
  };
  /** `bake` in the pod `shop`'s repositories were cloned into. */
  const bake = async (config: Record<string, unknown>) => {
    const run = await step("stadeum/pods/bake", config, "ada", "job-shop");
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return run.out;
  };
  const latest = () => service.bakes.get("shop")!.at(-1)!;
  const PAGE = ["```mermaid", "graph LR", "  web -->|API_URL| api", "```", "", "web is the frontend; it calls api.", "", "web on 5173, api on 8000. The test user is ada."].join("\n");

  it("writes the workspace's page only once this pod's bake is ready, under Pod, and deletes the old page", async () => {
    const podPage = await concept("Pod");
    assert.ok(podPage, "the package's Pod page");
    // Setting a workspace up, the kind of work under it.
    const setup = await concept("Pod Setup");
    assert.ok(setup, "the package's Pod Setup page");
    assert.deepEqual(await parentsOf(setup.ref_id), ["Pod"]);
    // What jobs kept before: `shop pod`, under Pod.
    const old = await node("Concept", { name: "shop pod", description: "Running shop.", docs: "web on 5173." });
    await step("graph/create-triplet", { source_ref_id: podPage.ref_id, target_ref_id: old, edge_type: "PARENT_OF" }, "root", `graph-${++n}`);

    // Another pod's image, ready: not this pod's bake.
    service.bakes.set("shop", [{ workspace: "shop", image: 1, state: "ready", from_pod: "pod-elsewhere" }]);
    let out = await bake({ status: true, page: PAGE });
    assert.equal(out.page.state, "not written");
    assert.match(out.page.note, /^This pod has baked no image/);

    // This pod's bake: building, then failed. Nothing is written.
    out = await bake({ page: PAGE });
    assert.equal(out.started, 2);
    assert.deepEqual(out.page, { name: "shop workspace", state: "waiting", note: "Not written yet: image 2 is still building. Pass the page again with `status: true` once it's ready." });
    Object.assign(latest(), { state: "failed", reason: "pod check failed" });
    out = await bake({ status: true, page: PAGE });
    assert.equal(out.page.state, "not written");
    assert.match(out.page.note, /^Image 2 failed: pod check failed\./);
    assert.equal(await concept("shop workspace"), undefined);

    // Baked again, and ready: written, and the old page is gone.
    assert.equal((await bake({})).started, 3);
    latest().state = "ready";
    out = await bake({ status: true, page: PAGE });
    assert.equal(out.page.state, "written", out.page.note);
    const page = await concept("shop workspace");
    assert.ok(page, out.page.note);
    assert.equal(page.properties["docs"], PAGE);
    // Under Codebase too where stadeum/code ships it.
    assert.deepEqual(await parentsOf(page.ref_id), (await concept("Codebase")) ? ["Codebase", "Pod"] : ["Pod"]);
    assert.equal(await concept("shop pod"), undefined, "the old page is deleted");
    assert.match(out.page.note, /shop pod is deleted\.$/);
  });

  it("changes the page in place with edits, never with a whole new text, and links it under Codebase", async () => {
    if (!(await concept("Codebase"))) await node("Concept", { name: "Codebase", description: "The box's code.", docs: "Each repository's page." });
    const before = (await concept("shop workspace"))!;
    let out = await bake({ status: true, page: "Something else entirely." });
    assert.equal(out.page.state, "not written");
    assert.match(out.page.note, /already has docs/);

    out = await bake({ status: true, edits: [{ old: "The test user is ada.", new: "The test user is ada, seeded by .pod/setup.sh." }] });
    assert.equal(out.page.state, "written", out.page.note);
    const after = (await concept("shop workspace"))!;
    assert.equal(after.ref_id, before.ref_id, "the same page");
    assert.equal(after.properties["docs"], PAGE.replace("The test user is ada.", "The test user is ada, seeded by .pod/setup.sh."));
    assert.deepEqual(await parentsOf(after.ref_id), ["Codebase", "Pod"]);

    // A bake with no page leaves it as it is.
    latest().state = "ready";
    assert.equal((await bake({})).page, undefined);
    assert.equal((await concept("shop workspace"))!.properties["docs"], after.properties["docs"]);
  });

  // ── the workspace's .pod/, kept in strut ───────────────────────────────

  /** The files strut keeps on a node for this package: its latest version. */
  const kept = async (ref: string) => strut.services.nodeFiles.read(ref, { package: "stadeum/pods" });
  /** A .pod/ with a binary file and a name with a space in it. */
  const STACK = {
    "compose.yml": "services:\n  db: { image: postgres:17 }\n",
    "pm2.config.js": "module.exports = { apps: [] };\n",
    "seed/blob bin": Buffer.from([0, 1, 2, 0xff, 0xfe, 10, 13, 0]),
  };
  const writeInPod = async (pod: string, files: Record<string, string | Buffer>) => {
    for (const [path, data] of Object.entries(files)) {
      const to = join(service.workspaces(pod), ".pod", path);
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, data);
    }
  };
  const inPod = async (pod: string) => {
    const dir = join(service.workspaces(pod), ".pod");
    const out: Record<string, Buffer> = {};
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) out[join(e.parentPath, e.name).slice(dir.length + 1)] = await readFile(join(e.parentPath, e.name));
    }
    return out;
  };
  const same = (a: Record<string, Uint8Array>, b: Record<string, string | Buffer>) =>
    assert.deepEqual(
      Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Buffer.from(v).toString("hex")])),
      Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Buffer.from(v).toString("hex")])),
    );

  it("bake saves the pod's /workspaces/.pod to strut once its image is ready, and a version only when it changed", async () => {
    await writeInPod(shopPod, STACK);
    let out = await bake({});
    assert.deepEqual(out.stack, { state: "waiting", note: `/workspaces/.pod is saved to strut once image ${out.started} is ready: call bake with \`status: true\` then.` });
    assert.equal(await kept(shopNode), null, "nothing while it builds");
    latest().state = "ready";
    out = await bake({ status: true });
    assert.equal(out.stack.state, "saved", out.stack.note);
    const first = await kept(shopNode);
    assert.equal(out.stack.version, first.version);
    same(first.files, STACK);

    // Asked again: the same files, no new version.
    out = await bake({ status: true });
    assert.deepEqual([out.stack.state, out.stack.version], ["unchanged", first.version]);

    // Changed, baked and ready: the next version.
    await writeInPod(shopPod, { "check.sh": "curl -fsS localhost:5173\n" });
    out = await bake({});
    latest().state = "ready";
    out = await bake({ status: true });
    assert.deepEqual([out.stack.state, out.stack.version], ["saved", first.version + 1]);
    same((await kept(shopNode)).files, { ...STACK, "check.sh": "curl -fsS localhost:5173\n" });
  });

  it("a bare pod of the workspace starts with its .pod/ from strut, and one claimed again keeps its own", async () => {
    const version = (await kept(shopNode)).version;
    const out = await claim("shop", "ada", "job-shop-stack");
    assert.equal(out.image, null);
    assert.deepEqual(out.stack, { path: "/workspaces/.pod", version, state: "written" });
    assert.match(out.note, new RegExp(`^A bare pod: no image of this workspace yet\\. Its repositories are cloned under /workspaces\\. /workspaces/\\.pod is the workspace's stack from strut, version ${version}`));
    same(await inPod(out.pod), { ...STACK, "check.sh": "curl -fsS localhost:5173\n" });
    assert.ok(!(await exists(join(service.workspaces(out.pod), ".pod.new"))), "moved into place whole");

    // The agent changes it; a claim again leaves it as it is.
    await writeInPod(out.pod, { "compose.yml": "services: {}\n" });
    const again = await claim("shop", "ada", "job-shop-stack");
    assert.equal(again.pod, out.pod);
    assert.equal(again.stack.state, "kept");
    assert.equal((await inPod(out.pod))["compose.yml"]!.toString(), "services: {}\n");
    await step("stadeum/pods/release", {}, "ada", "job-shop-stack");
  });

  it("without files on a node, claim and bake keep .pod/ as before: nothing written, nothing saved", async () => {
    const nodeFiles = strut.services.nodeFiles;
    delete strut.services.nodeFiles;
    try {
      const out = await claim("shop", "ada", "job-shop-old");
      assert.equal(out.stack, undefined);
      assert.ok(!(await exists(join(service.workspaces(out.pod), ".pod"))));
      assert.match(out.note, /write the workspace's stack in \/workspaces\/\.pod/);
      latest().state = "ready";
      assert.equal((await bake({ status: true })).stack, undefined);
      await step("stadeum/pods/release", {}, "ada", "job-shop-old");
    } finally {
      strut.services.nodeFiles = nodeFiles;
    }
  });

  // ── on: a workspace made, a workspace deleted ───────────────────────────

  /** One of the package's workflows, run as strut runs an `on:` entry: as the writer, with the write. */
  const onWrite = async (workflow: string, input: Record<string, unknown>, actor = "ada", trial?: { case: string; claims: string[] }) => {
    const run = (await strut.run(`stadeum/pods/${workflow}`, input, { actor, principal: actor, ...(trial ? { trial } : {}) })) as { status: string; output: any; error?: unknown };
    assert.equal(run.status, "success", JSON.stringify(run.error));
    // A one-step workflow's output is its step's.
    return run.output as any;
  };

  /** Waits for `ok`, up to 15 s: what `on:` starts is detached, a second after the write. */
  const eventually = async (ok: () => Promise<boolean> | boolean, what: string) => {
    for (let i = 0; i < 150; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`never: ${what}`);
  };
  const jobTitled = async (title: string) => {
    const res = await strut.app.request(`/jobs?q=${encodeURIComponent(title)}`, { headers: { "x-strut-actor": "root" } });
    return JSON.stringify(await res.json()).includes(title);
  };

  /** Runs `fn` with strut's step `type` as `def`, or with none when `def`
   *  is undefined, whatever this strut has: the run's `ctx.registry` is
   *  strut's registry at the run's start. */
  const withStep = async <T>(type: string, def: unknown, fn: () => Promise<T>): Promise<T> => {
    const registry = strut.getRegistry();
    const had = registry[type];
    if (def) registry[type] = def;
    else delete registry[type];
    try {
      return await fn();
    } finally {
      if (had) registry[type] = had;
      else delete registry[type];
    }
  };
  /** Strut's `conversation/start` (strut `plans/package-seams.md` §7), with
   *  that plan's API: records each call and who made it, and answers with a
   *  chat and its job as strut would. */
  const chats: Array<{ config: any; actor?: string; job?: string }> = [];
  const conversationStart = {
    type: "conversation/start",
    input: { parse: (v: unknown) => v },
    async run(config: any, ctx: any) {
      chats.push({ config, actor: ctx.actor, job: ctx.job });
      return { session: `${ctx.actor}/0123456789ab`, job: `job-chat-${chats.length}` };
    },
  };

  it("on a strut that takes on:, a workspace a person makes starts its setup, and one a job makes doesn't", async (t) => {
    if (!takesOn) return t.skip("this strut refuses on: (before strut#851)");
    // Made with no job, as the Code app makes one. Its setup starts a chat,
    // stood in for: this strut holds none, so its own conversation/start
    // refuses (strut#858).
    const name = `test/s${++n}`;
    await strut.workspace.publishWorkflowByContent(name, `steps:\n  - id: s\n    type: graph/create-node\n    config: ${JSON.stringify({ node_type: "Workspace", node_data: { name: "byhand" } })}\n`);
    const setUp = (ws: string) => chats.some((c) => c.config.job?.title === `Set up ${ws}`);
    /** The `setup` run strut started for the workspace `ref`, once it ended. */
    const setupOf = async (ref: string) => {
      for (const id of await store.listRuns("stadeum/pods/setup")) {
        const run = await store.getRunSummary("stadeum/pods/setup", id);
        if (run?.input?.ref_id === ref) return run;
      }
    };
    let byJob = "";
    await withStep("conversation/start", conversationStart, async () => {
      const made = (await strut.run(name, {}, { actor: "root", principal: "root" })) as { status: string; error?: unknown };
      assert.equal(made.status, "success", JSON.stringify(made.error));
      // And one made under a job, with the stand-in there to start a chat
      // if setup did.
      byJob = await node("Workspace", { name: "byjob" });
      await eventually(() => setUp("byhand"), "a chat sets byhand up");
      await eventually(async () => !!(await setupOf(byJob)), "setup runs on byjob too");
    });
    assert.equal(chats.find((c) => c.config.job?.title === "Set up byhand")!.actor, "root", "as the person who made it");
    const left = (await setupOf(byJob))!;
    assert.equal(left.status, "success", JSON.stringify(left.error));
    assert.ok(left.input.job, "strut says which job made it");
    assert.deepEqual(left.output, { started: false, note: `Job ${left.input.job} made the workspace, so it sets it up itself.` });
    assert.ok(!setUp("byjob"), "a job made byjob: no chat");
  });

  it("setup leaves a workspace a job made to that job, and starts no chat or job in a trial", async () => {
    const ref = await workspace("made", [{ url: a.url("acme/docs"), name: "docs" }]);
    await withStep("conversation/start", conversationStart, async () => {
      const before = chats.length;
      assert.deepEqual(await onWrite("setup", { ref_id: ref, type: "Workspace", op: "created", by: "r1", job: "job-maker" }), {
        started: false,
        note: "Job job-maker made the workspace, so it sets it up itself.",
      });
      const held = await onWrite("setup", { ref_id: ref, type: "Workspace", op: "created", by: "r1" }, "ada", TRIAL);
      assert.equal(held.started, false);
      assert.equal(held.workspace, "made");
      assert.match(held.note, /^A strut trial starts no job: one would set made up\.$/);
      assert.equal(chats.length, before, "no chat started");
    });
  });

  it("setup starts a Jamie chat as the person who made the workspace: their words, the Pod Setup job, about the workspace", async () => {
    // As the Code app's Set Up writes one: the person's note on the node.
    const noted = await node("Workspace", { name: "noted", note: "  The admin signs in at /admin.\nUse the staging API.\n" });
    const made = (await named("Workspace", "made"))[0]!.ref_id;
    await withStep("conversation/start", conversationStart, async () => {
      const before = chats.length;
      const out = await onWrite("setup", { ref_id: noted, type: "Workspace", op: "created", by: "r2" });
      const job = `job-chat-${before + 1}`;
      assert.deepEqual(out, { started: true, workspace: "noted", job, session: "ada/0123456789ab", note: `Job ${job} sets noted up on the Pod Setup page, in the chat ada/0123456789ab.` });
      const [chat] = chats.slice(before);
      assert.equal(chat!.actor, "ada", "as the person who made it");
      assert.equal(chat!.job, undefined, "in no job's run");
      assert.equal(chat!.config.message, "Set up noted\n\nThe admin signs in at /admin.\nUse the staging API.");
      assert.equal(chat!.config.about, noted);
      assert.deepEqual(Object.keys(chat!.config.job).sort(), ["brief", "kind", "title"]);
      assert.equal(chat!.config.job.title, "Set up noted");
      assert.equal(chat!.config.job.kind, "Pod Setup");
      assert.match(chat!.config.job.brief, /^Set up the workspace noted in a pod, as the Pod Setup page says\. Claim its pod \(claim \{ workspace: "noted" \}\)/);

      // With no note, the message is the title alone.
      await onWrite("setup", { ref_id: made, type: "Workspace", op: "created", by: "r3" });
      assert.equal(chats.at(-1)!.config.message, "Set up made");
      assert.equal(chats.at(-1)!.config.about, made);
    });
    assert.ok(!(await jobTitled("Set up noted")), "no job/start beside the chat");
  });

  it("on a strut without conversation/start, setup starts the job on Pod Setup alone, as the person who made the workspace", async () => {
    const ref = (await named("Workspace", "made"))[0]!.ref_id;
    const out = await withStep("conversation/start", undefined, () => onWrite("setup", { ref_id: ref, type: "Workspace", op: "created", by: "r2" }));
    assert.equal(out.started, true, out.note);
    assert.equal(out.workspace, "made");
    assert.equal(out.session, undefined);
    assert.match(out.note, /in no chat: this strut has no conversation\/start\.$/);
    // The job is launched detached: its record follows.
    let job: unknown;
    for (let i = 0; i < 100 && !job; i++) {
      const res = await strut.app.request(`/jobs/${out.job}`, { headers: { "x-strut-actor": "ada" } });
      if (res.ok) job = await res.json();
      else await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.ok(job, `job ${out.job} has no record`);
    assert.match(JSON.stringify(job), /Set up made/);
  });

  it("drop-images deletes a deleted workspace's images, its name read from the deleted node", async () => {
    const ref = (await named("Workspace", "made"))[0]!.ref_id;
    service.bakes.set("made", [{ workspace: "made", image: 1, state: "ready", from_pod: "pod-x" }]);
    const gone = await step("graph/delete-node", { ref_id: ref, reason: "a test" }, "root", `graph-${++n}`);
    assert.equal(gone.status, "success", JSON.stringify(gone.error));
    const before = service.deleted.length;
    if (takesOn) {
      // Strut runs drop-images on the delete itself.
      await eventually(() => service.deleted.length > before, "strut runs drop-images");
    } else {
      assert.deepEqual(await onWrite("drop-images", { ref_id: ref, type: "Workspace", op: "deleted", by: "r3" }), {
        workspace: "made",
        deleted: 1,
        note: "made's images are deleted (1).",
      });
    }
    assert.deepEqual(service.deleted.slice(before), ["made"]);
    assert.equal(service.bakes.get("made"), undefined);
    // One gone for good says so and deletes nothing.
    const none = await onWrite("drop-images", { ref_id: "no-such-node" });
    assert.match(none.note, /gone for good/);
    assert.equal(service.deleted.length, before + 1);
  });

  it("drop-images takes the name strut hands it (input.node), so a workspace gone for good still drops its images", async () => {
    service.bakes.set("gone", [{ workspace: "gone", image: 1, state: "ready", from_pod: "pod-y" }]);
    const before = service.deleted.length;
    const out = await onWrite("drop-images", { ref_id: "no-such-node", type: "Workspace", op: "deleted", by: "r4", node: { ref_id: "no-such-node", name: "gone" } });
    assert.deepEqual(out, { workspace: "gone", deleted: 1, note: "gone's images are deleted (1)." });
    assert.deepEqual(service.deleted.slice(before), ["gone"]);
    assert.equal(service.bakes.get("gone"), undefined);
  });

  it("a deleted workspace made again with its name starts with no stack: setup forgets the .pod/ its restored node kept", async () => {
    // Job c0f96a68 on a Stadeum box: `stakwork` deleted, then Set Up for a
    // new `stakwork`, and its bare pod came with the old .pod/.
    /** The `setup` runs strut ran on the workspace `ref`, ended. */
    const setups = async (ref: string) => {
      const out: any[] = [];
      for (const id of await store.listRuns("stadeum/pods/setup")) {
        const run = await store.getRunSummary("stadeum/pods/setup", id);
        if (run?.input?.ref_id === ref && run.status !== "running") out.push(run);
      }
      return out;
    };
    const ref = await workspace("again", [{ url: a.url("acme/docs"), name: "docs" }]);
    // Its setup, on a strut that runs it, ends before there is a stack.
    if (takesOn) await eventually(async () => (await setups(ref)).length === 1, "setup runs on again");

    // Set up and baked: strut keeps its .pod/.
    const first = await claim("again", "ada", "job-again");
    await writeInPod(first.pod, STACK);
    const bakeAgain = async (config: Record<string, unknown>) => {
      const run = await step("stadeum/pods/bake", config, "ada", "job-again");
      assert.equal(run.status, "success", JSON.stringify(run.error));
      return run.out;
    };
    await bakeAgain({});
    service.bakes.get("again")!.at(-1)!.state = "ready";
    const saved = (await bakeAgain({ status: true })).stack;
    assert.equal(saved.state, "saved", saved.note);
    await step("stadeum/pods/release", {}, "ada", "job-again");

    // Deleted as the Code app deletes it: its images go, its files stay.
    const gone = await step("graph/delete-node", { ref_id: ref, reason: "a test" }, "root", `graph-${++n}`);
    assert.equal(gone.status, "success", JSON.stringify(gone.error));
    if (takesOn) await eventually(() => service.deleted.includes("again"), "strut runs drop-images");
    else await onWrite("drop-images", { ref_id: ref, type: "Workspace", op: "deleted", by: "r5", node: { ref_id: ref, name: "again" } });
    assert.equal(service.bakes.get("again"), undefined);
    assert.equal((await kept(ref)).version, saved.version, "a soft delete keeps a node's files");

    // Made again with its name, with no job, as the Code app's Set Up makes
    // one: strut restores the node, and setup forgets its stack.
    const made = `test/s${++n}`;
    await strut.workspace.publishWorkflowByContent(made, `steps:\n  - id: s\n    type: graph/create-node\n    config: ${JSON.stringify({ node_type: "Workspace", node_data: { name: "again" } })}\n`);
    const setUp = await withStep("conversation/start", conversationStart, async () => {
      const run = (await strut.run(made, {}, { actor: "root", principal: "root" })) as { status: string; output: any; error?: unknown };
      assert.equal(run.status, "success", JSON.stringify(run.error));
      assert.equal((run.output?.s ?? run.output).ref_id, ref, "the same node, restored");
      if (!takesOn) return onWrite("setup", { ref_id: ref, type: "Workspace", op: "created", by: "r6" }, "root");
      await eventually(async () => (await setups(ref)).length === 2, "setup runs on again made again");
      const run2 = (await setups(ref)).find((r) => r.output?.forgot !== undefined);
      assert.ok(run2, JSON.stringify(await setups(ref)));
      assert.equal(run2.status, "success", JSON.stringify(run2.error));
      return run2.output;
    });
    assert.equal(setUp.started, true, setUp.note);
    assert.equal(setUp.forgot, saved.version);
    assert.match(setUp.note, new RegExp(`Its \\.pod/ from before it was deleted, version ${saved.version}, is forgotten: it starts with no stack\\.$`));
    const forgotten = await kept(ref);
    assert.equal(forgotten.version, saved.version + 1, "a version over it, the old one kept");
    assert.deepEqual(forgotten.files, {});

    // Its next pod is bare, and strut writes no stack into it.
    const next = await claim("again", "ada", "job-again-2");
    assert.equal(next.image, null);
    assert.equal(next.stack, undefined);
    assert.ok(!(await exists(join(service.workspaces(next.pod), ".pod"))), "no .pod/ in the pod");
    assert.match(next.note, /^A bare pod: no image of this workspace yet\. .*write the workspace's stack in \/workspaces\/\.pod/);
    await step("stadeum/pods/release", {}, "ada", "job-again-2");

    // Made again with nothing to forget: nothing written.
    const quiet = await withStep("conversation/start", conversationStart, () => onWrite("setup", { ref_id: ref, type: "Workspace", op: "created", by: "r7", job: "job-maker" }));
    assert.deepEqual(quiet, { started: false, note: "Job job-maker made the workspace, so it sets it up itself." });
    assert.equal((await kept(ref)).version, forgotten.version);
  });

  // ── a strut trial ───────────────────────────────────────────────────────

  /** A sample of a trial, as strut runs one: a job of its own, `trial-<batch>-<hex>`. */
  const TRIAL = { case: "case-1", claims: ["claim-1"] };
  const sample = `trial-t${randomBytes(5).toString("hex")}-${randomBytes(4).toString("hex")}`;
  const inTrial = (type: string, config: Record<string, unknown>, job = sample) => step(type, config, "ada", job, TRIAL);
  /** The sample's pod. */
  let trialPod = "";
  /** Every live node of a type, by name. */
  const named = async (type: string, name: string) => {
    const run = await step("graph/find", { node_type: type, where: { name }, limit: 5 }, "root", `graph-${++n}`);
    assert.equal(run.status, "success", JSON.stringify(run.error));
    return run.out.nodes as Array<{ ref_id: string; properties: Record<string, unknown> }>;
  };

  it("a trial's pod is for the workspace it names, under one of its own: bare, with the named one's repositories, and no Workspace made", async () => {
    // shop has an image a job would start from.
    service.images.set("shop", { image: 9, from: service.workspaces(shopPod) });
    const out = (await inTrial("stadeum/pods/claim", { workspace: "shop" })).out;
    trialPod = out.pod;
    assert.equal(service.claims.at(-1)!.workspace, sample, "claimed under the job's own name");
    assert.equal(out.image, null, "bare, never from shop's image");
    assert.equal(out.workspace, "shop");
    assert.deepEqual(
      out.repositories.map((r: any) => [r.path, r.state]),
      [["/workspaces/api", "cloned"], ["/workspaces/web", "cloned"]],
    );
    assert.match(out.note, new RegExp(`^A bare pod for shop: this run is a strut trial, so the pod is under a workspace of its own, ${sample}, never from shop's image`));
    assert.deepEqual(await named("Workspace", sample), [], "no Workspace node");
    // Claimed again: the same pod.
    assert.equal((await inTrial("stadeum/pods/claim", { workspace: "shop" })).out.pod, out.pod);
  });

  it("a trial's bake builds under its own workspace and writes the page to its job's files, never to the graph", async () => {
    const live = (await concept("shop workspace"))!;
    const shopBakes = JSON.stringify(service.bakes.get("shop"));
    let out = (await inTrial("stadeum/pods/bake", {})).out;
    assert.equal(out.started, 1, "the own workspace's first image");
    assert.equal(service.bakes.get(sample)!.length, 1);
    assert.equal(JSON.stringify(service.bakes.get("shop")), shopBakes, "shop's images untouched");
    service.bakes.get(sample)![0]!.state = "ready";

    // shop's page exists: edits change it, as on the graph, here in a file.
    const live0 = String(live.properties["docs"]);
    out = (await inTrial("stadeum/pods/bake", { status: true, page: "Something else entirely." })).out;
    assert.equal(out.page.state, "not written");
    assert.match(out.page.note, /has a page already/);
    out = (await inTrial("stadeum/pods/bake", { status: true, edits: [{ old: "web on 5173, api on 8000.", new: "web on 5173, api on 8000 (a trial's)." }] })).out;
    assert.equal(out.page.state, "written", out.page.note);
    assert.match(out.page.note, /to this trial's job as uploads\/shop workspace\.md/);
    // Then edits change the trial's file, never the live page.
    out = (await inTrial("stadeum/pods/bake", { status: true, edits: [{ old: "(a trial's)", new: "(a trial's, twice)" }] })).out;
    assert.equal(out.page.state, "written", out.page.note);
    const want = live0.replace("web on 5173, api on 8000.", "web on 5173, api on 8000 (a trial's, twice).");
    const { jobRoot } = await from<any>("jobs.ts");
    assert.equal(await readFile(join(jobRoot(root, sample), "uploads", "shop workspace.md"), "utf8"), want);
    assert.deepEqual(await readdir(join(jobRoot(root, sample), "uploads")), ["shop workspace.md"], "one file, written over");

    // The judge opens it among the work's files (strut's context/work-file).
    const { workCapability } = await from<any>("work.ts");
    const work = workCapability({ root: { workflow: "job", runId: "r" }, runs: [], concepts: [], files: { [`job-${sample}`]: jobRoot(root, sample) } });
    assert.equal((await work.read(`job-${sample}/uploads/shop workspace.md`)).text, want);

    // The graph: no page written, the live one as it was.
    const after = await named("Concept", "shop workspace");
    assert.equal(after.length, 1);
    assert.equal(after[0]!.ref_id, live.ref_id);
    assert.equal(after[0]!.properties["docs"], live0);
    assert.deepEqual(await named("Concept", `${sample} workspace`), []);
  });

  it("a trial's git sends no push and opens no pull request: what they would send goes to its job's files", async () => {
    const made = await inTrial("stadeum/pods/bash", {
      command: "git checkout -q -b pod-setup && mkdir -p .pod && echo 'services: {}' > .pod/compose.yml && git add .pod && git -c user.email=t@t -c user.name=t commit -q -m 'Add .pod'",
      cwd: "web",
    });
    assert.equal(made.status, "success", JSON.stringify(made.error));
    const before = execsOf(trialPod).length;
    const out = (await inTrial("stadeum/pods/git", { args: "push -u origin pod-setup", repo: "web", pr: { title: "Run shop in a pod" } })).out;
    assert.equal(out.held, true);
    assert.equal(out.ok, true);
    assert.equal(out.pr, undefined, "no pull request");
    assert.match(out.output, /^held: this run is a strut trial, so this push and pull request were not sent\. What it would have sent is in this job's files as uploads\/held push web\.md\.$/);
    assert.ok(!execsOf(trialPod).slice(before).some((e) => /\bpush\b/.test(e.cmd)), "git push never ran");
    const { jobRoot } = await from<any>("jobs.ts");
    const kept = await readFile(join(jobRoot(root, sample), "uploads", "held push web.md"), "utf8");
    assert.match(kept, /- Branch: pod-setup/);
    assert.match(kept, /- Pull request: "Run shop in a pod" into the default branch/);
    assert.match(kept, /Add \.pod/);
    assert.match(kept, /\.pod\/compose\.yml/);
    assert.match(kept, /^\+services: \{\}$/m, "each commit's changes, so the judge reads .pod/ itself");
    // git that sends nothing still runs in a trial.
    const status = (await inTrial("stadeum/pods/git", { args: "status --short", repo: "web" })).out;
    assert.equal(status.held, undefined);
    assert.equal(status.ok, true, status.output);
  });

  it("the baked check answers from the pods service: a ready image from the job's pod, or why not", async () => {
    // As strut runs a check on a claim: a run whose input carries the work's job.
    const name = `test/s${++n}`;
    await strut.workspace.publishWorkflowByContent(name, "steps:\n  - id: s\n    type: stadeum/pods/baked\n");
    const check = async (job: string) => {
      const run = (await strut.run(name, { job }, { actor: "root", principal: "root" })) as { status: string; output: any; error?: unknown };
      return { status: run.status, error: run.error, out: run.output?.s ?? run.output };
    };
    let r = await check(sample);
    assert.equal(r.status, "success", JSON.stringify(r.error));
    assert.deepEqual(r.out, { supports: true, content: `Image 1 of shop, baked from this job's pod ${trialPod}, is ready.` });
    // Still building when the work ended: no.
    service.bakes.get(sample)![0]!.state = "building";
    r = await check(sample);
    assert.deepEqual(r.out, { supports: false, content: `Image 1 of shop, baked from this job's pod ${trialPod}, is building.` });
    service.bakes.get(sample)![0]!.state = "ready";
    // A job that holds no pod: nothing to look at, so no verdict.
    r = await check("job-nobody");
    assert.equal(r.status, "error");
    assert.match(JSON.stringify(r.error), /holds no pod/);
  });

  it("closing a trial's job releases its pod and deletes its own workspace's images; shop's image and page stay", async () => {
    const docs = (await concept("shop workspace"))!.properties["docs"];
    const before = service.deleted.length;
    // As strut closes a sample's job once it is judged: each hold's release step.
    const res = await strut.app.request(`/jobs/${sample}`, { method: "DELETE", headers: { "x-strut-actor": "root" } });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.released, [trialPod], "its pod");
    assert.deepEqual(service.deleted.slice(before), [sample]);
    assert.equal(service.bakes.get(sample), undefined, "its images are gone");
    assert.equal(service.images.get("shop")?.image, 9, "shop's image stays");
    assert.equal((await concept("shop workspace"))!.properties["docs"], docs, "shop's page stays");
    const { jobRoot } = await from<any>("jobs.ts");
    assert.ok(!(await exists(jobRoot(root, sample))), "the job's files went with it");
  });

  it("a trial's agent releasing its pod deletes the images too; a job's release deletes none", async () => {
    const job = `trial-t${randomBytes(5).toString("hex")}-${randomBytes(4).toString("hex")}`;
    await inTrial("stadeum/pods/claim", { workspace: "shop" }, job);
    await inTrial("stadeum/pods/bake", {}, job);
    service.bakes.get(job)![0]!.state = "ready";
    const out = (await inTrial("stadeum/pods/release", {}, job)).out;
    assert.equal(out.images, job);
    assert.equal(service.deleted.at(-1), job);
    assert.deepEqual((await inTrial("stadeum/pods/release", {}, job)).out, { pod: null, released: false }, "its hold is gone");

    // Outside a trial: the pod goes, the workspace's images stay, whatever
    // the input says.
    const deleted = service.deleted.length;
    const plain = await step("stadeum/pods/release", { own: "job-shop" }, "ada", "job-shop");
    assert.equal(plain.status, "success", JSON.stringify(plain.error));
    assert.equal(plain.out.images, undefined);
    assert.equal(service.deleted.length, deleted);
    assert.ok(service.bakes.get("shop")?.length, "shop's images stay");
    service.images.delete("shop");
  });

  it("a trial whose job can't name a workspace says so", async () => {
    const run = await step("stadeum/pods/claim", { workspace: "shop" }, "ada", "TrialJob", TRIAL);
    assert.equal(run.status, "error");
    assert.match(JSON.stringify(run.error), /a trial's pod is under a workspace named after its job/);
  });

  it("url names a second frontend: a link of its own on the hold, and urls.pod stays the main one", async () => {
    const job = "job-two-frontends";
    const { pod } = await claim("shop", "ada", job);
    // The hold as strut keeps it, and the job's urls. A strut with a hold's
    // links (stakwork/strut#859) also folds them into urls by name; any
    // strut keeps them on the hold.
    const job_ = async () => {
      const res = await strut.app.request(`/jobs/${job}`, { headers: { "x-strut-actor": "ada" } });
      const v = (await res.json()) as { holds: Array<{ kind: string; url?: string; links?: Record<string, string> }>; urls: Record<string, string> };
      return { hold: v.holds.find((h) => h.kind === "pod"), urls: v.urls };
    };
    const url = async (config: Record<string, unknown>) => {
      const run = await step("stadeum/pods/url", config, "ada", job);
      assert.equal(run.status, "success", JSON.stringify(run.error));
      return run.out as { url: string };
    };
    const at = (port: number) => new RegExp(`^https://${pod}-${port}\\.pods\\.test/`);
    await url({ port: 3000 });
    assert.match((await url({ port: 5173, name: "admin" })).url, at(5173));
    let now = await job_();
    assert.match(now.hold?.url ?? "", at(3000), "the main frontend stays the hold's url");
    assert.deepEqual(Object.keys(now.hold?.links ?? {}), ["admin"]);
    assert.match(now.hold!.links!["admin"]!, at(5173));
    assert.match(now.urls["pod"]!, at(3000), "and urls.pod");
    if ("admin" in now.urls) assert.equal(now.urls["admin"], now.hold!.links!["admin"]);
    await url({ port: 3001 });
    now = await job_();
    assert.match(now.hold?.url ?? "", at(3001), "an unnamed link moves the main one");
    assert.match(now.hold?.links?.["admin"] ?? "", at(5173), "and keeps the named ones");
    for (const name of ["pod", "Admin", "a b", "-x"]) {
      assert.equal((await step("stadeum/pods/url", { port: 4000, name }, "ada", job)).status, "error", name);
    }
    await step("stadeum/pods/release", {}, "ada", job);
    now = await job_();
    assert.equal(now.hold, undefined, "the links go with the pod");
    assert.deepEqual(now.urls, {});
  });

  it("url lands a named link's button on its path, a sign-in or a dev key, and keeps urls.pod at the app's root", async () => {
    const job = "job-landings";
    const { pod } = await claim("shop", "ada", job);
    const held = async () => {
      const res = await strut.app.request(`/jobs/${job}`, { headers: { "x-strut-actor": "ada" } });
      const v = (await res.json()) as { holds: Array<{ kind: string; url?: string; links?: Record<string, string> }> };
      const h = v.holds.find((x) => x.kind === "pod");
      return { pod: h?.url ?? "", ...h?.links };
    };
    const url = async (config: Record<string, unknown>) => {
      const run = await step("stadeum/pods/url", config, "ada", job);
      assert.equal(run.status, "success", JSON.stringify(run.error));
      return (run.out as { url: string }).url;
    };
    // The stand-in service puts a link's path after its token, as the real one does.
    const lands = (port: number, path = "") =>
      new RegExp(`^https://${pod}-${port}\\.pods\\.test/_pods/open/[0-9a-f]+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

    assert.match(await url({ port: 3001, path: "/settings" }), lands(3001, "/settings"), "the agent's link lands on its path");
    assert.match((await held()).pod, lands(3001), "urls.pod stays at the app's root, where the checks add a path");

    assert.match(await url({ port: 3000, name: "strut", path: "?key=pod-dev-key" }), lands(3000, "/?key=pod-dev-key"));
    assert.match((await held())["strut"] ?? "", lands(3000, "/?key=pod-dev-key"), "a named link's button carries the app's dev key");
    await url({ port: 5173, name: "admin", path: "signin" });
    let now = await held();
    assert.match(now["admin"] ?? "", lands(5173, "/signin"), "or lands on its sign-in");
    assert.match(now["strut"] ?? "", lands(3000, "/?key=pod-dev-key"), "beside the other");
    assert.match(now.pod, lands(3001));

    await url({ port: 5173, name: "admin" });
    assert.match((await held())["admin"] ?? "", lands(5173), "a named link with no path lands at the app's root");
    const spaced = await step("stadeum/pods/url", { port: 5173, name: "admin", path: "/a b" }, "ada", job);
    assert.equal(spaced.status, "error", "a path with a space");
    await step("stadeum/pods/release", {}, "ada", job);
    now = await held();
    assert.deepEqual(now, { pod: "" });
  });

  it("url keeps every link when its calls come at once: the main one and each named one", async () => {
    // A turn's tool calls can run together, and each url reads the hold,
    // asks the service for its links, then writes the hold back. On a
    // Stadeum box, Open strut was written over Open pod (2026-11-24).
    // One run, as a turn is, with its steps at once (`depends: []`).
    const job = "job-at-once";
    const { pod } = await claim("shop", "ada", job);
    const calls = [{ port: 3001 }, { port: 3000, name: "strut" }, { port: 5173, name: "admin" }];
    const name = `test/s${++n}`;
    const yaml = calls.map((c, i) => `  - id: u${i}\n    type: stadeum/pods/url\n    depends: []\n    config: ${JSON.stringify(c)}\n`).join("");
    await strut.workspace.publishWorkflowByContent(name, `steps:\n${yaml}`);
    const run = (await strut.run(name, {}, { actor: "ada", principal: "ada", job })) as { status: string; error?: unknown };
    assert.equal(run.status, "success", JSON.stringify(run.error));
    const res = await strut.app.request(`/jobs/${job}`, { headers: { "x-strut-actor": "ada" } });
    const h = ((await res.json()) as { holds: Array<{ kind: string; url?: string; links?: Record<string, string> }> }).holds.find((x) => x.kind === "pod");
    const at = (port: number) => new RegExp(`^https://${pod}-${port}\\.pods\\.test/`);
    assert.match(h?.url ?? "", at(3001), "Open pod stays");
    assert.match(h?.links?.["strut"] ?? "", at(3000), "beside Open strut");
    assert.match(h?.links?.["admin"] ?? "", at(5173), "and Open admin");
    await step("stadeum/pods/release", {}, "ada", job);
  });

  it("never puts a token in a run's record or a log", () => {
    clean("the runs' records", [...store.events.values(), ...store.summaries.values()]);
    clean("strut's log", logged.join("\n"));
  });
});
