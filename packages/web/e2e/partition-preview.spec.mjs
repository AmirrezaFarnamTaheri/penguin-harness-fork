import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { AgentCockpit } from "./src/features/agent/agent-cockpit";
        import { ProjectProvider, useProject } from "./src/state/project";
        import { LocaleProvider } from "./src/state/locale";
        import { setActiveStrings } from "./src/lib/strings";
        import { en } from "./src/lib/strings-en";
        setActiveStrings(en);
        function Probe() {
          const { setCurrentProjectId } = useProject();
          return <><button onClick={() => setCurrentProjectId("beta")}>Select beta</button>
            <AgentCockpit embedded /></>;
        }
        createRoot(document.getElementById("root")).render(
          <LocaleProvider><ProjectProvider><Probe /></ProjectProvider></LocaleProvider>
        );`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "tsx",
    },
    loader: { ".css": "empty" },
    jsx: "automatic",
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script =
    result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ??
    result.outputFiles[0].text;
});

test("cockpit previews the current goal locally, clears on project switch, and never dispatches", async ({
  page,
}) => {
  const unexpected = [];
  const commands = [];
  const socketMessages = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // All HTTP and WebSocket traffic is intercepted: there is no live backend or model.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ json: body });
    if (request.method() !== "GET") {
      commands.push({ path, body: request.postData() });
      return json({});
    }
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (path === "/api/projects")
      return json({
        projects: [
          { projectId: "alpha", name: "Alpha" },
          { projectId: "beta", name: "Beta" },
        ],
      });
    if (/^\/api\/projects\/(alpha|beta)\/agents$/.test(path)) return json({ agents: [] });
    if (path === "/api/cockpit/telemetry")
      return json({
        success: true,
        data: {
          swarm: { agents: [], edges: [] },
          mailbox: {},
          replay: { events: [] },
        },
      });
    unexpected.push(request.url());
    return route.abort();
  });
  await page.routeWebSocket("**/*", (socket) => {
    socket.onMessage((message) => socketMessages.push(String(message)));
  });
  await page.goto("http://cockpit.test/");
  await page.evaluate(() => localStorage.setItem("penguin.lang", "en"));
  await page.addScriptTag({ content: script });
  const goal = page.getByRole("textbox", { name: "What should the agents do?" });
  await expect(goal).toBeVisible();
  const preview = page.getByRole("region", { name: "Decomposition preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("No sub-queries to preview.");
  await goal.fill("Design architecture; Write unit tests");
  await expect(preview.getByRole("listitem")).toHaveCount(2);
  await expect(preview.getByRole("listitem").nth(0)).toContainText("software_architect");
  await expect(preview.getByRole("listitem").nth(1)).toContainText("qa_test_engineer");
  await expect(preview).toContainText("Preview only");
  await goal.fill("Document <img src=x>");
  await expect(preview.getByRole("listitem")).toHaveCount(1);
  await expect(preview).toContainText("technical_writer");
  await expect(preview.locator("img")).toHaveCount(0);
  await expect(preview).not.toContainText("software_architect");
  await expect(preview.getByRole("button")).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(socketMessages).toEqual([]);
  await page.getByRole("button", { name: "Select beta" }).click();
  await expect(goal).toHaveValue("");
  await expect(preview).toContainText("No sub-queries to preview.");
  await expect(preview.getByRole("listitem")).toHaveCount(0);
  // Switching project may persist a preference, but may never dispatch work or leak the goal.
  expect(commands.every((request) => request.path === "/api/me/prefs")).toBe(true);
  expect(JSON.stringify(commands)).not.toContain("Document");
  expect(socketMessages).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
