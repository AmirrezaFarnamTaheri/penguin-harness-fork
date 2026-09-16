import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock electron before importing tray.ts
vi.mock("electron", () => {
  const listeners = new Map<string, () => void>();
  class MockTray {
    public tooltip = "";
    public contextMenu: unknown = null;
    constructor(public iconPath: string) {}
    setToolTip(tip: string) {
      this.tooltip = tip;
    }
    setContextMenu(menu: unknown) {
      this.contextMenu = menu;
    }
    on(event: string, cb: () => void) {
      listeners.set(event, cb);
    }
    destroy = vi.fn();
  }

  return {
    Tray: MockTray,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => template),
    },
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn(),
    },
  };
});

import {
  COCKPIT_GLOBAL_SHORTCUT,
  buildTrayMenuTemplate,
  registerCockpitShortcut,
  resolveTrayIcon,
  setupDesktopTray,
  unregisterCockpitShortcut,
} from "../src/tray.js";
import { globalShortcut } from "electron";

describe("buildTrayMenuTemplate", () => {
  it("generates correct menu items when server is offline and window is hidden", () => {
    const onToggleWindow = vi.fn();
    const onRestartServer = vi.fn();
    const onQuit = vi.fn();

    const template = buildTrayMenuTemplate({
      appOrigin: null,
      isRunning: false,
      isVisible: false,
      onToggleWindow,
      onRestartServer,
      onQuit,
    });

    expect(template.length).toBeGreaterThanOrEqual(4);
    const toggleItem = template[0]!;
    expect(toggleItem.label).toContain("Show Cockpit HUD");
    toggleItem.click?.(undefined as never, undefined as never, undefined as never);
    expect(onToggleWindow).toHaveBeenCalled();

    const statusItem = template[2]!;
    expect(statusItem.label).toBe("Server: Offline");
    expect(statusItem.enabled).toBe(false);

    const restartItem = template[3]!;
    expect(restartItem.label).toBe("Restart Embedded Server");
    expect(restartItem.enabled).toBe(false);

    const quitItem = template[5]!;
    expect(quitItem.label).toBe("Quit Penguin Harness");
    quitItem.click?.(undefined as never, undefined as never, undefined as never);
    expect(onQuit).toHaveBeenCalled();
  });

  it("generates correct menu items when server is running and window is visible", () => {
    const onToggleWindow = vi.fn();
    const onRestartServer = vi.fn();
    const onQuit = vi.fn();

    const template = buildTrayMenuTemplate({
      appOrigin: "http://localhost:7365",
      isRunning: true,
      isVisible: true,
      onToggleWindow,
      onRestartServer,
      onQuit,
    });

    const toggleItem = template[0]!;
    expect(toggleItem.label).toContain("Hide Cockpit HUD");

    const statusItem = template[2]!;
    expect(statusItem.label).toBe("Server: Running (http://localhost:7365)");

    const restartItem = template[3]!;
    expect(restartItem.enabled).toBe(true);
    restartItem.click?.(undefined as never, undefined as never, undefined as never);
    expect(onRestartServer).toHaveBeenCalled();
  });
});

describe("resolveTrayIcon", () => {
  it("resolves existing icon from candidates or null if absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tray-test-"));
    try {
      expect(resolveTrayIcon(tmp, "win32")).toBeNull();

      const iconPath = path.join(tmp, "dist", "icon.png");
      fs.mkdirSync(path.dirname(iconPath), { recursive: true });
      fs.writeFileSync(iconPath, "fake-icon");

      expect(resolveTrayIcon(tmp, "win32")).toBe(iconPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("global shortcut and tray manager", () => {
  it("has the standard CommandOrControl+Shift+P hotkey", () => {
    expect(COCKPIT_GLOBAL_SHORTCUT).toBe("CommandOrControl+Shift+P");
  });

  it("registers and unregisters shortcut", () => {
    const onTrigger = vi.fn();
    expect(registerCockpitShortcut(onTrigger)).toBe(true);
    expect(globalShortcut.register).toHaveBeenCalledWith(COCKPIT_GLOBAL_SHORTCUT, onTrigger);

    unregisterCockpitShortcut();
    expect(globalShortcut.unregister).toHaveBeenCalledWith(COCKPIT_GLOBAL_SHORTCUT);
  });

  it("initializes tray manager and updates status", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-tray-mgr-"));
    try {
      const iconPath = path.join(tmp, "dist", "icon.png");
      fs.mkdirSync(path.dirname(iconPath), { recursive: true });
      fs.writeFileSync(iconPath, "fake-icon");

      let isVisible = false;
      const manager = setupDesktopTray({
        appPath: tmp,
        platform: "win32",
        getAppOrigin: () => "http://localhost:1234",
        isServerRunning: () => true,
        getWindow: () => ({ isVisible: () => isVisible, isMinimized: () => false }) as never,
        onToggleWindow: vi.fn(),
        onRestartServer: vi.fn(),
        onQuit: vi.fn(),
      });

      expect(manager).not.toBeNull();
      isVisible = true;
      expect(() => manager?.updateStatus()).not.toThrow();
      manager?.destroy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
