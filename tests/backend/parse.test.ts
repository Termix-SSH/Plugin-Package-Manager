import { describe, expect, it } from "vitest";
import {
  parseHistory,
  parseInstalled,
  parseRepos,
  parseSearch,
  parseSize,
  parseUpdates,
  splitApk,
} from "../../src/backend/parse.js";

describe("updates", () => {
  it("reads apt and marks security updates", () => {
    const items = parseUpdates(
      "apt",
      `curl/stable-security 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]
tzdata/stable-updates 2026a-0+deb12u1 all [upgradable from: 2025b-0+deb12u1]
`,
    );
    expect(items).toEqual([
      {
        name: "curl",
        repo: "stable-security",
        available: "7.88.1-10+deb12u8",
        current: "7.88.1-10+deb12u7",
        security: true,
      },
      {
        name: "tzdata",
        repo: "stable-updates",
        available: "2026a-0+deb12u1",
        current: "2025b-0+deb12u1",
        security: false,
      },
    ]);
  });

  it("reads dnf with installed versions and security notices", () => {
    const items = parseUpdates(
      "dnf",
      `
curl.x86_64                 7.76.1-31.el9           baseos
vim-minimal.x86_64          2:8.2.2637-21.el9       baseos
Obsoleting Packages
grub2-tools.x86_64          1:2.06-80.el9           baseos
@@TERMIX@@SEC
RLSA-2026:1234 Important/Sec. curl-7.76.1-31.el9.x86_64
@@TERMIX@@INST
curl.x86_64 7.76.1-29.el9
vim-minimal.x86_64 8.2.2637-20.el9
`,
    );
    expect(items).toEqual([
      {
        name: "curl",
        current: "7.76.1-29.el9",
        available: "7.76.1-31.el9",
        repo: "baseos",
        security: true,
      },
      {
        name: "vim-minimal",
        current: "8.2.2637-20.el9",
        available: "2:8.2.2637-21.el9",
        repo: "baseos",
        security: false,
      },
    ]);
  });

  it("reads zypper, pacman and apk", () => {
    expect(
      parseUpdates(
        "zypper",
        `S | Repository | Name | Current Version | Available Version | Arch
--+------------+------+-----------------+-------------------+-------
v | Main       | curl | 8.0.1-1.1       | 8.1.0-1.1         | x86_64
`,
      ),
    ).toEqual([
      {
        name: "curl",
        repo: "Main",
        current: "8.0.1-1.1",
        available: "8.1.0-1.1",
        security: false,
      },
    ]);
    expect(
      parseUpdates("pacman", "linux 6.9.1.arch1-1 -> 6.9.2.arch1-1\n")[0],
    ).toMatchObject({
      name: "linux",
      current: "6.9.1.arch1-1",
      available: "6.9.2.arch1-1",
    });
    expect(
      parseUpdates(
        "apk",
        "musl-1.2.5-r1 x86_64 {musl} (MIT) [upgradable from: musl-1.2.5-r0]\n",
      )[0],
    ).toMatchObject({
      name: "musl",
      current: "1.2.5-r0",
      available: "1.2.5-r1",
    });
  });
});

describe("installed", () => {
  it("reads dpkg with holds and sizes in KiB", () => {
    const items = parseInstalled(
      "apt",
      `ii \tcurl\t7.88.1-10\t500\tcommand line tool for transferring data
rc \told\t1.0\t10\tremoved but config kept
hi \tnginx\t1.22.1-9\t1200\tsmall, powerful web server
@@TERMIX@@HELD
nginx
`,
    );
    expect(items).toEqual([
      {
        name: "curl",
        version: "7.88.1-10",
        size: 512000,
        summary: "command line tool for transferring data",
        held: false,
      },
      {
        name: "nginx",
        version: "1.22.1-9",
        size: 1228800,
        summary: "small, powerful web server",
        held: true,
      },
    ]);
  });

  it("reads rpm locks and pacman sizes", () => {
    const rpm = parseInstalled(
      "dnf",
      `ii \tcurl\t7.76.1-29.el9\t700000\tA utility\n@@TERMIX@@HELD\ncurl-0:7.76.1-29.el9.*\n`,
    );
    expect(rpm[0]).toMatchObject({ name: "curl", size: 700000, held: true });
    const pac = parseInstalled(
      "pacman",
      "ii \tbash\t5.2.026-2\t9.31 MiB\tThe shell\n",
    );
    expect(pac[0].size).toBe(Math.round(9.31 * 1024 * 1024));
  });

  it("splits apk names and parses sizes", () => {
    expect(splitApk("py3-pip-24.0-r2")).toEqual({
      name: "py3-pip",
      version: "24.0-r2",
    });
    expect(parseSize("12.0 KiB")).toBe(12288);
    expect(parseSize("nope")).toBeNull();
  });
});

