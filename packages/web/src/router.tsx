/**
 * Router (react-router v7 declarative style): /login is public; all other routes go through
 * the RequireAuth guard (redirects to /login when not authenticated) and are wrapped in
 * ProjectProvider + AppLayout.
 */
import { Component, lazy, Suspense } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useAuth } from "./state/auth";
import { ProjectProvider } from "./state/project";
import { SessionsProvider } from "./state/sessions";
import { CompanyProvider } from "./state/company";
import { S } from "./lib/strings";

const AppLayout = lazy(() =>
  import("./components/layout/app-layout").then(({ AppLayout }) => ({ default: AppLayout })),
);
const LoginPage = lazy(() =>
  import("./pages/login").then(({ LoginPage }) => ({ default: LoginPage })),
);
const ChatPage = lazy(() =>
  import("./features/chat/chat-page").then(({ ChatPage }) => ({ default: ChatPage })),
);
const AgentsPage = lazy(() =>
  import("./features/agents/agents-page").then(({ AgentsPage }) => ({ default: AgentsPage })),
);
const AgentSettingsPage = lazy(() =>
  import("./features/agents/agent-settings-page").then(({ AgentSettingsPage }) => ({
    default: AgentSettingsPage,
  })),
);
const PluginsPage = lazy(() =>
  import("./features/plugins/plugins-page").then(({ PluginsPage }) => ({ default: PluginsPage })),
);
const ModelsPage = lazy(() =>
  import("./features/models/models-page").then(({ ModelsPage }) => ({ default: ModelsPage })),
);
const UsagePage = lazy(() =>
  import("./features/usage/usage-page").then(({ UsagePage }) => ({ default: UsagePage })),
);
const BenchmarkPage = lazy(() =>
  import("./features/benchmark/benchmark-page").then(({ BenchmarkPage }) => ({
    default: BenchmarkPage,
  })),
);
const BenchmarkDetailPage = lazy(() =>
  import("./features/benchmark/benchmark-detail-page").then(({ BenchmarkDetailPage }) => ({
    default: BenchmarkDetailPage,
  })),
);
const TerminalPage = lazy(() =>
  import("./features/terminal/terminal-page").then(({ TerminalPage }) => ({
    default: TerminalPage,
  })),
);
const OrgIndexRedirect = lazy(() =>
  import("./features/company/org-layout").then(({ OrgIndexRedirect }) => ({
    default: OrgIndexRedirect,
  })),
);
const OrgLayout = lazy(() =>
  import("./features/company/org-layout").then(({ OrgLayout }) => ({ default: OrgLayout })),
);
const OverviewPage = lazy(() =>
  import("./features/company/overview-page").then(({ OverviewPage }) => ({
    default: OverviewPage,
  })),
);
const OrgChartPage = lazy(() =>
  import("./features/company/org-chart-page").then(({ OrgChartPage }) => ({
    default: OrgChartPage,
  })),
);
const CalendarPage = lazy(() =>
  import("./features/company/calendar-page").then(({ CalendarPage }) => ({
    default: CalendarPage,
  })),
);
const TicketsPage = lazy(() =>
  import("./features/company/tickets-page").then(({ TicketsPage }) => ({ default: TicketsPage })),
);
const FinancePage = lazy(() =>
  import("./features/company/finance-page").then(({ FinancePage }) => ({ default: FinancePage })),
);
const ChannelView = lazy(() =>
  import("./features/company/channel-view").then(({ ChannelView }) => ({ default: ChannelView })),
);
const HandbookPage = lazy(() =>
  import("./features/company/handbook-page").then(({ HandbookPage }) => ({
    default: HandbookPage,
  })),
);

function FullScreenStatus({ failed = false, retry }: { failed?: boolean; retry?: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-gray-700 dark:bg-gray-950 dark:text-gray-200">
      <div className="max-w-sm text-center" role={failed ? "alert" : "status"} aria-live="polite">
        <p>{failed ? S.common.unknownError : S.common.loading}</p>
        {retry && (
          <button
            className="mt-4 rounded-md border border-gray-300 px-4 py-2 dark:border-gray-700"
            type="button"
            onClick={retry}
          >
            {S.common.retry}
          </button>
        )}
      </div>
    </main>
  );
}

function RouteContent({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-48 items-center justify-center text-gray-500"
          role="status"
          aria-live="polite"
        >
          {S.common.loading}
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Route module failed to load", error, info);
  }
  render() {
    if (this.state.failed) return <FullScreenStatus failed retry={() => location.reload()} />;
    return this.props.children;
  }
}

