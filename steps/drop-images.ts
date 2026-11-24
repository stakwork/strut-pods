import { z, defineStep } from "strut";
import { call, nodeName, problem, WORKSPACE, type Ctx } from "./_pods.js";
import type { OnWrite } from "./setup.js";

/**
 * Run by `on: deleted: Workspace` (strut.yaml), never an agent's tool:
 * deletes the workspace's images from the pods service (PLAN.md §8), as
 * `release` does for a trial's own. Its `.pod/` goes with its node, in
 * strut. The name is the node's as strut read it before the delete
 * (`input.node`); a strut that hands no `node` has the node read
 * deleted. One gone for good, with no `node`, has no name left to say,
 * so nothing is deleted.
 */
export default defineStep({
  type: "stadeum/pods/drop-images",
  description:
    "Run by `on: deleted: Workspace`, NOT an agent's tool: deletes the workspace's images from the pods service. Its input is what `on:` hands the workflow ({ ref_id, node }).",
  input: z.object({
    ref_id: z.string().optional().describe("The Workspace node, deleted. Default: the run's input"),
  }),
  output: z.object({ workspace: z.string().optional(), deleted: z.number().optional(), note: z.string() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const on: OnWrite = { ...((c.input ?? {}) as OnWrite), ...cfg };
    if (!on.ref_id) throw new Error("drop-images: no workspace: `on: deleted: Workspace` hands its ref_id");
    const handed = on.node?.["name"];
    const name = (typeof handed === "string" && handed) || (await nodeName(c, on.ref_id));
    if (!name) return { note: `The workspace ${on.ref_id} is gone for good, with its name: no images to find.` };
    if (!WORKSPACE.test(name)) return { workspace: name, note: `${JSON.stringify(name.slice(0, 100))} names no pod's workspace: it has no images.` };
    const r = await call(c, "DELETE", `/workspaces/${encodeURIComponent(name)}/images`);
    if (!r.ok) throw problem(`deleting the images of ${name}`, r);
    const deleted = Number((r.body as { deleted?: unknown })?.deleted ?? 0);
    return { workspace: name, deleted, note: `${name}'s images are deleted (${deleted}).` };
  },
});
