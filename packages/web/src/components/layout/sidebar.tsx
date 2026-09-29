/**
 * Single-column sidebar, top to bottom:
 * Project switcher -> prominent new chat (default_agent draft) + three everyday links
 * and purpose-based tool groups (collapsed by default, with the current destination
 * always visible). Company mode retains its own collapsible page navigation.
 * The pinned new-chat block never collapses -> Session area with three grouping
 * modes (chosen in the section header's list options; the
 * choice and each Project's group collapse and pin state persist in localStorage): by Workspace
 * (the default; groups loaded Sessions by their
 * Workspace path, temporary workspaces merged into one trailing group, header "+" starts a
 * draft in that Workspace), by Agent (group header = Agent name + new chat + Agent settings;
 * shows all Agents, including empty groups), or by time (last day / last month / earlier,
 * bucketed on last activity; the buckets span every Agent, so the Subagents / Scheduled /
 * Archived folders and the paging row sit below them as one Project-wide set). Groups can
 * be pinned via the header's hover pin toggle: pinned groups sort before unpinned within
 * their mode, keeping each partition's own order — the time buckets excepted, whose order
 * IS the timeline and which therefore carry no pin. Conversations can be pinned too (row
 * context menu; persisted per Project in
 * localStorage): pinned rows bubble to the top of their group's active list. Each row's
 * trailing slot shows the compact last-active time at rest and swaps to archive + delete
 * icon buttons on hover/focus; the full set (pin, rename, archive, delete) opens as a
 * context menu on right-click, Shift+F10, or a press-and-hold on touch
 * -> bottom user row, which opens the shared account menu (user-menu.tsx).
 * In company mode the shape holds but the objects change: the organization switcher stands
 * where the Project switcher stands, "New channel" where "New chat" is, the organization's
 * six pages in the nav group, and the channel list where the conversation list is, followed
 * by the organization's own two groups — Workstations (one row per employee) and Ticket Sessions
 * (features/company/channel-sidebar.tsx, features/company/org-session-groups.tsx). The
 * development list is the user's OWN conversations only: an organization's desk and ticket
 * Sessions are filtered out of every group, bucket and folder here.
 * Desktop keeps it pinned as the left column; mobile puts the whole thing in a drawer.
 * New chats always enter draft state (/chat/new, route state specifies the Agent and optionally
 * the Workspace): Model / Workspace / approval mode are all chosen on the draft input card, so
 * there's no longer a separate "quick / advanced" pair of new-chat dialogs.
 * Color scheme is white/gray-based: active state uses a solid gray fill, running status uses a small color dot, no large blocks of color.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { NavLink, useLocation, useMatch, useNavigate } from "react-router";
import type {
  SessionCategory,
  SessionCategoryCounts,
  SessionInfo,
} from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { formatRelativeShort } from "../../lib/format";
import { sessionBackgroundTasks, sessionRowActivity } from "../../lib/session-activity";
import { forgetSession, noteSessionSeen, useSessionSeen } from "../../lib/session-seen";
import { apiErrorText } from "../../lib/api-error";
import { useAuth } from "../../state/auth";
import { useLocale } from "../../state/locale";
import { agentDisplayName, projectDisplayName, useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import {
  FOLDER_CATEGORIES,
  SIDEBAR_PAGE_SIZE,
  TIME_FOLDERS_GROUP_KEY,
  aggregateWorkspaceCounts,
  aggregateWorkspaceLatest,
  clampGroupPage,
  completeWorkspaceGroups,
  countsWithoutOrgSessions,
  groupPageCount,
  groupPageOf,
  groupPageSlice,
  groupSessionsByTime,
  groupSessionsByWorkspace,
  hiddenRowCount,
  matchesSessionQuery,
  partitionSessions,
  sessionCategory,
  splitDevelopmentList,
  totalCategoryCounts,
  withoutOrgSessions,
  workspaceGroupKey,
  workspaceLabel,
} from "../../lib/session-grouping";
import type { FolderCategory, SessionPartition } from "../../lib/session-grouping";
import {
  initialNavGroupCollapsed,
  navKeysFor,
  navPathFor,
  storeNavGroupCollapsed,
} from "../../lib/nav-group-collapse";
import {
  addPinnedSessions,
  loadPinnedSessions,
  removePinnedSession,
  removePinnedSessions,
  savePinnedSessions,
  togglePinnedSession,
} from "../../lib/pinned-sessions";
import {
  EMPTY_SELECTION,
  pruneSelection,
  reduceSelection,
  selectedInOrder,
} from "../../lib/session-selection";
import type { SelectionAction, SelectionState } from "../../lib/session-selection";
import {
  loadWorkspaceRegistry,
  mergeRegisteredWorkspaces,
  registerWorkspace,
  saveWorkspaceRegistry,
  setWorkspaceAlias,
  unregisterWorkspace,
} from "../../lib/workspace-registry";
import type { WorkspaceEntry } from "../../lib/workspace-registry";
import {
  applyManualReorder,
  initialSessionSortMode,
  loadSessionOrder,
  moveInSequence,
  orderSessionRows,
  removeFromSessionOrder,
  saveSessionOrder,
  storeSessionSortMode,
} from "../../lib/session-order";
import type { SessionSortMode } from "../../lib/session-order";
import {
  commitGroupOrder,
  isOrderableGroupMode,
  loadGroupOrder,
  orderGroups,
  saveGroupOrder,
} from "../../lib/group-order";
import { Dropdown, menuItemClass } from "../ui/dropdown";
import {
  ARCHIVE_ICON,
  HOVER_ROW_ACTIONS,
  PENCIL_ICON,
  PIN_ICON,
  SessionRowHoverActions,
  SessionRowMenuRows,
  TRASH_ICON,
  UNARCHIVE_ICON,
  contextMenuActions,
  overflowMenuDangerClass,
  overflowMenuGlyph,
  overflowMenuRowClass,
} from "../ui/session-row-menu";
import { AgentAvatar } from "../ui/agent-avatar";
import { ChevronDown, GEAR_ICON, NAV_ICONS } from "../ui/icons";
import {
  FOLDER_ICON,
  FOLDER_OPEN_ICON,
  GROUP_MODE_ICONS,
  SORT_MODE_ICONS,
  FolderSection,
  GroupHeader,
  GroupPager,
  Icon,
  MoreRow,
  initialGroupMode,
  newEntityForGroupMode,
  storeGroupMode,
} from "../ui/group-list";
import type { GroupMode } from "../ui/group-list";
import { toastError, toastInfo } from "../ui/toast";
import { Badge } from "../ui/badge";
import {
  BackgroundTasksMark,
  ScheduleMark,
  SessionActivityIcon,
} from "../ui/session-activity-icon";
import { Modal } from "../ui/modal";
import { ConfirmModal } from "../ui/confirm-modal";
import { Button } from "../ui/button";
import { Input, noAutofill } from "../ui/input";
import { SkeletonList } from "../ui/skeleton";
import { UpdateDot } from "../ui/update-dot";
import { DRAFT_SESSION_ID } from "../../features/chat/chat-page";
import { MessagingBindingModal } from "../../features/messaging/messaging-binding-modal";
import { WorkspaceSelect } from "../../features/chat/workspace-select";
import { clearDraft, sessionDraftKey } from "../../features/chat/draft-cache";
import {
  draftSessionTitle,
  parkActiveDraft,
  removeDraftSession,
  useDraftSessions,
} from "../../features/chat/draft-sessions";
import type { DraftSessionEntry } from "../../features/chat/draft-sessions";
import { CreateProjectDialog, ProjectSettingsDialog } from "./project-dialogs";
import { UserMenu } from "./user-menu";
import { ProductNavigation } from "./product-navigation";
import { NavGroupCollapse } from "./nav-collapse";
import { DraftRow } from "./draft-row";
import { GroupBlock } from "./group-block";
import { GroupOverflowMenu } from "./group-overflow-menu";
import { GroupPinButton } from "./group-pin-button";
import { MenuRadioRow } from "./menu-radio-row";
import { CLOSE_ICON, SelectionBar } from "./selection-bar";
import { SessionRow } from "./session-row";
import { navNoteFor, useUpdateBadges } from "../../lib/use-update-badges";
import { pendingScheduleSessions } from "../../features/schedules/schedule-panel-state";
import { useAgentSchedules } from "../../features/schedules/schedule-store";
import { ICON_SIZE } from "../../lib/icon-scale";
import { Segmented } from "../ui/segmented";
import { useCompany } from "../../state/company";
import { NoOrganizationsSidebar, OrgSwitcher } from "../../features/company/org-switcher";
import { ChannelSidebar } from "../../features/company/channel-sidebar";
import { OrgSessionGroups } from "../../features/company/org-session-groups";
import { COMPANY_NAV_ICONS } from "../../features/company/company-nav-icons";
import {
  COMPANY_NAV_KEYS,
  isOrgRoute,
  orgPagePath,
  parseOrgKey,
} from "../../features/company/company-nav";
import type { WorkMode } from "../../features/company/company-nav";

/** New-chat pencil (the pinned "New chat" button and the collapsed rail share it). */
export const NEW_CHAT_ICON = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z";

/** Magnifier (lucide search), the section header's search toggle. */
const SEARCH_ICON = "M21 21l-4.35-4.35M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z";

/** Horizontal sliders (lucide sliders-horizontal), the section header's list-settings menu. */
const SLIDERS_ICON = "M21 5h-7M10 5H3M21 12h-9M8 12H3M21 19h-5M12 19H3M14 2v6M8 9v6M16 16v6";

/**
 * Private drag payload type of a manual session reorder. Deliberately NOT `text/plain`:
 * the composer is a controlled textarea with no drop guard, and a native text drop
 * mutates its value and fires `input` — a mis-aimed reorder would paste a session id
 * into the user's message. Nothing outside these rows reads this type.
 */
const SESSION_DRAG_MIME = "application/x-penguin-session-id";

/** Private drag payload type of a group reorder (same reasoning as SESSION_DRAG_MIME: never text/plain). */
const GROUP_DRAG_MIME = "application/x-penguin-group-key";

/**
 * Is the drag in flight one of our group reorders? `types` is readable during dragover
 * (unlike getData), so the payload GROUP_DRAG_MIME carries is what authorizes the drop
 * rather than React state alone: a `dragGroup` left behind by a source header that
 * unmounted mid-drag can no longer make the sidebar swallow an unrelated drag — a file
 * from the desktop, a Session row — paint a phantom drop line, and commit on release.
 */
const isGroupDrag = (e: ReactDragEvent): boolean => e.dataTransfer.types.includes(GROUP_DRAG_MIME);

/** Manual drag-reordering needs a pointer that can drag (HTML5 DnD never fires from touch) — the outline rail's query. */
const DRAG_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * Mode-dependent create glyph: the entity's own icon (folder / robot) shrunk toward
 * the top-left, with a plus badge in the freed bottom-right corner — no knockout disc
 * needed (a background-colored punch would mismatch the hover pill), so it stays
 * legible at icon size in both themes. Stroke style matches the shared Icon set.
 */
function AddBadgeIcon({ base, size = 15 }: { base: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <g transform="translate(-1 -1) scale(0.82)">
        <path d={base} />
      </g>
      <path d="M18.5 15.5v6M15.5 18.5h6" strokeWidth="2" />
    </svg>
  );
}

/** Section-header icon control (search / list settings / create): the grouping-toggle button look — active renders as a pressed fill. */
const headerControlClass = (active: boolean) =>
  `flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ${
    active
      ? "bg-gray-200/70 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
      : "text-gray-500 hover:bg-gray-200/50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-300"
  }`;

/** Muted section label inside the list-settings menu (Grouping / Sorting), at the overflow menus' density. */
const menuSectionClass =
  "px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400";

/**
 * Collapsed-group and pinned-group persistence (survives a refresh), one storage key
 * per Project and concern — group keys are Agent ids / Workspace paths, which are
 * Project-scoped. Both grouping modes share one set per concern (their key spaces
 * never collide); stray keys left by deleted Agents or Workspaces are harmless
 * (never matched) and the per-Project sets stay tiny.
 */
const collapsedGroupsKey = (projectId: string) => `penguin.sidebarCollapsedGroups.${projectId}`;
const pinnedGroupsKey = (projectId: string) => `penguin.sidebarPinnedGroups.${projectId}`;
/** Reads a persisted group-key set (no Project yet / corrupted storage degrade to empty). */
function loadGroupSet(storageKey: string | null): ReadonlySet<string> {
  if (!storageKey) return new Set();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}
function saveGroupSet(storageKey: string | null, next: ReadonlySet<string>): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...next]));
  } catch {
    /* best-effort persistence (quota/private mode) */
  }
}

/**
 * Open-state key of a collapsed folder (subagent / scheduled / archived) inside a group:
 * each folder has its own state. "\0" never appears in Agent ids or Workspace paths, so
 * the composite never collides across groups or with plain group keys.
 */
const folderKey = (groupKey: string, category: FolderCategory) => `${category}\0${groupKey}`;

/** Collapse-state key of the parked-drafts group ("\0" keeps it clear of Agent ids and Workspace paths). */
const DRAFTS_GROUP_KEY = "\0drafts";

/** Standing "no Session is scheduled", so the first render has something to hold before any answer. */
const NO_SCHEDULED_SESSIONS: ReadonlySet<string> = new Set();

