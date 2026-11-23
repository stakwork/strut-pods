import { z, defineStep } from "strut";
import { call, held, problem, type Ctx } from "./_pods.js";

export default defineStep({
  type: "stadeum/pods/release",
  description:
    "Release the job's pod: destroy it, with everything on it that isn't pushed or baked. " +
    "Release when the job is done with it, or to claim another workspace. Strut also releases it when the job is deleted or idle. " +
    "A strut trial's pod takes what it baked with it.",
  input: z.object({
    pod: z.string().optional().describe("Strut's sweep names the pod. The agent leaves it out: the job's pod"),
  }),
  output: z.object({
    pod: z.string().nullable(),
    released: z.boolean(),
    images: z.string().optional().describe("A trial's own workspace, whose images were deleted with the pod"),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    // Strut runs this to let a hold go, with or without a job: never fail
    // for a pod that's already gone.
    const jobs = c.job ? c.services.jobs : undefined;
    const h = jobs ? await held(c, cfg.pod) : undefined;
    const name = cfg.pod ?? h?.pod;
    if (!name) return { pod: null, released: false };
    const r = await call(c, "DELETE", `/pods/${encodeURIComponent(name)}`);
    if (!r.ok && r.status !== 404 && r.status !== 410) throw problem(`releasing ${name}`, r);
    // A trial's pod was under a workspace of its own (claim): its images go
    // too. Until they do, the hold stays, so strut tries again.
    if (h?.own) {
      const d = await call(c, "DELETE", `/workspaces/${encodeURIComponent(h.own)}/images`);
      if (!d.ok) throw problem(`deleting the images of ${h.own}`, d);
    }
    if (jobs) await jobs.release(c.job!, name);
    return { pod: name, released: true, ...(h?.own ? { images: h.own } : {}) };
  },
});
