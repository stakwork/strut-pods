# package/

`stadeum/pods`, the strut package (PLAN.md §8). It gives strut's job agent
a pod: a machine of the job's own, through the pods service.

| Tool | Does |
| --- | --- |
| `claim { workspace }` | The job's pod: launched on the first call, the same pod on later ones |
| `bash { command, cwd?, timeout? }` | A command in the pod, with the result strut's own `bash` gives |
| `edit { command, path, ... }` | Strut's editor (`view`, `create`, `str_replace`, `insert`) on the pod's files |
| `git { args, repo?, pr? }` | `git <args>` in the pod, with the person's `GITHUB_TOKEN` for that one command. With `pr`, a push opens a pull request |
| `url { port, path? }` | A link to one of the pod's ports, `{ url, expires }`. The job's hold keeps a 12-hour one, so its checks open `{{ urls.pod }}/<path>` |
| `bake { status? }` | The workspace's next image, from the pod |
| `release { pod? }` | Destroys the pod. Strut runs it too when the job is deleted or swept |

Each step is a few HTTP calls to the service, at `PODS_URL` with the box's
tenant token in `PODS_TOKEN`. The steps find the job's pod in its hold,
`{ pod, workspace }`, so the model never copies a pod's name, and the hold
holds no secret. `concepts/Pod.md` is the page on how to work in a pod.

`GITHUB_TOKEN` is under `requires.optional`: the steps may read it, and a
strut without one still installs the package. That needs a strut with
`requires.optional` (strut's `plans/followed-repos.md` §2).

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
