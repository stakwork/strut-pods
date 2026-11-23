# stadeum/pods

A cloud machine for each coding job: your repos cloned, your app running,
and a link to see it.

| Tool | Does |
| --- | --- |
| `claim { workspace }` | The job's pod: launched on the first call, the same pod on later ones. The workspace's repositories, when the box keeps it, cloned into a bare pod or fetched in one from an image, and in a bare pod its `.pod/` from strut at `/workspaces/.pod` |
| `bash { command, cwd?, timeout? }` | A command in the pod, with the result strut's own `bash` gives |
| `edit { command, path, ... }` | Strut's editor (`view`, `create`, `str_replace`, `insert`) on the pod's files |
| `git { args, repo?, pr? }` | `git <args>` in the pod, with the person's token for the remote's host for that one command. With `pr`, a push opens a pull request |
| `url { port, path? }` | A link to one of the pod's ports, `{ url, expires }`. The job's hold keeps a 12-hour one, so its checks open `{{ urls.pod }}/<path>` |
| `bake { status?, page?, edits? }` | The workspace's next image, from the pod. Once this pod's image is ready, `/workspaces/.pod` saved to strut and, with `page` or `edits`, the workspace's page |
| `release { pod? }` | Destroys the pod. Strut runs it too when the job is deleted or swept. A trial's pod takes its images with it |

One more step is a CHECK on a claim, never an agent's tool.
`Pod Setup`'s claim names it, so strut judges that claim by what the
service says, never by the agent's word: `stadeum/pods/baked` answers
whether the work's job baked a ready image of its workspace from its pod.
Strut hands a check the work's job and runs it before it closes a trial's
job, so the pod and its images are still there. With no job, or a job that
holds no pod, it fails and strut records no verdict.

Two workflows run on graph writes, never an agent's tools (strut.yaml's
`on:`, strut `plans/package-seams.md` §2):

