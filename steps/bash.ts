import { z, defineStep } from "strut";
import { pod, run, shown, type Ctx } from "./_pods.js";

export default defineStep({
  type: "stadeum/pods/bash",
  description:
    "Run a bash command IN THE JOB'S POD (not on strut's disk, where your own bash runs), as root, from /workspaces unless `cwd` says otherwise. " +
    "The stack is run with the `pod` CLI here: `pod up` (compose, setup.sh, pm2), `pod status`, `pod logs <name> -n 100`, `pod restart <name>`, `pod check`, `pod survey`, `pod url <port>`. " +
    "docker, docker compose and pm2 work directly too. Output is stdout and stderr together. A command that never exits (a dev server) belongs in .pod/pm2.config.js, not here. " +
    "Claim the pod first.",
  input: z.object({
    command: z.string().describe("The bash command to run in the pod"),
    cwd: z.string().optional().describe("Where to run it: an absolute path, or one under /workspaces (\"hive/web\"). Default /workspaces"),
    timeout: z.number().int().positive().max(3600).optional().describe("Seconds before its process group is killed. Default 300; `pod up` on a big stack may need more"),
  }),
  output: z.string(),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const { pod: p } = await pod(c);
    const timeout = cfg.timeout ?? 300;
    return shown(await run(c, p, cfg.command, { ...(cfg.cwd ? { cwd: cfg.cwd } : {}), timeoutSeconds: timeout }), timeout);
  },
});