/** Route guard: shows blank while initializing, redirects to /login when not authenticated. */
function RequireAuth() {
  const { user, initializationFailed, refresh } = useAuth();
  if (user === undefined)
    return initializationFailed ? (
      <FullScreenStatus failed retry={() => void refresh().catch(() => undefined)} />
    ) : (
      <FullScreenStatus />
    );
  if (user === null) return <Navigate to="/login" replace />;
  return (
    <ProjectProvider>
      <SessionsProvider>
        <CompanyProvider>
          <AppLayout />
        </CompanyProvider>
      </SessionsProvider>
    </ProjectProvider>
  );
}

/**
 * Login guard without the app shell: the terminal page is a standalone full-window surface
 * (no sidebar, no Project context), it only needs the user to be signed in — the terminal
 * WebSocket authenticates with the same session cookie.
 */
function RequireAuthBare({ children }: { children: React.ReactNode }) {
  const { user, initializationFailed, refresh } = useAuth();
  if (user === undefined)
    return initializationFailed ? (
      <FullScreenStatus failed retry={() => void refresh().catch(() => undefined)} />
    ) : (
      <FullScreenStatus />
    );
  if (user === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** When already logged in, visiting /login redirects straight to the chat page. */
function LoginRoute() {
  const { user, initializationFailed, refresh } = useAuth();
  if (user === undefined)
    return initializationFailed ? (
      <FullScreenStatus failed retry={() => void refresh().catch(() => undefined)} />
    ) : (
      <FullScreenStatus />
    );
  if (user) return <Navigate to="/chat" replace />;
  return <LoginPage />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <RouteErrorBoundary>
        <Suspense fallback={<FullScreenStatus />}>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route
              path="/terminal"
              element={
                <RequireAuthBare>
                  <TerminalPage />
                </RequireAuthBare>
              }
            />
            <Route element={<RequireAuth />}>
              <Route index element={<Navigate to="/chat" replace />} />
              <Route
                path="/chat/:sessionId?"
                element={
                  <RouteContent>
                    <ChatPage />
                  </RouteContent>
                }
              />
              <Route
                path="/agents"
                element={
                  <RouteContent>
                    <AgentsPage />
                  </RouteContent>
                }
              />
              <Route
                path="/agents/:agentId"
                element={
                  <RouteContent>
                    <AgentSettingsPage />
                  </RouteContent>
                }
              />
              <Route
                path="/plugins"
                element={
                  <RouteContent>
                    <PluginsPage />
                  </RouteContent>
                }
              />
              <Route
                path="/models"
                element={
                  <RouteContent>
                    <ModelsPage />
                  </RouteContent>
                }
              />
              {/* Admin-only server-side (403 otherwise); the sidebar hides the row for
              everyone else, so a member only ever reaches this by typing the URL. */}
              <Route
                path="/usage"
                element={
                  <RouteContent>
                    <UsagePage />
                  </RouteContent>
                }
              />
              <Route
                path="/benchmark"
                element={
                  <RouteContent>
                    <BenchmarkPage />
                  </RouteContent>
                }
              />
              {/* A Benchmark is identified by a pair — the Agent it tests and its directory
              name — so its own page carries both segments. */}
              <Route
                path="/benchmark/:agentId/:benchmarkId"
                element={
                  <RouteContent>
                    <BenchmarkDetailPage />
                  </RouteContent>
                }
              />
              {/* Company mode: /org resolves to an organization (or the empty landing), and an
              organization opens on its overview — the page that says what the whole
              organization is doing; its channels are the sidebar's own list beside it. Both
              fall back to /chat while company mode is unavailable (see OrgLayout). */}
              <Route
                path="/org"
                element={
                  <RouteContent>
                    <OrgIndexRedirect />
                  </RouteContent>
                }
              />
              <Route path="/org/:projectId/:orgId" element={<OrgLayout />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route
                  path="overview"
                  element={
                    <RouteContent>
                      <OverviewPage />
                    </RouteContent>
                  }
                />
                <Route
                  path="chart"
                  element={
                    <RouteContent>
                      <OrgChartPage />
                    </RouteContent>
                  }
                />
                <Route
                  path="calendar"
                  element={
                    <RouteContent>
                      <CalendarPage />
                    </RouteContent>
                  }
                />
                <Route
                  path="tickets"
                  element={
                    <RouteContent>
                      <TicketsPage />
                    </RouteContent>
                  }
                />
                <Route
                  path="finance"
                  element={
                    <RouteContent>
                      <FinancePage />
                    </RouteContent>
                  }
                />
                <Route
                  path="handbook"
                  element={
                    <RouteContent>
                      <HandbookPage />
                    </RouteContent>
                  }
                />
                <Route
                  path="channels/:channelId"
                  element={
                    <RouteContent>
                      <ChannelView />
                    </RouteContent>
                  }
                />
                <Route path="*" element={<Navigate to="overview" replace />} />
              </Route>
              {/* System settings and user management live in the settings dialog now (see
              SettingsDialog); their old routes fall through to the catch-all. */}
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </BrowserRouter>
  );
}
