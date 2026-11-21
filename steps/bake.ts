import { z, defineStep } from "strut";
import { must, pod, writePage, type Ctx, type Image } from "./_pods.js";

export default defineStep({
  type: "stadeum/pods/bake",
  description:
    "Bake the workspace's next IMAGE from the job's pod, so later jobs' pods start with the stack already running. " +
    "It takes the pod's repositories as git sees them (with .pod/, without ignored files such as node_modules), builds them on the image's base, and runs `pod up` until `pod check` passes. " +
    "Bake once `pod check` passes and the app looks right in a browser; commit .pod/ and open a PR too, so later bakes from the base branch have it. " +
    "It takes minutes and the pod keeps working meanwhile. `status: true` only reports the workspace's images, newest first. " +
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
    images: z.array(z.object({ image: z.number(), state: z.string(), reason: z.string().optional(), current: z.boolean().optional() })),
    page: z.object({ name: z.string(), state: z.string(), note: z.string() }).optional().describe("The workspace's page: written, waiting for the image, or not written, and why"),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const h = await pod(c);
    let started: number | undefined;
    if (!cfg.status) {
      const r = await must<{ image: number }>(c, "starting a bake", "POST", `/pods/${encodeURIComponent(h.pod)}/bake`);
      started = r.image;
    }
    const all = await must<Image[]>(c, "the workspace's images", "GET", `/workspaces/${encodeURIComponent(h.workspace)}/images`);
    const images = all.slice(0, 5).map((i) => ({
      image: i.image,
      state: i.state,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.current ? { current: true } : {}),
    }));
    const page = cfg.page !== undefined || cfg.edits?.length ? await writePage(c, h, all, { ...(cfg.page !== undefined ? { page: cfg.page } : {}), ...(cfg.edits ? { edits: cfg.edits } : {}) }) : undefined;
    return { ...(started !== undefined ? { started } : {}), images, ...(page ? { page } : {}) };
  },
});
