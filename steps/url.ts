import { z, defineStep } from "strut";
import { changeHold, must, pod, type Ctx } from "./_pods.js";

interface Link {
  url: string;
  name: string;
  expires: number;
}

const links = (p: string) => `/pods/${encodeURIComponent(p)}/links`;

/** A frontend's name: a word, never the hold's own kind. */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Where a link lands, with one leading slash, as the service's open
 *  route keeps it: `signin` is `/signin`, `?key=k` is `/?key=k`. */
const landing = (p: string | undefined) => (p ? `/${p.replace(/^[/\\]+/, "")}` : undefined);

export default defineStep({
  type: "stadeum/pods/url",
  description:
    "A link to one of the job's pod's ports over HTTPS, to open in a browser (browser/verify, browser/walkthrough) or to give the person. " +
    "It opens within 10 minutes; once opened, that browser stays in the pod for 12 hours, every port included. It lands on path; a path added to a link made without one is where that lands. " +
    "Each call also sets a button on the person's job card. With no name, the port is the main frontend: Open pod, and the job's {{ urls.pod }}, which stays at the app's root since the job's checks add a path to it. " +
    "Each other app a person opens gets a name (name: \"admin\"): Open admin, and {{ urls.admin }}, which lands on path, so a signed-out browser gets in there: the app's sign-in page, or /?key=<the pod's dev key> for an app that takes its key in the URL. Never a real secret. " +
    "The app sees a request as if from inside the pod (Host localhost:<port>), so no app setting is needed. Claim the pod first.",
  input: z.object({
    port: z.number().int().min(1).max(65535).describe("The app's port in the pod, such as 3000 or 5173"),
    path: z
      .string()
      .regex(/^\S*$/, "a path has no spaces: encode them as %20")
      .optional()
      .describe("Where the link lands, with any query, such as \"/signin\" or \"/?key=pod-dev-key\". Default /. A named link's button lands there too"),
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
    const path = landing(cfg.path);
    const at = path ? { path } : {};
    const link = await must<Link>(c, "a link to the pod", "POST", links(h.pod), { port: cfg.port, ...at });
    // The hold carries a link that lasts, for the person's button and the
    // job's checks, which open {{ urls.pod }}/<path> in a new browser at
    // any time: so the main one stays at the app's root, and a named one,
    // the person's way into another app, lands where this call says.
    const lasting = await must<Link>(c, "a link for the job", "POST", links(h.pod), { port: cfg.port, minutes: 720, ...(cfg.name ? at : {}) });
    // The hold as it is now: another call may have added a link meanwhile.
    await changeHold(c, h.pod, (now) => (cfg.name ? { ...now, links: { ...now.links, [cfg.name!]: lasting.url } } : { ...now, url: lasting.url }));
    // The link only: the port's bare name needs a cookie a new browser
    // doesn't have, and an agent handed both opened the name (2026-11-19).
    return { url: link.url, expires: link.expires };
  },
});
