import { z, defineStep } from "strut";
import { nodeName, STACK, strutStep, WORKSPACE, type Ctx } from "./_pods.js";

/** What strut hands a workflow it runs on a graph write (strut.yaml's
 *  `on:`, strut `plans/package-seams.md` §2): the node, its type, the
 *  write, the run that wrote it (or `proposal:<id>`), and that run's job
 *  when it has one. */
export interface OnWrite {
  ref_id?: string;
  type?: string;
  op?: string;
  by?: string;
  job?: string;
}

/** The job's brief: what `Pod Setup` asks, for this workspace. */
const brief = (name: string) =>
  `Set up the workspace ${name} in a pod, as the Pod Setup page says. Claim its pod (claim { workspace: "${name}" }): it comes with the workspace's repositories, ` +
  `and with its stack in ${STACK} when strut keeps one. Get them running together until \`pod check\` passes and a person can sign in and click through, ` +
  `then bake it and write its page, \`${name} workspace\`. The bake saves ${STACK} to strut once its image is ready. ` +
  "Ask the person only for what nothing can stand in for.";

/**
 * Run by `on: created: Workspace` (strut.yaml), never an agent's tool:
 * starts a job on the `Pod Setup` page that sets the new workspace up and
 * bakes it (PLAN.md §8). Strut runs the workflow as the person whose run
 * made the workspace, so the job is theirs: their tokens, their bill. A
 * workspace a job made is that job's to set up, so nothing starts.
 */
export default defineStep({
  type: "stadeum/pods/setup",
  description:
    "Run by `on: created: Workspace`, NOT an agent's tool: starts a job on the Pod Setup page, as the person who made the workspace, that sets it up in a pod and bakes it. " +
    "A workspace a job made is that job's to set up: nothing starts. Its input is what `on:` hands the workflow ({ ref_id, job? }).",
  input: z.object({
    ref_id: z.string().optional().describe("The Workspace node. Default: the run's input"),
    job: z.string().optional().describe("The job of the run that made it, if any. Default: the run's input"),
  }),
  output: z.object({ started: z.boolean(), workspace: z.string().optional(), job: z.string().optional(), note: z.string() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const on: OnWrite = { ...((c.input ?? {}) as OnWrite), ...cfg };
    if (!on.ref_id) throw new Error("setup: no workspace to set up: `on: created: Workspace` hands its ref_id");
    if (on.job) return { started: false, note: `Job ${on.job} made the workspace, so it sets it up itself.` };
    const name = await nodeName(c, on.ref_id);
    if (!name) return { started: false, note: `The workspace ${on.ref_id} is gone: nothing to set up.` };
    if (!WORKSPACE.test(name)) return { started: false, workspace: name, note: `${JSON.stringify(name.slice(0, 100))} can't name a pod's workspace: lowercase letters, digits, '.', '_' and '-'.` };
    const started = await strutStep<{ job: string; held?: true }>(c, "job/start", { title: `Set up ${name}`, prompt: brief(name), kind: "Pod Setup" });
    if (!started) throw new Error("setup: this strut has no job/start to start the job with");
    if (started.held) return { started: false, workspace: name, job: started.job, note: `A strut trial starts no job: one would set ${name} up.` };
    return { started: true, workspace: name, job: started.job, note: `Job ${started.job} sets ${name} up on the Pod Setup page.` };
  },
});
