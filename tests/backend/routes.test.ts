import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { actionScript } from "../../src/backend/scripts.js";
import type { Manager, PackageAction } from "../../src/shared/types.js";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const status = (pm = "apt") =>
  `os=Debian GNU/Linux 13 (trixie)\nroot=1\nmanager=${pm}\nreboot=1\nindex=1762000000\n`;

const UPDATES =
  "curl/stable-security 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]\n";

describe("status", () => {
  it("reports the package manager and reboot state", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    const res = await s.request("GET", "/1/status");
    expect(res.body).toMatchObject({
      manager: "apt",
      root: true,
      rebootRequired: true,
      indexUpdatedAt: 1762000000,
      singleUpdates: true,
      holds: true,
      canEdit: true,
    });
  });

  it("knows pacman does only full upgrades", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status("pacman") });
    const res = await s.request("GET", "/1/status");
    expect(res.body).toMatchObject({ singleUpdates: false, holds: false });
  });

  it("refuses hosts with Packages turned off", async () => {
    s = await startServer({ settings: { enablePackages: false } });
    const res = await s.request("GET", "/1/status");
    expect(res.body.code).toBe("disabled");
  });
});

describe("reads", () => {
  it("lists updates with the detected manager", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    s.ssh.replies.push({ match: "apt list --upgradable", stdout: UPDATES });
    const res = await s.request("GET", "/1/updates");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ name: "curl", security: true });
  });

  it("answers noManager without a package manager", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: "manager=none\n" });
    const res = await s.request("GET", "/1/installed");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("noManager");
  });

  it("checks the search query", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    expect((await s.request("GET", "/1/search?q=a")).status).toBe(400);
    expect((await s.request("GET", "/1/search?q=%24(id)")).status).toBe(400);
    const ok = await s.request("GET", "/1/search?q=htop");
    expect(ok.status).toBe(200);
    expect(s.ssh.calls.at(-1)!.stdin).toContain(
      "apt-cache search --names-only -- 'htop'",
    );
  });
});

describe("actions", () => {
  it("installs as root and audits it", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    s.ssh.replies.push({ match: "install", stdout: "Setting up htop\n" });
    const res = await s.request("POST", "/1/action", {
      action: "install",
      packages: ["htop"],
    });
    expect(res.body).toEqual({ ok: true, output: "Setting up htop" });
    const call = s.ssh.calls.at(-1)!;
    expect(call.command).toContain("sudo");
    expect(call.stdin).toContain("install 'htop'");
    expect(s.mock.audits.at(-1)).toMatchObject({
      action: "package-manager.action",
      resourceName: "install htop",
      success: true,
    });
  });

  it("sends the output back when the package manager fails", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    s.ssh.replies.push({
      match: "install",
      stdout: "E: Unable to locate package nope\n",
      code: 100,
    });
    const res = await s.request("POST", "/1/action", {
      action: "install",
      packages: ["nope"],
    });
    expect(res.status).toBe(400);
    expect(res.body.output).toContain("Unable to locate package");
  });

  it("refuses bad names and unknown actions", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    expect(
      (
        await s.request("POST", "/1/action", {
          action: "install",
          packages: ["a;b"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.request("POST", "/1/action", {
          action: "install",
          packages: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (await s.request("POST", "/1/action", { action: "nuke" })).status,
    ).toBe(400);
  });

  it("refuses single updates on pacman", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "manager=", stdout: status("pacman") });
    const res = await s.request("POST", "/1/action", {
      action: "update",
      packages: ["linux"],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full upgrades/);
  });

  it("needs edit access and a writable host", async () => {
    s = await startServer({ level: "connect" });
    expect(
      (await s.request("POST", "/1/action", { action: "refresh" })).body.code,
    ).toBe("HOST_EDIT_REQUIRED");
    await s.close();
    s = await startServer({ settings: { readOnly: true } });
    expect(
      (await s.request("POST", "/1/action", { action: "refresh" })).body.code,
    ).toBe("readOnly");
  });
});

describe("summary", () => {
  it("counts updates per enabled host", async () => {
    s = await startServer();
    await s.mock.ctx.hosts.list();
    Object.assign(s.mock.ctx.hosts, {
      list: async () => [{ id: 1 }, { id: 2 }],
    });
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    s.ssh.replies.push({ match: "apt list --upgradable", stdout: UPDATES });
    const res = await s.request("GET", "/summary");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      hostId: 1,
      updates: 1,
      security: 1,
      reboot: true,
    });
  });
});

describe("update alerts", () => {
  const read = async (settings: Record<string, unknown>) => {
    s = await startServer({ settings });
    s.mock.ctx.currentActor = () => "u1";
    Object.assign(s.mock.ctx.hosts, { list: async () => [{ id: 1 }] });
    s.ssh.replies.push({ match: "manager=", stdout: status() });
    s.ssh.replies.push({ match: "apt list --upgradable", stdout: UPDATES });
    await s.request("GET", "/summary?refresh=1");
    return s;
  };

  it("sends one alert for security updates and one for a reboot", async () => {
    const t = await read({ alertUpdates: true });
    const sent = t.mock.notifications.map((n) => n.notification.category);
    expect(sent.sort()).toEqual([
      "package-manager.reboot",
      "package-manager.security",
    ]);
    await t.request("GET", "/summary?refresh=1");
    expect(t.mock.notifications).toHaveLength(2);
  });

  it("stays quiet unless the host turns alerts on", async () => {
    const t = await read({});
    expect(t.mock.notifications).toHaveLength(0);
  });
});

describe("scripts", () => {
  const bash = spawnSync("bash", ["-c", "true"]).status === 0;
  const managers: Manager[] = ["apt", "dnf", "yum", "zypper", "pacman", "apk"];
  const actions: PackageAction[] = [
    "refresh",
    "update",
    "upgrade-all",
    "install",
    "remove",
    "hold",
    "unhold",
  ];

  it.skipIf(!bash)("every script parses as bash", async () => {
    const scripts: string[] = [];
    for (const pm of managers) {
      for (const action of actions) {
        try {
          scripts.push(actionScript(pm, action, ["curl", "libc6:amd64"]));
        } catch {
          // Not supported on this manager.
        }
      }
      s = await startServer();
      s.ssh.replies.push({ match: "manager=", stdout: status(pm) });
      for (const path of [
        "status",
        "updates",
        "installed",
        "search?q=htop",
        "history",
        "repos",
      ]) {
        await s.request("GET", `/1/${path}`);
      }
      scripts.push(...s.ssh.calls.map((call) => call.stdin));
      await s.close();
      s = null;
    }
    expect(scripts.length).toBeGreaterThan(60);
    for (const script of scripts) {
      const out = spawnSync("bash", ["-n"], { input: script });
      expect(out.status, `${script}\n${out.stderr}`).toBe(0);
    }
  });
});
