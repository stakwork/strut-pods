import { z, defineStep } from "strut";
import { must, pod, saveStack, writePage, type Ctx, type Image } from "./_pods.js";

/** How long strut looks at a bake before it gives the job a turn saying so. */
const BAKE_LIMIT_MINUTES = 60;

/**
 * Asks strut to look at the bake every minute, as this run's person, and
 * give the job a turn once this pod's image is ready or failed (strut
 * `plans/job-follow-ups.md`), so the agent ends its turn instead of
 * sleeping. The look is `bake { status: true }`, which saves the stack
 * once the image is ready. A trial gets no later turn, and a strut from
 * before follow-ups has none: there the agent looks with `status: true`.
 * What to do next, in a line for the answer.
 */
async function followUp(ctx: Ctx, image: number): Promise<string> {
  const ask = ctx.services.jobs?.followUp;
  if (ask && ctx.job && ctx.runId && !ctx.trial) {
    try {
      await ask({ job: ctx.job, runId: ctx.runId, id: "bake", look: { type: "stadeum/pods/bake", input: { status: true } }, limitMinutes: BAKE_LIMIT_MINUTES });
      return `Image ${image} is baking, which takes about ten minutes. End your turn now: strut gives this job a turn when it's ready or failed, with this pod's images. Write the workspace's page then.`;
    } catch {
      // Refused: look with `status: true`, as before.
    }
  }
  return `Image ${image} is baking, which takes about ten minutes. Call bake with \`status: true\` until it's ready or failed.`;
}

export default defineStep({
  type: "stadeum/pods/bake",
  description:
    "Bake the workspace's next IMAGE from the job's pod, so later jobs' pods start with the stack already running. " +
    "It takes the workspace's stack, /workspaces/.pod, and the pod's repositories as git sees them (without ignored files such as node_modules), builds them on the image's base, and runs `pod up` until `pod check` passes. " +
    "Bake once `pod check` passes and the app looks right in a browser. Once this pod's image is ready, it saves /workspaces/.pod to strut as the workspace's next version, so every bare pod starts from it: no pull request carries .pod/. " +
    "It takes minutes and the pod keeps working meanwhile. Starting one ends your turn: its `note` says so, and strut gives the job a turn once this pod's image is ready or failed. " +
    "`status: true` only reports the workspace's images, newest first, and saves .pod/ once the image is ready. " +
    "With `page` or `edits`, it also writes the workspace's Concept page, `<workspace> workspace`, once this pod's newest image is ready, and nothing while it builds or after it failed: " +
    "`page` is the page's whole text when it has none yet, `edits` change it when it has. The page's answer says which.",
  input: z.object({
    status: z.boolean().optional().describe("Only report the images: building, ready, or failed with a reason"),
    page: z.string().optional().describe("The workspace's page in full, when it has none yet: the diagram of its systems, the system in words, how to run it"),
    edits: z
      .array(
        z.object({
          old: z.string().describe("The page's text as it is now, quoted exactly; it must occur once"),
          new: z.string().describe("What it becomes"),
        }),
      )
      .optional()
      .describe("Changes to the workspace's page when it has one, applied in order: change the lines you mean to and leave the rest as it is"),
  }),
  output: z.object({
    started: z.number().optional().describe("The image this call started"),
    note: z.string().optional().describe("What to do while the image this call started bakes"),
    settled: z.boolean().describe("This pod's newest image is ready or failed: no longer building"),
    images: z.array(z.object({ image: z.number(), state: z.string(), reason: z.string().optional(), current: z.boolean().optional() })),
    page: z.object({ name: z.string(), state: z.string(), note: z.string() }).optional().describe("The workspace's page: written, waiting for the image, or not written, and why"),
    stack: z
      .object({ state: z.string(), version: z.number().optional(), note: z.string() })
      .optional()
      .describe("The workspace's /workspaces/.pod in strut: saved as a new version, unchanged, waiting for the image, or not saved, and why"),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const h = await pod(c);
    let started: number | undefined;
    if (!cfg.status) {
      const r = await must<{ image: number }>(c, "starting a bake", "POST", `/pods/${encodeURIComponent(h.pod)}/bake`);
      started = r.image;
    }
    // A trial's pod bakes under the workspace of its own (claim).
    const all = await must<Image[]>(c, "the workspace's images", "GET", `/workspaces/${encodeURIComponent(h.own ?? h.workspace)}/images`);
    const images = all.slice(0, 5).map((i) => ({
      image: i.image,
      state: i.state,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.current ? { current: true } : {}),
    }));
    const page = cfg.page !== undefined || cfg.edits?.length ? await writePage(c, h, all, { ...(cfg.page !== undefined ? { page: cfg.page } : {}), ...(cfg.edits ? { edits: cfg.edits } : {}) }) : undefined;
    // Beside the page, and on the same rule: once this pod's image is ready.
    const stack = await saveStack(c, h, all);
    const mine = all.find((i) => i.from_pod === h.pod);
    const note = started !== undefined ? await followUp(c, started) : undefined;
    return {
      ...(started !== undefined ? { started } : {}),
      ...(note ? { note } : {}),
      images,
      ...(page ? { page } : {}),
      ...(stack ? { stack } : {}),
      settled: !!mine && mine.state !== "building",
    };
  },
});