| Workflow | When | Does |
| --- | --- | --- |
| `setup` | `created: Workspace` | Starts a job on `Pod Setup` (strut's `job/start`) that sets the new workspace up and bakes it, as the person whose run made it. A workspace a job made is that job's to set up, so nothing starts |
| `drop-images` | `deleted: Workspace` | Deletes the workspace's images from the service. Its `.pod/` goes with its node |

Each step is a few HTTP calls to the service, at `PODS_URL` with the box's
tenant token in `PODS_TOKEN`. The steps find the job's pod in its hold,
`{ pod, workspace }`, so the model never copies a pod's name, and the hold
holds no secret. `concepts/Pod.md` is the page on how to work in a pod, and
`concepts/Pod Setup.md`, under it, on setting up a workspace that has no
image yet, up to the bake and the workspace's page.

**A workspace's repositories** are read from strut's graph, as the
`stadeum/code` package keeps them (its `Repositories` page has the
contract): a `Workspace` by name, and its `INCLUDES` links to
`Repository` nodes, by name. A workspace has no main repository. Nothing
requires that package: on a box without it, or for a name it doesn't
know, `claim` brings no repositories and the agent clones them.

**A workspace's `.pod/`** is its own, at `/workspaces/.pod` beside the
repositories (PLAN.md §1), and strut keeps it: this package's files on
the `Workspace` node (`ctx.services.nodeFiles`, strut `plans/package-seams.md`
§1), a version at each change. `claim` writes the latest into a bare pod
that has none; a pod from an image has it baked in. Once this pod's newest
image is ready, `bake` saves the pod's `/workspaces/.pod` as the next
version, when it changed. Files go through one `bash` command each way, in
base64, so a binary one comes through as it is. Nothing is saved in a
trial, nor where the box keeps no such workspace. On a strut without
files on a node, neither step does anything here, and a repository's own
`.pod/` works as before.

**A workspace's page**, `<workspace> workspace`, is a Concept page: a
Mermaid diagram of its systems and how they connect, the system in words,
and how to run it (PLAN.md §3, "Remember"). The agent writes the page and
`bake` stores it, through strut's own graph steps, only once the newest
image baked from this pod is ready (the service's `from_pod`). Nothing is
written while it builds or after it failed. The first time it takes the
whole text (`page`). After that it takes `edits`, so the page is changed
in place and keeps its claims and history: strut's `graph/edit-node`
refuses a whole new text for a page that has one. It's linked under `Pod`,
and under `Codebase` on a box that has that page. Then the old
`<workspace> pod` page is deleted: the agent folded in what still holds.

**In a strut trial, a pod leaves nothing behind.** A trial replays a
case to judge a page's claims, and strut's contract for one is that
nothing it starts outlasts it: every run of it carries `ctx.trial`, and a
case of the `job` workflow runs as a job of its own, `trial-<batch>-<hex>`,
closed once it is judged. So in a trial:

- `claim` puts the pod under a workspace of the trial's own, named after
  its job. It starts bare, never from the named workspace's image, and
  still clones the named workspace's repositories. It makes no
  `Workspace` node. Its answer says which workspace the pod is for.
- `bake` bakes under that workspace, so the named one's images never
  change. Its page goes to a file of the job, `uploads/<workspace>
  workspace.md` (through strut's `job/upload`), where the trial's judge
  reads the work's files (`context/work-file`), and never to the graph.
  As there, `page` is the first text and `edits` change it after: this
  job's file, or else the live page.
- `release`, which strut runs when it closes the job, also deletes that
  workspace's images (the service's `DELETE /workspaces/:workspace/images`).
  The hold's release records that workspace, so it's read from the hold,
  never from what an agent passes. Until the images are gone (a bake still
  building), the hold stays and strut tries again.
- `git` sends no push and opens no pull request. It answers `held`, and
  what they would have sent (the branch, its commits with each one's
  changes, cut at 120 KB, the pull request) goes to a file of the job, `uploads/held push
  <repo>.md`, where the trial's judge reads it.

What a sample leaves: its runs and their verdicts, its agent's session and
the `StrutJob` node (strut keeps both for every deleted job), the
service's rows of its gone pods, and on Lambda its image's log group.

**Git tokens are the person's, by host.** `requires: { git: true }` lets
the steps read the run's token for a repository's host,
`secrets.git(url)`, which strut maps from host to secret: `github.com` to
`GITHUB_TOKEN`, and any other host a package serves with its
`provides.git`. So a GitLab or Forgejo repository clones the same way. A
token is handed to git for one command, in that command's environment,
through a credential helper that answers its own host alone, so it never
reaches another host, a command's arguments, a remote's URL or the pod's
disk. With no token for a host, git gets none, and a private repository
fails with a sentence saying whose account on which host isn't
connected. That needs a strut with git credentials by host
(stakwork/strut#798).

## Installing it

This directory is published, on every merge to main, to the public
[stakwork/strut-pods](https://github.com/stakwork/strut-pods) at its
root (`.github/workflows/package.yml`). A strut installs it from there with
no token, with its deployment key:

```bash
curl -X POST $STRUT/packages/install -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"ref":"git+https://github.com/stakwork/strut-pods@main"}'
```

Its tools work once `PODS_URL` and `PODS_TOKEN` are set (stadeum's
README, "Pods"), and a subscription waits for them. It needs a strut that
takes `on:` in `strut.yaml` (stakwork/strut#851): an older one refuses
it. Change it here, never
in strut-pods: the next publish replaces what's there.

## Trying it

With the service running on the docker backend (`service/README.md`), on a
strut:

```bash
curl -X PUT $STRUT/secrets/PODS_URL -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"value":"http://127.0.0.1:4600"}'
```

```bash
curl -X PUT $STRUT/secrets/PODS_TOKEN -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"value":"<the tenant token>"}'
```

```bash
curl -X POST $STRUT/packages/install -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d "{\"ref\":\"file:$PWD/package\"}"
```

Then run a job: `POST /workflows/job/run { job, input: { prompt } }`. A
changed package is installed again after an uninstall.

## Its tests

`package.test.ts` installs the package from this directory into a strut
started in the test's process, from a checkout of stakwork/strut's main
with its install (`STRUT_DIR`), with `stadeum/code` from its checkout
(`STRUT_CODE_DIR`). The pods service and two forges are stand-ins on the
machine, so the tests reach no network and use no one's token. Where the
strut doesn't keep files on a node itself, a stand-in with the API of
strut's `plans/package-seams.md` §1 does. Where it refuses `on:`, the
package is installed without it and its two workflows are run directly.
CI runs them on every PR (`.github/workflows/checks.yml`).

```bash
STRUT_DIR=../../strut STRUT_CODE_DIR=../../strut-code npm test
```
