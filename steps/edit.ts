import { z, defineStep } from "strut";
import { call, filesPath, inPod, pod, problem, type Ctx } from "./_pods.js";

/** A `view` longer than this is cut. */
const VIEW_MAX_CHARS = 200_000;

type Read = { kind: "file"; text: string; binary: boolean } | { kind: "dir"; entries: Array<{ name: string; kind: string }> } | { kind: "missing" };

/** A file as `{ text }` (`?as=json`): strut's http parses any body that
 *  looks like JSON, which would reformat a package.json. */
async function read(c: Ctx, p: string, path: string): Promise<Read> {
  const r = await call(c, "GET", `${filesPath(p, path)}?as=json`);
  if (r.status === 404) return { kind: "missing" };
  if (!r.ok) throw problem(`reading ${inPod(path)}`, r);
  if (r.headers["x-pod-kind"] === "dir") return { kind: "dir", entries: r.body as Array<{ name: string; kind: string }> };
  const f = r.body as { text: string; binary: boolean };
  return { kind: "file", text: f.text, binary: f.binary };
}

async function write(c: Ctx, p: string, path: string, text: string): Promise<void> {
  const r = await call(c, "PUT", filesPath(p, path), text);
  if (!r.ok) throw problem(`writing ${inPod(path)}`, r);
}

export default defineStep({
  type: "stadeum/pods/edit",
  description:
    "View and edit text files IN THE JOB'S POD (not on strut's disk, where your own editor works). Paths are absolute in the pod, or under /workspaces (\"hive/.pod/compose.yml\"). Commands: " +
    "`view` (a directory lists its entries; optional view_range [start, end]), `create` (file_text: the whole file; makes its directories), " +
    "`str_replace` (old_str must match EXACTLY once; new_str), `insert` (insert_line, 0 = top of file; insert_text). Claim the pod first.",
  input: z.object({
    command: z.enum(["view", "create", "str_replace", "insert"]),
    path: z.string().describe("The file (or, for view, a directory) in the pod"),
    file_text: z.string().optional().describe("create: the whole file"),
    old_str: z.string().optional().describe("str_replace: the text to replace, exactly one match"),
    new_str: z.string().optional().describe("str_replace: its replacement"),
    insert_line: z.number().int().nonnegative().optional().describe("insert: after this line (0 = top of file)"),
    insert_text: z.string().optional().describe("insert: the text to insert"),
    view_range: z.array(z.number().int()).length(2).optional().describe("view: [start, end] lines (1-based; end -1 = the last)"),
  }),
  output: z.string(),
  async run(cfg, ctx) {
    const c = ctx as unknown as Ctx;
    const { pod: p } = await pod(c);
    const path = cfg.path;

    if (cfg.command === "create") {
      await write(c, p, path, cfg.file_text ?? "");
      return `Successfully created ${inPod(path)}`;
    }

    const got = await read(c, p, path);
    if (got.kind === "missing") return "Error: File not found";
    if (got.kind === "dir") {
      if (cfg.command !== "view") return `Error: ${inPod(path)} is a directory`;
      const names = got.entries.filter((e) => e.name !== ".git").map((e) => (e.kind === "dir" ? `${e.name}/` : e.name));
      return names.length ? names.join("\n") : "(empty directory)";
    }
    if (got.binary) return "Error: binary file: this tool reads text only";

    switch (cfg.command) {
      case "view": {
        const lines = got.text.split("\n");
        let start = 1;
        let end = lines.length;
        if (cfg.view_range) {
          start = Math.max(1, cfg.view_range[0]!);
          end = cfg.view_range[1] === -1 ? lines.length : cfg.view_range[1]!;
        }
        const out = lines
          .slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join("\n");
        return out.length > VIEW_MAX_CHARS ? `${out.slice(0, VIEW_MAX_CHARS)}\n\n[... output truncated ...]` : out;
      }
      case "str_replace": {
        const old = cfg.old_str ?? "";
        const count = old ? got.text.split(old).length - 1 : 0;
        if (count === 0) return "Error: No match found for replacement. Please check your text and try again.";
        if (count > 1) return `Error: Found ${count} matches for replacement text. Please provide more context to make a unique match.`;
        const at = got.text.indexOf(old);
        await write(c, p, path, got.text.slice(0, at) + (cfg.new_str ?? "") + got.text.slice(at + old.length));
        return "Successfully replaced text at exactly one location.";
      }
      case "insert": {
        const lines = got.text.split("\n");
        const at = cfg.insert_line ?? 0;
        if (at > lines.length) return `Error: insert_line ${at} is out of range (0-${lines.length})`;
        lines.splice(at, 0, cfg.insert_text ?? "");
        await write(c, p, path, lines.join("\n"));
        return `Successfully inserted text after line ${at}`;
      }
    }
    return `Error: unknown command "${String(cfg.command)}"`;
  },
});
