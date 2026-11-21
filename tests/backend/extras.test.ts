import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  extraActionScript,
  extraHistoryScript,
  extraInstalledScript,
  extraReposScript,
  extraSearchScript,
  extraUpdatesScript,
  parseExtraHistory,
  parseExtraInstalled,
  parseExtraRepos,
  parseExtraSearch,
  parseExtraUpdates,
} from "../../src/backend/extras.js";
import { MARK, cleanNames } from "../../src/backend/scripts.js";
import { parseStatus } from "../../src/backend/service.js";
import { EXTRA_MANAGERS, type PackageAction } from "../../src/shared/types.js";
import { startServer, type TestServer } from "./helpers";

const hasBash = spawnSync("bash", ["--version"]).status === 0;

let s: TestServer | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

const SNAP_LIST = `Name    Version    Rev    Tracking       Publisher   Notes
core20  20240416   2318   latest/stable  canonical✓  base
lxd     5.21.1     28463  5.21/stable    canonical✓  held`;

describe("status", () => {
  it("lists the extras a host has", () => {
    expect(parseStatus("manager=apt\nflatpak=1\nbrew=1\n").extras).toEqual([
      "flatpak",
      "brew",
    ]);
    expect(parseStatus("manager=none\nsnap=1\n")).toMatchObject({
      manager: "none",
      extras: ["snap"],
    });
  });
});

describe("Flatpak", () => {
  it("reads updates with the installed version", () => {
    const out = `${MARK}CUR
org.mozilla.firefox\tstable\t128.0
org.gnome.Platform\t46\t
${MARK}UP
org.mozilla.firefox\tstable\t129.0\tflathub
org.gnome.Platform\t46\t\tflathub`;
    expect(parseExtraUpdates("flatpak", out)).toEqual([
      {
        name: "org.mozilla.firefox",
        current: "128.0",
        available: "129.0",
        repo: "flathub",
        security: false,
      },
      {
        name: "org.gnome.Platform",
        current: "46",
        available: "46",
        repo: "flathub",
        security: false,
      },
    ]);
  });

  it("reads installed apps with masks as holds", () => {
    const out = `org.mozilla.firefox\t128.0\t250.1 MB\tFirefox
org.videolan.VLC\t3.0.21\t80.0 MB\tVLC
${MARK}MASK
org.videolan.VLC`;
    expect(parseExtraInstalled("flatpak", out)).toEqual([
      {
        name: "org.mozilla.firefox",
        version: "128.0",
        size: 250_100_000,
        summary: "Firefox",
        held: false,
      },
      expect.objectContaining({ name: "org.videolan.VLC", held: true }),
    ]);
  });

  it("reads search results, history and remotes", () => {
    expect(
      parseExtraSearch(
        "flatpak",
        `org.gimp.GIMP\t2.10.38\tGIMP\tImage editor\n${MARK}HAVE\norg.gimp.GIMP`,
      ),
    ).toEqual([
      {
        name: "org.gimp.GIMP",
        version: "2.10.38",
        summary: "GIMP: Image editor",
        installed: true,
      },
    ]);
    expect(
      parseExtraHistory(
        "flatpak",
        "Nov 19 10:00:01\tdeploy install\torg.gimp.GIMP\tstable\nNov 20 09:00:00\tuninstall\torg.gimp.GIMP\tstable",
      )[0],
    ).toMatchObject({ action: "uninstall", packages: "org.gimp.GIMP stable" });
    expect(
      parseExtraRepos(
        "flatpak",
        "flathub\thttps://dl.flathub.org/repo/\tsystem\nold\thttps://x.example/\tsystem,disabled",
      ),
    ).toEqual([
      {
        id: "flathub",
        name: "flathub",
        url: "https://dl.flathub.org/repo/",
        enabled: true,
      },
      { id: "old", name: "old", url: "https://x.example/", enabled: false },
    ]);
  });
});

describe("Snap", () => {
  it("reads updates against the installed list", () => {
    const out = `${MARK}CUR
${SNAP_LIST}
${MARK}UP
Name  Version   Rev    Size  Publisher   Notes
lxd   5.21.2    29000  95MB  canonical✓  -`;
    expect(parseExtraUpdates("snap", out)).toEqual([
      {
        name: "lxd",
        current: "5.21.1",
        available: "5.21.2",
        repo: "canonical✓",
        security: false,
      },
    ]);
    expect(
      parseExtraUpdates("snap", `${MARK}CUR\n${SNAP_LIST}\n${MARK}UP\n`),
    ).toEqual([]);
  });

  it("reads installed snaps with holds", () => {
    expect(parseExtraInstalled("snap", SNAP_LIST)).toEqual([
      {
        name: "core20",
        version: "20240416",
        size: null,
        summary: "Tracking latest/stable",
        held: false,
      },
      expect.objectContaining({ name: "lxd", held: true }),
    ]);
  });

  it("keeps spaces in the last column and in aligned ones", () => {
    expect(
      parseExtraSearch(
        "snap",
        `Name     Version  Publisher   Notes  Summary
htop     3.3.0    maxiberta   -      Interactive processes viewer
${MARK}HAVE
core20`,
      ),
    ).toEqual([
      {
        name: "htop",
        version: "3.3.0",
        summary: "Interactive processes viewer",
        installed: false,
      },
    ]);
    expect(
      parseExtraHistory(
        "snap",
        `ID   Status  Spawn               Ready               Summary
12   Done    today at 10:01 UTC  today at 10:02 UTC  Refresh "lxd" snap`,
      ),
    ).toEqual([
      {
        date: "today at 10:01 UTC",
        action: "Done",
        packages: 'Refresh "lxd" snap',
        command: "",
      },
    ]);
  });
});

