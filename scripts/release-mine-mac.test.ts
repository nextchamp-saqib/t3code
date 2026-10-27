// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell scripts against stub macOS tools.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const base = "0.1.3-nightly.20261026.3710";
const appName = "T3 Code (Nightly).app";

const python = (body: string) => `#!/usr/bin/env python3\nimport os, sys, zipfile\n${body}\n`;
const logged = (name: string) => `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n`;

// Each stub stands in for a macOS or build tool and logs its call to $STUB_LOG.
const stubs: Record<string, string> = {
  uname: `#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n`,
  "xcode-select": "#!/bin/sh\necho /Library/Developer/CommandLineTools\n",
  cargo: logged("cargo"),
  ssh: `#!/bin/sh\necho "ssh $*" >> "$STUB_LOG"\necho "t3 v$SERVER_VERSION"\n`,
  node: `#!/bin/sh\nif [ "$1" = -p ]; then echo 24.0.0; else echo "node $*" >> "$STUB_LOG"; fi\n`,
  vp: python(`
open(os.environ["STUB_LOG"], "a").write("vp " + " ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["run", "dist:desktop:artifact"]:
    with open(os.environ["STUB_LOG"], "a") as log:
        for key in ["T3CODE_RELEASE_BASE_URL", "T3CODE_DESKTOP_UPDATE_REPOSITORY"]:
            log.write(f"{key}={os.environ.get(key)}\\n")
        log.write("HEAD=" + open(".git/HEAD").read())
    version = sys.argv[sys.argv.index("--build-version") + 1]
    os.makedirs("release", exist_ok=True)
    with zipfile.ZipFile(f"release/T3-Code-{version.split('+')[0]}-arm64.zip", "w") as z:
        z.writestr("${appName}/Contents/version", version)`),
  unzip: python(`print("\\n".join(zipfile.ZipFile(sys.argv[2]).namelist()))`),
  ditto: python(`zipfile.ZipFile(sys.argv[3]).extractall(sys.argv[4])`),
  codesign: logged("codesign"),
  osascript: "#!/bin/sh\necho false\n",
  open: logged("open"),
  // Keeps attributes inside the bundle, so they move with it as real ones do.
  xattr: `#!/bin/sh
case "$1" in
  -p) cat "$3/.xattr-$2" ;;
  -w) printf %s "$3" > "$4/.xattr-$2" ;;
esac
`,
};

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function makeFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mine-mac-"));
  const bin = NodePath.join(root, "bin");
  const work = NodePath.join(root, "work");
  const origin = NodePath.join(root, "origin.git");
  const clone = NodePath.join(root, "home/.cache/t3-mine/t3code");
  await NodeFSP.mkdir(bin);
  await NodeFSP.mkdir(NodePath.join(work, "scripts"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, "Applications"));
  await NodeFSP.mkdir(NodePath.join(root, "tmp"));
  for (const [name, body] of Object.entries(stubs)) {
    await NodeFSP.writeFile(NodePath.join(bin, name), body, { mode: 0o755 });
  }
  for (const name of ["release-mine-mac.sh", "release-mine-linux.sh", "install-mac.sh"]) {
    const source = await NodeFSP.readFile(NodePath.resolve(import.meta.dirname, name), "utf8");
    const target = NodePath.join(work, "scripts", name);
    await NodeFSP.writeFile(target, source.replaceAll("/Applications", `${root}/Applications`), {
      mode: 0o755,
    });
  }
  await NodeFSP.writeFile(NodePath.join(work, "package.json"), '{"engines":{"node":"24.0.0"}}\n');
  await NodeFSP.writeFile(
    NodePath.join(work, ".env.example"),
    [
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test",
      "T3CODE_CLERK_JWT_TEMPLATE=template",
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=client",
      "T3CODE_RELAY_URL=https://relay.example",
      "",
    ].join("\n"),
  );
  git(root, "init", "-q", "--bare", "origin.git");
  git(work, "init", "-q", "-b", "mine");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "base");
  git(work, "tag", `v${base}`);
  git(work, "commit", "-q", "--allow-empty", "-m", "shipped to saqib-dev");
  const shipped = git(work, "rev-parse", "HEAD");
  git(work, "commit", "-q", "--allow-empty", "-m", "merged, not shipped");
  git(work, "push", "-q", origin, "mine", `v${base}`);
  git(root, "clone", "-q", "-b", "mine", origin, clone);

  const log = NodePath.join(root, "stub.log");
  const run = (
    args: string[],
    options: { readonly path?: string; readonly checkout?: string } = {},
  ) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        "bash",
        [NodePath.join(options.checkout ?? clone, "scripts/release-mine-mac.sh"), ...args],
        {
          env: {
            PATH: options.path ?? `${bin}:/usr/bin:/bin`,
            HOME: NodePath.join(root, "home"),
            TMPDIR: NodePath.join(root, "tmp"),
            STUB_LOG: log,
            SERVER_VERSION: `${base}+mine.${shipped.slice(0, 10)}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  const readLog = () => NodeFSP.readFile(log, "utf8").catch(() => "");
  const installed = () =>
    NodeFSP.readFile(
      NodePath.join(root, "Applications", appName, ".xattr-dev.t3code.release"),
      "utf8",
    ).catch(() => undefined);
  return {
    root,
    bin,
    work,
    clone,
    shipped,
    run,
    readLog,
    installed,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("release-mine-mac.sh", () => {
  it("builds and installs the version saqib-dev runs, then does nothing on a rerun", async () => {
    await using fixture = await makeFixture();
    const version = `${base}+mine.${fixture.shipped.slice(0, 10)}`;
    // An older checkout of its own clone updates itself to origin/mine first.
    git(fixture.clone, "checkout", "-q", "--detach", fixture.shipped);

    const first = await fixture.run([]);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain(`Installed T3 Code ${version} (was unknown).`);
    expect(await fixture.installed()).toBe(version);
    expect(
      await NodeFSP.readFile(
        NodePath.join(fixture.root, "Applications", appName, "Contents/version"),
        "utf8",
      ),
    ).toBe(version);
    expect(git(fixture.clone, "rev-parse", "HEAD")).toBe(git(fixture.work, "rev-parse", "mine"));
    const log = await fixture.readLog();
    expect(log).toContain(
      "ssh -o BatchMode=yes -o ClearAllForwardings=yes saqib-dev ~/.local/bin/t3 --version",
    );
    expect(log).toContain(`node scripts/update-release-package-versions.ts ${version}`);
    expect(log).toContain("vp run build:desktop");
    expect(log).toContain(`--platform mac --target zip --arch arm64 --build-version ${version}`);
    expect(log).toContain(`codesign --force --deep --sign - `);
    expect(log).toContain(`HEAD=${fixture.shipped}\n`);
    expect(log).toContain("T3CODE_DESKTOP_UPDATE_REPOSITORY=none\n");
    expect(log).toMatch(/^T3CODE_RELEASE_BASE_URL=https:\/\/github\.com\/.+\/releases\/download$/m);
    expect(await NodeFSP.readdir(NodePath.join(fixture.root, "tmp"))).toEqual([]);

    await NodeFSP.rm(NodePath.join(fixture.root, "stub.log"));
    const second = await fixture.run([]);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain(`T3 Code ${version} is already installed.`);
    expect(await fixture.readLog()).not.toMatch(/^(vp|node|codesign) /m);
  });

  it("builds an explicit version without asking saqib-dev and keeps only that build", async () => {
    await using fixture = await makeFixture();
    const shipped = `${base}+mine.${fixture.shipped.slice(0, 10)}`;
    const tip = `${base}+mine.${git(fixture.work, "rev-parse", "mine").slice(0, 10)}`;
    expect((await fixture.run([])).code).toBe(0);
    await NodeFSP.rm(NodePath.join(fixture.root, "stub.log"));

    const result = await fixture.run([tip]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Installed T3 Code ${tip} (was ${shipped}).`);
    expect(await fixture.readLog()).not.toContain("ssh ");
    expect(
      await NodeFSP.readdir(NodePath.join(fixture.root, "home/.cache/t3-mine/releases")),
    ).toEqual([`v${tip}`]);
  });

  it("rejects a version whose commit builds as another version", async () => {
    await using fixture = await makeFixture();
    const result = await fixture.run([
      `0.1.2-nightly.20261021.3473+mine.${fixture.shipped.slice(0, 10)}`,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`builds as ${base}+mine.${fixture.shipped.slice(0, 10)}`);
    expect(await fixture.installed()).toBeUndefined();
  });

  it("refuses to run from another checkout and leaves it alone", async () => {
    await using fixture = await makeFixture();
    const refs = git(fixture.work, "show-ref");

    const result = await fixture.run([], { checkout: fixture.work });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Run this from its own clone");
    expect(git(fixture.work, "show-ref")).toBe(refs);
    expect(await fixture.readLog()).toBe("");
  });

  it("names the install command for each missing tool and changes nothing", async () => {
    await using fixture = await makeFixture();
    const bare = NodePath.join(fixture.root, "bare");
    await NodeFSP.mkdir(bare);
    await NodeFSP.copyFile(NodePath.join(fixture.bin, "uname"), NodePath.join(bare, "uname"));
    await NodeFSP.chmod(NodePath.join(bare, "uname"), 0o755);

    const result = await fixture.run([], { path: `${bare}:/usr/bin:/bin` });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Xcode command line tools: xcode-select --install");
    expect(result.output).toContain("Vite+: curl -fsSL https://vite.plus | bash");
    expect(result.output).toContain(
      "Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    );
    expect(await fixture.readLog()).toBe("");
    expect(await fixture.installed()).toBeUndefined();
  });

  it("asks for Vite+'s Node when another node comes first", async () => {
    await using fixture = await makeFixture();
    const other = NodePath.join(fixture.root, "other");
    await NodeFSP.mkdir(other);
    await NodeFSP.writeFile(NodePath.join(other, "node"), "#!/bin/sh\n", { mode: 0o755 });

    const result = await fixture.run([], { path: `${other}:${fixture.bin}:/usr/bin:/bin` });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "Node from Vite+: curl -fsSL https://vite.plus | VP_NODE_MANAGER=yes bash",
    );
    expect(result.output).not.toContain("Rust:");
    expect(await fixture.readLog()).toBe("");
  });
});
