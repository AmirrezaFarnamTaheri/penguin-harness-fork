import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./cockpit-telemetry.fixture.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    define: { "process.env.NODE_ENV": '"test"' },
  });
  script = result.outputFiles[0].text;
});

const snapshot = (id = null) => ({
  type: "cockpit_init",
  data: {
    swarm: {
      agents: id ? [{ id, role: "coder", status: "idle", tasksCompleted: 0 }] : [],
      edges: id ? [{ from: id, to: id, kind: "directive", activeCount: 1 }] : [],
    },
    mailbox: {},
    replay: { events: [] },
    keyFleet: { healthy: false, activeCount: 0, providers: [] },
  },
});
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const state = async (page) =>
  JSON.parse(await page.getByLabel("Telemetry", { exact: true }).textContent());

async function boot(page, telemetry = (route) => json(route, snapshot())) {
  const sockets = [];
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.route("http://cockpit.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.route("**/api/cockpit/telemetry?*", (route) => {
    requests.push(route.request().url());
    return telemetry(route);
  });
  await page.routeWebSocket("**/api/cockpit/stream?*", (ws) => sockets.push(ws));
  await page.goto("http://cockpit.test/");
  await page.addScriptTag({ content: script });
  await expect(page.getByLabel("Telemetry", { exact: true })).toBeVisible();
  return { sockets, requests, errors };
}

async function select(page, project = "alpha") {
  await page.getByRole("button", { name: `Select ${project}` }).click();
  await expect.poll(async () => (await state(page)).transport).toBe("ws");
}

test("no project means no traffic or seeded topology, even for manual actions", async ({
  page,
}) => {
  const { sockets, requests } = await boot(page);
  await page.getByRole("button", { name: "Refresh telemetry" }).click();
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await page.getByRole("button", { name: "Send directive" }).click();
  await page.clock.runFor(15000);
  expect(sockets).toHaveLength(0);
  expect(requests).toHaveLength(0);
  expect(await state(page)).toMatchObject({
    swarmAgents: [],
    swarmEdges: [],
    transport: "offline",
    connected: false,
    error: null,
  });
  await expect(page.getByLabel("Task result")).toHaveText("false");
  await expect(page.getByLabel("Directive result")).toHaveText("false");
});

test("switching projects clears topology and ignores delayed responses and old sockets", async ({
  page,
}) => {
  let delayed;
  let count = 0;
  const { sockets } = await boot(page, (route) => {
    if (++count === 2) {
      delayed = route;
      return;
    }
    return json(route, snapshot());
  });
  await select(page);
  sockets[0].send(JSON.stringify(snapshot("old-agent")));
  await expect.poll(async () => (await state(page)).swarmAgents.length).toBe(1);
  await page.getByRole("button", { name: "Refresh telemetry" }).click();
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await select(page, "beta");
  expect(await state(page)).toMatchObject({
    swarmAgents: [],
    swarmEdges: [],
    turnSummaries: [],
    mailboxEntries: [],
    activeTaskId: null,
    isDispatching: false,
  });
  await json(delayed, snapshot("stale-agent"));
  sockets[0].send(JSON.stringify(snapshot("stale-socket")));
  sockets[1].send(JSON.stringify(snapshot("beta-agent")));
  await expect.poll(async () => (await state(page)).swarmAgents[0]?.id).toBe("beta-agent");
  await page.getByRole("button", { name: "Clear project" }).click();
  expect(await state(page)).toMatchObject({
    swarmAgents: [],
    swarmEdges: [],
    lastEventTime: null,
    transport: "offline",
  });
});

test("HTTP errors surface without downgrading an open websocket; empty replay clears old turns", async ({
  page,
}) => {
  let fail = false;
  const { sockets } = await boot(page, (route) =>
    json(
      route,
      fail ? { error: { message: "Telemetry unavailable" } } : snapshot(),
      fail ? 503 : 200,
    ),
  );
  await select(page);
  sockets[0].send(
    JSON.stringify({
      type: "cockpit_init",
      data: { replay: { events: [{ kind: "turn_done", seq: 1 }] } },
    }),
  );
  await expect.poll(async () => (await state(page)).turnSummaries.length).toBe(1);
  await page.getByRole("button", { name: "Refresh telemetry" }).click();
  await expect.poll(async () => (await state(page)).turnSummaries.length).toBe(0);
  fail = true;
  await page.getByRole("button", { name: "Refresh telemetry" }).click();
  await expect.poll(async () => (await state(page)).error).toBe("Telemetry unavailable");
  expect(await state(page)).toMatchObject({ connected: true, transport: "ws" });
});

