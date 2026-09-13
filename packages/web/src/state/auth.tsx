/**
 * Current user context:
 * initialized via GET /api/me on mount; when unauthenticated, the route guard (RequireAuth)
 * redirects to /login; a successful login/registration holds a session cookie (HttpOnly,
 * issued by the server).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MeResponse, UploadLimits, UserInfo } from "@prismshadow/penguin-server/api";
import * as api from "../api/endpoints";
import { ApiError, setUnauthorizedHandler } from "../api/client";

/**
 * Stand-in until GET /api/me answers, matching the server's shipped defaults. The window is the
 * mount-time fetch, before a composer can be used at all; the server re-validates every upload
 * against the real limits regardless, so a stale value here can only make the composer's
 * pre-flight check slightly wrong, never let an oversize file through.
 */
const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  attachmentMaxMb: 100,
  attachmentTotalMb: 120,
  attachmentMaxCount: 20,
  imageMaxMb: 20,
  attachmentLimitMinMb: 1,
  attachmentLimitMaxMb: 200,
};

interface AuthContextValue {
  /** undefined = initializing; null = not logged in. */
  user: UserInfo | null | undefined;
  /** The initial /api/me request failed without proving that the session is unauthorized. */
  initializationFailed: boolean;
  /**
   * Whether Workspace HTML previews open on a separate origin. False means this
   * deployment falls back to the same-origin sandbox, where `localStorage`, cookies and
   * third-party embeds do not work — the Files panel warns before opening. Comes from
   * /api/me because it depends on the host the browser is using.
   */
  previewIsolated: boolean;
  /**
   * Whether the server runs in desktop mode (spawned by the desktop shell). The UI then
   * hides the logout entry, the initial-password banner and the self-update entry — the
   * desktop app manages sign-in and updates itself.
   */
  desktopMode: boolean;
  /**
   * How THIS session was established — a browser signed into a desktop-mode server holds a
   * "password" session. "desktop" and "setup" may change the password without the old one
   * (see omitsOldPassword in lib/account-menu). ("token" marks Bearer-authenticated API
   * callers and never occurs in a browser session; it is carried for type parity with the
   * server.)
   */
  sessionVia: MeResponse["sessionVia"];
  /**
   * Upload limits in force on this server (admin-settable). The composer reads them to refuse an
   * oversize pick before reading it and to name the real number in the message, so the client
   * check and the server check can never disagree about what "too large" means.
   */
  uploadLimits: UploadLimits;
  /**
   * Whether company mode is enabled server-wide (the admin master switch in server settings,
   * default on). Off hides the work-mode switch for everyone and 404s every organization
   * route; the user's own preference (`UiPrefs.companyMode`) only hides the switch for them.
   */
  companyMode: boolean;
  login: (userId: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Refetch /api/me (e.g. to refresh the passwordIsInitial flag after a password change). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** A failed identity request proves sign-out only when the server explicitly answers 401. */
export function isConfirmedUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function authFailureState(
  currentUser: UserInfo | null | undefined,
  error: unknown,
): Pick<AuthContextValue, "user" | "initializationFailed"> {
  if (isConfirmedUnauthorized(error)) return { user: null, initializationFailed: false };
  return { user: currentUser, initializationFailed: currentUser === undefined };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Latest auth operation owns the result. This prevents the mount-time /me request from
  // overwriting a newer login, logout, or manual retry when responses arrive out of order.
  const authGeneration = useRef(0);
  const [user, setUser] = useState<UserInfo | null | undefined>(undefined);
  const [initializationFailed, setInitializationFailed] = useState(false);
  // Assume isolated until told otherwise: the warning is the exceptional state, and
  // flashing it during initialization would be noise.
  const [previewIsolated, setPreviewIsolated] = useState(true);
  const [desktopMode, setDesktopMode] = useState(false);
  const [sessionVia, setSessionVia] = useState<MeResponse["sessionVia"]>("password");
  const [uploadLimits, setUploadLimits] = useState<UploadLimits>(DEFAULT_UPLOAD_LIMITS);
  // Off until /api/me says otherwise: the mode switch must not flash for a server that has
  // turned company mode off, and the default on the server side is on anyway.
  const [companyMode, setCompanyMode] = useState(false);

  // Any API returning 401 (session expired / database rebuilt) clears the current user, and
  // RequireAuth redirects back to the login page.
  // Must be registered before the GET /api/me effect below (effects in the same component
  // run in declaration order).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      authGeneration.current += 1;
      setUser(null);
      setInitializationFailed(false);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (userId: string, password: string) => {
    const res = await api.login({ userId, password });
    const generation = ++authGeneration.current;
    setUser(res.user);
    // previewIsolated only rides on GET /api/me, and the mount-time fetch ran before
    // this session existed — without a refetch, a deployment with no separate preview
    // origin would keep the optimistic `true` after a UI login (navigation is
    // client-side, so nothing else re-asks) and the Files panel would take the isolated
    // preview path it can't actually serve. Never fail the login over it: the session
    // cookie is already set, so a transient /me error just leaves the default in place
    // until the next refresh.
    try {
      const me = await api.getMe({ handleUnauthorized: false });
      if (authGeneration.current !== generation) return;
      setUser(me.user);
      setPreviewIsolated(me.previewIsolated);
      setDesktopMode(me.desktopMode);
      setSessionVia(me.sessionVia);
      setUploadLimits(me.uploadLimits);
      setCompanyMode(me.companyMode);
    } catch (error) {
      if (authGeneration.current === generation && isConfirmedUnauthorized(error)) setUser(null);
    }
  }, []);

  const logout = useCallback(async () => {
    authGeneration.current += 1;
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++authGeneration.current;
    setInitializationFailed(false);
    try {
      const res = await api.getMe({ handleUnauthorized: false });
      if (authGeneration.current !== generation) return;
      setUser(res.user);
      setPreviewIsolated(res.previewIsolated);
      setDesktopMode(res.desktopMode);
      setSessionVia(res.sessionVia);
      setUploadLimits(res.uploadLimits);
      setCompanyMode(res.companyMode);
    } catch (err) {
      if (authGeneration.current !== generation) return;
      if (isConfirmedUnauthorized(err)) setUser(null);
      else setInitializationFailed(true);
      throw err;
    }
  }, []);

  useEffect(() => {
    // A transport error or 5xx says nothing about the cookie. Keep the guard in an explicit
    // retry state; redirecting to login would discard a valid signed-in screen merely because
    // the server was restarting. Only a confirmed 401 changes the user to unauthenticated.
    void refresh().catch(() => undefined);
    return () => {
      authGeneration.current += 1;
    };
  }, [refresh]);

  return (
    <AuthContext.Provider
      value={{
        user,
        initializationFailed,
        previewIsolated,
        desktopMode,
        sessionVia,
        uploadLimits,
        companyMode,
        login,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
