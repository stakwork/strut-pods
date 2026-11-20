import { z, defineStep } from "strut";
import { call, held, hold, problem, podd, type Ctx } from "./_pods.js";

interface PodView {
  pod: string;
  workspace: string;
  image: number | null;
  state: string;
}

export default defineStep({
  type: "stadeum/pods/claim",
  description:
    "Claim this job's POD for a workspace: a machine of the job's own with the workspace's repositories under /workspaces, " +
    "the services they need under Docker and the apps under pm2, each port served over HTTPS. " +
    "The first call launches it, from the workspace's newest image (its stack already running) or a bare one; later calls return the same pod. " +
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
    note: z.string(),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const mine = await held(c);
    if (mine && mine.workspace !== cfg.workspace) {
      throw new Error(`this job's pod ${mine.pod} is for the workspace ${mine.workspace}: release it first to claim another`);
    }
    const r = await call(c, "POST", "/pods", { workspace: cfg.workspace, job: c.job }, 120_000);
    if (!r.ok) throw problem("claiming a pod", r);
    const p = r.body as PodView;
    if (!mine || mine.pod !== p.pod) await hold(c, { pod: p.pod, workspace: p.workspace });

    // A pod from an image runs its stack; say whether it's up yet.
    const ready = await call(c, "GET", podd(p.pod, "/ready"), undefined, 30_000);
    const body = (ready.body ?? {}) as { ready?: boolean; problems?: string[] };
    const isReady = ready.ok && body.ready !== false;
    let note: string;
    if (p.image === null) {
      note =
        "A bare pod: no image of this workspace yet. Clone its repositories with git (\"clone <url>\" into /workspaces), " +
        "run `pod survey` with bash, write .pod/ in the main repository, and `pod up` until `pod check` passes. Then bake.";
    } else if (isReady) {
      note = `From image ${p.image}, its stack up. Run \`git pull\` with git and \`pod up\` with bash to bring it to the newest code.`;
    } else {
      note = `From image ${p.image}; its stack is still starting. \`pod status\` and \`pod logs\` with bash show where it is.`;
    }
    return {
      pod: p.pod,
      workspace: p.workspace,
      image: p.image,
      state: p.state,
      ready: isReady,
      ...(body.problems?.length ? { problems: body.problems } : {}),
      note,
    };
  },
});

