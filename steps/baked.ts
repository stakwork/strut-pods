import { z, defineStep } from "strut";
import { held, must, type Ctx, type Image } from "./_pods.js";

/**
 * A CHECK on a claim, never an agent's tool: whether the work baked a ready
 * image of its workspace from its job's pod, asked of the pods service. A
 * page names it in its `claims:` block (`checks: [{ type:
 * stadeum/pods/baked }]`), and strut runs it once the work is done, handing
 * it the work's job as its input's `job`. A trial's sample is judged before
 * strut closes its job, so the job still holds the pod and its images are
 * still there. With no job, or a job that holds no pod (released, or never
 * claimed), there is nothing to look at: it fails, and strut records no
 * verdict. Nor while the image is still building: the turn that started
 * the bake ended, and the turn strut gives the job once it is ready or
 * failed is judged instead. A trial's sample has no such turn, so there a
 * building image is a verdict against it.
 */
export default defineStep({
  type: "stadeum/pods/baked",
  effect: "read",
  description:
    "A CHECK, not a tool: whether the work's job baked a ready image of its workspace from its pod, as the pods service says. " +
    "Answers { supports, content }. The job is the check's input `job` (what strut hands a check on a Concept), or `job` in its config.",
  input: z.object({
    job: z.string().optional().describe("The job whose pod to look at. Default: the check's input `job`"),
  }),
  output: z.object({ supports: z.boolean(), content: z.string() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const given = cfg.job || (ctx.input as { job?: unknown } | undefined)?.job;
    if (typeof given !== "string" || !given) throw new Error("baked: the work ran under no job, so there is no pod to look at");
    const h = await held({ ...c, job: given } as Ctx);
    if (!h) throw new Error(`baked: job ${given} holds no pod (released, or never claimed), so there is nothing to look at`);
    // A trial's pod bakes under the workspace of its own (claim).
    const all = await must<Image[]>(c, "the workspace's images", "GET", `/workspaces/${encodeURIComponent(h.own ?? h.workspace)}/images`);
    // Newest first: this pod's latest bake.
    const mine = all.find((i) => i.from_pod === h.pod);
    if (!mine) return { supports: false, content: `The pod ${h.pod} baked no image of ${h.workspace}.` };
    const which = `Image ${mine.image} of ${h.workspace}, baked from this job's pod ${h.pod},`;
    if (mine.state === "ready") return { supports: true, content: `${which} is ready.` };
    if (mine.state === "building" && !h.own) throw new Error(`baked: ${which} is still building; the job's turn once it's ready or failed is judged`);
    return { supports: false, content: `${which} is ${mine.state}${mine.reason ? `: ${mine.reason}` : ""}.` };
  },
});
