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
 *   made up for this run, and nobody's.
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
const TOKENS = [ONE, TWO];

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
  const workspace = async (name: string, main: string, repos: Array<{ url: string; name: string }>) => {
    const space = await node("Workspace", { name, main });
    for (const r of repos) {
      const repo = repoNodes.get(r.url) ?? (await node("Repository", r));
      repoNodes.set(r.url, repo);
      const run = await step("graph/create-triplet", { source_ref_id: space, target_ref_id: repo, edge_type: "INCLUDES" }, "root", `graph-${++n}`);
      assert.equal(run.status, "success", JSON.stringify(run.error));
    }
  };
  const install = async (dir: string) => {
    const res = await strut.app.request("/packages/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-strut-actor": "root" },
      body: JSON.stringify({ ref: `file:${dir}` }),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.json()));
  };
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
    strut = await createStrut({
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
    await install(HERE);
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

  it("claims as today on a box without stadeum/code: no repositories, nothing run in the pod", async () => {
    const out = await claim("hive", "ada", "job-no-code");
    assert.equal(out.image, null);
    assert.equal(out.repositories, undefined);
    assert.match(out.note, TODAY);
    assert.deepEqual(execsOf(out.pod), []);
  });

  it("claims as today a workspace stadeum/code doesn't know", async () => {
    await install(CODE);
    const out = await claim("nowhere", "ada", "job-unknown");
    assert.equal(out.repositories, undefined);
    assert.match(out.note, TODAY);
    assert.deepEqual(execsOf(out.pod), []);
  });

  it("clones a workspace's repositories into a bare pod, the main one first, each with its own host's token and no other", async () => {
    // Main is `web`, after `api` by name: main first is the graph's main.
    await workspace("shop", a.url("acme/web"), [
      { url: b.url("acme/api"), name: "api" },
      { url: a.url("acme/web"), name: "web" },
    ]);
    const sentA = a.sent.length;
    const sentB = b.sent.length;
    const out = await claim("shop", "ada", "job-shop");
    shopPod = out.pod;
    assert.deepEqual(out.repositories, [
      { url: a.url("acme/web"), path: "/workspaces/web", state: "cloned" },
      { url: b.url("acme/api"), path: "/workspaces/api", state: "cloned" },
    ]);
    assert.match(out.note, /^A bare pod: no image of this workspace yet\. Its repositories are cloned, the main one at \/workspaces\/web\. Run `pod survey`/);

    // One command each, in order, each with its own host's token alone.
    const [web, api, ...more] = execsOf(out.pod);
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

  it("fetches in a pod from an image and leaves the pull to the agent", async () => {
    // The image: the repositories as the last pod had them.
    service.images.set("shop", { image: 7, from: service.workspaces(shopPod) });
    const head = a.commit("acme/web");
    const out = await claim("shop", "ada", "job-shop-image");
    assert.equal(out.image, 7);
    assert.deepEqual(
      out.repositories.map((r: any) => [r.path, r.state]),
      [["/workspaces/web", "fetched"], ["/workspaces/api", "fetched"]],
    );
    assert.match(out.note, /^From image 7, its stack up\. Run `git pull` with git/);
    const [web, api] = execsOf(out.pod);
    assert.match(web!.cmd, /git -C 'web' -c credential\.helper= -c '.*' fetch --quiet origin/);
    assert.equal(web!.env["POD_GIT_TOKEN"], ONE);
    assert.equal(api!.env["POD_GIT_TOKEN"], TWO);
    const repo = join(service.workspaces(out.pod), "web");
    assert.equal(git(repo, "rev-parse", "origin/main"), head, "fetched");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), head, "not pulled");
    service.images.delete("shop");
  });

  it("clones a public repository with no token, and says plainly whose account isn't connected for a private one", async () => {
    await workspace("mixed", a.url("acme/docs"), [
      { url: a.url("acme/docs"), name: "docs" },
      { url: b.url("acme/api"), name: "api" },
    ]);
    const out = await claim("mixed", "bob", "job-bob");
    assert.deepEqual(out.repositories, [
      { url: a.url("acme/docs"), path: "/workspaces/docs", state: "cloned" },
      {
        url: b.url("acme/api"),
        path: "/workspaces/api",
        state: "failed",
        problem: `${b.url("acme/api")} asks for a sign-in (it is private, or not there), and no account on ${b.host} is connected for bob: connect one, then try again.`,
      },
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
    await workspace("odd", a.url("acme/docs"), [
      { url: a.url("acme/docs"), name: "docs" },
      { url: a.url("acme/odd"), name: "../../etc" },
    ]);
    const out = await claim("odd", "ada", "job-odd");
    assert.deepEqual(out.repositories[1], { url: a.url("acme/odd"), path: "", state: "failed", problem: `its name "../../etc" can't be a folder's` });
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
      [["/workspaces/web", "cloned"], ["/workspaces/api", "cloned"]],
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

  it("never puts a token in a run's record or a log", () => {
    clean("the runs' records", [...store.events.values(), ...store.summaries.values()]);
    clean("strut's log", logged.join("\n"));
  });
});