describe("Homebrew", () => {
  it("reads outdated and installed JSON after any noise", () => {
    const outdated = `Warning: something\n{"formulae":[{"name":"wget","installed_versions":["1.21.3"],"current_version":"1.24.5","pinned":false}],"casks":[{"name":"firefox","installed_versions":["128.0"],"current_version":"129.0"}]}`;
    expect(parseExtraUpdates("brew", outdated)).toEqual([
      {
        name: "wget",
        current: "1.21.3",
        available: "1.24.5",
        repo: "",
        security: false,
      },
      expect.objectContaining({ name: "firefox", repo: "cask" }),
    ]);
    const installed = `{"formulae":[{"name":"jq","desc":"JSON processor","installed":[{"version":"1.7.1"}],"pinned":true}],"casks":[{"token":"iterm2","desc":"Terminal","installed":"3.5.0"}]}`;
    expect(parseExtraInstalled("brew", installed)).toEqual([
      {
        name: "jq",
        version: "1.7.1",
        size: null,
        summary: "JSON processor",
        held: true,
      },
      {
        name: "iterm2",
        version: "3.5.0",
        size: null,
        summary: "Terminal",
        held: false,
      },
    ]);
    expect(parseExtraUpdates("brew", "not json")).toEqual([]);
  });

  it("reads search names and taps", () => {
    expect(
      parseExtraSearch(
        "brew",
        `==> Formulae\nwget\nwgetpaste\n${MARK}HAVE\nwget`,
      ),
    ).toEqual([
      { name: "wget", version: "", summary: "", installed: true },
      { name: "wgetpaste", version: "", summary: "", installed: false },
    ]);
    expect(parseExtraRepos("brew", "hashicorp/tap")).toEqual([
      {
        id: "hashicorp/tap",
        name: "hashicorp/tap",
        url: "https://github.com/hashicorp/homebrew-tap",
        enabled: true,
      },
    ]);
  });

  it("runs as the owner of its prefix, never as root", () => {
    const script = extraActionScript("brew", "install", ["wget"]);
    expect(script).toContain('runuser -u "$BU"');
    expect(script).toContain("HOMEBREW_NO_AUTO_UPDATE=1");
    expect(script).toContain("brew install 'wget'");
  });

  it("takes tap names", () => {
    expect(cleanNames(["hashicorp/tap/terraform"])).toEqual([
      "hashicorp/tap/terraform",
    ]);
    expect(() => cleanNames(["/etc/passwd"])).toThrow();
  });
});

describe("scripts", () => {
  const actions: PackageAction[] = [
    "refresh",
    "update",
    "upgrade-all",
    "install",
    "remove",
    "hold",
    "unhold",
  ];
  for (const pm of EXTRA_MANAGERS) {
    const scripts = [
      extraUpdatesScript(pm),
      extraInstalledScript(pm),
      extraSearchScript(pm, "htop"),
      extraHistoryScript(pm),
      extraReposScript(pm),
      ...actions.map((a) => extraActionScript(pm, a, ["a b"])),
    ];
    it.runIf(hasBash)(`${pm} scripts are valid bash`, () => {
      for (const script of scripts) {
        const run = spawnSync("bash", ["-n"], {
          input: script,
          encoding: "utf8",
        });
        expect(run.stderr).toBe("");
      }
    });
    it(`${pm} quotes package names`, () => {
      expect(extraActionScript(pm, "install", ["a b"])).toContain("'a b'");
    });
  }
});

describe("routes", () => {
  const status = "os=Ubuntu\nroot=1\nmanager=apt\nsnap=1\n";

  it("use the extra a request picks", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status });
    s.ssh.replies.push({
      match: "snap list",
      stdout: `${MARK}CUR\n${SNAP_LIST}\n${MARK}UP\nName  Version  Rev  Size  Publisher  Notes\nlxd   5.21.2   1    1MB   canonical  -\n`,
    });
    const res = await s.request("GET", "/1/updates?manager=snap");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ name: "lxd" })]);
    expect(s.ssh.calls.at(-1)!.stdin).toContain("snap refresh --list");
  });

  it("refuse an extra the host does not have, or an unknown one", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status });
    expect((await s.request("GET", "/1/updates?manager=flatpak")).status).toBe(
      400,
    );
    expect((await s.request("GET", "/1/updates?manager=npm")).status).toBe(400);
  });

  it("run actions with the picked extra", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status });
    s.ssh.replies.push({ match: "snap install", stdout: "htop installed\n" });
    const res = await s.request("POST", "/1/action", {
      action: "install",
      packages: ["htop"],
      manager: "snap",
    });
    expect(res.body).toEqual({ ok: true, output: "htop installed" });
  });

  it("report the extras in the status", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status });
    expect((await s.request("GET", "/1/status")).body.extras).toEqual(["snap"]);
  });
});
