import { z, defineStep } from "strut";
import { call, FOLDER, gitAuth, held, hold, problem, podd, quote, repositories, run, signIn, type Ctx, type Repository } from "./_pods.js";

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

export default defineStep({
  type: "stadeum/pods/claim",
  description:
    "Claim this job's POD for a workspace: a machine of the job's own with the workspace's repositories under /workspaces/<name>, the main one first, " +
    "the services they need under Docker and the apps under pm2, each port served over HTTPS. " +
    "The first call launches it, from the workspace's newest image (its stack already running) or a bare one; later calls return the same pod. " +
    "A workspace the box keeps has its repositories cloned into a bare pod, or fetched in a pod from an image. " +
    "Then work IN the pod with the pod tools (bash, edit, git, url), never with your own bash or editor, which act on strut's disk. " +
    "A workspace is a short lowercase name, usually the main repository's (\"hive\"). Read the Pod page for the loop.",
  input: z.object({
    workspace: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "a workspace is lowercase letters, digits, '.', '_' and '-'")
      .describe("The workspace, usually the main repository's name: \"hive\""),
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
      .describe("The workspace's repositories, the main one first, when the box keeps it: each cloned, fetched, or failed with why"),
    note: z.string(),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const mine = await held(c);
    if (mine && mine.workspace !== cfg.workspace) {
      throw new Error(`this job's pod ${mine.pod} is for the workspace ${mine.workspace}: release it first to claim another`);
    }
    const repos = await repositories(c, cfg.workspace);
    const r = await call(c, "POST", "/pods", { workspace: cfg.workspace, job: c.job }, 120_000);
    if (!r.ok) throw problem("claiming a pod", r);
    const p = r.body as PodView;
    if (!mine || mine.pod !== p.pod) await hold(c, { pod: p.pod, workspace: p.workspace });

    const brought: Brought[] = [];
    const taken = new Set<string>();
    for (const repo of repos) {
      if (c.control?.state === "cancelling") break;
      brought.push(await bring(c, p.pod, repo, taken));
    }

    // A pod from an image runs its stack; say whether it's up yet.
    const ready = await call(c, "GET", podd(p.pod, "/ready"), undefined, 30_000);
    const body = (ready.body ?? {}) as { ready?: boolean; problems?: string[] };
    const isReady = ready.ok && body.ready !== false;
    const main = brought[0]?.path;
    let note: string;
    if (p.image === null && main) {
      note =
        `A bare pod: no image of this workspace yet. Its repositories are cloned, the main one at ${main}. ` +
        "Run `pod survey` with bash, write .pod/ in the main repository, and `pod up` until `pod check` passes. Then bake.";
    } else if (p.image === null) {
      note =
        "A bare pod: no image of this workspace yet. Clone its repositories with git (\"clone <url>\" into /workspaces), " +
        "run `pod survey` with bash, write .pod/ in the main repository, and `pod up` until `pod check` passes. Then bake.";
    } else if (isReady) {
      note = `From image ${p.image}, its stack up. Run \`git pull\` with git and \`pod up\` with bash to bring it to the newest code.`;
    } else {
      note = `From image ${p.image}; its stack is still starting. \`pod status\` and \`pod logs\` with bash show where it is.`;
    }
    if (brought.some((b) => b.state === "failed")) note += " Some of its repositories aren't here: each one's problem says why.";
    return {
      pod: p.pod,
      workspace: p.workspace,
      image: p.image,
      state: p.state,
      ready: isReady,
      ...(body.problems?.length ? { problems: body.problems } : {}),
      ...(brought.length ? { repositories: brought } : {}),
      note,
    };
  },
});
