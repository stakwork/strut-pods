---
name: Pod
description: Work in a workspace's pod, a machine of the job's own, started from the workspace's image with its app running, then change it, see it in a browser, and bake what changed so the next job starts from it. A workspace with no image yet is set up first (`Pod Setup`).
parents:
  - Job
---
A pod is a machine of the job's own. It holds the workspace's repositories
under `/workspaces/<repo>` and its stack in `/workspaces/.pod`, runs the
services they need under Docker and the apps being developed under pm2,
and serves each port over HTTPS.

Work in it with the pod tools: `claim`, `bash`, `edit`, `git`, `url`,
`bake` and `release` (as tools, `stadeum_pods_<name>`). They act in the
pod. Your own `bash` and editor act on strut's disk, never on the pod.

## The loop

1. **Claim** the pod with the workspace's name. A workspace the box
   keeps comes with its repositories at `/workspaces/<name>`: `claim`
   fetches them in a pod from an image, and removes the image's checkouts
   of repositories the workspace no longer has (`removed`). Its answer says, for each one, what it did, or why
   it couldn't (pass that on to the person). With an image, the stack is
   already running: run `git pull` with `git`, then `pod up` with `bash`.
   A workspace with no image yet comes as a bare pod, with nothing
   running but the `/workspaces/.pod` strut keeps, if any: setting it
   up is `Pod Setup`'s, the page under this one, so open it. For a workspace the box doesn't know, `claim` brings no
   repositories: clone them with `git` (`clone <url>`, into
   `/workspaces`), and set it up the same way. Claim again at the start
   of each turn that works in the pod: it renews the pod's model key.
2. **Work.** Change the code or `.pod/`, then `pod up` or
   `pod restart <name>`, and `pod status`. `pod up` starts afresh an app
   whose definition in `pm2.config.js` changed, so it needs no
   `pm2 delete`. When something fails, read `pod logs <name> -n 100`.
   Each try takes seconds. `pod check` still passes when you're done.
3. **Look at it.** `url` with the app's port gives a link. Open that link
   (never the bare `<pod>-<port>` name, which needs the link's cookie)
   with `browser/verify` or `browser/walkthrough`, or give it to the person,
   who can watch it change as you work. Each `url` also sets a button on
   the person's job card (below). Log in as the test user and open
   the pages that matter. A page that answers isn't proof that it works.
4. **Push** the work on a branch and open a PR with `git`
   (`push -u origin <branch>` with `pr`). A commit is the person's: every
   command in the pod carries their GitHub name and email. Never set a
   name or email of your own. When git asks who you are, no GitHub
   account is connected for them: say so.
5. **Bake again** when the setup changed: `.pod/`, a new service, a new
   connection between the systems. Then end your turn, as bake's answer
   says: strut gives the job a turn once the image is ready or failed. In
   it, pass `bake` (`status: true`) `edits` to the workspace's page,
   `<workspace> workspace`, for what changed in how its systems connect
   or run (`Pod Setup` says what the page holds), and update
   `.pod/check.sh` when what proves the app works changed. That call also
   saves `/workspaces/.pod` to strut, so `.pod/` needs no pull request.

## The person's links

The person gets into the pod from the buttons on their job card, one for
each link the job names, in their own browser, signed out.

- **A link for each app a person opens.** The main one, `url` with no
  name, is Open pod: the app they click through first, usually the one
  they sign into. Each other app they open (an admin app, docs, a second
  UI) gets a `name` and a button of its own. An API, or a port that
  answers only with a key, is no way in on its own: it gets no link,
  unless it serves pages that take the key in their URL.
- **Each lands where a signed-out browser gets in.** Open pod opens the
  app's root, where the job's checks add a path, so the main app is one
  whose root sends a signed-out browser to sign in. A named link lands on
  its `path`: the app's sign-in page (`/signin`), or, for an app that
  takes its key in its URL, the pod's dev key (`/?key=<dev key>`).
- **Open pod shows the app in a frame** beside the person's chat, or in
  a tab. The pods service lets the person's box frame the pod's pages; a
  page from outside the pod that refuses frames, such as a Google or
  GitHub sign-in, opens only in the tab.
- **A dev key, never a secret.** An app that wants a key of its own gets
  a made-up one in `.pod/`, like the test user's password: it opens
  nothing outside the pod. A real secret never goes in a link: the job
  and the person's chat keep links.
- **Your reply matches the buttons.** Send the person to each by its
  name (Open pod, Open admin), with the test user to sign in as. Name no
  way in that has no button, such as a port or a path to type.

## `.pod/`

At `/workspaces/.pod`, beside the repositories: the workspace's, not one
repository's. Its commands run from `/workspaces`, so a path in it starts
from there (`web/package.json`, `.pod/compose.yml`). Strut keeps it with
the workspace: each bake saves it once its image is ready, and a bare pod
starts with the latest. A workspace deleted and made again has none. A repository's own `.pod/` still works where the
workspace has none. Each file is the stock tool's own format:

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
- **Models through the box.** When `claim`'s answer has `models`, every
  command and `pod up` get `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
  `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, and on a newer box
  `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` (Google's `@google/genai`
  SDK): a key of the pod's own, billed to the person. `env` in `bash`
  shows which. OpenRouter's models go through the OpenAI ones, with
  `openrouter/` before the model's name (`openrouter/<org>/<model>`);
  never set an `OPENROUTER_API_KEY`, which would send the key to
  OpenRouter. Never ask the person for a model key. Name each
  one an app uses in `.pod/`, never its value
  (`OPENAI_API_KEY: process.env.OPENAI_API_KEY` in `pm2.config.js`,
  `- ANTHROPIC_API_KEY` under a service's `environment` in
  `compose.yml`), so the app gets it and starts again when it changes. An
  app that reads other names gets them the same way
  (`LLM_KEY: process.env.ANTHROPIC_API_KEY`). When `models` says `none`,
  its `problem` is the reason: tell the person.
- **Anything that never exits goes in `pm2.config.js`,** never in `bash`,
  whose command is killed when it ends or times out.
- **pm2 runs a Node script through a wrapper of its own,** so the script
  isn't `process.argv[1]`. A server that starts only when it's the main
  module, by comparing `process.argv[1]` with its own file or by
  `import.meta.main`, loads under pm2 and never listens
  (`require.main === module` still works). Have pm2 run `node` itself:
  `script: "node"`, `args: "<file>"`, `interpreter: "none"`.
- **Bind wherever the app likes.** Requests reach it as `localhost:<port>`,
  with no `X-Forwarded-*` headers, so dev servers' host checks and
  frameworks' origin checks (Next's Server Actions, CSRF) pass with no
  setting and no proxy of your own.
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
