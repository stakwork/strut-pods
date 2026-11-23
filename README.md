# stadeum/pods

A cloud machine for each coding job: your repos cloned, your app running,
and a link to see it.

| Tool | Does |
| --- | --- |
| `claim { workspace }` | The job's pod: launched on the first call, the same pod on later ones. The workspace's repositories, when the box keeps it, cloned into a bare pod or fetched in one from an image |
| `bash { command, cwd?, timeout? }` | A command in the pod, with the result strut's own `bash` gives |
| `edit { command, path, ... }` | Strut's editor (`view`, `create`, `str_replace`, `insert`) on the pod's files |
| `git { args, repo?, pr? }` | `git <args>` in the pod, with the person's token for the remote's host for that one command. With `pr`, a push opens a pull request |
| `url { port, path? }` | A link to one of the pod's ports, `{ url, expires }`. The job's hold keeps a 12-hour one, so its checks open `{{ urls.pod }}/<path>` |
| `bake { status?, page?, edits? }` | The workspace's next image, from the pod. With `page` or `edits`, the workspace's page, once this pod's image is ready |
| `release { pod? }` | Destroys the pod. Strut runs it too when the job is deleted or swept |

Each step is a few HTTP calls to the service, at `PODS_URL` with the box's
tenant token in `PODS_TOKEN`. The steps find the job's pod in its hold,
`{ pod, workspace }`, so the model never copies a pod's name, and the hold
holds no secret. `concepts/Pod.md` is the page on how to work in a pod.

**A workspace's repositories** are read from strut's graph, as the
`stadeum/code` package keeps them (its `Repositories` page has the
contract): a `Workspace` by name, its `main`, and its `INCLUDES` links to
`Repository` nodes. Nothing requires that package: on a box without it,
or for a name it doesn't know, `claim` brings no repositories and the
agent clones them.

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
README, "Pods"), and a subscription waits for them. Change it here, never
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
machine, so the tests reach no network and use no one's token. CI runs
them on every PR (`.github/workflows/checks.yml`).

```bash
STRUT_DIR=../../strut STRUT_CODE_DIR=../../strut-code npm test
```
