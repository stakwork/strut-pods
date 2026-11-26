# stadeum/pods

A cloud machine for each coding job: your repos cloned, your app running,
and a link to see it.

| Tool | Does |
| --- | --- |
| `claim { workspace }` | The job's pod: launched on the first call, the same pod on later ones. The workspace's repositories, when the box keeps it, cloned into a bare pod or fetched in one from an image (which loses its checkouts of repositories the workspace no longer has), and in a bare pod its `.pod/` from strut at `/workspaces/.pod`. On a box with a model gateway, a model key of the pod's own (below) |
| `bash { command, cwd?, timeout? }` | A command in the pod, with the result strut's own `bash` gives |
| `edit { command, path, ... }` | Strut's editor (`view`, `create`, `str_replace`, `insert`) on the pod's files |
| `git { args, repo?, pr? }` | `git <args>` in the pod, with the person's token for the remote's host for that one command. With `pr`, a push opens a pull request |
| `url { port, path?, name? }` | A link to one of the pod's ports, `{ url, expires }`, landing on `path` (query and all). The job's hold keeps a 12-hour one at the app's root, so its checks open `{{ urls.pod }}/<path>`, and the person's job card opens it as Open pod. With `name` (another app a person opens, `admin`), the hold keeps it as `{{ urls.admin }}` instead, landing on `path` (its sign-in, or `/?key=<dev key>`), a row of its own on the card, and `urls.pod` stays put |
| `bake { status?, page?, edits? }` | The workspace's next image, from the pod. Starting one asks strut to look every minute and give the job a turn once it's ready or failed (strut's follow-ups), so the agent ends its turn. Once this pod's image is ready, `/workspaces/.pod` saved to strut and, with `page` or `edits`, the workspace's page |
| `release { pod? }` | Destroys the pod and revokes its model key. Strut runs it too when the job is deleted or swept. A trial's pod takes its images with it |

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
| `setup` | `created: Workspace` | Starts a job on `Pod Setup` that sets the new workspace up and bakes it, in a Jamie chat of the person whose run made it (strut's `conversation/start`, `package-seams.md` §7): their message is "Set up <name>" and the workspace's `note`, and the chat is about the workspace. A strut without `conversation/start` starts the job alone (`job/start`). A workspace a job made is that job's to set up, so nothing starts. First, one made again after it was deleted forgets the `.pod/` its node kept |
| `drop-images` | `deleted: Workspace` | Deletes the workspace's images from the service, by the name strut hands it from before the delete (`input.node`); a strut that hands none has the deleted node read. Its `.pod/` stays on the node, which takes no write once deleted: `setup` forgets it if the workspace is made again |

Each step is a few HTTP calls to the service, at `PODS_URL` with the box's
tenant token in `PODS_TOKEN`. The steps find the job's pod in its hold,
`{ pod, workspace }`, so the model never copies a pod's name, and the hold
holds no secret. `concepts/Pod.md` is the page on how to work in a pod, and
`concepts/Pod Setup.md`, under it, on setting up a workspace that has no
image yet, up to the bake and the workspace's page.

**A workspace's repositories** are read from strut's graph, as the
`stadeum/code` package keeps them (its `Repositories` page has the
contract): a `Workspace` by name, and its `INCLUDES` links to
`Repository` nodes, by name. A workspace has no main repository. When
`claim` launches a pod from an image, it first removes each git checkout
directly under `/workspaces` that isn't one of them, so a repository taken
out of the workspace since the bake goes, and its answer lists them
(`removed`). `.pod`, and anything that isn't a git checkout, stay. A later
claim of the same pod removes nothing: the agent may have cloned something
on purpose. Nothing requires that package: on a box without it, or for a
name it doesn't know, `claim` brings no repositories, removes nothing, and
the agent clones them.

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

A deleted workspace keeps its `.pod/`: strut's delete is soft, and keeps
a node's files. A workspace made again with its name is that node
restored, files and all, so `setup` (on `created: Workspace`, which a
restore is) writes an empty version over them first, which `claim` reads
as none: the workspace starts from nothing, as it does with no images.
`drop-images` can't do it: strut takes no write to a deleted node's files.

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

**A commit in a pod is the person's.** Every command the package runs
in a pod carries git's author and committer variables for the run's
person, as their GitHub account says: their name (or login) and
`<id>+<login>@users.noreply.github.com`, the address GitHub credits to
that account. They win over any `user.name` the pod or its image has, and
over one a command sets with `-c`, and nothing is written to the pod's
disk, so an image never carries one person's name into another's job.
The account is read once an hour per token (`GET https://api.github.com/user`
with the person's token for github.com). With no GitHub account connected,
or when GitHub won't say, a command carries none: the pod's own config
decides, and a pod has none, so git asks who you are.

**A pod's model calls are the person's** (PLAN.md §3.2). On a strut with a
model gateway, `claim` asks strut for a grant (`ctx.services.llm.grant`,
stakwork/strut#785): a key of the pod's own through the box's gateway,
named after the pod, billed to the run's person and capped by strut, for
24 hours. It goes into podd's memory with `PUT /env`, so every command
and `pod up` get `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`
and `ANTHROPIC_API_KEY`, and from stakwork/strut#915 Gemini's
`GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY`, and no disk or image has
them. The package sets whatever the grant gives. OpenRouter's models go
through the OpenAI variables, as `openrouter/<org>/<id>`. It's set before a
bare pod has a `.pod/`, and a pod from an image runs its stack again with
it. The hold keeps the grant's id and when it ends, never the key.
A later claim keeps it, unless under 12 hours are left: then a new key
goes in and the old one is revoked. `release` revokes it, and until it's
revoked the hold stays, so strut tries again. A pod with no key is still
claimed: on a strut with no gateway the answer says nothing of models,
and otherwise `models` says why (nobody to bill, a refused grant, a podd
without `PUT /env`, whose grant is revoked at once). A key that can't be
renewed is kept while it lasts.

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