describe("search", () => {
  it("reads apt with installed marks", () => {
    const items = parseSearch(
      "apt",
      "htop - interactive processes viewer\nhtop-dbg - debug\n@@TERMIX@@INST\nhtop ii \n",
    );
    expect(items).toEqual([
      {
        name: "htop",
        version: "",
        summary: "interactive processes viewer",
        installed: true,
      },
      { name: "htop-dbg", version: "", summary: "debug", installed: false },
    ]);
  });

  it("reads pacman pairs and dnf lines", () => {
    const pac = parseSearch(
      "pacman",
      "extra/htop 3.3.0-3 [installed]\n    Interactive process viewer\nextra/btop 1.3.2-1\n    Monitor\n",
    );
    expect(pac).toEqual([
      {
        name: "htop",
        version: "3.3.0-3",
        summary: "Interactive process viewer",
        installed: true,
      },
      {
        name: "btop",
        version: "1.3.2-1",
        summary: "Monitor",
        installed: false,
      },
    ]);
    const dnf = parseSearch(
      "dnf",
      "======== Name Exactly Matched: htop ========\nhtop.x86_64 : Interactive process viewer\n@@TERMIX@@INST\nhtop\n",
    );
    expect(dnf).toEqual([
      {
        name: "htop",
        version: "",
        summary: "Interactive process viewer",
        installed: true,
      },
    ]);
  });
});

describe("history", () => {
  it("groups apt runs, newest first", () => {
    const items = parseHistory(
      "apt",
      `
Start-Date: 2026-11-01  10:00:00
Commandline: apt-get install htop
Install: htop:amd64 (3.2.2-2), libnl-3-200:amd64 (3.7.0-0.2, automatic)
End-Date: 2026-11-01  10:00:05

Start-Date: 2026-11-02  11:00:00
Commandline: apt-get upgrade
Upgrade: curl:amd64 (7.88.1-10, 7.88.1-11)
End-Date: 2026-11-02  11:00:30
`,
    );
    expect(items).toEqual([
      {
        date: "2026-11-02  11:00:00",
        action: "upgrade",
        packages: "curl",
        command: "apt-get upgrade",
      },
      {
        date: "2026-11-01  10:00:00",
        action: "install",
        packages: "htop, libnl-3-200",
        command: "apt-get install htop",
      },
    ]);
  });

  it("reads dnf, zypper and pacman", () => {
    expect(
      parseHistory(
        "dnf",
        "ID     | Command line             | Date and time    | Action(s)      | Altered\n-----\n     7 | install htop             | 2026-11-01 10:00 | Install        |    1\n",
      ),
    ).toEqual([
      {
        date: "2026-11-01 10:00",
        action: "Install",
        packages: "1",
        command: "install htop",
      },
    ]);
    expect(
      parseHistory(
        "zypper",
        "2026-11-01 10:00:00|install|htop|3.3.0-1.1|x86_64||repo-oss|abc|\n",
      ),
    ).toEqual([
      {
        date: "2026-11-01 10:00:00",
        action: "install",
        packages: "htop 3.3.0-1.1",
        command: "",
      },
    ]);
    expect(
      parseHistory(
        "pacman",
        "[2026-11-01T10:00:00+0000] [ALPM] upgraded curl (8.0-1 -> 8.1-1)\n",
      ),
    ).toEqual([
      {
        date: "2026-11-01T10:00:00+0000",
        action: "upgraded",
        packages: "curl (8.0-1 -> 8.1-1)",
        command: "",
      },
    ]);
  });
});

describe("repos", () => {
  it("reads apt list and deb822 files", () => {
    const items = parseRepos(
      "apt",
      `sources.list\tdeb http://deb.debian.org/debian bookworm main
sources.list\t# deb-src http://deb.debian.org/debian bookworm main
@@TERMIX@@FILE debian.sources
Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main
Enabled: yes

Types: deb
URIs: http://security.debian.org/debian-security
Suites: trixie-security
Components: main
Enabled: no
`,
    );
    expect(items).toEqual([
      {
        id: "sources.list",
        name: "bookworm main",
        url: "http://deb.debian.org/debian",
        enabled: true,
      },
      {
        id: "sources.list",
        name: "deb-src bookworm main",
        url: "http://deb.debian.org/debian",
        enabled: false,
      },
      {
        id: "debian.sources",
        name: "trixie trixie-updates main",
        url: "http://deb.debian.org/debian",
        enabled: true,
      },
      {
        id: "debian.sources",
        name: "trixie-security main",
        url: "http://security.debian.org/debian-security",
        enabled: false,
      },
    ]);
  });

  it("reads dnf repolist", () => {
    expect(
      parseRepos(
        "dnf",
        "repo id            repo name                      status\nappstream          Rocky Linux 9 - AppStream      enabled\ncrb                Rocky Linux 9 - CRB            disabled\n",
      ),
    ).toEqual([
      {
        id: "appstream",
        name: "Rocky Linux 9 - AppStream",
        url: "",
        enabled: true,
      },
      { id: "crb", name: "Rocky Linux 9 - CRB", url: "", enabled: false },
    ]);
  });
});
