import { z, defineStep } from "strut";
import { githubRepo, held, openPull, run, type Ctx } from "./_pods.js";

/** Each branch of each repository in the pod whose commits change `.pod/`
 *  past origin's default branch, one a line: the repository's folder, the
 *  branch, its last commit to `.pod/`, and origin's address. */
const BRANCHES = [
  'for d in */; do d="${d%/}"; [ -d "$d/.git" ] || continue',
  '  base=; git -C "$d" rev-parse -q --verify origin/HEAD >/dev/null && base=origin/HEAD..',
  '  o=$(git -C "$d" remote get-url origin 2>/dev/null)',
  "  for b in $(git -C \"$d\" for-each-ref --format='%(refname:short)' refs/heads); do",
  '    c=$(git -C "$d" log -1 --format=%H "$base$b" -- .pod)',
  "    [ -n \"$c\" ] && printf '%s\\t%s\\t%s\\t%s\\n' \"$d\" \"$b\" \"$c\" \"$o\"",
  "  done",
  "done; true",
].join("\n");

interface Branch {
  repo: string;
  branch: string;
  /** Its last commit to `.pod/`. */
  commit: string;
  origin: string;
}

/** A yes, a no, or (no `supports`) can't tell. */
interface Found {
  supports?: boolean;
  content: string;
}

const lastCommit = (b: Branch) => `the last commit to .pod/ (${b.commit.slice(0, 7)})`;

/** A trial's push is held (`git`): what it would have sent is the job's
 *  `uploads/held push <repo>.md`, which stands for the push and the pull
 *  request. Only `git` writes it. */
async function heldPush(c: Ctx, job: string, b: Branch): Promise<Found> {
  const name = `held push ${b.repo}.md`;
  const at = `${b.repo}'s branch ${b.branch}`;
  const text = (await c.services.jobs?.read?.(job, `uploads/${name}`, { maxChars: 200_000 }))?.text;
  if (!text) return { supports: false, content: `${at} changes .pod/, and was never pushed: the job's files have no ${name}.` };
  if (!text.includes(`- Branch: ${b.branch}\n`)) return { supports: false, content: `The push held in ${name} is of another branch than ${b.branch}.` };
  const pr = /^- Pull request: (.+)$/m.exec(text)?.[1];
  if (!pr) return { supports: false, content: `${at} was pushed with no pull request.` };
  if (!text.includes(`commit ${b.commit.slice(0, 7)}`)) return { supports: false, content: `The push of ${at} doesn't carry ${lastCommit(b)}: it was committed after the push.` };
  return { supports: true, content: `${at}, with ${lastCommit(b)}, was pushed with the pull request ${pr}. Held, as a trial's push is: it is ${name} in the job's files.` };
}

/** Outside a trial: an open pull request on GitHub from the branch, at a
 *  commit that has the branch's last commit to `.pod/`. */
async function pullRequest(c: Ctx, pod: string, b: Branch): Promise<Found> {
  const at = `${b.repo}'s branch ${b.branch}`;
  const gh = githubRepo(b.origin);
  if (!gh) return { content: `${b.repo}'s origin isn't on GitHub, where this package opens pull requests.` };
  const token = await c.services.secrets.git?.(`https://github.com/${gh.owner}/${gh.repo}`);
  let pr: Awaited<ReturnType<typeof openPull>>;
  try {
    pr = await openPull(c, token, { ...gh, head: b.branch });
  } catch (err) {
    return { content: `${err instanceof Error ? err.message : String(err)}.` };
  }
  if (!pr) return { supports: false, content: `${at} changes .pod/, and has no open pull request on GitHub.` };
  if (!/^[0-9a-f]{40}$/.test(pr.sha)) return { content: `GitHub gave pull request #${pr.number} no commit.` };
  const r = await run(c, pod, `git merge-base --is-ancestor ${b.commit} ${pr.sha}`, { cwd: `/workspaces/${b.repo}`, timeoutSeconds: 30 });
  if (r.exit_code !== 0) return { supports: false, content: `Pull request #${pr.number} (${pr.url}) from ${at} doesn't have ${lastCommit(b)}: it wasn't pushed.` };
  return { supports: true, content: `Pull request #${pr.number} (${pr.url}) from ${at} has ${lastCommit(b)}.` };
}

/**
 * A CHECK on a claim, never an agent's tool: whether the work pushed
 * `.pod/` on a branch with a pull request. It reads the job's pod for the
 * branches whose commits change `.pod/`, then asks where the push went: in
 * a trial (the job's pod is under a workspace of its own), the held push in
 * the job's files, which `git` writes in place of the push and the pull
 * request; otherwise GitHub, for an open pull request from the branch with
 * its last commit to `.pod/`. A page names it in its `claims:` block, and
 * strut runs it once the work is done, handing it the work's job as its
 * input's `job`. With no job, a job that holds no pod, or nothing it can
 * ask (an origin not on GitHub, a repository GitHub won't show), it fails,
 * and strut records no verdict.
 */
export default defineStep({
  type: "stadeum/pods/pushed",
  effect: "read",
  description:
    "A CHECK, not a tool: whether the work's job pushed .pod/ on a branch with a pull request: in a trial, its held push; otherwise an open pull request on GitHub. " +
    "Answers { supports, content }. The job is the check's input `job` (what strut hands a check on a Concept), or `job` in its config.",
  input: z.object({
    job: z.string().optional().describe("The job whose pod to look at. Default: the check's input `job`"),
  }),
  output: z.object({ supports: z.boolean(), content: z.string() }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const given = cfg.job || (ctx.input as { job?: unknown } | undefined)?.job;
    if (typeof given !== "string" || !given) throw new Error("pushed: the work ran under no job, so there is no pod to look at");
    const h = await held({ ...c, job: given } as Ctx);
    if (!h) throw new Error(`pushed: job ${given} holds no pod (released, or never claimed), so there is nothing to look at`);
    const r = await run(c, h.pod, BRANCHES, { timeoutSeconds: 60 });
    if (r.exit_code !== 0) throw new Error(`pushed: reading the pod's branches failed: ${r.output.slice(-300)}`);
    const branches = r.output
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l): Branch => {
        const [repo = "", branch = "", commit = "", origin = ""] = l.split("\t");
        return { repo, branch, commit, origin };
      });
    if (!branches.length) return { supports: false, content: "No branch in the pod's repositories changes .pod/ past its default branch: .pod/ was never committed." };
    const no: string[] = [];
    const unknown: string[] = [];
    for (const b of branches) {
      const f = h.own ? await heldPush(c, given, b) : await pullRequest(c, h.pod, b);
      if (f.supports) return { supports: true, content: f.content };
      (f.supports === false ? no : unknown).push(f.content);
    }
    if (unknown.length) throw new Error(`pushed: can't tell. ${[...unknown, ...no].join(" ")}`);
    return { supports: false, content: no.join(" ") };
  },
});