test("directives await an explicit REST ACK and preserve their input on rejection", async ({
  page,
}) => {
  let pending;
  const { sockets, errors } = await boot(page);
  await page.route("**/api/cockpit/mailbox/send?*", (route) => {
    pending = route;
  });
  await select(page);
  const sent = [];
  sockets[0].onMessage((message) => sent.push(message));
  await page.getByRole("button", { name: "Send directive" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect(page.getByLabel("Directive result")).toHaveText("none");
  expect(sent).toHaveLength(0);
  await json(pending, { success: false, error: "Mailbox full" }, 429);
  await expect(page.getByLabel("Directive result")).toHaveText("false");
  await expect(page.getByLabel("Directive", { exact: true })).not.toHaveValue("");
  expect((await state(page)).error).toBe("Mailbox full");
  pending = null;
  await page.getByRole("button", { name: "Send directive" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await json(pending, { success: true, mailbox: {} });
  await expect(page.getByLabel("Directive result")).toHaveText("true");
  await expect(page.getByLabel("Directive", { exact: true })).toHaveValue("");
  expect(errors).toEqual([]);
});

test("task failures resolve false, release dispatching, and retain the prompt for retry", async ({
  page,
}) => {
  let pending;
  const { sockets, errors } = await boot(page);
  await page.route("**/api/cockpit/swarm/run?*", (route) => {
    pending = route;
  });
  await select(page);
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  expect((await state(page)).isDispatching).toBe(true);
  sockets[0].send(JSON.stringify({ type: "swarm_task_error", error: "Worker unavailable" }));
  await json(pending, { success: false, error: "Worker unavailable" }, 500);
  await expect(page.getByLabel("Task result")).toHaveText("false");
  expect(await state(page)).toMatchObject({ isDispatching: false, error: "Worker unavailable" });
  await expect(page.getByLabel("Task prompt")).not.toHaveValue("");
  pending = null;
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await json(pending, { success: true, result: { status: "completed" } });
  await expect(page.getByLabel("Task result")).toHaveText("true");
  await expect(page.getByLabel("Task prompt")).toHaveValue("");
  expect((await state(page)).isDispatching).toBe(false);
  expect(errors).toEqual([]);
});

test("aborted old-project commands never clear the current prompt or publish stale errors", async ({
  page,
}) => {
  let pending;
  await boot(page);
  await page.route("**/api/cockpit/swarm/run?*", (route) => {
    pending = route;
  });
  await select(page);
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await select(page, "beta");
  await json(pending, { success: true, result: { status: "completed" } });
  await expect(page.getByLabel("Task result")).toHaveText("false");
  await expect(page.getByLabel("Task prompt")).not.toHaveValue("");
  expect(await state(page)).toMatchObject({ isDispatching: false, error: null });
});

test("disconnected fallback polls repeatedly and stops after unmount", async ({ page }) => {
  const { sockets, requests } = await boot(page);
  await select(page);
  sockets[0].close();
  await expect.poll(async () => (await state(page)).transport).toBe("http");
  const afterClose = requests.length;
  await page.clock.runFor(5000);
  await expect.poll(() => requests.length).toBeGreaterThan(afterClose);
  await expect.poll(() => sockets.length).toBe(2);
  sockets[1].close();
  await expect.poll(async () => (await state(page)).transport).toBe("http");
  const afterRetry = requests.length;
  await page.clock.runFor(5000);
  await expect.poll(() => requests.length).toBeGreaterThan(afterRetry);
  await page.getByRole("button", { name: "Unmount telemetry" }).click();
  const finalRequests = requests.length;
  await page.clock.runFor(20000);
  expect(requests).toHaveLength(finalRequests);
});

test("a delayed REST snapshot cannot overwrite newer WebSocket data", async ({ page }) => {
  let pending;
  const { sockets } = await boot(page, (route) => {
    pending = route;
  });
  await select(page);
  await expect.poll(() => Boolean(pending)).toBe(true);
  sockets[0].send(JSON.stringify(snapshot("newer-ws-agent")));
  await expect.poll(async () => (await state(page)).swarmAgents[0]?.id).toBe("newer-ws-agent");
  await json(pending, snapshot("older-http-agent"));
  await page.clock.runFor(1000);
  expect((await state(page)).swarmAgents[0]?.id).toBe("newer-ws-agent");
  expect((await state(page)).transport).toBe("ws");
});

test("network errors and missing or failed ACKs never report successful commands", async ({
  page,
}) => {
  await boot(page);
  await select(page);
  await page.route("**/api/cockpit/swarm/run?*", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await expect(page.getByLabel("Task result")).toHaveText("false");
  expect((await state(page)).isDispatching).toBe(false);
  expect((await state(page)).error).not.toBeNull();
  await page.route("**/api/cockpit/swarm/run?*", (route) =>
    json(route, { success: true, result: { status: "failed" } }),
  );
  await page.getByRole("button", { name: "Dispatch task" }).click();
  await expect.poll(async () => (await state(page)).error).toBe("Swarm task failed");
  await expect(page.getByLabel("Task prompt")).not.toHaveValue("");
  await page.route("**/api/cockpit/mailbox/send?*", (route) => json(route, {}));
  await page.getByRole("button", { name: "Send directive" }).click();
  await expect(page.getByLabel("Directive result")).toHaveText("false");
  expect((await state(page)).error).toBe("Cockpit command was not acknowledged");
});

test("polling survives a missing WebSocket API and reports HTTP failures", async ({ page }) => {
  let failing = true;
  const { requests, errors } = await boot(page, (route) =>
    json(route, failing ? { error: "Offline" } : snapshot(), failing ? 503 : 200),
  );
  // Replace after Playwright's socket routing has installed its browser shim.
  await page.evaluate(() => {
    window.WebSocket = undefined;
  });
  await page.getByRole("button", { name: "Select alpha" }).click();
  await expect.poll(async () => (await state(page)).error).toBe("Offline");
  expect((await state(page)).transport).toBe("offline");
  failing = false;
  const first = requests.length;
  await page.clock.runFor(5000);
  await expect.poll(() => requests.length).toBeGreaterThan(first);
  await expect.poll(async () => (await state(page)).transport).toBe("http");
  expect((await state(page)).error).toBeNull();
  const second = requests.length;
  await page.clock.runFor(5000);
  await expect.poll(() => requests.length).toBeGreaterThan(second);
  expect(errors).toEqual([]);
});
