---
name: Pod
description: Get a repository's app running in a pod, a machine of the job's own, then change it, see it in a browser, and bake what works so the next job starts in seconds.
parents:
  - Job
---
A pod is a machine of the job's own. It holds the workspace's repositories
under `/workspaces/<repo>`, runs the services they need under Docker and
the apps being developed under pm2, and serves each port over HTTPS.

Work in it with the pod tools: `claim`, `bash`, `edit`, `git`, `url`,
`bake` and `release` (as tools, `stadeum_pods_<name>`). They act in the
pod. Your own `bash` and editor act on strut's disk, never on the pod.

## The loop

1. **Claim** the pod with the workspace, usually the main repository's
   name. A workspace the box keeps comes with its repositories at
   `/workspaces/<name>`, the main one first: `claim` clones them into a
   bare pod and fetches them in a pod from an image. Its answer says, for
   each one, what it did, or why it couldn't (pass that on to the
   person). With an image, the stack is already running: run `git pull`
   with `git`, then `pod up` with `bash`. A bare pod has no stack yet:
   run `pod survey`, and write `.pod/` in the main repository. For a
   workspace the box doesn't know, `claim` brings no repositories: clone
   them with `git` (`clone <url>`, into `/workspaces`).
2. **Bring it up.** `pod up`, then `pod status`. When something fails,
   read `pod logs <name> -n 100`, fix the config, and `pod restart <name>`
   or `pod up` again. Each try takes seconds. Keep going until
   `pod check` passes.
3. **Look at it.** `url` with the app's port gives a link. Open that link
   (never the bare `<pod>-<port>` name, which needs the link's cookie)
   with `browser/verify` or `browser/walkthrough`, or give it to the person,
   who can watch it change as you work. Log in as the test user and open
   the pages that matter. A page that answers isn't proof that it works.
4. **Write `.pod/check.sh`** from what you checked in the browser, so
   `pod check` proves it next time. It runs in every bake, so what it
   leaves behind is baked: make it safe to run again and leave the app as
   a person would find it (a mock sign-in that seeds a user must work a
   second time).
5. **Bake** once `pod check` passes and the app looks right. Commit
   `.pod/` and open a PR with `git` (`push -u origin <branch>` with `pr`),
   so later bakes from the base branch have it.
6. **Remember.** Keep what the next job needs on a page under this one,
   `<workspace> pod`: the services and ports, the test user, and what
   broke and how it was fixed. The workspace holds its repositories. For
   a workspace the box doesn't know, list them there too, the main one
   first.

## `.pod/`

In the main repository. Each file is the stock tool's own format:

- `compose.yml`: services run from images: databases, queues, stubs.
- `pm2.config.js`: the apps being developed: dev servers, workers. An app
  with `env.PORT` serves that port, and `pod check` waits until it
  answers.
- `setup.sh` (optional): installs, migrations, seeds. It runs at every
  `pod up`, so make it quick when nothing changed. Use `npm install`, not
  `npm ci`, which deletes `node_modules` first.
- `check.sh` (optional): exits 0 when the app works.
- `Dockerfile` (optional): system packages, `FROM ghcr.io/stakwork/pods-base`.
  Try a package by hand in the pod first (you're root), then move it here.

`.pod/` can hold anything these use: a stub's config, seed data, an env
file.

## Rules of thumb

- **Stubs first.** Run MinIO or rustfs in place of S3, Mailpit in place of
  a mail service, a local database in place of a hosted one. Ask the
  person only for a secret no stub can stand in for, and never write a
  secret's value into a file.
- **Anything that never exits goes in `pm2.config.js`,** never in `bash`,
  whose command is killed when it ends or times out.
- **Bind wherever the app likes.** Requests reach it as `localhost:<port>`,
  so dev servers' host checks pass with no setting.
- **An address the browser uses** (a frontend calling an API on another
  port, file URLs from a storage stub, a login server's redirects) is the
  port's public address, never `localhost`. Every command and `pod up` get
  it as `POD_URL_<port>`, and `pod url <port>` prints it. Wire it in
  `.pod/`, such as `API_URL: process.env.POD_URL_8000` in
  `pm2.config.js`. A pod that uses them starts its apps again at each
  claim, with its own addresses. Each address carries a key, so a page's
  calls to it need no link and no cookie, as on a laptop.
- **CORS works as on a laptop.** The app sees the page's origin as
  `http://localhost:5173`, so a CORS list written for a laptop works as
  it is. Don't change an app's CORS or `fetch` for the pod.
- **One link opens all of the pod's ports** in that browser.
- **One pod per job.** `release` it when done, or to claim another
  workspace. Anything not pushed or baked goes with it.
