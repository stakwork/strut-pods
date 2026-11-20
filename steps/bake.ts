import { z, defineStep } from "strut";
import { must, pod, type Ctx } from "./_pods.js";

interface Image {
  workspace: string;
  image: number;
  state: string;
  reason?: string;
  current?: boolean;
}

export default defineStep({
  type: "stadeum/pods/bake",
  description:
    "Bake the workspace's next IMAGE from the job's pod, so later jobs' pods start with the stack already running. " +
    "It takes the pod's repositories as git sees them (with .pod/, without ignored files such as node_modules), builds them on the image's base, and runs `pod up` until `pod check` passes. " +
    "Bake once `pod check` passes and the app looks right in a browser; commit .pod/ and open a PR too, so later bakes from the base branch have it. " +
    "It takes minutes and the pod keeps working meanwhile. `status: true` only reports the workspace's images, newest first.",
  input: z.object({
    status: z.boolean().optional().describe("Only report the images: building, ready, or failed with a reason"),
  }),
  output: z.object({
    started: z.number().optional().describe("The image this call started"),
    images: z.array(z.object({ image: z.number(), state: z.string(), reason: z.string().optional(), current: z.boolean().optional() })),
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
    return { ...(started !== undefined ? { started } : {}), images };
  },
});
