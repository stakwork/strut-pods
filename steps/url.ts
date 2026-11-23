import { z, defineStep } from "strut";
import { hold, must, pod, type Ctx } from "./_pods.js";

interface Link {
  url: string;
  name: string;
  expires: number;
}

const links = (p: string) => `/pods/${encodeURIComponent(p)}/links`;

/** A frontend's name: a word, never the hold's own kind. */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export default defineStep({
  type: "stadeum/pods/url",
  description:
    "A link to one of the job's pod's ports over HTTPS, to open in a browser (browser/verify, browser/walkthrough) or to give the person. " +
    "It opens within 10 minutes; once opened, that browser stays in the pod for 12 hours, every port included. A path added to the link is where it lands. " +
    "With no name, the port becomes the job's {{ urls.pod }}, which the job's checks open with a path, and the person's Open pod. " +
    "A workspace with more than one frontend names each other one (name: \"admin\"): it becomes {{ urls.admin }} and a row of its own, Open admin, on the person's job card, and {{ urls.pod }} stays where it was. " +
    "The app sees a request as if from inside the pod (Host localhost:<port>), so no app setting is needed. Claim the pod first.",
  input: z.object({
    port: z.number().int().min(1).max(65535).describe("The app's port in the pod, such as 3000 or 5173"),
    path: z.string().optional().describe("Where the link lands, such as \"/settings\". Default /"),
    name: z
      .string()
      .regex(NAME)
      .refine((n) => n !== "pod", "name the main frontend by leaving name out")
      .optional()
      .describe("For a frontend other than the main one: its name, such as \"admin\" or \"docs\" (lowercase, a word). Leave it out for the main frontend"),
  }),
  output: z.object({ url: z.string().describe("Open this, with any path added to it"), expires: z.number() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const h = await pod(c);
    const path = cfg.path && cfg.path.startsWith("/") ? cfg.path : undefined;
    const link = await must<Link>(c, "a link to the pod", "POST", links(h.pod), { port: cfg.port, ...(path ? { path } : {}) });
    // The job's checks open {{ urls.<name> }}/<path> in a new browser at any
    // time, so the hold carries a link that lasts.
    const lasting = await must<Link>(c, "a link for the job", "POST", links(h.pod), { port: cfg.port, minutes: 720 });
    await hold(c, cfg.name ? { ...h, links: { ...h.links, [cfg.name]: lasting.url } } : { ...h, url: lasting.url });
    // The link only: the port's bare name needs a cookie a new browser
    // doesn't have, and an agent handed both opened the name (2026-11-19).
    return { url: link.url, expires: link.expires };
  },
});