export function Sidebar({
  onNavigate,
  onCollapse,
}: {
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, sessionVia } = useAuth();
  const { locale } = useLocale();
  const {
    projects,
    currentProject,
    setCurrentProjectId,
    reloadProjects,
    agents,
    currentAgent,
    setCurrentAgentId,
  } = useProject();
  const {
    sessions: allSessions,
    byAgent: allByAgent,
    countsByAgent: serverCountsByAgent,
    workspaceCountsByAgent: serverWorkspaceCounts,
    workspaceLatestByAgent,
    isLoadedFor,
    hasMoreFor,
    loadMoreFor,
    loading,
    remove,
    replace,
  } = useSessions();
  const chatMatch = useMatch("/chat/:sessionId");
  const activeSessionId = chatMatch?.params.sessionId ?? null;

  const [projectOpen, setProjectOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  /** The badges over the update and to-do trails (use-update-badges.ts); the avatar's dot follows the update flow's offer / restart states. */
  const badges = useUpdateBadges();
  const company = useCompany();
  /** Company mode swaps the Project switcher, the page nav and the session list for their organization forms. */
  const inCompany = company.workMode === "company";
  /** The organization the company nav points at: the open one, else the one last opened (the switcher names the same). */
  const navOrg = parseOrgKey(company.currentOrgKey ?? company.lastOrgKey);

  /**
   * The rows this list renders: the user's OWN conversations. An organization's desk and
   * ticket Sessions (marked by `orgId`, or by the durable `client === "org"` stamp once the
   * organization is gone) are driven by its scheduler and are listed as themselves in company
   * mode's Workstations / Ticket Sessions groups, so they are filtered out here — once, at the source, or a
   * dropped row would still conjure the Workspace group, Agent group or time bucket it belongs
   * to. They are filtered whatever the company-mode switches say (see withoutOrgSessions):
   * this list is the user's conversations, and a switch about the shell does not turn a
   * scheduler's Session into one.
   */
  const devList = useMemo(() => splitDevelopmentList(allSessions), [allSessions]);
  const sessions = devList.own;
  const byAgent = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const [agentId, rows] of allByAgent) map.set(agentId, withoutOrgSessions(rows));
    return map;
  }, [allByAgent]);
  // …and the server totals those rows are counted in, corrected the same way, so a group
  // header never promises rows this list will not draw.
  const { byAgent: countsByAgent, byWorkspace: workspaceCountsByAgent } = useMemo(
    () =>
      countsWithoutOrgSessions(serverCountsByAgent, serverWorkspaceCounts, devList.organization),
    [serverCountsByAgent, serverWorkspaceCounts, devList],
  );

  const currentProjectId = currentProject?.projectId ?? null;
  /** This Project's read markers; re-renders the rows whenever one is stamped. */
  const sessionSeen = useSessionSeen(currentProjectId);
  // The current Agent's scheduled tasks, shared with the dock's schedules panel through one
  // store, which caches a list per Agent so that neither surface's scope discards the other's.
  // The scope is the current Agent: the chat page keeps it in step with the open conversation,
  // so the panel and these rows ask for the same list. In workspace or time grouping the list
  // can also show OTHER Agents' Sessions, and those rows simply wear no mark — a row saying
  // nothing is honest, a row answered from another Agent's list would not be. Re-read on every
  // navigation: opening a conversation is the moment a task may just have been created or
  // switched off.
  const { items: agentSchedules } = useAgentSchedules(
    currentProjectId,
    currentAgent?.agentId ?? null,
    activeSessionId ?? "",
  );
  // The Sessions of that Agent wearing the alarm clock: one bound task with a next fire time is
  // enough. The store re-renders these rows on every refresh (a navigation, a schedule event, a
  // turn ending, the panel's poll), and the server recomputes `nextFireAt` on each listing, so a
  // task that fired for the last time loses its mark at the next refresh.
  const pendingScheduled = useMemo(
    () => (agentSchedules === null ? null : pendingScheduleSessions(agentSchedules)),
    [agentSchedules],
  );
  // A null list means "this Agent has not been read yet", never "this Agent has no tasks":
  // reading it as the second blanks every alarm in the list for as long as a request takes. The
  // marks on screen stand until a real answer replaces them, which is the standing the pin and
  // the relay glyph get for free by being fields of the row itself.
  const lastScheduledRef = useRef<ReadonlySet<string>>(NO_SCHEDULED_SESSIONS);
  useEffect(() => {
    if (pendingScheduled !== null) lastScheduledRef.current = pendingScheduled;
  }, [pendingScheduled]);
  const scheduledSessions = pendingScheduled ?? lastScheduledRef.current;
  const collapseStoreKey = currentProjectId === null ? null : collapsedGroupsKey(currentProjectId);
  const pinStoreKey = currentProjectId === null ? null : pinnedGroupsKey(currentProjectId);
  /** The page-nav collapse preference. One stored key, one state, both nav surfaces: company
      mode's flat list and dev mode's ProductNavigation both render this toggle. */
  const [navCollapsed, setNavCollapsed] = useState(initialNavGroupCollapsed);
  /** Grouping mode of the Session list (Workspace by default; the choice persists across sessions). */
  const [groupMode, setGroupModeState] = useState<GroupMode>(initialGroupMode);
  /** Collapsed groups (expanded by default), keyed by Agent id or Workspace group key depending on the mode; persisted per Project. */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() =>
    loadGroupSet(collapseStoreKey),
  );
  /** Pinned groups (sorted before unpinned within their mode), keyed like collapsedGroups; persisted per Project. */
  const [pinnedGroups, setPinnedGroups] = useState<ReadonlySet<string>>(() =>
    loadGroupSet(pinStoreKey),
  );
  /** Pinned conversations (bubbled to the top of their group's active list), Session ids; persisted per Project frontend-side (lib/pinned-sessions.ts). */
  const [pinnedSessions, setPinnedSessions] = useState<ReadonlySet<string>>(() =>
    loadPinnedSessions(currentProjectId),
  );
  /**
   * Multi-selection over the conversation list (lib/session-selection.ts holds the rules).
   * `selectionMode` is the mode flag rather than `selection.selected.size > 0`: an empty
   * selection can be reached mid-interaction (Esc on the last marked row, "Select all" on a
   * list that then re-filters to nothing), and a mode that switches itself off there would
   * turn the checkboxes off under a user who is still holding one.
   */
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [selectionMode, setSelectionMode] = useState(false);
  /**
   * The marks, mirrored for handlers that must keep their identity (see the row-handler note
   * below): a memoised row holds the first closure it was given, so a handler that closed
   * over `selection` would act on the marks as they were when the row mounted. Synced after
   * commit — which is the first moment a click can observe them anyway.
   */
  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  });
  const batchArchiveBusy = useRef(false);
  /** The scroll area, so the selection can ask the DOM which rows are on screen and in what order. */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Row sort mode ("recent" default / "manual" drag order; the choice persists across sessions like the grouping mode). */
  const [sortMode, setSortModeState] = useState<SessionSortMode>(initialSessionSortMode);
  /** Manual row order (Session ids; only relative order within a co-rendered partition matters); persisted per Project AND grouping mode — the modes cut different partitions. */
  const [sessionOrder, setSessionOrder] = useState<readonly string[]>(() =>
    loadSessionOrder(currentProjectId, initialGroupMode()),
  );
  /**
   * Manual GROUP order (Workspace keys / Agent ids), persisted per Project and grouping
   * mode like the row order. Independent of `sortMode`: dragging a group is itself the
   * intent, so there is no second toggle — an empty array is the identity and the list
   * keeps its automatic sort. Empty in time mode, whose buckets are chronological
   * (group-order.ts).
   */
  const [groupOrder, setGroupOrder] = useState<readonly string[]>(() =>
    loadGroupOrder(currentProjectId, initialGroupMode()),
  );
  /** Manually-added Workspaces (header "New Workspace"; render as empty groups until Sessions exist, with optional display aliases); persisted per Project. */
  const [registeredWorkspaces, setRegisteredWorkspaces] = useState<readonly WorkspaceEntry[]>(() =>
    loadWorkspaceRegistry(currentProjectId),
  );
  /** Registered Workspace being renamed (alias edit; null = none) and the alias being typed. */
  const [renamingWorkspace, setRenamingWorkspace] = useState<{ path: string } | null>(null);
  const [workspaceAliasText, setWorkspaceAliasText] = useState("");
  /** Registered Workspace pending removal confirmation (null = none); label = the group's displayed name for the confirm copy. */
  const [deletingWorkspace, setDeletingWorkspace] = useState<{
    path: string;
    label: string;
  } | null>(null);
  /** Live title search: the input's visibility and its query (transient — never persisted). */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** Header list-settings dropdown (grouping + sort radios). */
  const [listSettingsOpen, setListSettingsOpen] = useState(false);
  /**
   * Whether a pointer that can drag is present (the outline rail's HOVER_QUERY idiom).
   * HTML5 drag-and-drop never fires from touch, and the sort mode is one GLOBAL
   * preference: offering "manual sort" in the mobile drawer would freeze that list in an
   * order the phone has no gesture to change — and flip the desktop too. The option is
   * hidden there; an already-stored "manual" degrades to recency on such a device.
   */
  const [canDrag, setCanDrag] = useState(() => window.matchMedia(DRAG_POINTER_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DRAG_POINTER_QUERY);
    const onChange = (e: MediaQueryListEvent) => setCanDrag(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  /** Row being dragged (manual sort only) and the current drop hint (target row + which edge). */
  const [dragSession, setDragSession] = useState<{ scope: string; id: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  /** Group header being dragged (its key) and the current group drop hint (target group + which edge). */
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [groupDropHint, setGroupDropHint] = useState<{ key: string; after: boolean } | null>(null);
  // Project resolved on first load / switched: swap in that Project's persisted collapse/pin sets.
  useEffect(() => {
    setCollapsedGroups(loadGroupSet(collapseStoreKey));
    setPinnedGroups(loadGroupSet(pinStoreKey));
    setPinnedSessions(loadPinnedSessions(currentProjectId));
    setSessionOrder(loadSessionOrder(currentProjectId, groupMode));
    setGroupOrder(loadGroupOrder(currentProjectId, groupMode));
    setRegisteredWorkspaces(loadWorkspaceRegistry(currentProjectId));
    setGroupPage(0);
    // The other Project's groups are gone, and so is any meaning their reveal state had.
    setGroupCaps(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseStoreKey, pinStoreKey, currentProjectId]);
  /** Expanded folders (subagent / scheduled / archived; collapsed by default), keyed by folderKey — each folder has its own open state. */
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  /** "More" rows with a fetch in flight, keyed `${category}\0${groupKey}` — the row disables and reads "loading" so a page that lands entirely in other groups still visibly did something. */
  const [pendingLoads, setPendingLoads] = useState<ReadonlySet<string>>(new Set());
  /** Per-group display cap for active rows (keyed by group key; absent = SIDEBAR_PAGE_SIZE). "More" raises it a page at a time. */
  const [groupCaps, setGroupCaps] = useState<ReadonlyMap<string, number>>(new Map());
  /** Which PAGE of groups renders (#139: dozens of Agents/Workspaces made the list too tall to scan), 0-based; reset per Project and on a mode switch, and clamped at render to the pages that still exist. */
  const [groupPage, setGroupPage] = useState(0);
  /** Session pending delete confirmation (null = none). */
  const [deletingSession, setDeletingSession] = useState<SessionInfo | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  /** Batch delete: the marked ids one confirmation will remove (null = the dialog is closed). */
  const [deletingMany, setDeletingMany] = useState<readonly string[] | null>(null);
  const batchDeleteBusy = useRef(false);
  /** Parked draft conversation pending delete confirmation (null = none). */
  const [deletingDraft, setDeletingDraft] = useState<DraftSessionEntry | null>(null);
  /** Parked draft conversations of this user × Project, newest first (reactive module store). */
  const draftEntries = useDraftSessions(user?.userId ?? null, currentProjectId);
  /** Session currently being renamed (null = none) and the title being typed. */
  const [renamingSession, setRenamingSession] = useState<SessionInfo | null>(null);
  const [renameText, setRenameText] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  /** Session whose messaging-binding dialog is open (null = none). */
  const [messagingSession, setMessagingSession] = useState<SessionInfo | null>(null);

  const setGroupMode = (mode: GroupMode) => {
    storeGroupMode(mode);
    setGroupModeState(mode);
    // The modes have unrelated group lists: go back to the first page, drop the per-group
    // reveal state (a cap keyed by an Agent id means nothing to a Workspace group), and
    // swap in this mode's own manual order (the stored sequence is read within partitions,
    // whose boundaries are exactly what the mode decides — one shared array would scramble).
    setSessionOrder(loadSessionOrder(currentProjectId, mode));
    setGroupOrder(loadGroupOrder(currentProjectId, mode));
    setGroupPage(0);
    setGroupCaps(new Map());
  };

  /** Collapse/expand the page-nav group (same store-then-set convention as setGroupMode). */
  const toggleNavGroup = () => {
    const next = !navCollapsed;
    storeNavGroupCollapsed(next);
    setNavCollapsed(next);
  };

  /** Workspace-mode per-group exact server totals (folded from the per-Agent per-Workspace counts). */
  const workspaceGroupCounts = useMemo(
    () => aggregateWorkspaceCounts(workspaceCountsByAgent),
    [workspaceCountsByAgent],
  );

  /** Workspace-mode per-group newest-Session stamps (folded the same way): a group's recency before any of its rows are loaded. */
  const workspaceGroupLatest = useMemo(
    () => aggregateWorkspaceLatest(workspaceLatestByAgent),
    [workspaceLatestByAgent],
  );

  /**
   * Workspace groups (workspace mode): the loaded rows' groups, completed with every
   * Workspace the server's counts know (empty until their rows page in — the initial load
   * is each Agent's ten newest conversations, which touch only a few of dozens of
   * Workspaces), by recency with the temp group last, plus the manually-added Workspaces
   * as empty groups behind them (newest registration first).
   */
  const workspaceGroups = useMemo(
    () =>
      mergeRegisteredWorkspaces(
        completeWorkspaceGroups(
          groupSessionsByWorkspace(sessions),
          workspaceGroupCounts,
          workspaceGroupLatest,
        ),
        registeredWorkspaces,
      ),
    [sessions, workspaceGroupCounts, workspaceGroupLatest, registeredWorkspaces],
  );

  // Pinned groups first within each mode, then the manual drag order within each pin
  // partition. Nothing dragged yet = an empty order = the automatic sort untouched
  // (recency for Workspace groups with the temp group last, the configured Agent order
  // for Agents), which is also what a group with no stored place falls back to.
  // The stored array belongs to the mode it was loaded for: handing an Agent list an
  // order of Workspace keys is a no-op only as long as the two key namespaces cannot
  // collide, and it costs the empty-order fast path on every render of the other mode.
  const orderedAgents = useMemo(
    () =>
      orderGroups(agents, (a) => a.agentId, {
        pinned: pinnedGroups,
        order: groupMode === "agent" ? groupOrder : [],
      }),
    [agents, pinnedGroups, groupOrder, groupMode],
  );
  const orderedWorkspaceGroups = useMemo(
    () =>
      orderGroups(workspaceGroups, (g) => g.key, {
        pinned: pinnedGroups,
        order: groupMode === "workspace" ? groupOrder : [],
      }),
    [workspaceGroups, pinnedGroups, groupOrder, groupMode],
  );

  // The FULL displayed group sequences a drop commits — every group of the mode, not the
  // page of groups on screen (see groupDragProps).
  const agentGroupSequence = useMemo(() => orderedAgents.map((a) => a.agentId), [orderedAgents]);
  const workspaceGroupSequence = useMemo(
    () => orderedWorkspaceGroups.map((g) => g.key),
    [orderedWorkspaceGroups],
  );

  /** Group key a Session's FOLDERS hang off under the current mode (the archived-open state); time mode keeps one shared set for the whole Project. */
  const sessionGroupKey = (s: SessionInfo) =>
    groupMode === "agent"
      ? s.agentId
      : groupMode === "time"
        ? TIME_FOLDERS_GROUP_KEY
        : workspaceGroupKey(s.workspace);

  const toggleGroup = (key: string) => {
    // Inert while searching: groups render force-opened then, so a click would change
    // nothing on screen while silently rewriting the persisted collapse state — the user
    // would find groups flipped once the query clears.
    if (searching) return;
    // Computed outside the state updater (theme.tsx convention): the persistence write is a
    // side effect, and updaters must stay pure (double-invoked in StrictMode).
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsedGroups(next);
    saveGroupSet(collapseStoreKey, next);
  };

  /** Pin / unpin a group (same toggle-and-persist convention as toggleGroup). */
  const togglePin = (key: string) => {
    const next = new Set(pinnedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPinnedGroups(next);
    saveGroupSet(pinStoreKey, next);
  };

  /**
   * Pin / unpin one conversation (row menu; same toggle-and-persist convention).
   *
   * Memoised on `pinnedSessions` for the row's sake, not for its own: this is the ONE
   * handler a SessionRow holds that reads changing state, and the row's comparator
   * deliberately does not compare handlers (session-row.tsx). A stale copy would compute
   * the next pin set from the pins as they stood before the last one, and writing that back
   * would silently drop a pin the user had just set on a different row.
   */
  const toggleSessionPin = useCallback(
    (sessionId: string) => {
      const next = togglePinnedSession(pinnedSessions, sessionId);
      setPinnedSessions(next);
      savePinnedSessions(currentProjectId, next);
    },
    [pinnedSessions, currentProjectId],
  );

  /** Switch the row sort mode (store-then-set convention). Leaving manual KEEPS the stored order — toggling back restores it. */
  const setSortMode = (mode: SessionSortMode) => {
    storeSessionSortMode(mode);
    setSortModeState(mode);
  };

  /** Search active = a non-blank query is live-filtering the list. */
  const searching = searchQuery.trim() !== "";

  /**
   * Group pagination (Workspace / Agent modes — time mode has at most three buckets and
   * pages nothing). A pure display window: the manual group order still commits over the
   * FULL sequence (see groupDragProps), and no group's data loading depends on which page
   * it sits on. Search bypasses paging entirely — a match on page 3 would read as no match
   * at all, which is the same reason a collapsed group is forced open while searching.
   */
  const pagedGroupTotal =
    groupMode === "agent"
      ? orderedAgents.length
      : groupMode === "workspace"
        ? orderedWorkspaceGroups.length
        : 0;
  const groupPageTotal = groupPageCount(pagedGroupTotal);
  /** The page actually on screen: the stored one, pinned inside the pages that still exist. */
  const shownGroupPage = clampGroupPage(groupPage, pagedGroupTotal);

  /** The groups to render: this page's slice, or every match while searching. */
  const groupsOnPage = <T,>(groups: T[]): T[] =>
    searching ? groups : groupPageSlice(groups, shownGroupPage);

  /** Pager below the group list — rendered only once the groups overflow a single page. */
  const groupPagerRow = () =>
    !searching && groupPageTotal > 1 ? (
      <GroupPager page={shownGroupPage} pageCount={groupPageTotal} onChange={setGroupPage} />
    ) : null;

  /** The sort actually applied: a stored "manual" needs a drag-capable pointer to mean anything (see canDrag). */
  const effectiveSortMode: SessionSortMode = sortMode === "manual" && canDrag ? "manual" : "recent";

  /** Title filter of one group's loaded rows (search only sees loaded pages — there is no server-side search). */
  const filterRows = (rows: SessionInfo[]) =>
    searching ? rows.filter((s) => matchesSessionQuery(s, searchQuery)) : rows;

  /**
   * Time mode's split of the loaded rows: the buckets take the active conversations, the
   * shared folders below take the rest. Deliberately NOT memoized — the bucket boundary is
   * `Date.now()`, and a memo would freeze it at its last dependency change; the compact
   * relative timestamps rendered beside these rows are recomputed every render for exactly
   * the same reason. Null outside time mode, so no other mode pays for the two passes.
   */
  const timeParts = groupMode === "time" ? partitionSessions(filterRows(sessions)) : null;
  const timeGroups = timeParts === null ? [] : groupSessionsByTime(timeParts.active, Date.now());

  /** Time mode's exact server share, Project-wide: its buckets span every Agent, so the shared folders and the whole-list "More" read the summed counts. */
  const projectCounts = totalCategoryCounts(countsByAgent);

  /** Agents holding rows of a category anywhere in this Project — time mode's fetch fan-out (the counts are kept in step locally, so they cover freshly added rows too). */
  const projectAgentsFor = (category: SessionCategory) =>
    [...countsByAgent].filter(([, counts]) => counts[category] > 0).map(([agentId]) => agentId);

  /** Agents with an unfetched active page left; the whole-list "More" of time mode pages all of them at once. */
  const timeMoreAgents = projectAgentsFor("active").filter((id) => hasMoreFor(id, "active"));

  /** A time bucket's rows as a group partition: the buckets carry active conversations only. */
  const bucketPartition = (rows: SessionInfo[]): SessionPartition => ({
    active: rows,
    subagent: [],
    schedule: [],
    archived: [],
  });

  /** Close the search row and drop the filter (the toggle button, the clear ×, and Escape all land here). */
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  /**
   * Drop of a manual drag: commit the reordered partition sequence into the stored
   * order (the sequence moves to the array's front; only relative order within a
   * co-rendered partition is ever read, so other groups' ids are unaffected).
   */
  const commitManualDrop = (partitionIds: readonly string[], targetId: string, after: boolean) => {
    if (!dragSession) return;
    const seq = moveInSequence(partitionIds, dragSession.id, targetId, after);
    // Identity guard: a drop that changes nothing (self-drop, or landing where the row
    // already sat) must not rewrite and persist a fresh array.
    if (seq === partitionIds) return;
    const next = applyManualReorder(sessionOrder, seq);
    setSessionOrder(next);
    saveSessionOrder(currentProjectId, groupMode, next);
  };

  /**
   * Drop of a group drag: splice the dragged group in beside its target and persist.
   *
   * `sequence` is the mode's FULL rendered key list — every group of the mode, not the
   * page of groups on screen — and commitGroupOrder folds it into the stored array
   * where those groups already render, so a Workspace whose Sessions have not paged in
   * yet keeps its stored place instead of being pushed behind the ones that have.
   *
   * Nothing prunes here. Deciding a stored key is DEAD needs the mode's complete live
   * key set, and this component cannot prove one — the per-Workspace counts that look
   * like a proof are filtered by the "show CLI sessions" preference, and a settled Agent
   * fetch may simply have failed. Stale keys are inert (group-order.ts), so the cost of
   * keeping them is a map entry; the cost of a wrong proof is an arrangement the user
   * cannot get back.
   */
  const commitGroupDrop = (sequence: readonly string[], targetKey: string, after: boolean) => {
    if (dragGroup === null) return;
    const next = commitGroupOrder(groupOrder, sequence, dragGroup, targetKey, after);
    // Identity guard, as for rows: a drop that changes nothing must not persist a fresh array.
    if (next === groupOrder) return;
    setGroupOrder(next);
    saveGroupOrder(currentProjectId, groupMode, next);
  };

  /**
   * Drag-reorder wiring of one group header, given the mode's FULL ordered key list
   * (not the page of groups on screen — committing only the visible groups would drop
   * the hidden ones out of the stored sequence and bring them back as newcomers).
   *
   * Offered only where the groups have an order to change (isOrderableGroupMode: time
   * mode's buckets are a fixed chronological ladder), never on a search-filtered view,
   * and only where a pointer that can drag exists — HTML5 drag-and-drop never fires
   * from touch. A stored order still APPLIES on such a device: unlike the rows' global
   * sort mode, a group order is per Project and implicit, so there is nothing to
   * degrade — a phone renders the arrangement its owner made at a desk.
   *
   * A drop stays inside the dragged group's own pin partition, so dragging can reorder
   * but never pin or unpin (the rows' rule, one axis up).
   */
  const groupDragProps = (key: string, sequence: readonly string[]) => {
    if (!canDrag || searching || !isOrderableGroupMode(groupMode)) {
      return { header: {}, dropEdge: null as "above" | "below" | null };
    }
    const dragging = dragGroup;
    const samePartition =
      dragging !== null && dragging !== key && pinnedGroups.has(dragging) === pinnedGroups.has(key);
    /** Which half of the header the pointer is in — the edge the drop would land on. */
    const edgeOf = (e: ReactDragEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return e.clientY - rect.top > rect.height / 2;
    };
    return {
      header: {
        draggable: true,
        onDragStart: (e: ReactDragEvent) => {
          e.dataTransfer.setData(GROUP_DRAG_MIME, key);
          e.dataTransfer.effectAllowed = "move" as const;
          setDragGroup(key);
        },
        onDragEnd: () => {
          setDragGroup(null);
          setGroupDropHint(null);
        },
        onDragOver: (e: ReactDragEvent) => {
          if (!samePartition || !isGroupDrag(e)) return;
          e.preventDefault();
          // preventDefault alone only says "a drop may land here"; the effect still has
          // to be one effectAllowed permits, or a modifier held during the drag resolves
          // it to "none" and the drop event never fires (drop-zone.tsx sets it too).
          e.dataTransfer.dropEffect = "move";
          const after = edgeOf(e);
          setGroupDropHint((prev) =>
            prev?.key === key && prev.after === after ? prev : { key, after },
          );
        },
        // dragleave also fires when the pointer merely crosses onto one of the header's
        // OWN children — the collapse toggle spans most of the row, and up to three
        // action buttons follow it — so clearing unconditionally strobes the indicator.
        // relatedTarget is where the drag is going: still inside means nothing changed
        // (the idiom features/chat/drop-zone.tsx already uses).
        onDragLeave: (e: ReactDragEvent) => {
          const to = e.relatedTarget;
          if (to instanceof Node && e.currentTarget.contains(to)) return;
          setGroupDropHint((prev) => (prev?.key === key ? null : prev));
        },
        onDrop: (e: ReactDragEvent) => {
          if (!samePartition || dragging === null || !isGroupDrag(e)) return;
          e.preventDefault();
          // The FULL sequence, not the drag's pin partition: commitGroupOrder splices
          // within one array, and samePartition has already refused a cross-boundary
          // drop, so filtering here would only hide the other partition's keys from the
          // splice and cost them their stored positions.
          commitGroupDrop(sequence, key, edgeOf(e));
          setDragGroup(null);
          setGroupDropHint(null);
        },
      },
      dropEdge:
        samePartition && groupDropHint?.key === key
          ? groupDropHint.after
            ? ("below" as const)
            : ("above" as const)
          : null,
    };
  };

  /** Parked drafts through the live search (matched on their first-line title). */
  const shownDrafts = searching
    ? draftEntries.filter((e) =>
        draftSessionTitle(e).toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : draftEntries;

  /** Whether the active search hits anything anywhere (drafts included) — drives the quiet no-match line. */
  const hasSearchMatches =
    shownDrafts.length > 0 ||
    (groupMode === "agent"
      ? orderedAgents.some((a) => filterRows(byAgent.get(a.agentId) ?? []).length > 0)
      : groupMode === "time"
        ? timeParts !== null && Object.values(timeParts).some((rows) => rows.length > 0)
        : orderedWorkspaceGroups.some((g) => filterRows(g.sessions).length > 0));

  /** In-flight key of one group's category "More" (folderKey shares the same composite for folder categories). */
  const loadKey = (groupKey: string, category: SessionCategory) => `${category}\0${groupKey}`;

  /**
   * The server stream a group's fetches walk: its own, under Workspace grouping, or the
   * Agent's whole one otherwise. Only Workspace groups need their own — an Agent group IS
   * the whole stream, and a time bucket is cut from rows that are already loaded, so it
   * fetches nothing of its own at all.
   *
   * This is what makes the groups independent. Sharing one per-Agent cursor meant a group's
   * "load more" consumed the page its siblings were about to read: their rows appeared,
   * their reveal counts moved, and the group that asked could grow by less than a page — or
   * by nothing at all.
   */
  const fetchScope = (groupKey: string): string | undefined =>
    groupMode === "workspace" ? groupKey : undefined;

  /** loadMoreFor with an in-flight marker for the triggering "More" row (disable + loading text). */
  const trackedLoadMore = (groupKey: string, category: SessionCategory, agentIds: string[]) => {
    const key = loadKey(groupKey, category);
    setPendingLoads((prev) => new Set(prev).add(key));
    void loadMoreFor(agentIds, category, fetchScope(groupKey)).finally(() => {
      setPendingLoads((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });
  };

  /**
   * Open/close a group's folder. A folder's content is loaded on demand: the first
   * expand fetches its category's first page for every contributing Agent that hasn't
   * been asked yet (already-loaded rows stay put — re-expanding never refetches; the
   * folder's own "More" row does the paging from there).
   */
  const toggleFolder = (groupKey: string, category: FolderCategory, agentIds: string[]) => {
    // Inert while searching (same reason as toggleGroup): folders render force-opened,
    // so a click would only fire a pointless category fetch and desync the open state.
    if (searching) return;
    const key = folderKey(groupKey, category);
    const opening = !openFolders.has(key);
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    if (opening) {
      const scope = fetchScope(groupKey);
      const unloaded = agentIds.filter((id) => !isLoadedFor(id, category, scope));
      if (unloaded.length > 0) void loadMoreFor(unloaded, category, scope);
    }
  };

  // The open chat is an automation-created Session: expand exactly its origin's folder in its
  // group, so the active row is never hidden inside a collapsed folder (mirrors the archived
  // expansion on archiving the open chat; archived wins, so an archived Session is left to
  // that folder). Auto-expansion fires ONCE per (grouping mode, active session): the ref guard
  // keeps list mutations (status ticks, reloads) from re-opening a folder the user explicitly
  // collapsed while that chat stays open. `sessions` must remain a dependency — the active
  // session may not be in the list yet on first render, and the guard is only set once the
  // row is actually found and expanded.
  const lastAutoExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) return;
    const s = sessions.find((x) => x.sessionId === activeSessionId);
    if (!s) return;
    const category = sessionCategory(s);
    if (category === "active" || category === "archived") return;
    const guard = `${groupMode}\0${activeSessionId}`;
    if (lastAutoExpandedRef.current === guard) return;
    lastAutoExpandedRef.current = guard;
    const groupKey =
      groupMode === "agent"
        ? s.agentId
        : groupMode === "time"
          ? TIME_FOLDERS_GROUP_KEY
          : workspaceGroupKey(s.workspace);
    const key = folderKey(groupKey, category);
    setOpenFolders((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    // Same on-demand load a click-expand does, for this Session's own Agent (siblings of
    // other contributing Agents stay behind the folder's "More"), down the same stream the
    // folder itself pages.
    const scope = groupMode === "workspace" ? groupKey : undefined;
    if (!isLoadedFor(s.agentId, category, scope)) void loadMoreFor([s.agentId], category, scope);
  }, [activeSessionId, sessions, groupMode, isLoadedFor, loadMoreFor]);

  /**
   * Workspace mode: give every rendered group its own first page. The initial load reads
   * the Agent's whole stream, which is one stream cut by Workspace — it fills the groups
   * unevenly, so a group can come up with two rows while the neighbour it shares an Agent
   * with got eight. Any group left short of a full first page (or of its own total, if that
   * is smaller) asks for one down its own stream, once: the scoped pair is loaded from then
   * on and this is inert.
   *
   * Only the groups on screen ask — the pager bounds that to one page of groups — and a
   * search is left alone, since it renders loaded matches only and fetching cannot find more.
   *
   * The ask is marked in flight like a "More" click (pendingLoads), for two reasons: a group
   * the counts know but no page has loaded rows of starts out empty, and its body must read
   * as loading rather than as having no conversations; and the marker is what keeps this
   * effect from asking twice — every landed page changes the group list and re-runs it, and
   * an in-flight pair is still unloaded, so a second request would start its cursor over and
   * the group would later skip a page.
   */
  useEffect(() => {
    if (groupMode !== "workspace" || searching) return;
    for (const group of groupPageSlice(orderedWorkspaceGroups, shownGroupPage)) {
      const counts = workspaceGroupCounts.get(group.key);
      const total = counts?.totals.active ?? 0;
      // Counts not in yet (0): nothing is known to be missing, so nothing is asked for.
      const loaded = group.sessions.filter((s) => sessionCategory(s) === "active").length;
      if (loaded >= Math.min(SIDEBAR_PAGE_SIZE, total)) continue;
      const agents = [
        ...new Set([...(counts?.agents.active ?? []), ...group.sessions.map((s) => s.agentId)]),
      ];
      const unloaded = agents.filter((id) => !isLoadedFor(id, "active", group.key));
      if (unloaded.length === 0) continue;
      const key = loadKey(group.key, "active");
      if (pendingLoads.has(key)) continue;
      setPendingLoads((prev) => new Set(prev).add(key));
      void loadMoreFor(unloaded, "active", group.key).finally(() => {
        setPendingLoads((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
    }
  }, [
    groupMode,
    searching,
    orderedWorkspaceGroups,
    shownGroupPage,
    workspaceGroupCounts,
    isLoadedFor,
    loadMoreFor,
    pendingLoads,
  ]);

  /**
   * Archive / unarchive: persists immediately and updates in place (fails silently; the next list refresh self-corrects).
   *
   * Memoised for the row's sake (session-row.tsx compares no handlers): the two values read
   * here decide only WHICH folder an archived open chat expands into, and both are in the
   * deps, so the copy a row holds is never older than the mode and the open Session it was
   * built for.
   */
  const toggleArchive = useCallback(
    async (s: SessionInfo) => {
      // Archiving the currently open chat: expand the "archived" folder so it doesn't silently vanish from the sidebar with no way back.
      if (!s.archived && s.sessionId === activeSessionId) {
        setOpenFolders((prev) => new Set(prev).add(folderKey(sessionGroupKey(s), "archived")));
      }
      try {
        const res = await api.patchSession(s.sessionId, { archived: !s.archived });
        replace(res.session);
      } catch {
        /* Ignore: non-critical operation */
      }
    },
    [activeSessionId, groupMode],
  );

  /**
   * Batch pin / unpin over the marked rows, one pass and one storage write.
   *
   * Ids come from `selectedIds()`, which re-reads the DOM and re-checks membership, so a
   * batch can never reach a row that has since been filtered, collapsed or paged out — the
   * mark may be a moment stale, the target never is.
   */
  const batchPin = (pin: boolean) => {
    const ids = selectedIds();
    if (ids.length === 0) return;
    const next = pin
      ? addPinnedSessions(pinnedSessions, ids)
      : removePinnedSessions(pinnedSessions, ids);
    if (next === pinnedSessions) return;
    setPinnedSessions(next);
    savePinnedSessions(currentProjectId, next);
  };

  /**
   * Batch archive / unarchive: the single-row operation fanned out over the marked rows.
   *
   * Fanned out, NOT one request carrying an array. The per-id route resolves the row's
   * owner and requires project access, answering 404 for anything the caller cannot reach;
   * a batch endpoint would have to re-implement that check per element, and the version
   * that forgot one element would archive another Project's conversation with a perfectly
   * valid-looking response. Per-id also means one conversation failing does not roll back
   * the other thirty-nine — the succeeded ones are replaced in the store as they land.
   */
  const batchArchive = async (archived: boolean) => {
    if (batchArchiveBusy.current) return;
    const ids = selectedIds();
    if (ids.length === 0) return;
    batchArchiveBusy.current = true;
    // Same courtesy the single-row path extends: the conversation that is open right now
    // must not silently vanish behind a closed folder with no way back.
    if (archived && activeSessionId !== null && ids.includes(activeSessionId)) {
      const open = sessions.find((x) => x.sessionId === activeSessionId);
      if (open !== undefined) {
        setOpenFolders((prev) => new Set(prev).add(folderKey(sessionGroupKey(open), "archived")));
      }
    }
    try {
      const results = await Promise.allSettled(
        ids.map((id) => api.patchSession(id, { archived }).then((res) => res.session)),
      );
      const succeeded = new Set<string>();
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") continue;
        replace(result.value);
        const id = ids[index];
        if (id !== undefined) succeeded.add(id);
      }
      const failed = ids.length - succeeded.size;
      if (failed > 0) {
        // Keep failed rows marked for retry, including any new marks made while requests ran.
        setSelection((prev) => ({
          selected: new Set([...prev.selected].filter((id) => !succeeded.has(id))),
          anchor: null,
        }));
        toastError(S.chat.batchArchiveFailed(failed, ids.length, archived));
      } else {
        // Successful rows may have moved into a different folder; return them to links.
        clearSelection();
      }
    } finally {
      batchArchiveBusy.current = false;
    }
  };

  const confirmRename = async () => {
    if (!renamingSession) return;
    const title = renameText.trim();
    if (!title) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const res = await api.patchSession(renamingSession.sessionId, { title });
      replace(res.session);
      setRenamingSession(null);
    } catch (e) {
      setRenameError(apiErrorText(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const confirmDeleteSession = async () => {
    if (!deletingSession) return;
    setDeletingBusy(true);
    const target = deletingSession;
    try {
      await api.deleteSession(target.sessionId);
      // remove() also tombstones the id (see the store's isDeleted), which is what keeps the
      // chat page from re-fetching the Session it is still routed at during the frames before
      // the navigate() below lands. Ordering the two is deliberately NOT the mechanism: the
      // list lives in a zustand store whose updates are not subject to React's transition
      // lanes, so scheduling tricks here cannot be relied on to sequence them.
      remove(target.sessionId);
      // The session is gone, so clear its input draft too (no orphaned keys left in localStorage; keys are scoped per user, #68).
      if (user) clearDraft(sessionDraftKey(user.userId, target.sessionId));
      // Prune its pin and manual-order entry as well (both helpers return the same
      // reference when the id wasn't present — the write is skipped then).
      const prunedPins = removePinnedSession(pinnedSessions, target.sessionId);
      if (prunedPins !== pinnedSessions) {
        setPinnedSessions(prunedPins);
        savePinnedSessions(currentProjectId, prunedPins);
      }
      forgetSession(currentProjectId, target.sessionId);
      const prunedOrder = removeFromSessionOrder(sessionOrder, target.sessionId);
      if (prunedOrder !== sessionOrder) {
        setSessionOrder(prunedOrder);
        saveSessionOrder(currentProjectId, groupMode, prunedOrder);
      }
      setDeletingSession(null);
      // The deleted session was the one open: jump to this Agent's next conversation, otherwise
      // fall back to the chat home page. Auto-opened conversations are never archived (hidden by
      // default — landing there would look like the chat vanished into thin air) and never
      // subagent children (they belong to some other conversation).
      if (activeSessionId === target.sessionId) {
        const rest = (byAgent.get(target.agentId) ?? []).filter((s) => {
          const category = sessionCategory(s);
          return (
            s.sessionId !== target.sessionId && (category === "active" || category === "schedule")
          );
        });
        navigate(rest[0] ? `/chat/${rest[0].sessionId}` : "/chat");
      }
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      setDeletingBusy(false);
    }
  };

  /**
   * Batch delete over the marked rows: one confirmation naming the count, then the per-id
   * delete route fanned out — the same rationale as batchArchive (each request re-checks
   * project access on the server, and one conversation failing does not roll back the
   * others). The cleanup the single path does per row (store tombstone, draft, pin, manual
   * order) is done once over the ids that actually went.
   */
  const confirmBatchDelete = async () => {
    if (deletingMany === null || batchDeleteBusy.current) return;
    const ids = [...deletingMany];
    if (ids.length === 0) {
      setDeletingMany(null);
      return;
    }
    batchDeleteBusy.current = true;
    setDeletingBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.deleteSession(id)));
      const succeeded = new Set<string>();
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") continue;
        const id = ids[index];
        if (id !== undefined) succeeded.add(id);
      }
      let prunedPins = pinnedSessions;
      let prunedOrder = sessionOrder;
      for (const id of succeeded) {
        // remove() also tombstones the id (see the store's isDeleted), which is what keeps
        // the chat page from re-fetching a Session it is still routed at — same reason as
        // the single-row path.
        remove(id);
        if (user) clearDraft(sessionDraftKey(user.userId, id));
        forgetSession(currentProjectId, id);
        prunedPins = removePinnedSession(prunedPins, id);
        prunedOrder = removeFromSessionOrder(prunedOrder, id);
      }
      if (prunedPins !== pinnedSessions) {
        setPinnedSessions(prunedPins);
        savePinnedSessions(currentProjectId, prunedPins);
      }
      if (prunedOrder !== sessionOrder) {
        setSessionOrder(prunedOrder);
        saveSessionOrder(currentProjectId, groupMode, prunedOrder);
      }
      const failed = ids.length - succeeded.size;
      if (failed > 0) {
        // Keep the rows that failed marked for retry, including new marks made while the
        // requests ran (same contract as batchArchive).
        setSelection((prev) => ({
          selected: new Set([...prev.selected].filter((id) => !succeeded.has(id))),
          anchor: null,
        }));
        toastError(S.chat.batchDeleteFailed(failed, ids.length));
      } else {
        clearSelection();
      }
      setDeletingMany(null);
      // The chat that was open went with the batch: jump to that Agent's next conversation,
      // else the chat home page (the single-row delete's fallback).
      if (activeSessionId !== null && succeeded.has(activeSessionId)) {
        const open = sessions.find((x) => x.sessionId === activeSessionId);
        const rest = (open ? (byAgent.get(open.agentId) ?? []) : []).filter((s) => {
          const category = sessionCategory(s);
          return !succeeded.has(s.sessionId) && (category === "active" || category === "schedule");
        });
        navigate(rest[0] ? `/chat/${rest[0].sessionId}` : "/chat");
      }
    } catch (e) {
      toastError(apiErrorText(e));
    } finally {
      batchDeleteBusy.current = false;
      setDeletingBusy(false);
    }
  };

  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };

  /**
   * New chat: enters draft state (/chat/new) without creating a Session — Model / Workspace /
   * approval mode are all chosen on the draft input card, and the Session is only actually
   * created when the first message is sent. The route state explicitly carries the target
   * Agent: the agent-mode group header's "+" uses that group's Agent, while the menu's "New
   * chat" uses default_agent; this explicit intent overrides the previously selected Agent in
   * the draft cache (the rest of the draft content, such as the message body, is preserved).
   * The workspace-mode group header's "+" additionally carries that group's Workspace path
   * ("" = a temporary workspace), pre-filling the draft's Workspace selection the same way.
   */
  const newChat = (agentId?: string, workspace?: string) => {
    // Typed-but-unsent text in the ACTIVE new-chat draft becomes a parked draft
    // conversation first (a row in the list below, sendable anytime — draft-sessions.ts),
    // so this click always lands on an empty composer and never silently shelves content.
    if (user && currentProjectId) parkActiveDraft(user.userId, currentProjectId);
    if (agentId) setCurrentAgentId(agentId);
    const state = {
      ...(agentId ? { agentId } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    navigate(`/chat/${DRAFT_SESSION_ID}`, Object.keys(state).length > 0 ? { state } : undefined);
    onNavigate?.();
  };

  /** Confirmed parked-draft deletion: drops the entry; a deleted draft that is open falls back to the plain new-chat page. */
  const confirmDeleteDraft = () => {
    if (!deletingDraft) return;
    if (user && currentProjectId) {
      removeDraftSession(user.userId, currentProjectId, deletingDraft.id);
    }
    if (activeSessionId === deletingDraft.id) navigate(`/chat/${DRAFT_SESSION_ID}`);
    setDeletingDraft(null);
  };

  /** Target of the menu's "New chat": default_agent, falling back to the first Agent (if the list isn't ready yet, resolution is deferred to the draft page). */
  const defaultAgentId = (agents.find((a) => a.agentId === "default_agent") ?? agents[0])?.agentId;

  /** A Session always needs an Agent, so the workspace-mode "+" uses the current Agent, falling back to default_agent. */
  const workspaceNewChatAgentId = currentAgent?.agentId ?? defaultAgentId;

  /** What the header's create button makes, and its tooltip (the created object follows the grouping mode). */
  const newEntity = newEntityForGroupMode(groupMode);
  const newEntityLabel =
    newEntity === "agent"
      ? S.agent.create
      : newEntity === "chat"
        ? S.chat.newSessionMenu
        : S.chat.newWorkspaceEntity;

  /** Persist-if-changed for every registry mutation (register / alias / unregister share the same-reference fast exit). */
  const applyRegistryChange = (next: readonly WorkspaceEntry[]) => {
    if (next === registeredWorkspaces) return;
    setRegisteredWorkspaces(next);
    saveWorkspaceRegistry(currentProjectId, next);
  };

  /**
   * New Workspace: register the browsed pick so it surfaces as a group immediately, Sessions
   * or not. An empty registered group is appended and nothing pins or orders it yet, so it
   * lands last — turn to the page that now holds it, or to the page of the group that was
   * already there. Otherwise, past ten groups, the freshly added Workspace would sit on a
   * page the user is not looking at and the click would read as a no-op.
   */
  const addWorkspace = (path: string) => {
    const next = registerWorkspace(registeredWorkspaces, path);
    if (next === registeredWorkspaces) return;
    applyRegistryChange(next);
    const key = workspaceGroupKey(path);
    const existing = orderedWorkspaceGroups.findIndex((g) => g.key === key);
    setGroupPage(groupPageOf(existing >= 0 ? existing : orderedWorkspaceGroups.length));
  };

  /** Paths with a registry entry — only their groups offer the rename/remove overflow. */
  const registeredPaths = useMemo(
    () => new Set(registeredWorkspaces.map((e) => e.path)),
    [registeredWorkspaces],
  );

  /** Open the alias editor pre-filled with the current alias ("" = following the basename). */
  const openRenameWorkspace = (path: string) => {
    setWorkspaceAliasText(registeredWorkspaces.find((e) => e.path === path)?.alias ?? "");
    setRenamingWorkspace({ path });
  };

  /** Commit the alias (blank reverts the label to the directory basename). Direct save — no server, nothing destructive. */
  const confirmRenameWorkspace = () => {
    if (!renamingWorkspace) return;
    applyRegistryChange(
      setWorkspaceAlias(registeredWorkspaces, renamingWorkspace.path, workspaceAliasText),
    );
    setRenamingWorkspace(null);
  };

  /**
   * Delete workspace (confirmed via the shared ConfirmModal, like every destructive-looking
   * action): drops the sidebar registry entry only — disk and Sessions are never
   * touched, the confirm copy says exactly that, and re-adding restores it. A group
   * that still has Sessions simply persists as session-derived.
   */
  const confirmDeleteWorkspace = () => {
    if (!deletingWorkspace) return;
    applyRegistryChange(unregisterWorkspace(registeredWorkspaces, deletingWorkspace.path));
    setDeletingWorkspace(null);
  };

  const openSession = (s: SessionInfo) => {
    // Opening is what "read" means here: stamp the marker before navigating.
    noteSessionSeen(currentProjectId, s.sessionId, s.lastActiveAt);
    // Cross-group click: the current Agent follows this Session's own Agent.
    setCurrentAgentId(s.agentId);
    go(`/chat/${s.sessionId}`);
  };

  /**
   * The mode switch: company mode enters at `/org` (the organization last opened, else the
   * first); development mode keeps whatever conversation is open and only leaves an
   * organization page, which has no development form.
   */
  const switchMode = (mode: WorkMode) => {
    if (mode === company.workMode) return;
    company.setWorkMode(mode);
    if (mode === "company") go("/org");
    else if (isOrgRoute(location.pathname)) go("/chat");
  };

  /** agentId → display name (row hint tooltips in workspace mode). */
  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.agentId, agentDisplayName(a)])),
    [agents],
  );

  /**
   * The conversation rows on screen, in the order the user reads them.
   *
   * Read from the DOM at interaction time rather than collected while rendering, because the
   * render pass does not visit rows in display order: a group's folder rows are BUILT before
   * its active list is (`renderFolder` runs while the group's element is still being
   * assembled, `renderRows` for the active list runs inside the JSX), while the DOM puts the
   * active list first. A Shift-click spanning that boundary would then have marked a set that
   * does not match the span the user drew. The DOM is the one place where the order is the
   * order; a single querySelectorAll per click is far cheaper than a layout read to sort a
   * collected list, and it cannot drift from what is actually rendered.
   */
  const visibleSessionIds = (): readonly string[] => {
    const list = listRef.current;
    if (list === null) return [];
    return [...list.querySelectorAll<HTMLElement>("[data-session-id]")]
      .map((el) => el.dataset.sessionId ?? "")
      .filter((id) => id !== "");
  };

  /** Apply one selection action against the rows currently on screen. Stable by construction: a setter and a ref read. */
  const applySelection = useCallback((action: SelectionAction) => {
    setSelection((prev) => reduceSelection(prev, action, visibleSessionIds()));
  }, []);

  /** Leave selection mode: the marks and the anchor go, the rows go back to being links. */
  const clearSelection = () => {
    setSelection(EMPTY_SELECTION);
    setSelectionMode(false);
  };

  /** The marked rows in display order — the only thing a batch action is ever handed. */
  const selectedIds = (): readonly string[] => selectedInOrder(selection, visibleSessionIds());

  /**
   * What the marked rows have in common, in ONE pass over the selection: whether any is
   * pinned, whether any is not, whether any is archived, whether any is not. These are what
   * the batch bar shows, and asking the question per-flag meant a `sessions.find` per marked
   * row per flag — four linear scans of the whole list for every marked row, on a component
   * that re-renders on every stream event. A 100-row selection was 40,000 comparisons to
   * answer four yes/no questions.
   */
  const selectionKinds = useMemo(() => {
    const archivedIds = new Set(sessions.filter((s) => s.archived).map((s) => s.sessionId));
    const kinds = { pinned: false, unpinned: false, archived: false, active: false };
    for (const id of selection.selected) {
      if (pinnedSessions.has(id)) kinds.pinned = true;
      else kinds.unpinned = true;
      if (archivedIds.has(id)) kinds.archived = true;
      else kinds.active = true;
    }
    return kinds;
  }, [selection.selected, pinnedSessions, sessions]);

  /**
   * Esc leaves selection mode, but only while the focus is inside the conversation list —
   * not while a dialog or a menu over it is open, where Esc belongs to that. Scoped to the
   * list element rather than the document so a keystroke aimed at the composer (which also
   * answers to Esc) never throws away a selection the user is one row away from finishing.
   */
  useEffect(() => {
    const list = listRef.current;
    if (list === null || !selectionMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    list.addEventListener("keydown", onKeyDown);
    return () => list.removeEventListener("keydown", onKeyDown);
  }, [selectionMode]);

  /**
   * Re-prune the selection against the rows on screen, after every commit that could have
   * changed them.
   *
   * The reducer already refuses to ADD an id the user cannot see, and the batch actions
   * re-intersect at the moment they run — so nothing here is about safety. It is about the
   * COUNT. Without this, a search query that filters the last marked row away leaves the
   * bar reading "1 selected" over a list showing none of it, and the user's next click on
   * Pin reports success having done nothing. A number that cannot be acted on is worse
   * than no number, because the bar is the only place the count is stated.
   *
   * Reading the DOM in an effect rather than during render is deliberate: the rendered set
   * is only knowable once the commit lands.
   */
  useEffect(() => {
    if (!selectionMode) return;
    const list = listRef.current;
    if (list === null) return;
    setSelection((prev) => pruneSelection(prev, visibleSessionIds()));
  });

  /**
   * The row handlers, hoisted out of `renderRows` and memoised.
   *
   * A SessionRow is memoised and its comparator deliberately compares no handlers
   * (session-row.tsx) — which is only sound because every handler below is the SAME function
   * from one render to the next, so "not compared" can never mean "stale". Five of the six
   * are setters and cost nothing to hold; the two that read state (the pin toggle, the
   * archive) are memoised on exactly what they read.
   */
  const onTogglePinRow = useCallback(
    (x: SessionInfo) => toggleSessionPin(x.sessionId),
    [toggleSessionPin],
  );
  const onRenameRow = useCallback((x: SessionInfo) => {
    setRenameError(null);
    setRenameText(x.title ?? "");
    setRenamingSession(x);
  }, []);
  const onMessagingRow = useCallback((x: SessionInfo) => setMessagingSession(x), []);
  const onDeleteRow = useCallback((x: SessionInfo) => {
    // With two or more rows marked, Delete deletes the MARKED rows — the same contract the
    // batch bar's other actions follow; a row's menu is just where the click landed. The
    // marks are read through the ref so this handler keeps its identity (see above).
    const marked = selectedInOrder(selectionRef.current, visibleSessionIds());
    if (marked.length > 1 && marked.includes(x.sessionId)) {
      setDeletingMany(marked);
      return;
    }
    setDeletingSession(x);
  }, []);
  const onToggleArchiveRow = useCallback(
    (x: SessionInfo) => void toggleArchive(x),
    [toggleArchive],
  );
  const onSelectRow = useCallback(
    (x: SessionInfo, shiftKey: boolean) => {
      setSelectionMode(true);
      applySelection(
        shiftKey ? { kind: "range", id: x.sessionId } : { kind: "toggle", id: x.sessionId },
      );
    },
    [applySelection],
  );
  /**
   * The one handler that cannot be hoisted: "Select" acts on a single row, so it closes over
   * that row's id. Cached per Session id instead of rebuilt per render, which is the same
   * closure for a given row on every render — `applySelection` and `setSelectionMode` are
   * both stable, so a cached entry can never hold a value the fresh one would not.
   */
  const selectModeHandlers = useMemo(() => {
    const cache = new Map<string, () => void>();
    return {
      get: (sessionId: string) => {
        let handler = cache.get(sessionId);
        if (handler === undefined) {
          handler = () => {
            setSelectionMode(true);
            applySelection({ kind: "only", id: sessionId });
          };
          cache.set(sessionId, handler);
        }
        return handler;
      },
    };
  }, [applySelection]);

  /** Session rows shared by both modes; withAgentHint adds a small Agent avatar per row (workspace mode, where the group no longer names the Agent). */
  const renderRows = (
    rows: SessionInfo[],
    withAgentHint: boolean,
    /** Manual sort only: the drag scope (group key) plus the group's FULL ordered active list — the drop must commit every loaded row of the partition, not the display-capped slice the user happens to see. */
    dragCtx?: { scope: string; fullRows: SessionInfo[] },
    /** Whether these rows are the group's ACTIVE list (the only rows pinning can reorder). */
    activeList = false,
  ) => (
    <ul className="space-y-0.5">
      {rows.map((s) => {
        // Manual-sort drag wiring (active lists only; never while searching — a filtered
        // view is not the real order). A drop stays within its own scope AND its own
        // pin partition: dragging can reorder but never pin or unpin.
        const dragging =
          dragCtx !== undefined && dragSession?.scope === dragCtx.scope ? dragSession : null;
        const samePartition =
          dragging !== null &&
          dragging.id !== s.sessionId &&
          pinnedSessions.has(dragging.id) === pinnedSessions.has(s.sessionId);
        const drag =
          dragCtx === undefined
            ? {}
            : {
                draggable: true,
                onDragStart: (e: ReactDragEvent) => {
                  // Firefox refuses to start a drag without payload data — but the id must
                  // NOT ride on text/plain: the composer is a controlled textarea with no
                  // drop guard, so a mis-aimed reorder would paste a session id straight
                  // into the user's message. A private type is invisible to text drops.
                  e.dataTransfer.setData(SESSION_DRAG_MIME, s.sessionId);
                  e.dataTransfer.effectAllowed = "move" as const;
                  setDragSession({ scope: dragCtx.scope, id: s.sessionId });
                },
                onDragEnd: () => {
                  setDragSession(null);
                  setDropHint(null);
                },
                onDragOver: (e: ReactDragEvent) => {
                  if (!dragging || !samePartition) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY - rect.top > rect.height / 2;
                  setDropHint((prev) =>
                    prev?.id === s.sessionId && prev.after === after
                      ? prev
                      : { id: s.sessionId, after },
                  );
                },
                onDragLeave: () => setDropHint((prev) => (prev?.id === s.sessionId ? null : prev)),
                onDrop: (e: ReactDragEvent) => {
                  if (!dragging || !samePartition) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY - rect.top > rect.height / 2;
                  // The FULL partition (every loaded row of this group on the dragged
                  // row's side of the pin boundary), not the visible slice: committing
                  // only the capped rows would drop the hidden ones out of the stored
                  // sequence, and they would come back as "newcomers" at the top.
                  const partitionIds = dragCtx.fullRows
                    .filter(
                      (r) => pinnedSessions.has(r.sessionId) === pinnedSessions.has(dragging.id),
                    )
                    .map((r) => r.sessionId);
                  commitManualDrop(partitionIds, s.sessionId, after);
                  setDragSession(null);
                  setDropHint(null);
                },
                dropEdge:
                  samePartition && dropHint?.id === s.sessionId
                    ? dropHint.after
                      ? ("below" as const)
                      : ("above" as const)
                    : null,
              };
        return (
          <SessionRow
            key={s.sessionId}
            s={s}
            active={s.sessionId === activeSessionId}
            // Busy / settled / read / never-ran, decided in one place (session-activity.ts) so
            // the whole transition sequence is testable without a DOM.
            activity={sessionRowActivity(s, sessionSeen, activeSessionId)}
            background={sessionBackgroundTasks(s)}
            scheduled={scheduledSessions.has(s.sessionId)}
            pinned={pinnedSessions.has(s.sessionId)}
            // Pinning is an ACTIVE-list priority: folder rows (subagent / scheduled /
            // archived) are ordered chronologically inside their folder and never pass
            // through orderSessionRows, so a pin there would write an id, light the
            // glyph, move nothing — and then shift the active list's drag partition.
            canPin={activeList}
            // Last ACTIVITY, not creation: the server stamps lastActiveAt when a run
            // starts and again when it ends, so a running row shows its run-start time
            // (it recedes while the run continues — the hourglass beside it is what says
            // "active right now"). CLI-adopted and subagent rows are not
            // driven by this server, so theirs stays at createdAt.
            lastActive={formatRelativeShort(s.lastActiveAt, locale)}
            {...(withAgentHint ? { agentHint: agentNameById.get(s.agentId) ?? s.agentId } : {})}
            {...drag}
            onOpen={openSession}
            onTogglePin={onTogglePinRow}
            onRename={onRenameRow}
            onMessaging={onMessagingRow}
            onDelete={onDeleteRow}
            onToggleArchive={onToggleArchiveRow}
            // Selection mode: the row stops being a link and becomes a checkbox, and the
            // modifier-click that enters the mode is what the user's Cmd/Ctrl habit already
            // does elsewhere (open in a new tab, select text) — no new gesture to learn.
            selecting={selectionMode}
            selected={selection.selected.has(s.sessionId)}
            onSelect={onSelectRow}
            onSelectMode={selectModeHandlers.get(s.sessionId)}
          />
        );
      })}
    </ul>
  );

  /**
   * Collapsed-by-default lazy folder (subagent / scheduled / archived): nothing is
   * fetched until the first expand, and once open the folder pages independently with
   * its own "More" row. Everything is driven by the group's **own** exact server share
   * (`totals` — the Agent's counts in agent mode, the per-Workspace fold in workspace
   * mode): the folder exists only while its share is non-zero, the label shows that
   * share, and "More" shows only while loaded rows fall short of it — an Agent's
   * content in *other* Workspaces can never surface a folder here. The folder's "More"
   * pages independently of the active list's; in workspace mode a fetched page can land
   * rows in other groups' folders too, so one click may grow this folder by fewer than
   * a full page — the row shows a loading state while the fetch runs and stays until
   * this group's share is fully loaded.
   */
  const renderFolder = (
    groupKey: string,
    category: FolderCategory,
    parts: SessionPartition,
    withAgentHint: boolean,
    /** Agents that may hold this group's rows of this category (fetch fan-out set). */
    agentIds: string[],
    totals: SessionCategoryCounts | undefined,
  ) => {
    const rows = parts[category];
    // While searching the folder speaks for its loaded MATCHES only: a match hidden
    // behind a collapsed folder would look like a missing result (the models page's
    // search-forces-open rationale), so the folder is forced open, labelled by the
    // match count, hidden when nothing matches, and never offers "More" (the server
    // cannot search unloaded rows).
    if (searching && rows.length === 0) return null;
    // Loaded rows win a disagreement with the totals (counts refresh only on reload).
    const total = searching ? rows.length : Math.max(totals?.[category] ?? 0, rows.length);
    if (total === 0) return null;
    // More while the group's share isn't fully loaded AND somewhere is left to fetch from
    // (counts drifting above reality would otherwise leave a dead button until reload).
    const more =
      !searching &&
      rows.length < total &&
      agentIds.some((id) => hasMoreFor(id, category, fetchScope(groupKey)));
    return (
      <FolderSection
        key={category}
        label={S.chat.folderGroups[category](total)}
        open={searching || openFolders.has(folderKey(groupKey, category))}
        onToggle={() => toggleFolder(groupKey, category, agentIds)}
        more={more}
        // The folder shows every row it has loaded, so its remainder is its own share
        // minus those — the same count the active list's reveal row names one level up.
        moreLabel={S.chat.expandRestSessions(Math.max(total - rows.length, 0))}
        pending={pendingLoads.has(loadKey(groupKey, category))}
        onMore={() => trackedLoadMore(groupKey, category, agentIds)}
      >
        {renderRows(rows, withAgentHint)}
      </FolderSection>
    );
  };

  /**
   * Active-list "Show N more chats": reveal one more page of this group's already-loaded
   * active rows, and fetch the next active server page only when the reveal actually runs
   * past what is loaded. A group whose next page is already in memory spends no request —
   * in workspace mode a fetch fans out to every Agent contributing to the group and its
   * rows may land in other groups entirely, so a pointless one is not free.
   */
  const showMore = (groupKey: string, agentIds: string[], loaded: number) => {
    const nextCap = (groupCaps.get(groupKey) ?? SIDEBAR_PAGE_SIZE) + SIDEBAR_PAGE_SIZE;
    setGroupCaps((prev) => {
      const next = new Map(prev);
      next.set(groupKey, nextCap);
      return next;
    });
    if (agentIds.length > 0 && loaded < nextCap) trackedLoadMore(groupKey, "active", agentIds);
  };

  /** "Show less": drop one group's reveal back to the first page (rows already fetched stay in memory). */
  const collapseRows = (groupKey: string) => {
    setGroupCaps((prev) => {
      if (!prev.has(groupKey)) return prev;
      const next = new Map(prev);
      next.delete(groupKey);
      return next;
    });
  };

  /**
   * Expanded group body shared by both modes: active user rows (display-capped; "More"
   * reveals and loads further **active-only** pages — the folders below never feed it) +
   * the collapsed-by-default subagent / scheduled / archived folders, each loading on
   * first expand and paging on its own. `totals` / `agentsFor` carry the group's exact
   * server share and its fetch fan-out set per category.
   */
  const renderGroupBody = (
    groupKey: string,
    parts: SessionPartition,
    withAgentHint: boolean,
    totals: SessionCategoryCounts | undefined,
    agentsFor: (category: SessionCategory) => string[],
  ) => {
    const cap = groupCaps.get(groupKey) ?? SIDEBAR_PAGE_SIZE;
    // Row order: the pinned cluster first, then — under manual sort — the stored order
    // within each pin partition (lib/session-order.ts). Both reorder only rows already
    // FETCHED: a pinned conversation that lives past the loaded pages does not surface
    // until "More" pulls its page in (the list has no server-side pin), so the pinned
    // cluster leads what is loaded, not the Agent's whole history. Folder rows keep
    // their chronological order: pinning and manual order are active-list concerns.
    // While searching, the display cap is bypassed — every loaded match shows, and
    // "More" hides (it pages the unfiltered list and would read as "more matches",
    // which the server cannot promise).
    const orderedActive = orderSessionRows(parts.active, (s) => s.sessionId, {
      pinned: pinnedSessions,
      sortMode: effectiveSortMode,
      order: sessionOrder,
      recencyOf: (s) => s.lastActiveAt,
    });
    const shownActive = searching ? orderedActive : orderedActive.slice(0, cap);
    /** Manual sort only (never on a search-filtered view): drag scope + the group's full ordered list, so a drop commits the whole partition. */
    const dragCtx =
      effectiveSortMode === "manual" && !searching
        ? { scope: groupKey, fullRows: orderedActive }
        : undefined;
    // The reveal row counts THIS group's own hidden conversations and nothing else — the
    // folders never feed it, and no other group's numbers reach it. `fullyLoaded` says the
    // group's whole active share is already in memory (every Agent that could hold a row of
    // it is fetched out), which is when the loaded rows become the truth: server counts
    // refresh only on reload, so a count drifting above reality would otherwise leave a row
    // that reveals nothing behind it.
    const activeAgents = agentsFor("active");
    const fullyLoaded =
      activeAgents.length > 0 &&
      !activeAgents.some((id) => hasMoreFor(id, "active", fetchScope(groupKey)));
    const hiddenActive = searching
      ? 0
      : hiddenRowCount({
          shown: shownActive.length,
          loaded: parts.active.length,
          total: totals?.active ?? 0,
          fullyLoaded,
        });
    // "Show less" appears once the group is revealed past its first page and there is
    // something for it to hide again.
    const canCollapse =
      !searching && cap > SIDEBAR_PAGE_SIZE && parts.active.length > SIDEBAR_PAGE_SIZE;
    const folders = FOLDER_CATEGORIES.map((category) =>
      renderFolder(groupKey, category, parts, withAgentHint, agentsFor(category), totals),
    );
    const empty = parts.active.length === 0 && folders.every((f) => f === null);
    const activePending = pendingLoads.has(loadKey(groupKey, "active"));
    // Rows the server counts that no page has loaded yet — a Workspace group known from
    // the counts alone while its own first page is on its way (or, after a failed fetch,
    // waiting on the reveal row below to be asked for again). Not "no conversations".
    const awaitingRows = !searching && parts.active.length === 0 && hiddenActive > 0;
    return (
      <>
        {empty ? (
          loading || (awaitingRows && activePending) ? (
            // The same window the chat pane's skeleton covers: the Agent groups render as
            // soon as the Agents arrive, but the session pages are still being fetched —
            // "no Sessions yet" is not the honest answer until they land.
            <SkeletonList rows={2} />
          ) : awaitingRows ? null : (
            <p className="px-2.5 py-1 text-xs text-gray-500 dark:text-gray-600">
              {S.chat.noSessions}
            </p>
          )
        ) : (
          // Drag-reorder is offered on the active list under manual sort (folders keep
          // chronological order), and never on a search-filtered view.
          renderRows(shownActive, withAgentHint, dragCtx, true)
        )}

        {/* Reveal / collapse this group's own conversations (kept adjacent to the active
            list they extend, above the folders). Both rows can stand at once: a group
            revealed part-way still has more to show AND something to fold back. */}
        {hiddenActive > 0 && (
          <MoreRow
            label={S.chat.expandRestSessions(hiddenActive)}
            ariaLabel={S.chat.expandRestSessions(hiddenActive)}
            pending={activePending}
            onClick={() => showMore(groupKey, activeAgents, parts.active.length)}
            className="mt-0.5"
          />
        )}
        {canCollapse && (
          <MoreRow
            label={S.chat.showLess}
            ariaLabel={S.chat.showLess}
            onClick={() => collapseRows(groupKey)}
            {...(hiddenActive > 0 ? {} : { className: "mt-0.5" })}
          />
        )}

        {/* Folders (collapsed by default): subagent — spawned from the conversations at hand
            — then scheduled background runs, then archived (archived wins over the origin
            folders). */}
        {folders}
      </>
    );
  };

  /**
   * Time mode's one shared, Project-wide set of folders (rendered once below the buckets):
   * their rows load only on first expand, so an unloaded Session has no known bucket and no
   * bucket could honestly claim a share of them. Counts and fetch fan-out are summed over
   * every Agent. A null entry means the Project holds no rows of that category at all —
   * which is also what tells the empty-list line whether it is telling the truth.
   */
  const timeFolders =
    timeParts === null
      ? []
      : FOLDER_CATEGORIES.map((category) =>
          renderFolder(
            TIME_FOLDERS_GROUP_KEY,
            category,
            timeParts,
            true,
            projectAgentsFor(category),
            projectCounts,
          ),
        );

  /**
   * Page entries, driven by the manifest minus entries this user's role cannot reach. Company
   * mode: the organization's six pages (COMPANY_NAV_KEYS) — channels are not among them,
   * they are the list below. Always mounted — the collapse animates their height to zero and
   * turns them inert.
   */
  const navItems: Array<{
    key: string;
    /** Where the row leads — null for a row with nowhere to lead, which renders disabled. */
    to: string | null;
    label: string;
    icon: string;
    note: string | null;
  }> = inCompany
    ? COMPANY_NAV_KEYS.map((key) => ({
        key,
        // Company mode with no organization keeps its six rows and disables them: the pages
        // exist, they just have no organization to show yet, and a nav that empties itself
        // reads as a broken shell rather than as an empty one.
        to: navOrg === null ? null : orgPagePath(navOrg.projectId, navOrg.orgId, key),
        label: S.nav.org[key],
        icon: COMPANY_NAV_ICONS[key],
        note: null,
      }))
    : navKeysFor(user?.isAdmin === true).map((key) => {
        const path = navPathFor(key);
        return {
          key,
          to: path,
          label: S.nav[key],
          icon: NAV_ICONS[key],
          note: navNoteFor(badges, path),
        };
      });

  return (
    <div className="flex h-full w-full flex-col">
      {/* The work-mode switch, above the Project switcher: Dev | Company. Rendered only while
          company mode is available (the admin master switch and the user's own switch both
          on); the choice persists per user. */}
      {company.available && (
        <div className="shrink-0 px-2 pt-2" role="group" aria-label={S.company.workMode}>
          <Segmented
            options={[
              { value: "dev" as const, label: S.company.modeDev },
              { value: "company" as const, label: S.company.modeCompany },
            ]}
            value={company.workMode}
            onChange={switchMode}
            cols={2}
          />
        </div>
      )}
      {/* Project switcher (+ collapse sidebar); the organization switcher in company mode */}
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        {onCollapse && (
          <button
            type="button"
            title={S.nav.collapseSidebar}
            aria-label={S.nav.collapseSidebar}
            onClick={onCollapse}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Icon d="M15 6l-6 6 6 6M4 4v16" size={18} />
          </button>
        )}
        {inCompany ? (
          <OrgSwitcher {...(onNavigate ? { onNavigate } : {})} />
        ) : (
          <Dropdown
            open={projectOpen}
            setOpen={setProjectOpen}
            className="min-w-0 flex-1"
            menuClass="left-0 right-0 top-full mt-1 origin-top"
            button={
              <button
                type="button"
                onClick={() => setProjectOpen(!projectOpen)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-base font-semibold transition-colors duration-150 hover:bg-gray-200/70 dark:hover:bg-gray-800"
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {currentProject ? projectDisplayName(currentProject) : S.common.loading}
                </span>
                <span className="text-gray-500">
                  <ChevronDown />
                </span>
              </button>
            }
          >
            {projects.map((p) => (
              <button
                key={p.projectId}
                type="button"
                onClick={() => {
                  setCurrentProjectId(p.projectId);
                  setProjectOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-gray-100 dark:hover:bg-gray-800 ${
                  p.projectId === currentProject?.projectId ? "font-semibold" : ""
                }`}
              >
                <span className="truncate">{projectDisplayName(p)}</span>
                <Badge tone="gray">{p.role}</Badge>
              </button>
            ))}
            <div className="mt-1.5 border-t border-gray-100 pt-1.5 dark:border-gray-800">
              <button
                type="button"
                className={menuItemClass}
                onClick={() => {
                  setProjectOpen(false);
                  setCreateProjectOpen(true);
                }}
              >
                + {S.project.create}
              </button>
              {currentProject && (
                <button
                  type="button"
                  className={menuItemClass}
                  onClick={() => {
                    setProjectOpen(false);
                    setProjectSettingsOpen(true);
                  }}
                >
                  {S.project.settings}
                </button>
              )}
            </div>
          </Dropdown>
        )}
      </div>

      {/* New chat: a prominent, theme-accent primary action pinned below the Project switcher.
          The gap to the scroll area below is this block's OWN pb-2, not padding inside the
          scroller: padding-top there belongs to the scrollable content and slides away with
          it, so a scrolled nav entry ended up flush against this pinned button, the two
          labels touching. Outside the scroller the 8px stays put at every scroll offset —
          the same text-to-text rhythm two adjacent nav rows have. */}
      {/* Company mode pins nothing here: a channel is made rarely, so "New channel" is the
          channel list's own header action rather than a permanent row (channel-sidebar.tsx).
          The slot still holds its 8px, which is the gap the scroll area below depends on. */}
      {inCompany ? (
        <div className="shrink-0 pb-2" />
      ) : (
        <div className="shrink-0 px-2 pb-2 pt-2">
          <Button
            variant="primary"
            onClick={() => newChat(defaultAgentId)}
            className="min-h-10 w-full justify-start gap-2 px-2.5 max-md:min-h-11"
          >
            <Icon d={NEW_CHAT_ICON} />
            {S.chat.newSessionMenu}
          </Button>
        </div>
      )}

      {/* Scroll area: the page nav and the session list scroll together, so the nav rides up
          as the list is scrolled. It is the sidebar's only shrinkable block — with the nav
          pinned, the column's fixed height (Project switcher + New chat + eight nav entries +
          user row ≈ 412px) exceeded a short window, and the overflow, clipped by nothing,
          grew the document into a second scrollbar.
          relative: the scroller acts as its own containing block, so absolute descendants
          (each row's sr-only Agent name) anchor and scroll inside it — anchored to the
          initial containing block instead, rows past the fold would bypass this
          overflow-y-auto and stretch the **document**, so expanding "More" / a source
          folder made the whole page scroll (composer pushed up, blank space below). */}
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!inCompany ? (
          <ProductNavigation
            items={navItems}
            collapsed={navCollapsed}
            onToggleCollapse={toggleNavGroup}
            {...(onNavigate ? { onNavigate } : {})}
          />
        ) : (
          <nav aria-label={S.nav.navigation} className="space-y-0.5">
            <NavGroupCollapse collapsed={navCollapsed} onToggle={toggleNavGroup}>
              {navItems.map((item) => {
                /* Four nav entries sit on a badge trail — Agents (an outdated kernel, fixed on
                     the Agent settings page two clicks down), Skills, Models and the Cost Center
                     (each cleared on the page itself). The dot is anchored to the row, not to the
                     label text (where it would float over whatever follows the word): at the
                     row's right edge, on the same inset as its horizontal padding, and vertically
                     centred on the row rather than on the line of text. */
                const note = item.note;
                if (item.to === null) {
                  /* Nowhere to go: the row keeps its place and its glyph, muted, with no
                       hover fill and nothing to click or tab to. */
                  return (
                    <span
                      key={item.key}
                      role="link"
                      aria-disabled="true"
                      className="relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-gray-500 dark:text-gray-600"
                    >
                      <span className="text-gray-300 dark:text-gray-700">
                        <Icon d={item.icon} />
                      </span>
                      {item.label}
                    </span>
                  );
                }
                return (
                  <NavLink
                    key={item.key}
                    to={item.to}
                    onClick={() => onNavigate?.()}
                    {...(note !== null
                      ? {
                          // The row's own label is visible, so the tooltip only adds what
                          // the dot means; the accessible name keeps that label as its
                          // prefix. (The collapsed rail's icon-only twin has no visible
                          // label, so its tooltip carries both.)
                          title: note,
                          "aria-label": `${item.label} · ${note}`,
                        }
                      : {})}
                    className={({ isActive }) =>
                      `relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                        isActive
                          ? "bg-gray-200/70 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                          : "text-gray-600 hover:bg-gray-200/50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-200"
                      }`
                    }
                  >
                    <span className="text-gray-500 dark:text-gray-400">
                      <Icon d={item.icon} />
                    </span>
                    {item.label}
                    {note !== null && (
                      <UpdateDot size="inline" position="right-2.5 top-1/2 -translate-y-1/2" />
                    )}
                  </NavLink>
                );
              })}
            </NavGroupCollapse>
          </nav>
        )}

        {inCompany ? (
          navOrg !== null ? (
            /* Company mode: the organization's channels, where development mode lists
               conversations, and below them its own two groups — one row per employee's
               desk, and the sessions attached to tickets. */
            <>
              <ChannelSidebar
                projectId={navOrg.projectId}
                orgId={navOrg.orgId}
                {...(onNavigate ? { onNavigate } : {})}
              />
              <OrgSessionGroups
                projectId={navOrg.projectId}
                orgId={navOrg.orgId}
                activeSessionId={activeSessionId}
                {...(onNavigate ? { onNavigate } : {})}
              />
            </>
          ) : (
            /* No organization to list: the create block, not an empty channel list. */
            <NoOrganizationsSidebar {...(onNavigate ? { onNavigate } : {})} />
          )
        ) : (
          <>
            {/* Section header: list label + right-aligned controls (icon + tooltip family):
            search, list settings (grouping + sort radios — the old inline grouping
            toggle relocated into this menu), and the mode-dependent create button (the
            created object follows the grouping mode). The search is a mac-style
            IN-PLACE expansion — no extra row: the two grid columns tween (the 0fr/1fr
            trick, horizontal), the label's column collapsing while the controls column
            takes the full width and the field inside grows leftward over the label's
            place; the magnifier morphs from toggle button into the field's leading
            glyph. No ruled separator at this boundary — see the nav toggle above. */}
            <div
              className={`mt-3 grid items-center px-1 pt-2 transition-[grid-template-columns] duration-200 ease-out ${
                searchOpen ? "grid-cols-[0fr_1fr]" : "grid-cols-[1fr_1fr]"
              }`}
            >
              <span
                className={`min-w-0 overflow-hidden whitespace-nowrap px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 transition-opacity duration-200 dark:text-gray-400 ${
                  searchOpen ? "opacity-0" : "opacity-100"
                }`}
              >
                {S.chat.sessionList}
              </span>
              <div className="flex min-w-0 items-center justify-end gap-0.5">
                {searchOpen ? (
                  /* Expanded field: leading magnifier glyph + input + clear ×, one bordered
                 box filling the row (its width rides the column tween). Esc and × both
                 collapse it and drop the filter. */
                  <div className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 transition-colors duration-150 focus-within:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-gray-500">
                    <span aria-hidden className="shrink-0 text-gray-400 dark:text-gray-500">
                      <Icon d={SEARCH_ICON} size={12} />
                    </span>
                    <input
                      autoFocus
                      value={searchQuery}
                      placeholder={S.chat.searchSessionsPlaceholder}
                      aria-label={S.chat.searchSessions}
                      {...noAutofill}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          closeSearch();
                        }
                      }}
                      className="min-w-0 flex-1 bg-transparent text-xs text-gray-700 placeholder:text-gray-500 focus:outline-none dark:text-gray-200 dark:placeholder:text-gray-400"
                    />
                    <button
                      type="button"
                      title={S.chat.searchClear}
                      aria-label={S.chat.searchClear}
                      onClick={closeSearch}
                      className="flex h-4 w-4 shrink-0 items-center justify-center text-gray-500 transition-colors duration-150 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      <Icon d={CLOSE_ICON} size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    title={S.chat.searchSessions}
                    aria-label={S.chat.searchSessions}
                    onClick={() => setSearchOpen(true)}
                    className={headerControlClass(false)}
                  >
                    <Icon d={SEARCH_ICON} size={14} />
                  </button>
                )}
                <Dropdown
                  open={listSettingsOpen}
                  setOpen={setListSettingsOpen}
                  portal={{ direction: "down", align: "right" }}
                  menuClass="w-40"
                  button={
                    <button
                      type="button"
                      title={S.chat.listSettings}
                      aria-label={S.chat.listSettings}
                      aria-haspopup="menu"
                      aria-expanded={listSettingsOpen}
                      onClick={() => setListSettingsOpen(!listSettingsOpen)}
                      className={headerControlClass(listSettingsOpen)}
                    >
                      <Icon d={SLIDERS_ICON} size={14} />
                    </button>
                  }
                >
                  <p className={menuSectionClass}>{S.chat.groupModeSection}</p>
                  <MenuRadioRow
                    icon={GROUP_MODE_ICONS.workspace}
                    label={S.chat.groupByWorkspace}
                    checked={groupMode === "workspace"}
                    onSelect={() => {
                      setGroupMode("workspace");
                      setListSettingsOpen(false);
                    }}
                  />
                  <MenuRadioRow
                    icon={GROUP_MODE_ICONS.agent}
                    label={S.chat.groupByAgent}
                    checked={groupMode === "agent"}
                    onSelect={() => {
                      setGroupMode("agent");
                      setListSettingsOpen(false);
                    }}
                  />
                  <MenuRadioRow
                    icon={GROUP_MODE_ICONS.time}
                    label={S.chat.groupByTime}
                    checked={groupMode === "time"}
                    onSelect={() => {
                      setGroupMode("time");
                      setListSettingsOpen(false);
                    }}
                  />
                  <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
                  <p className={menuSectionClass}>{S.chat.sortModeSection}</p>
                  {/* Manual order is offered only where a drag can actually happen (see canDrag). */}
                  {canDrag && (
                    <MenuRadioRow
                      icon={SORT_MODE_ICONS.manual}
                      label={S.chat.sortManual}
                      checked={sortMode === "manual"}
                      onSelect={() => {
                        setSortMode("manual");
                        setListSettingsOpen(false);
                      }}
                    />
                  )}
                  <MenuRadioRow
                    icon={SORT_MODE_ICONS.recent}
                    label={S.chat.sortRecent}
                    checked={sortMode === "recent"}
                    onSelect={() => {
                      setSortMode("recent");
                      setListSettingsOpen(false);
                    }}
                  />
                </Dropdown>
                {/* Mode-dependent create — specific entity created depends on grouping mode, the icon following
                suit (folder+ / robot+, a bottom-right plus badge on the entity's glyph):
                agent grouping opens the Agents page's existing create dialog (route
                state); workspace grouping opens the SAME directory-browse menu the
                draft's workspace picker uses — the picked directory registers as a
                workspace group immediately, Sessions or not. Time buckets are not
                something to create into, so that mode starts a plain new conversation
                and wears the compose glyph without a plus badge. */}
                {newEntity === "agent" ? (
                  <button
                    type="button"
                    title={newEntityLabel}
                    aria-label={newEntityLabel}
                    onClick={() => {
                      navigate("/agents", { state: { create: true } });
                      onNavigate?.();
                    }}
                    className={headerControlClass(false)}
                  >
                    <AddBadgeIcon base={NAV_ICONS.agents} />
                  </button>
                ) : newEntity === "chat" ? (
                  <button
                    type="button"
                    title={newEntityLabel}
                    aria-label={newEntityLabel}
                    onClick={() => newChat()}
                    className={headerControlClass(false)}
                  >
                    <Icon d={NEW_CHAT_ICON} size={ICON_SIZE.iconButton} />
                  </button>
                ) : (
                  <WorkspaceSelect
                    // Remount per Project: the picker browses lazily and caches the listing
                    // for its lifetime, so a long-lived instance would show the PREVIOUS
                    // Project's directories after a switch — and register that path into the
                    // new Project's registry.
                    key={currentProjectId ?? "no-project"}
                    projectId={currentProjectId ?? ""}
                    workspace=""
                    onChange={addWorkspace}
                    trigger={(open, toggle) => (
                      <button
                        type="button"
                        title={newEntityLabel}
                        aria-label={newEntityLabel}
                        aria-expanded={open}
                        onClick={toggle}
                        className={headerControlClass(open)}
                      >
                        <AddBadgeIcon base={FOLDER_ICON} />
                      </button>
                    )}
                  />
                )}
              </div>
            </div>

            {/* Selection bar: its own row under the section header, so the header's search
                and list-settings controls stay reachable while a selection is live (a user
                who starts marking and then wants to narrow the list has to be able to reach
                the search). The count is the number of rows actually marked AND still on
                screen — the reducer prunes on every interaction, so this number and the
                actions below it always describe one and the same set. */}
            {selectionMode && (
              <SelectionBar
                count={selection.selected.size}
                anyPinned={selectionKinds.pinned}
                anyUnpinned={selectionKinds.unpinned}
                anyArchived={selectionKinds.archived}
                anyActive={selectionKinds.active}
                onPin={() => batchPin(true)}
                onUnpin={() => batchPin(false)}
                onArchive={() => void batchArchive(true)}
                onUnarchive={() => void batchArchive(false)}
                onDelete={() => setDeletingMany(selectedIds())}
                onClear={clearSelection}
              />
            )}

            {/* Parked draft conversations (unsent new chats, newest first): pinned above both
            grouping modes — they belong to no Agent or Workspace until sent. Hidden
            entirely while there are none; the search filter applies to their titles too. */}
            {shownDrafts.length > 0 && (
              <div className="pt-2.5">
                <GroupHeader
                  open={searching || !collapsedGroups.has(DRAFTS_GROUP_KEY)}
                  onToggle={() => toggleGroup(DRAFTS_GROUP_KEY)}
                  icon={
                    <span className="shrink-0 text-gray-500 dark:text-gray-400">
                      <Icon d={NEW_CHAT_ICON} size={ICON_SIZE.groupHeaderGlyph} />
                    </span>
                  }
                  label={S.chat.draftGroup}
                  uppercase
                  count={shownDrafts.length}
                />
                {(searching || !collapsedGroups.has(DRAFTS_GROUP_KEY)) && (
                  <ul className="space-y-0.5">
                    {shownDrafts.map((entry) => (
                      <DraftRow
                        key={entry.id}
                        entry={entry}
                        active={entry.id === activeSessionId}
                        onOpen={() => go(`/chat/${entry.id}`)}
                        onDelete={() => setDeletingDraft(entry)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {groupMode === "agent" ? (
              loading && agents.length === 0 ? (
                <SkeletonList rows={5} />
              ) : (
                // While searching: every group renders (paging bypassed), zero-match groups
                // hide, and the rest are forced open — a hit inside a collapsed group would
                // look like a missing result.
                groupsOnPage(orderedAgents).map((agent) => {
                  const groupRows = filterRows(byAgent.get(agent.agentId) ?? []);
                  if (searching && groupRows.length === 0) return null;
                  const parts = partitionSessions(groupRows);
                  const collapsed = !searching && collapsedGroups.has(agent.agentId);
                  const pinned = pinnedGroups.has(agent.agentId);
                  const drag = groupDragProps(agent.agentId, agentGroupSequence);
                  return (
                    <GroupBlock key={agent.agentId} dropEdge={drag.dropEdge}>
                      {/* Group header: collapse toggle (Agent name) + pin + new chat + Agent settings; also the group's drag handle. */}
                      <GroupHeader
                        {...drag.header}
                        open={!collapsed}
                        onToggle={() => toggleGroup(agent.agentId)}
                        icon={
                          <AgentAvatar
                            id={agent.agentId}
                            name={agentDisplayName(agent)}
                            size={18}
                            className="shrink-0 rounded"
                          />
                        }
                        label={agentDisplayName(agent)}
                        uppercase
                        actions={
                          <>
                            <GroupPinButton
                              pinned={pinned}
                              onToggle={() => togglePin(agent.agentId)}
                            />
                            {/* New chat: enters draft state directly with this group's Agent (all options live on the draft input card) */}
                            <button
                              type="button"
                              title={S.chat.newSessionMenu}
                              aria-label={S.chat.newSessionMenu}
                              onClick={() => newChat(agent.agentId)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                            >
                              <Icon d="M12 5v14M5 12h14" size={ICON_SIZE.groupHeaderAction} />
                            </button>
                            <button
                              type="button"
                              title={S.agent.settings}
                              onClick={() => go(`/agents/${agent.agentId}`)}
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                            >
                              <Icon d={GEAR_ICON} size={ICON_SIZE.groupHeaderAction} />
                            </button>
                          </>
                        }
                      />

                      {collapsed
                        ? null
                        : renderGroupBody(
                            agent.agentId,
                            parts,
                            false,
                            countsByAgent.get(agent.agentId),
                            () => [agent.agentId],
                          )}
                    </GroupBlock>
                  );
                })
              )
            ) : null}
            {groupMode === "agent" ? groupPagerRow() : null}
            {groupMode !== "workspace" ? null : loading && sessions.length === 0 ? (
              <SkeletonList rows={5} />
            ) : orderedWorkspaceGroups.length === 0 && !searching ? (
              <p className="px-2.5 pt-3 text-xs text-gray-500 dark:text-gray-600">
                {S.chat.noSessions}
              </p>
            ) : (
              // Same search treatment as agent mode: paging bypassed, zero-match groups hidden, the rest forced open.
              groupsOnPage(orderedWorkspaceGroups).map((group) => {
                const groupRows = filterRows(group.sessions);
                if (searching && groupRows.length === 0) return null;
                const parts = partitionSessions(groupRows);
                const collapsed = !searching && collapsedGroups.has(group.key);
                const pinned = pinnedGroups.has(group.key);
                const drag = groupDragProps(group.key, workspaceGroupSequence);
                /** This group's exact server share (per-Workspace fold) and its per-category fetch fan-out. */
                const counts = workspaceGroupCounts.get(group.key);
                const contributingAgents = [...new Set(group.sessions.map((s) => s.agentId))];
                const agentsFor = (category: SessionCategory) => [
                  ...new Set([...(counts?.agents[category] ?? []), ...contributingAgents]),
                ];
                return (
                  <GroupBlock key={group.key} dropEdge={drag.dropEdge}>
                    {/* Group header: collapse toggle (folder icon + directory basename + count, full
                    path in the tooltip; the count = the group's active conversations only, exact
                    server share, loaded rows win a disagreement — the folders never feed it) +
                    pin + new chat in this Workspace; also the group's drag handle. */}
                    <GroupHeader
                      {...drag.header}
                      open={!collapsed}
                      onToggle={() => toggleGroup(group.key)}
                      icon={
                        /* Folder opens and closes with the group */
                        <span className="shrink-0 text-gray-500 dark:text-gray-400">
                          <Icon
                            d={collapsed ? FOLDER_ICON : FOLDER_OPEN_ICON}
                            size={ICON_SIZE.groupHeaderGlyph}
                          />
                        </span>
                      }
                      label={group.temp ? S.chat.tempWorkspaces : group.label}
                      count={
                        searching
                          ? parts.active.length
                          : Math.max(counts?.totals.active ?? 0, parts.active.length)
                      }
                      {...(group.fullPath !== null ? { title: group.fullPath } : {})}
                      actions={
                        <>
                          <GroupPinButton pinned={pinned} onToggle={() => togglePin(group.key)} />
                          {/* New chat in this Workspace: pre-fills the group's path in the draft ("" = temporary workspace); the Agent is the current one, falling back to default_agent */}
                          <button
                            type="button"
                            title={S.chat.newSessionInWorkspace}
                            aria-label={S.chat.newSessionInWorkspace}
                            onClick={() => newChat(workspaceNewChatAgentId, group.fullPath ?? "")}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 hover:bg-gray-200/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                          >
                            <Icon d="M12 5v14M5 12h14" size={ICON_SIZE.groupHeaderAction} />
                          </button>
                          {/* Manually-added (registry-backed) Workspaces only: rename-alias /
                            remove-from-sidebar overflow, to the right of the "+" (session-
                            derived groups have no registry entry for these to act on). */}
                          {registeredPaths.has(group.key) && (
                            <GroupOverflowMenu
                              onRename={() => openRenameWorkspace(group.key)}
                              onDelete={() =>
                                setDeletingWorkspace({ path: group.key, label: group.label })
                              }
                            />
                          )}
                        </>
                      }
                    />

                    {/* A workspace group can span Agents: the group body fans folder loads and "More"
                    out per category to the Agents whose share of THIS group is non-zero (plus the
                    Agents already contributing loaded rows) — the active list and each folder
                    page independently. */}
                    {collapsed
                      ? null
                      : renderGroupBody(group.key, parts, true, counts?.totals, agentsFor)}
                  </GroupBlock>
                );
              })
            )}
            {groupMode === "workspace" ? groupPagerRow() : null}

            {/* Time mode: last day / last month / earlier, bucketed on each conversation's last
            activity — the same stamp the rows' compact timestamps and the recency sort read,
            so a row can never sit under a bucket its own timestamp contradicts. Empty buckets
            are dropped, and there are at most three, so this mode never paginates its groups.
            The buckets span every Agent and every Workspace: a bucket's "More" only reveals
            further loaded rows, while fetching the next page and reaching the Subagents /
            Scheduled / Archived rows happen once for the whole Project, below. */}
            {groupMode !== "time" || timeParts === null ? null : loading &&
              sessions.length === 0 ? (
              <SkeletonList rows={5} />
            ) : (
              <>
                {timeGroups.map((group) => {
                  const collapsed = !searching && collapsedGroups.has(group.key);
                  return (
                    <div key={group.key} className="pt-2.5">
                      <GroupHeader
                        open={!collapsed}
                        onToggle={() => toggleGroup(group.key)}
                        icon={
                          <span className="shrink-0 text-gray-500 dark:text-gray-400">
                            <Icon d={GROUP_MODE_ICONS.time} size={ICON_SIZE.groupHeaderGlyph} />
                          </span>
                        }
                        label={S.chat.timeGroups[group.bucket]}
                        uppercase
                        count={group.sessions.length}
                      />
                      {collapsed
                        ? null
                        : renderGroupBody(
                            group.key,
                            bucketPartition(group.sessions),
                            true,
                            undefined,
                            () => [],
                          )}
                    </div>
                  );
                })}

                {/* Empty only when the shared folders below are empty too (renderGroupBody's own
                rule): "no Sessions yet" over an "Archived (3)" row would contradict it. */}
                {timeGroups.length === 0 && !searching && timeFolders.every((f) => f === null) && (
                  <p className="px-2.5 pt-3 text-xs text-gray-500 dark:text-gray-600">
                    {S.chat.noSessions}
                  </p>
                )}

                {/* Whole-list paging: a fetched page lands in whichever bucket its rows' activity
                puts them, so the row that pulls one belongs to the list, not to a bucket —
                and its label says "conversations" where a bucket's says "more". */}
                {!searching &&
                  timeParts.active.length < projectCounts.active &&
                  timeMoreAgents.length > 0 && (
                    <MoreRow
                      label={S.chat.loadMoreSessions}
                      ariaLabel={S.chat.loadMoreSessions}
                      pending={pendingLoads.has(loadKey(TIME_FOLDERS_GROUP_KEY, "active"))}
                      onClick={() =>
                        trackedLoadMore(TIME_FOLDERS_GROUP_KEY, "active", timeMoreAgents)
                      }
                      className="mt-1"
                    />
                  )}

                {/* The shared, Project-wide folders (see timeFolders). */}
                <div className="pt-2.5">{timeFolders}</div>
              </>
            )}

            {/* Quiet no-match line: the search is live and nothing — drafts included — hit. */}
            {searching && !hasSearchMatches && (
              <p className="px-2.5 pt-3 text-xs text-gray-500 dark:text-gray-600">
                {S.chat.searchNoMatches}
              </p>
            )}
          </>
        )}
      </div>

      {/* Bottom user row: the trigger for the account menu both this sidebar and the
          collapsed rail open (user-menu.tsx). */}
      <div className="shrink-0 border-t border-gray-200 p-2 dark:border-gray-800">
        <UserMenu
          menuClass="bottom-full left-0 right-0 mb-1 origin-bottom"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              {...(badges.softwareNote !== null
                ? {
                    // The dot alone is mysterious: name what is waiting on the trigger (hover
                    // tooltip + accessible name), in the update row's own wording.
                    title: badges.softwareNote,
                    "aria-label": `${user?.userId ?? ""} · ${badges.softwareNote}`,
                  }
                : {})}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-gray-200/70 dark:hover:bg-gray-800"
            >
              <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-xs font-bold text-white dark:bg-gray-200 dark:text-gray-900">
                {(user?.userId ?? "?").slice(0, 1).toUpperCase()}
                {/* Update reminder: the menu behind this trigger holds the row that acts on
                    it, and the trigger's tooltip/label above say what it is. */}
                {badges.software !== null && <UpdateDot />}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{user?.userId}</span>
              {user?.isAdmin && (
                <span className="text-xs text-gray-500 dark:text-gray-400">{S.auth.admin}</span>
              )}
            </button>
          )}
        />
      </div>

      <CreateProjectDialog
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onCreated={(projectId) => {
          setCreateProjectOpen(false);
          void reloadProjects().then(() => setCurrentProjectId(projectId));
        }}
      />
      {currentProject && (
        <ProjectSettingsDialog
          open={projectSettingsOpen}
          onClose={() => setProjectSettingsOpen(false)}
        />
      )}
      {/* Rename chat */}
      <Modal
        open={renamingSession !== null}
        title={S.chat.renameSession}
        onClose={() => (renameBusy ? undefined : setRenamingSession(null))}
        footer={
          <>
            <Button size="sm" onClick={() => setRenamingSession(null)} disabled={renameBusy}>
              {S.common.cancel}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={renameBusy || !renameText.trim()}
              onClick={() => void confirmRename()}
            >
              {S.common.save}
            </Button>
          </>
        }
      >
        <Input
          size="sm"
          label={S.chat.renameSessionLabel}
          value={renameText}
          error={renameError ?? undefined}
          autoFocus
          maxLength={120}
          onChange={(e) => {
            setRenameText(e.target.value);
            if (renameError) setRenameError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && renameText.trim() && !renameBusy) void confirmRename();
          }}
        />
      </Modal>

      {/* Messaging binding dialog (row menu "Messaging binding…"): the row indicator
          updates in place from the dialog's own save/unbind outcome. */}
      {messagingSession && (
        <MessagingBindingModal
          sessionId={messagingSession.sessionId}
          onClose={() => setMessagingSession(null)}
          onChanged={(sessionId, channel) => {
            const current = sessions.find((x) => x.sessionId === sessionId);
            if (!current) return;
            const updated = { ...current };
            if (channel !== null) updated.messagingChannel = channel;
            else delete updated.messagingChannel;
            replace(updated);
          }}
        />
      )}

      {/* Rename workspace (alias edit, same Modal + Input idiom as rename chat): the alias
          replaces the directory basename as the group label; leaving it blank reverts to
          the basename — so an empty save is valid here, unlike the chat rename. */}
      <Modal
        open={renamingWorkspace !== null}
        title={S.chat.renameWorkspace}
        onClose={() => setRenamingWorkspace(null)}
        footer={
          <>
            <Button size="sm" onClick={() => setRenamingWorkspace(null)}>
              {S.common.cancel}
            </Button>
            <Button size="sm" variant="primary" onClick={confirmRenameWorkspace}>
              {S.common.save}
            </Button>
          </>
        }
      >
        <Input
          size="sm"
          label={S.chat.renameWorkspaceLabel}
          hint={S.chat.renameWorkspaceHint}
          value={workspaceAliasText}
          placeholder={renamingWorkspace ? workspaceLabel(renamingWorkspace.path) : ""}
          autoFocus
          maxLength={80}
          onChange={(e) => setWorkspaceAliasText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing guard (the repo's IME convention, cf. workspace-select.tsx):
            // accepting a Chinese candidate fires Enter, which would save the raw pinyin.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) confirmRenameWorkspace();
          }}
        />
      </Modal>

      {/* Delete chat confirmation (shared ConfirmModal) */}
      <ConfirmModal
        open={deletingSession !== null}
        title={S.chat.deleteSession}
        confirmLabel={S.common.delete}
        busy={deletingBusy}
        onClose={() => (deletingBusy ? undefined : setDeletingSession(null))}
        onConfirm={() => void confirmDeleteSession()}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {deletingSession
            ? S.chat.deleteSessionConfirm(deletingSession.title ?? S.chat.defaultSessionTitle)
            : ""}
        </p>
      </ConfirmModal>

      {/* Batch delete confirmation: one dialog naming the count. Opened from the batch bar's
          Delete, or from a marked row's own delete — the marks decide the scope. */}
      <ConfirmModal
        open={deletingMany !== null}
        title={S.chat.deleteSelected}
        confirmLabel={S.common.delete}
        busy={deletingBusy}
        onClose={() => (deletingBusy ? undefined : setDeletingMany(null))}
        onConfirm={() => void confirmBatchDelete()}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {deletingMany ? S.chat.deleteSelectedConfirm(deletingMany.length) : ""}
        </p>
      </ConfirmModal>

      {/* Remove-workspace confirmation (shared ConfirmModal, same stop as the other
          destructive-looking actions): the copy is honest about the scope — sidebar
          registry entry only, disk and Sessions untouched, re-addable anytime. */}
      <ConfirmModal
        open={deletingWorkspace !== null}
        title={S.chat.deleteWorkspace}
        confirmLabel={S.common.delete}
        onClose={() => setDeletingWorkspace(null)}
        onConfirm={confirmDeleteWorkspace}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {deletingWorkspace ? S.chat.deleteWorkspaceConfirm(deletingWorkspace.label) : ""}
        </p>
      </ConfirmModal>

      {/* Delete parked-draft confirmation: purely local (localStorage entry), but the typed
          content is gone for good, which deserves the same explicit stop as a session. */}
      <ConfirmModal
        open={deletingDraft !== null}
        title={S.chat.deleteDraft}
        confirmLabel={S.common.delete}
        onClose={() => setDeletingDraft(null)}
        onConfirm={confirmDeleteDraft}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {deletingDraft
            ? S.chat.deleteDraftConfirm(draftSessionTitle(deletingDraft) || S.chat.draftUntitled)
            : ""}
        </p>
      </ConfirmModal>
    </div>
  );
}
