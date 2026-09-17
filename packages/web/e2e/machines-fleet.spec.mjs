import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import { createRoot } from 'react-dom/client';
        import { MachinesPage } from './src/features/machines/machines-page';
        import { ProjectProvider } from './src/state/project';
        import { LocaleProvider } from './src/state/locale';
        import { en } from './src/lib/strings-en';
        import { setActiveStrings } from './src/lib/strings';
        localStorage.setItem('penguin.lang', 'en');
        setActiveStrings(en);
        createRoot(document.getElementById('root')).render(
          <LocaleProvider><ProjectProvider><MachinesPage /></ProjectProvider></LocaleProvider>);`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "tsx",
    },
    jsx: "automatic",
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

test("real MachinesPage shows dated fleet health and unknown state without probing hosts", async ({
  page,
}) => {
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Fleet fixture page error:", error.message);
  });
  const checkedAt = "2026-09-17T12:00:00.000Z";
  const machine = (alias, status) => ({
    id: `ssh:${alias}`,
    alias,
    machineId: null,
    local: false,
    installed: { version: "0.2.14", at: checkedAt },
    connection: { pid: 123 },
    api: null,
    status,
  });
  await page.route("http://fleet.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    requests.push({ path, method: route.request().method() });
    if (path === "/api/projects")
      return route.fulfill({ json: { projects: [{ projectId: "fleet", name: "Fleet" }] } });
    if (path === "/api/projects/fleet/agents") return route.fulfill({ json: { agents: [] } });
    if (path === "/api/projects/fleet/machines")
      return route.fulfill({
        json: {
          imageVersion: "0.2.14",
          job: null,
          machines: [
            machine("gpu-node", { state: "running", checkedAt }),
            machine("unprobed", null),
            machine("offline", {
              state: "unreachable",
              checkedAt,
              detail: "Permission denied (publickey).",
            }),
          ],
        },
      });
    return route.fulfill({ status: 404, json: { error: "Unexpected request" } });
  });
  await page.goto("http://fleet.test/");
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Installed machines (3)" })).toBeVisible();
  const running = page.getByRole("button", { name: /gpu-node/ });
  await expect(running).toContainText("Running");
  await expect(running).toContainText("Last probe");
  await expect(running.locator("time")).toHaveAttribute("datetime", checkedAt);
  await expect(page.getByRole("button", { name: /unprobed/ })).toContainText("Not probed");
  await page.getByRole("button", { name: /offline/ }).click();
  await expect(page.getByText("Permission denied (publickey).", { exact: true })).toHaveCount(2);
  expect(errors).toEqual([]);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(requests.filter((request) => request.path.endsWith("/machines"))).toHaveLength(1);
});
