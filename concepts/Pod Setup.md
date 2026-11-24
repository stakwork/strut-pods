---
name: Pod Setup
description: Set up a workspace in a pod, the app a person clicks through first and then whatever else can run beside it, and bake it, so every later job starts in seconds. Once a workspace has an image, work in it is Pod's.
parents:
  - Pod
claims:
  - text: The work leaves a ready image of the workspace, baked by this work.
    checks:
      - { type: stadeum/pods/baked, name: a ready image from this job's pod }
  - text: From that image, a signed-out browser reaches the app, signs in as the test user and opens the pages a person would use, with no error page.
  - text: It asked the person for no secret and wrote none into a file.
  - text: The workspace's page draws each system and each connection between them, says how they fit together and how to run them, and says which repositories run in the pod and which are only source.
---
A workspace with no image yet: a bare pod, its repositories cloned, and
nothing running. Set it up until a person can use it, then bake it. What
a pod is, its tools and how its addresses work are on `Pod`, the page
above this one: open it first if it isn't in front of you.

Done means: an image this work baked; from it, a person signs in as the
test user and clicks through the pages they would use; no real secret
asked for or written down; and the workspace's page written, saying what
runs and what is only source. The bake saves `/workspaces/.pod` to
strut, so it needs no pull request.

## What runs

The app a person clicks through comes first: get it running end to end,
signed in and through the pages they would use. Then run every other
repository that can run beside it, wired to it. A change often spans
several (a frontend and its backend), and a job sees the whole of it
only where they all run.

Not every repository can run in a pod: a phone app, or one for a
platform the pod lacks. It stays as source, to read and change in pull
requests. That's fine, not a failure; the workspace's page says so.

How you get there is yours to judge. Nothing needs the person's
go-ahead first.

## The setup is in the connections

Each repository on its own is the easy part. What makes a workspace run
is how its repositories reach each other: the address one calls, the
queue or database they share, the webhook, and the setting in each that
points at the other. Find each one and wire it in `/workspaces/.pod`. Every
connection you wire is an arrow on the workspace's page.

## Working

- `pod survey` reads the repositories. Write the stack in
  `/workspaces/.pod`, beside them: it is the workspace's, not one
  repository's. A bare pod has the one strut keeps there already, when
  an earlier bake saved one: start from it.
- `pod up`, then `pod status`. When something fails, read
  `pod logs <name> -n 100`, fix the config, and try again. Each try
  takes seconds.
- Stub what the workspace calls out to, and ask the person only for what
  nothing can stand in for (`Pod`'s rules of thumb).
- Look at it as a person would: `url`, then strut's browser
  (`browser/verify`, `browser/walkthrough`). Sign in as the test user and
  open the pages that matter. A page that answers isn't proof that it
  works.
- Write `.pod/check.sh` from what you saw, so `pod check` proves it at
  every bake. What it leaves behind is baked: make it safe to run twice,
  and leave the app as a person would find it.
- Bake once `pod check` passes and it looks right. A bake starts again
  from the repositories and `/workspaces/.pod` alone, on a fresh machine:
  it runs `pod up` and `pod check` there and keeps what they leave.
  Whatever you did by hand that isn't in `.pod/` (a package installed, a
  database seeded, a variable set) won't be in the image.
- Once the image is ready, `bake` (`status: true`) saves
  `/workspaces/.pod` to strut as the workspace's next version, so every
  later bare pod starts from it. `.pod/` goes in no repository and no
  pull request.

## The workspace's page

`<workspace> workspace` (`hive workspace`) is what the next job or a
person most needs: how the workspace's systems fit together, and what to
set up to run them. The bake writes it, because that is when it's proven:
once the image is ready, pass it to `bake` with `status: true`, its whole
text as `page`. It holds, in this order:

- a diagram of the systems, in a `mermaid` block. Each arrow is a real
  connection (an HTTP route, a queue, a webhook, a shared database),
  labelled with the setting that points it;
- the system in words: how the parts fit together;
- how to run it: the services and ports, the test user, and what broke
  and how it was fixed;
- what runs in the pod and what is only source, and why.

It sits under `Pod`, and under `Codebase` when the box has one. A pod
released without a bake leaves no page. The workspace holds its
repositories; for one the box doesn't know, list them on the page too. An old `<workspace> pod` page goes once the page is
written: read it first and fold in what still holds.
