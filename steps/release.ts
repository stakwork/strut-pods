import { z, defineStep } from "strut";
import { call, held, problem, type Ctx } from "./_pods.js";

export default defineStep({
  type: "stadeum/pods/release",
  description:
    "Release the job's pod: destroy it, with everything on it that isn't pushed or baked. " +
    "Release when the job is done with it, or to claim another workspace. Strut also releases it when the job is deleted or idle.",
  input: z.object({
    pod: z.string().optional().describe("Strut's sweep names the pod. The agent leaves it out: the job's pod"),
  }),
  output: z.object({ pod: z.string().nullable(), released: z.boolean() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    // Strut runs this to let a hold go, with or without a job: never fail
    // for a pod that's already gone.
    const name = cfg.pod ?? (c.job && c.services.jobs ? (await held(c))?.pod : undefined);
    if (!name) return { pod: null, released: false };
    const r = await call(c, "DELETE", `/pods/${encodeURIComponent(name)}`);
    if (!r.ok && r.status !== 404 && r.status !== 410) throw problem(`releasing ${name}`, r);
    if (c.job && c.services.jobs) await c.services.jobs.release(c.job, name);
    return { pod: name, released: true };
  },
});
