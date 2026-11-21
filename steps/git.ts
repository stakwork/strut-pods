import { z, defineStep } from "strut";
import { gitAuth, httpsHost, pod, run, shown, signIn, type Ctx } from "./_pods.js";

/** The first https address among git's arguments (`clone <url>`,
 *  `fetch <url>`), its quotes dropped. */
const urlIn = (args: string) => args.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).find((w) => httpsHost(w));

/** The address of `origin` where the command runs, if it has one. */
async function origin(c: Ctx, p: string, cwd: string): Promise<string | undefined> {
  const r = await run(c, p, "git remote get-url origin", { cwd, timeoutSeconds: 30 });
  return r.exit_code === 0 ? r.output.trim() || undefined : undefined;
}

/** `owner/repo` of a GitHub remote, https or ssh. */
function githubRepo(remote: string): { owner: string; repo: string } | undefined {
  const m = /github\.com[/:]([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

interface Pr {
  url: string;
  number: number;
  created: boolean;
}

async function openPr(
  c: Ctx,
  token: string,
  where: { owner: string; repo: string; head: string; base: string },
  pr: { title: string; body?: string; draft?: boolean },
): Promise<Pr> {
  const api = `https://api.github.com/repos/${where.owner}/${where.repo}/pulls`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "stadeum-pods" };
  const open = await c.services.http(`${api}?state=open&per_page=1&head=${encodeURIComponent(`${where.owner}:${where.head}`)}`, { headers, timeout: 30_000 });
  const found = Array.isArray(open.body) ? (open.body[0] as { html_url: string; number: number } | undefined) : undefined;
  if (found) return { url: found.html_url, number: found.number, created: false };
  const made = await c.services.http(api, {
    method: "POST",
    headers,
    body: { title: pr.title, head: where.head, base: where.base, ...(pr.body ? { body: pr.body } : {}), ...(pr.draft ? { draft: true } : {}) },
    timeout: 30_000,
  });
  if (!made.ok) {
    const msg = (made.body as { message?: string } | undefined)?.message ?? String(made.body);
    throw new Error(`pr_create_failed: GitHub answered ${made.status}: ${msg.slice(0, 300)}`);
  }
  const b = made.body as { html_url: string; number: number };
  return { url: b.html_url, number: b.number, created: true };
}

export default defineStep({
  type: "stadeum/pods/git",
  description:
    "Run `git <args>` IN THE JOB'S POD with the person's token for the remote's host available to that one command, for what needs it: clone, fetch, pull, push. " +
    "In `repo` (a repository under /workspaces), or in /workspaces itself, where `clone <url>` makes /workspaces/<name>. " +
    "With `pr`, a successful push opens a pull request from the pushed branch (or returns the open one). " +
    "Plain git that needs no token (status, diff, commit, checkout -b) can run through bash too. Claim the pod first.",
  input: z.object({
    args: z.string().describe("git's arguments: \"clone https://github.com/org/repo\", \"pull\", \"push -u origin feature/x\""),
    repo: z.string().optional().describe("The repository's directory under /workspaces (\"hive\"). Default /workspaces"),
    pr: z
      .object({
        title: z.string(),
        body: z.string().optional(),
        base: z.string().optional().describe("The branch to merge into. Default the remote's default branch"),
        draft: z.boolean().optional(),
      })
      .optional()
      .describe("After the command succeeds, open a pull request from the current branch"),
    timeout: z.number().int().positive().max(3600).optional().describe("Seconds. Default 600"),
  }),
  output: z.object({
    output: z.string(),
    ok: z.boolean(),
    pr: z.object({ url: z.string(), number: z.number(), created: z.boolean() }).optional(),
  }),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const { pod: p } = await pod(c);
    const cwd = cfg.repo ? `/workspaces/${cfg.repo}` : "/workspaces";
    const timeout = cfg.timeout ?? 600;
    // The remote it talks to: the address in its arguments, else origin's.
    // Its host's token, and no other, is the command's.
    const url = urlIn(cfg.args) ?? (await origin(c, p, cwd));
    const auth = await gitAuth(c, url);

    const r = await run(c, p, `git ${auth.config}${cfg.args}`, { cwd, env: auth.env, timeoutSeconds: timeout });
    const said = auth.hide(shown(r, timeout));
    const ok = r.exit_code === 0 && !r.timed_out && !r.cancelled;
    const why = !ok && url ? signIn(c, url, auth, said) : undefined;
    const output = why ? `${said}\n${why}` : said;
    if (!ok || !cfg.pr) return { output, ok };

    const facts = await run(
      c,
      p,
      `git remote get-url origin; git rev-parse --abbrev-ref HEAD; git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main`,
      { cwd, timeoutSeconds: 30 },
    );
    const [remote = "", head = "", originHead = ""] = facts.output.trim().split("\n");
    const gh = githubRepo(remote);
    if (facts.exit_code !== 0 || !gh) throw new Error(`pr: origin isn't a GitHub repository (${auth.hide(remote) || "no origin"})`);
    const token = await c.services.secrets.git?.(`https://github.com/${gh.owner}/${gh.repo}`);
    if (!token) throw new Error(`opening a pull request needs a token for github.com, and no account on github.com is connected for ${c.principal ?? c.actor ?? "the person running this job"}`);
    const base = cfg.pr.base ?? originHead.replace(/^origin\//, "");
    const pr = await openPr(c, token, { ...gh, head, base }, cfg.pr);
    return { output, ok, pr };
  },
});
