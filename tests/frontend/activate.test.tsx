import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { formatAgo, formatBytes } from "../../src/frontend/format";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  os: "Debian GNU/Linux 13",
  manager: "apt",
  root: true,
  rebootRequired: true,
  indexUpdatedAt: null,
  singleUpdates: true,
  holds: true,
  canEdit: true,
  readOnly: false,
};

const updates = [
  {
    name: "curl",
    current: "7.88.1-10",
    available: "7.88.1-11",
    repo: "stable-security",
    security: true,
  },
  {
    name: "tzdata",
    current: "2025b",
    available: "2026a",
    repo: "stable-updates",
    security: false,
  },
];

const installed = [
  {
    name: "nginx",
    version: "1.22.1",
    size: 1228800,
    summary: "web server",
    held: true,
  },
];

function api(current: unknown) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? current
        : url.endsWith("/updates")
          ? updates
          : url.endsWith("/installed")
            ? installed
            : [],
    })),
    post: vi.fn(async () => ({ data: { ok: true, output: "" } })),
  } as never;
}

const host = { id: 1, name: "web", enableSsh: true };

describe(`${manifest.id} activate`, () => {
  it("registers the host tab and the dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["package-manager"]);
  });

  it("adds a homepage widget and keeps the panel switch in the manifest", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.extensions("homepage.widgets")).toEqual([
      "package_updates_widget",
    ]);
    expect(manifest.contributes.uses).toContain("homepage.widgets");
    const fields = (
      manifest.contributes.settings as {
        host: { fields: Array<{ key: string }> };
      }
    ).host.fields.map((f) => f.key);
    expect(fields).toContain("showPanel");
  });

  it("shows pending updates in the homepage widget", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["package-manager.use"],
      hosts: [{ id: "7", name: "apps", ip: "10.0.0.7", port: 22 }],
      api: {
        get: vi.fn(async () => ({
          data: [
            {
              hostId: 7,
              updates: 3,
              security: 1,
              reboot: false,
              checkedAt: "",
            },
          ],
        })),
      } as never,
    });
    const view = rendered.renderExtension(
      "homepage.widgets",
      "package_updates_widget",
      "view",
      { widget: { title: null }, config: {} },
    );
    expect(await screen.findByText("apps")).toBeTruthy();
    expect(view.textContent).toContain("3 updates");
  });

  it("lists updates with security first and the reboot notice", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("package-manager", { isVisible: true, host });
    expect(await screen.findByText("curl")).toBeTruthy();
    expect(screen.getByText("tzdata")).toBeTruthy();
    expect(screen.getByText(locales.updates.security)).toBeTruthy();
    expect(screen.getByText(locales.tab.reboot)).toBeTruthy();
  });

  it("shows installed packages with holds", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("package-manager", { isVisible: true, host });
    fireEvent.click(await screen.findByText(locales.tab.viewInstalled));
    expect(await screen.findByText("nginx")).toBeTruthy();
    expect(screen.getAllByText(locales.installed.heldBadge).length).toBe(2);
  });

  it("hides changes from read only callers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, canEdit: false }),
    });
    rendered.renderTab("package-manager", { isVisible: true, host });
    expect(await screen.findByText("curl")).toBeTruthy();
    expect(screen.queryByText(locales.actions["upgrade-all"].label)).toBeNull();
  });

  it("explains a host with no package manager", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, manager: "none" }),
    });
    rendered.renderTab("package-manager", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.noManagerTitle)).toBeTruthy();
  });
});

describe("formatting", () => {
  it("formats sizes and ages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(null)).toBe("");
    expect(formatAgo(1000, 1_000_000 + 7_200_000)).toBe("2h");
  });
});
