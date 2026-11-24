import { z, defineStep } from "strut";
import { call, FOLDER, gitAuth, held, hold, problem, podd, quote, run, signIn, STACK, storedStack, trialWorkspace, workspaceOf, WORKSPACE, writeStack, type Ctx, type Repository, type Space } from "./_pods.js";

interface PodView {
  pod: string;
  workspace: string;
  image: number | null;
  state: string;
}

/** Seconds one repository's clone or fetch may take. */
const GIT_TIMEOUT = 600;

interface Brought {
  url: string;
  path: string;
  state: "cloned" | "fetched" | "failed";
  problem?: string;
}

/** An https address with nothing in it but the repository's. */
function address(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * One of the workspace's repositories at `/workspaces/<name>`: cloned when
 * it isn't there (a bare pod, or one added since the image), fetched when it
 * is (a pod from an image), leaving the pull to the agent. One command in
 * the pod, with the run's token for the repository's host alone.
 */
async function bring(c: Ctx, p: string, repo: Repository, taken: Set<string>): Promise<Brought> {
  if (repo.name === ".pod") return { url: repo.url, path: "", state: "failed", problem: `its name is the workspace's ${STACK}` };
  const path = `/workspaces/${repo.name}`;
  const failed = (why: string): Brought => ({ url: repo.url, path, state: "failed", problem: why });
  if (!FOLDER.test(repo.name)) return { ...failed(`its name ${JSON.stringify(repo.name.slice(0, 100))} can't be a folder's`), path: "" };
  if (taken.has(repo.name)) return failed(`another of the workspace's repositories is at ${path}`);
  taken.add(repo.name);
  if (!address(repo.url)) return failed("its address isn't an https one with no credentials in it");

  const auth = await gitAuth(c, repo.url);
  const dir = quote(repo.name);
  const cmd =
    `if test -e ${dir}/.git; then echo fetch; git -C ${dir} ${auth.config}fetch --quiet origin; ` +
    `else echo clone; git ${auth.config}clone --quiet -- ${quote(repo.url)} ${dir}; fi`;
  const r = await run(c, p, cmd, { cwd: "/workspaces", env: auth.env, timeoutSeconds: GIT_TIMEOUT });
  const [did = "", ...rest] = r.output.split("\n");
  if (r.exit_code === 0 && !r.timed_out && !r.cancelled) return { url: repo.url, path, state: did === "fetch" ? "fetched" : "cloned" };
  const said = auth.hide(rest.join("\n").trim());
  if (r.timed_out) return failed(`git took over ${GIT_TIMEOUT}s`);
  return failed(signIn(c, repo.url, auth, said) ?? (said.split("\n").slice(-3).join(" ").slice(0, 500) || `git failed (${r.exit_code ?? "killed"})`));
}

/**
 * A pod just launched from an image has the checkouts its bake had, and
 * some may be of repositories the workspace no longer has (job 96dd97e9
 * found two it never picked). Removes each folder directly under
 * `/workspaces` that is a git checkout and isn't at one of `keep`, the
 * workspace's repositories' names, in one command. The glob skips hidden
 * folders, so `.pod` stays, and so does a symlink or a folder that isn't a
 * checkout. Their paths.
 */
async function prune(c: Ctx, p: string, keep: string[]): Promise<string[]> {
  const cmd =
    `keep=(${keep.map(quote).join(" ")}); ` +
    'for d in *; do [ -d "$d" ] && [ ! -L "$d" ] && [ -e "$d/.git" ] || continue; ' +
    'for k in "${keep[@]}"; do [ "$d" = "$k" ] && continue 2; done; ' +
    'rm -rf -- "$d" && echo "$d"; done';
  const r = await run(c, p, cmd, { cwd: "/workspaces" });
  return r.output
    .split("\n")
    .filter((d) => FOLDER.test(d) && !keep.includes(d))
    .map((d) => `/workspaces/${d}`);
}

interface StackBrought {
  path: string;
  version: number;
  state: "written" | "kept" | "failed";
  problem?: string;
}

/**
 * The workspace's `.pod/` from strut, its latest version, at
 * `/workspaces/.pod` in a bare pod (PLAN.md §1): the setup the last bake
 * kept. Undefined when strut keeps none, or keeps no files on a node (a
 * strut from before them, where a repository holds `.pod/`). A pod that
 * has one keeps it: one claimed again holds what the agent changed.
 */
async function bringStack(c: Ctx, p: string, space: Space): Promise<StackBrought | undefined> {
  const stored = await storedStack(c, space.ref_id);
  if (!stored) return undefined;
  try {
    return { path: STACK, version: stored.version, state: await writeStack(c, p, stored.files) };
  } catch (e) {
    return { path: STACK, version: stored.version, state: "failed", problem: e instanceof Error ? e.message : String(e) };
  }
}

export default defineStep({
  type: "stadeum/pods/claim",
  description:
    "Claim this job's POD for a workspace: a machine of the job's own with the workspace's repositories under /workspaces/<name>, its stack in /workspaces/.pod, " +
    "the services they need under Docker and the apps under pm2, each port served over HTTPS. " +
    "The first call launches it, from the workspace's newest image (its stack already running) or a bare one; later calls return the same pod. " +
    "A workspace the box keeps has its repositories cloned into a bare pod, with the .pod/ its last bake kept, or fetched in a pod from an image, " +
    "where the image's checkouts of repositories the workspace no longer has are removed. " +
    "Then work IN the pod with the pod tools (bash, edit, git, url), never with your own bash or editor, which act on strut's disk. " +
    "A workspace is a short lowercase name, as the box keeps it (\"hive\"). Read the Pod page for the loop.",
  input: z.object({
    workspace: z
      .string()
      .regex(WORKSPACE, "a workspace is lowercase letters, digits, '.', '_' and '-'")
      .describe("The workspace, by its name: \"hive\""),
  }),
  output: z.object({
    pod: z.string(),
    workspace: z.string(),
    image: z.number().nullable().describe("The workspace image it started from, or null for the bare base image"),
    state: z.string(),
    ready: z.boolean().describe("Whether its stack is up and `pod check` passes"),
    problems: z.array(z.string()).optional(),
    repositories: z
      .array(z.object({ url: z.string(), path: z.string(), state: z.enum(["cloned", "fetched", "failed"]), problem: z.string().optional() }))
      .optional()
      .describe("The workspace's repositories by name, when the box keeps it: each cloned, fetched, or failed with why"),
    removed: z
      .array(z.string())
      .optional()
      .describe("Checkouts the image had of repositories the workspace no longer has, removed when the pod launched"),
    stack: z
      .object({ path: z.string(), version: z.number(), state: z.enum(["written", "kept", "failed"]), problem: z.string().optional() })
      .optional()
      .describe("A bare pod's /workspaces/.pod, when strut keeps the workspace's: written from its latest version, kept as the pod had it, or failed with why"),
    note: z.string(),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const mine = await held(c);
    if (mine && mine.workspace !== cfg.workspace) {
      throw new Error(`this job's pod ${mine.pod} is for the workspace ${mine.workspace}: release it first to claim another`);
    }
    // A trial's pod is under a workspace of its own; the one named gives
    // its repositories and its page.
    const own = trialWorkspace(c);
    const space = await workspaceOf(c, cfg.workspace);
    const r = await call(c, "POST", "/pods", { workspace: own ?? cfg.workspace, job: c.job }, 120_000);
    if (!r.ok) throw problem("claiming a pod", r);
    const p = r.body as PodView;
    if (!mine || mine.pod !== p.pod) {
      // The service launches another only once the job's pod is gone: its
      // hold goes, so the tools find this one.
      if (mine) await c.services.jobs!.release(c.job!, mine.pod);
      await hold(c, { pod: p.pod, workspace: cfg.workspace, ...(own ? { own } : {}) });
    }

    // Only the claim that launched it (the service's 201): a later one of
    // the same pod keeps whatever the agent cloned on purpose.
    const removed =
      r.status === 201 && p.image !== null && space && c.control?.state !== "cancelling"
        ? await prune(c, p.pod, space.repositories.map((x) => x.name).filter((n) => FOLDER.test(n)))
        : [];
    const brought: Brought[] = [];
    const taken = new Set<string>();
    for (const repo of space?.repositories ?? []) {
      if (c.control?.state === "cancelling") break;
      brought.push(await bring(c, p.pod, repo, taken));
    }
    // A bare pod gets the workspace's .pod/; one from an image has it baked in.
    const stack = p.image === null && space && c.control?.state !== "cancelling" ? await bringStack(c, p.pod, space) : undefined;

    // A pod from an image runs its stack; say whether it's up yet.
    const ready = await call(c, "GET", podd(p.pod, "/ready"), undefined, 30_000);
    const body = (ready.body ?? {}) as { ready?: boolean; problems?: string[] };
    const isReady = ready.ok && body.ready !== false;
    const bare = own
      ? `A bare pod for ${cfg.workspace}: this run is a strut trial, so the pod is under a workspace of its own, ${own}, never from ${cfg.workspace}'s image, and what it bakes goes when the trial's job does.`
      : "A bare pod: no image of this workspace yet.";
    const cloned = brought.length ? "Its repositories are cloned under /workspaces. " : `Clone its repositories with git ("clone <url>" into /workspaces), `;
    const kept = stack && stack.state !== "failed";
    let note: string;
    if (p.image === null && kept) {
      const which = stack.state === "written" ? `the workspace's stack from strut, version ${stack.version}, as its last bake kept it` : `this pod's own, as it was (strut keeps version ${stack.version})`;
      note = `${bare} ${cloned}${STACK} is ${which}. Run \`pod up\` with bash until \`pod check\` passes, fixing .pod/ where it doesn't, then bake.`;
    } else if (p.image === null) {
      note =
        `${bare} ${cloned}${brought.length ? "Run" : "run"} \`pod survey\` with bash, write the workspace's stack in ${STACK}, ` +
        "and `pod up` until `pod check` passes. Then bake.";
    } else if (isReady) {
      note = `From image ${p.image}, its stack up. Run \`git pull\` with git and \`pod up\` with bash to bring it to the newest code.`;
    } else {
      note = `From image ${p.image}; its stack is still starting. \`pod status\` and \`pod logs\` with bash show where it is.`;
    }
    if (removed.length) note += ` Removed the image's checkouts of repositories not in the workspace: ${removed.join(", ")}.`;
    if (brought.some((b) => b.state === "failed")) note += " Some of its repositories aren't here: each one's problem says why.";
    if (stack?.state === "failed") note += ` Its .pod/ from strut couldn't be written to ${STACK}: its problem says why.`;
    return {
      pod: p.pod,
      workspace: cfg.workspace,
      image: p.image,
      state: p.state,
      ready: isReady,
      ...(body.problems?.length ? { problems: body.problems } : {}),
      ...(brought.length ? { repositories: brought } : {}),
      ...(removed.length ? { removed } : {}),
      ...(stack ? { stack } : {}),
      note,
    };
  },
});
