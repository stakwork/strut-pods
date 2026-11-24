import { z, defineStep } from "strut";
import { forgetStack, nodeOf, STACK, strutStep, WORKSPACE, type Ctx } from "./_pods.js";

/** What strut hands a workflow it runs on a graph write (strut.yaml's
 *  `on:`, strut `plans/package-seams.md` §2): the node, its type, the
 *  write, the run that wrote it (or `proposal:<id>`), that run's job
 *  when it has one, and on a delete the node's values as they were (a
 *  strut from before it hands none). */
export interface OnWrite {
  ref_id?: string;
  type?: string;
  op?: string;
  by?: string;
  job?: string;
  node?: Record<string, unknown>;
}

/** The job's brief: what `Pod Setup` asks, for this workspace. */
const brief = (name: string) =>
  `Set up the workspace ${name} in a pod, as the Pod Setup page says. Claim its pod (claim { workspace: "${name}" }): it comes with the workspace's repositories, ` +
  `and with its stack in ${STACK} when strut keeps one. Run the app a person clicks through, and what else can run beside it, until \`pod check\` passes and a person can sign in and click through, ` +
  `then bake it and write its page, \`${name} workspace\`. The bake saves ${STACK} to strut once its image is ready. ` +
  "Ask the person only for what nothing can stand in for.";

/**
 * Run by `on: created: Workspace` (strut.yaml), never an agent's tool:
 * starts a job on the `Pod Setup` page that sets the new workspace up and
 * bakes it (PLAN.md §8), in a Jamie chat of the person's own. Strut runs
 * the workflow as the person whose run made the workspace, so the chat
 * and the job are theirs: their tokens, their bill. The chat opens with
 * their words, "Set up <name>" and the workspace's `note`, and is about
 * the workspace, so the Code app finds it (strut `package-seams.md` §7).
 * A strut from before `conversation/start` starts the job alone, in no
 * chat. A workspace a job made is that job's to set up, so nothing starts.
 *
 * First, whoever made it, a workspace made starts with no stack: one made
 * again with a deleted one's name is that node restored, with the `.pod/`
 * it had, and that is forgotten (`forgetStack`), as its images were.
 */
export default defineStep({
  type: "stadeum/pods/setup",
  description:
    "Run by `on: created: Workspace`, NOT an agent's tool: starts a job on the Pod Setup page, in a Jamie chat of the person who made the workspace, that sets it up in a pod and bakes it. " +
    "A workspace a job made is that job's to set up: nothing starts. One made again after it was deleted first forgets the .pod/ it had. Its input is what `on:` hands the workflow ({ ref_id, job? }).",
  input: z.object({
    ref_id: z.string().optional().describe("The Workspace node. Default: the run's input"),
    job: z.string().optional().describe("The job of the run that made it, if any. Default: the run's input"),
  }),
  output: z.object({
    started: z.boolean(),
    workspace: z.string().optional(),
    job: z.string().optional(),
    session: z.string().optional(),
    forgot: z.number().optional().describe("The version of .pod/ strut kept from before the workspace was deleted, now forgotten"),
    note: z.string(),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const on: OnWrite = { ...((c.input ?? {}) as OnWrite), ...cfg };
    if (!on.ref_id) throw new Error("setup: no workspace to set up: `on: created: Workspace` hands its ref_id");
    const forgot = c.trial ? undefined : await forgetStack(c, on.ref_id);
    const out = await start(c, on.ref_id, on.job);
    return forgot === undefined ? out : { ...out, forgot, note: `${out.note} Its .pod/ from before it was deleted, version ${forgot}, is forgotten: it starts with no stack.` };
  },
});

/** Starts the job that sets the workspace up, or says why none starts. */
async function start(c: Ctx, ref_id: string, job: string | undefined) {
  if (job) return { started: false, note: `Job ${job} made the workspace, so it sets it up itself.` };
  const space = await nodeOf(c, ref_id);
  const name = space?.name;
  if (!name) return { started: false, note: `The workspace ${ref_id} is gone: nothing to set up.` };
  if (!WORKSPACE.test(name)) return { started: false, workspace: name, note: `${JSON.stringify(name.slice(0, 100))} can't name a pod's workspace: lowercase letters, digits, '.', '_' and '-'.` };
  if (c.trial) return { started: false, workspace: name, note: `A strut trial starts no job: one would set ${name} up.` };
  const title = `Set up ${name}`;
  const chat = await strutStep<{ session: string; job: string }>(c, "conversation/start", {
    message: space?.note ? `${title}\n\n${space.note}` : title,
    job: { title, kind: "Pod Setup", brief: brief(name) },
    about: ref_id,
  });
  if (chat) return { started: true, workspace: name, job: chat.job, session: chat.session, note: `Job ${chat.job} sets ${name} up on the Pod Setup page, in the chat ${chat.session}.` };
  const started = await strutStep<{ job: string }>(c, "job/start", { title, prompt: brief(name), kind: "Pod Setup" });
  if (!started) throw new Error("setup: this strut has neither conversation/start nor job/start to start the job with");
  return { started: true, workspace: name, job: started.job, note: `Job ${started.job} sets ${name} up on the Pod Setup page, in no chat: this strut has no conversation/start.` };
}
