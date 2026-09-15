/**
 * Desktop system tray and global HUD shortcut support.
 *
 * Provides quick access to the Penguin Harness Cockpit HUD from anywhere on the system:
 * - System tray icon with menu (Show/Hide HUD, Server status indicator, Restart server, Quit)
 * - Global hotkey (Cmd/Ctrl + Shift + P) to toggle the Cockpit window
 */
import fs from "node:fs";
import path from "node:path";
import { Menu, Tray, globalShortcut } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

export const COCKPIT_GLOBAL_SHORTCUT = "CommandOrControl+Shift+P";

/**
 * Locate suitable tray icon across Linux, macOS, and Windows.
 */
export function resolveTrayIcon(appPath: string, platform: NodeJS.Platform): string | null {
  const candidates = [
    path.join(appPath, "dist", "icon.png"),
    path.join(appPath, "build", "icon.png"),
    path.join(appPath, "build", "icons", "128x128.png"),
    platform === "darwin" ? path.join(appPath, "build", "icon-mac.png") : null,
  ].filter((p): p is string => p !== null);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface TrayMenuOptions {
  appOrigin: string | null;
  isRunning: boolean;
  isVisible: boolean;
  onToggleWindow: () => void;
  onRestartServer: () => void;
  onQuit: () => void;
}

export function buildTrayMenuTemplate(opts: TrayMenuOptions): MenuItemConstructorOptions[] {
  const toggleLabel = opts.isVisible ? "Hide Cockpit HUD" : "Show Cockpit HUD";
  const shortcutHint = process.platform === "darwin" ? "⌘⇧P" : "Ctrl+Shift+P";

  return [
    {
      label: `${toggleLabel} (${shortcutHint})`,
      click: opts.onToggleWindow,
    },
    { type: "separator" },
    {
      label:
        opts.isRunning && opts.appOrigin
          ? `Server: Running (${opts.appOrigin})`
          : "Server: Offline",
      enabled: false,
    },
    {
      label: "Restart Embedded Server",
      enabled: opts.isRunning,
      click: opts.onRestartServer,
    },
    { type: "separator" },
    {
      label: "Quit Penguin Harness",
      click: opts.onQuit,
    },
  ];
}

export interface DesktopTrayManager {
  updateStatus: () => void;
  destroy: () => void;
}

export function setupDesktopTray(opts: {
  appPath: string;
  platform: NodeJS.Platform;
  getAppOrigin: () => string | null;
  isServerRunning: () => boolean;
  getWindow: () => BrowserWindow | null;
  onToggleWindow: () => void;
  onRestartServer: () => void;
  onQuit: () => void;
}): DesktopTrayManager | null {
  const iconPath = resolveTrayIcon(opts.appPath, opts.platform);
  if (!iconPath) return null;

  try {
    const tray = new Tray(iconPath);
    tray.setToolTip("Penguin Harness Cockpit");

    const update = () => {
      const win = opts.getWindow();
      const isVisible = win !== null && win.isVisible() && !win.isMinimized();
      const template = buildTrayMenuTemplate({
        appOrigin: opts.getAppOrigin(),
        isRunning: opts.isServerRunning(),
        isVisible,
        onToggleWindow: opts.onToggleWindow,
        onRestartServer: opts.onRestartServer,
        onQuit: opts.onQuit,
      });
      tray.setContextMenu(Menu.buildFromTemplate(template));
    };

    tray.on("click", () => opts.onToggleWindow());
    update();

    return {
      updateStatus: update,
      destroy: () => {
        tray.destroy();
      },
    };
  } catch (err) {
    process.stderr.write(`[tray] Failed to initialize tray: ${String(err)}\n`);
    return null;
  }
}

export function registerCockpitShortcut(onTrigger: () => void): boolean {
  try {
    const registered = globalShortcut.register(COCKPIT_GLOBAL_SHORTCUT, onTrigger);
    if (!registered) {
      process.stderr.write(
        `[shortcut] Failed to register global shortcut: ${COCKPIT_GLOBAL_SHORTCUT}\n`,
      );
    }
    return registered;
  } catch (err) {
    process.stderr.write(`[shortcut] Error registering global shortcut: ${String(err)}\n`);
    return false;
  }
}

export function unregisterCockpitShortcut(): void {
  try {
    globalShortcut.unregister(COCKPIT_GLOBAL_SHORTCUT);
  } catch {
    // Ignore error on unregister
  }
}
