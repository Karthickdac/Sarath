import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, Newspaper, Calendar, Activity, Image,
  Users, MessageSquare, HelpCircle, UserCircle, LogOut, Menu, X,
  ChevronRight, ChevronDown, Settings, Megaphone, FileText, MapPin, ClipboardList, Network, Map as MapIcon, BarChart3, Home as HomeIcon, ShieldAlert, Share2, Trophy, Radio, Sparkles, Newspaper as NewsIcon, Timer, Flame, Layers, CheckSquare, CalendarDays, CalendarCheck, Globe,
} from "lucide-react";
import { isAuthenticated, removeToken, getToken } from "@/lib/auth";
import { useGetMe } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
const ConstituencyMap = lazy(() => import("@/components/maps/ConstituencyMap"));
import GrievanceOfficer from "./GrievanceOfficer";
import Dashboard from "./admin/Dashboard";
import LeaderDashboard from "./admin/LeaderDashboard";
import Analytics from "./admin/Analytics";
import NewsAdmin from "./admin/NewsAdmin";
import EventsAdmin from "./admin/EventsAdmin";
import ActivitiesAdmin from "./admin/ActivitiesAdmin";
import GalleryAdmin from "./admin/GalleryAdmin";
import VolunteersAdmin from "./admin/VolunteersAdmin";
import FaqsAdmin from "./admin/FaqsAdmin";
import AboutAdmin from "./admin/AboutAdmin";
import HomeAdmin from "./admin/HomeAdmin";
import SiteSettingsAdmin from "./admin/SiteSettingsAdmin";
import AuditLogAdmin from "./admin/AuditLogAdmin";
import BannersAdmin from "./admin/BannersAdmin";
import ConstituencyAdmin from "./admin/ConstituencyAdmin";
import WardAdmin from "./admin/WardAdmin";
import HierarchyAdmin from "./admin/HierarchyAdmin";
import VoterRollAdmin from "./admin/VoterRollAdmin";
import VotersAdmin from "./admin/VotersAdmin";
import VoterTagsAdmin from "./admin/VoterTagsAdmin";
import VoterExportsAdmin from "./admin/VoterExportsAdmin";
import { Download } from "lucide-react";
import PressReleasesAdmin from "./admin/PressReleasesAdmin";
import AssignmentsAdmin from "./admin/AssignmentsAdmin";
import SocialMediaAdmin from "./admin/SocialMediaAdmin";
import PromisesAdmin from "./admin/PromisesAdmin";
import BroadcastAdmin from "./admin/BroadcastAdmin";
import AiToolsAdmin from "./admin/AiToolsAdmin";
import AskAiWidget from "./admin/AskAiWidget";
import PressCoverageAdmin from "./admin/PressCoverageAdmin";
import SlaAdmin from "./admin/SlaAdmin";
import EscalationsAdmin from "./admin/EscalationsAdmin";
import OutreachScorecardAdmin from "./admin/OutreachScorecardAdmin";
import HeatmapAdmin from "./admin/HeatmapAdmin";
import Map3DAdmin from "./admin/Map3DAdmin";
import TasksAdmin from "./admin/TasksAdmin";
import CalendarAdmin from "./admin/CalendarAdmin";
import AppointmentsAdmin from "./admin/AppointmentsAdmin";
import MinisterHome from "./admin/MinisterHome";
import PaHome from "./admin/PaHome";
import MinisterReadOnly from "./admin/MinisterReadOnly";
import { type Language, tAdmin } from "@/lib/i18n";
import { useLeaderConfig, lc } from "@/lib/LeaderConfigContext";
import { Crown } from "lucide-react";
import { UnsavedChangesProvider, useConfirmDiscard } from "@/lib/unsavedChanges";

interface AdminProps { lang?: Language; setLang?: (l: Language) => void }

type NavGroupId =
  | "overview"
  | "home"
  | "schedule"
  | "grievances"
  | "voters"
  | "maps"
  | "content"
  | "people"
  | "comms"
  | "outreach"
  | "site"
  | "system";

interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: string[];
  group: NavGroupId;
}

interface NavGroup {
  id: NavGroupId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Ordered. Empty groups (after role filtering) are hidden automatically.
const NAV_GROUPS: NavGroup[] = [
  { id: "overview",   label: "Overview",      icon: LayoutDashboard },
  { id: "schedule",   label: "Schedule",      icon: CalendarDays },
  { id: "grievances", label: "Grievances",    icon: MessageSquare },
  { id: "voters",     label: "Voters",        icon: Users },
  { id: "maps",       label: "Maps",          icon: MapIcon },
  { id: "content",    label: "Content",       icon: Newspaper },
  { id: "outreach",   label: "Outreach",      icon: Trophy },
  { id: "site",       label: "Site",          icon: Settings },
  { id: "system",     label: "System",        icon: ClipboardList },
];

// roles: undefined = all staff; listed = only those roles
const NAV_ITEMS: NavItem[] = [
  // Role home pages
  { id: "minister-home", label: "My Dashboard", icon: Crown,    group: "overview", roles: ["minister"] },
  { id: "pa-home",       label: "PA Home",      icon: HomeIcon, group: "overview", roles: ["pa_staff"] },

  // Minister read-only feeds
  { id: "minister-events",     label: "Today's Schedule", icon: CalendarDays, group: "schedule", roles: ["minister"] },
  { id: "minister-activities", label: "Activities",       icon: Activity,     group: "schedule", roles: ["minister"] },
  { id: "minister-promises",   label: "Promises",         icon: Trophy,       group: "outreach", roles: ["minister"] },
  { id: "minister-press",      label: "Press & News",     icon: Newspaper,    group: "content",  roles: ["minister"] },

  // Overview
  { id: "leader-dashboard", label: "Leader Dashboard", icon: Trophy, group: "overview", roles: ["super_admin", "admin", "pa_staff", "grievance_officer", "minister"] },
  { id: "dashboard",  label: "Dashboard",   icon: LayoutDashboard, group: "overview" },
  { id: "analytics",  label: "Analytics",   icon: BarChart3,       group: "overview", roles: ["super_admin", "admin", "constituency_coordinator"] },

  // Schedule
  { id: "tasks",    label: "Tasks",    icon: CheckSquare,   group: "schedule", roles: ["super_admin", "admin", "minister", "pa_staff"] },
  { id: "calendar", label: "Calendar", icon: CalendarDays,  group: "schedule", roles: ["super_admin", "admin", "minister", "pa_staff"] },
  { id: "appointments", label: "Appointments", icon: CalendarCheck, group: "schedule", roles: ["super_admin", "admin", "minister", "pa_staff"] },

  // Grievances
  { id: "grievances",   label: "Grievances",          icon: MessageSquare, group: "grievances" },
  { id: "assignments",  label: "Officer Assignments", icon: Network,       group: "grievances", roles: ["super_admin", "admin", "constituency_coordinator"] },
  { id: "sla",          label: "SLA Performance",     icon: Timer,         group: "grievances", roles: ["super_admin", "admin", "pa_staff", "grievance_officer"] },
  { id: "escalations",  label: "Escalations",         icon: Flame,         group: "grievances", roles: ["super_admin", "admin", "pa_staff", "grievance_officer"] },

  // Voters
  { id: "voters-search", label: "Voter Search",   icon: Users,      group: "voters", roles: ["super_admin", "admin", "constituency_coordinator", "grievance_officer", "pa_staff"] },
  { id: "voters",        label: "Voter Roll",     icon: ShieldAlert, group: "voters", roles: ["super_admin"] },
  { id: "voter-tags",    label: "Voter Tags",     icon: ShieldAlert, group: "voters", roles: ["super_admin"] },
  { id: "voter-exports", label: "Voter Exports",  icon: Download,    group: "voters", roles: ["super_admin"] },

  // Maps
  { id: "map",     label: "Constituency Map", icon: MapIcon, group: "maps" },
  { id: "heatmap", label: "Grievance Heatmap", icon: Layers,  group: "maps", roles: ["super_admin", "admin", "pa_staff", "grievance_officer"] },
  { id: "map3d",   label: "3D Map",           icon: MapIcon, group: "maps", roles: ["super_admin", "admin", "pa_staff", "grievance_officer"] },

  // Content
  { id: "news",           label: "News",           icon: Newspaper, group: "content", roles: ["super_admin", "admin", "pa_staff", "media_team"] },
  { id: "press",          label: "Press Releases", icon: FileText,  group: "content", roles: ["super_admin", "admin", "pa_staff", "media_team"] },
  { id: "press-coverage", label: "Press Coverage", icon: NewsIcon,  group: "content", roles: ["super_admin", "admin", "pa_staff", "media_team"] },
  { id: "events",         label: "Events",         icon: Calendar,  group: "content", roles: ["super_admin", "admin", "pa_staff", "constituency_coordinator", "media_team"] },
  { id: "activities",     label: "Activities",     icon: Activity,  group: "content", roles: ["super_admin", "admin", "pa_staff", "constituency_coordinator", "media_team"] },
  { id: "gallery",        label: "Gallery",        icon: Image,     group: "content", roles: ["super_admin", "admin", "pa_staff", "media_team"] },
  { id: "banners",        label: "Banners",        icon: Megaphone, group: "content", roles: ["super_admin", "admin", "pa_staff"] },

  // Outreach
  { id: "volunteers",   label: "Volunteers",         icon: Users,    group: "outreach", roles: ["super_admin", "admin", "pa_staff", "constituency_coordinator"] },
  { id: "constituency", label: "Constituency & Wards", icon: MapPin, group: "outreach", roles: ["super_admin", "admin", "pa_staff", "constituency_coordinator"] },
  // Broadcast cross-posts to website news + Social Media APIs, which only
  // accept super_admin / admin / media_team — keep the nav role aligned to
  // avoid pa_staff loading a page whose social calls would 403 silently.
  { id: "broadcast",    label: "Broadcast",          icon: Radio,    group: "outreach", roles: ["super_admin", "admin", "media_team"] },
  { id: "social",       label: "Social Media",       icon: Share2,   group: "outreach", roles: ["super_admin", "admin", "media_team"] },
  { id: "promises",     label: "Promises Tracker",   icon: Trophy,   group: "outreach", roles: ["super_admin", "admin", "pa_staff", "media_team"] },
  { id: "outreach",     label: "Outreach Scorecard", icon: BarChart3, group: "outreach", roles: ["super_admin", "admin", "pa_staff", "constituency_coordinator"] },

  // Site
  { id: "home",      label: "Home CMS",    icon: HomeIcon,  group: "site", roles: ["super_admin", "admin"] },
  { id: "about",     label: "About CMS",   icon: UserCircle, group: "site", roles: ["super_admin", "admin"] },
  { id: "faqs",      label: "FAQs",        icon: HelpCircle, group: "site", roles: ["super_admin", "admin", "pa_staff"] },
  { id: "settings",  label: "Site Settings", icon: Settings, group: "site", roles: ["super_admin", "admin"] },
  { id: "ai-tools",  label: "AI Tools",    icon: Sparkles,  group: "site", roles: ["super_admin", "admin", "pa_staff", "media_team", "grievance_officer"] },

  // System
  { id: "audit", label: "Audit Log", icon: ClipboardList, group: "system", roles: ["super_admin", "admin"] },
];

// ── Role-specific portal layouts ───────────────────────────
// Minister sees a slim, read-only-focused sidebar. We restrict the visible
// items via an allowlist and present them under friendly group labels.
const MINISTER_ALLOW = [
  "minister-home", "leader-dashboard", "grievances", "minister-events",
  "minister-activities", "minister-promises", "minister-press", "appointments",
];
const MINISTER_GROUPS: NavGroup[] = [
  { id: "overview",   label: "Home",        icon: Crown },
  { id: "grievances", label: "Grievances",  icon: MessageSquare },
  { id: "schedule",   label: "Schedule",    icon: CalendarDays },
  { id: "content",    label: "Press & News", icon: Newspaper },
  { id: "outreach",   label: "Promises",    icon: Trophy },
];

// PA keeps full role-based access but the items are regrouped into a
// daily-workflow layout. We override each item's group label without
// touching the underlying NAV_ITEMS definitions.
const PA_GROUPS: NavGroup[] = [
  { id: "overview",   label: "Home",       icon: HomeIcon },
  { id: "schedule",   label: "Schedule",   icon: CalendarDays },
  { id: "grievances", label: "Grievances", icon: MessageSquare },
  { id: "content",    label: "Content",    icon: Newspaper },
  { id: "people",     label: "People",     icon: Users },
  { id: "comms",      label: "Comms",      icon: Radio },
  { id: "site",       label: "Settings",   icon: Settings },
];
const PA_ITEM_GROUP: Record<string, NavGroupId> = {
  "pa-home": "overview", "leader-dashboard": "overview", "dashboard": "overview",
  "tasks": "schedule", "calendar": "schedule", "appointments": "schedule", "events": "schedule", "activities": "schedule", "map": "schedule",
  "grievances": "grievances", "sla": "grievances", "escalations": "grievances", "heatmap": "grievances", "map3d": "grievances",
  "news": "content", "press": "content", "press-coverage": "content", "gallery": "content", "banners": "content",
  "volunteers": "people", "voters-search": "people", "constituency": "people",
  "promises": "comms", "outreach": "comms", "ai-tools": "comms",
  "faqs": "site",
};

// Persisted collapse state. Stored as a comma-separated list of
// collapsed group ids so we can hand-edit / inspect easily and so an
// older saved value never crashes parsing.
const COLLAPSED_GROUPS_KEY = "nc.admin.sidebar.collapsedGroups";

function loadCollapsedGroups(): Set<NavGroupId> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const ids = raw.split(",").map(s => s.trim()).filter(Boolean) as NavGroupId[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(set: Set<NavGroupId>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, [...set].join(","));
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}

export default function Admin({ lang = "ta", setLang }: AdminProps) {
  return (
    <UnsavedChangesProvider>
      <AdminInner lang={lang} setLang={setLang} />
    </UnsavedChangesProvider>
  );
}

function AdminInner({ lang = "ta", setLang }: AdminProps) {
  const [, setLocation] = useLocation();
  const confirmDiscard = useConfirmDiscard();
  const { data: me, error } = useGetMe();
  const [active, setActive] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Deep-link support: other admin pages (e.g. VotersAdmin grievance
  // click-through) can navigate here by setting `window.location.hash`
  // to a tab id like `#grievances`. Read on mount and on hashchange.
  useEffect(() => {
    function syncFromHash() {
      const m = window.location.hash.match(/^#([\w-]+)/);
      if (m) setActive(m[1]);
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  useEffect(() => { if (!isAuthenticated()) setLocation("/login"); }, []);
  useEffect(() => { if (error) { removeToken(); setLocation("/login"); } }, [error]);

  async function logout() {
    const ok = await confirmDiscard(
      "You have unsaved changes. If you sign out now, they will be lost.",
    );
    if (!ok) return;
    removeToken();
    setLocation("/login");
  }

  const leader = useLeaderConfig();
  const token = getToken() ?? "";
  const role = me?.role ?? "";
  const isAdminRole = ["super_admin", "admin", "constituency_coordinator"].includes(role);
  const [mapHeatPoints, setMapHeatPoints] = useState<Array<{ lat: number; lng: number; weight: number }> | undefined>(undefined);
  useEffect(() => {
    if (!isAdminRole) { setMapHeatPoints(undefined); return; }
    const t = getToken();
    if (!t) return;
    let cancelled = false;
    fetch(`/api/admin/analytics/grievances`, { headers: { Authorization: `Bearer ${t}` } })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { heatPoints?: Array<{ lat: number; lng: number; weight: number }> } | null) => {
        if (!cancelled && j?.heatPoints) setMapHeatPoints(j.heatPoints);
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [isAdminRole]);

  // Fetch the logged-in officer's assignments so the embedded map can offer
  // a "show only my ward" toggle. Skipped for super_admin/admin who already
  // see everything.
  const isOfficer = role === "grievance_officer" || role === "constituency_coordinator";
  // Read assignments via the dedicated /admin/my-assignments endpoint —
  // /admin/assignments requires WARD_ROLES, which excludes grievance_officer,
  // so officers must use this self-scoped route instead.
  const { data: myAssignments } = useQuery<{
    items: Array<{ wardId: number | null; areaId: number | null; pollingStationId: number | null }>;
    wardIds: number[];
    areaIds: number[];
    pollingStationIds: number[];
  }>({
    queryKey: ["map-my-assignments", me?.id],
    queryFn: async () => {
      const tok = getToken();
      const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
      const r = await fetch(`${base}/api/admin/my-assignments`, {
        headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
      });
      if (!r.ok) throw new Error("Failed to load assignments");
      return r.json();
    },
    enabled: Boolean(me?.id && isOfficer),
    staleTime: 60_000,
  });
  // Server returns the full ward set already expanded across ward/area/booth
  // assignments, so the map filter honours every assignment granularity.
  const officerWardIds = useMemo(() => myAssignments?.wardIds ?? [], [myAssignments]);
  const officerAreaIds = useMemo(() => myAssignments?.areaIds ?? [], [myAssignments]);
  const officerPollingStationIds = useMemo(
    () => myAssignments?.pollingStationIds ?? [],
    [myAssignments],
  );

  const STAFF_ROLES = ["super_admin", "admin", "pa_staff", "media_team", "constituency_coordinator", "grievance_officer", "minister", "staff"];

  // Authenticated but not a staff role → show forbidden screen
  if (me && !STAFF_ROLES.includes(role)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4">
          <span className="text-3xl">🚫</span>
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Access Denied</h1>
        <p className="text-sm text-muted-foreground mb-6 max-w-xs">
          Your account (<strong>{me.email}</strong>) does not have staff privileges to access the admin panel.
        </p>
        <Button variant="outline" onClick={logout}>Sign out</Button>
      </div>
    );
  }

  const isMinister = role === "minister";
  const isPa = role === "pa_staff";

  const visibleNav = NAV_ITEMS.filter(item => {
    // Minister gets a curated, slim sidebar regardless of generic staff access.
    if (isMinister && !MINISTER_ALLOW.includes(item.id)) return false;
    if (!item.roles) return true;
    return item.roles.includes(role);
  });

  // Resolve a nav item's group, applying the PA workflow regrouping override.
  const groupOf = (it: NavItem): NavGroupId => (isPa ? (PA_ITEM_GROUP[it.id] ?? it.group) : it.group);

  // Group → visible items (preserves group order, drops empty groups)
  const groupedNav = useMemo(() => {
    const groups = isMinister ? MINISTER_GROUPS : isPa ? PA_GROUPS : NAV_GROUPS;
    return groups
      .map(g => ({ group: g, items: visibleNav.filter(it => groupOf(it) === g.id) }))
      .filter(g => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNav, isMinister, isPa]);

  // Collapsed-group state, persisted to localStorage. The group
  // containing the active item is always rendered expanded regardless
  // of the persisted value, so users never lose sight of where they
  // are after a deep-link or page reload.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<NavGroupId>>(() => loadCollapsedGroups());
  useEffect(() => { saveCollapsedGroups(collapsedGroups); }, [collapsedGroups]);

  function toggleGroup(id: NavGroupId): void {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const activeItem = visibleNav.find(n => n.id === active);
  const activeGroupId = activeItem ? groupOf(activeItem) : undefined;
  const roleHome = isMinister ? "minister-home" : isPa ? "pa-home" : "dashboard";

  // Ensure active tab is accessible; reset to the role's home tab if not.
  // Runs whenever role, visibleNav, or active changes — so deep-links
  // (e.g. from clickable KPI tiles) targeting tabs the current role
  // cannot access fall back gracefully instead of rendering a blank
  // content area.
  useEffect(() => {
    if (role && !visibleNav.find(n => n.id === active)) {
      setActive(roleHome);
    }
  }, [role, visibleNav, active, roleHome]);

  // Land minister/PA on their portal home after login when no deep-link
  // hash was provided. Applied once per session.
  const [defaultApplied, setDefaultApplied] = useState(false);
  useEffect(() => {
    if (defaultApplied || !role) return;
    const hash = window.location.hash.match(/^#([\w-]+)/);
    if (!hash && (isMinister || isPa)) setActive(roleHome);
    setDefaultApplied(true);
  }, [role, defaultApplied, isMinister, isPa, roleHome]);

  async function navigate(id: string) {
    if (id === active) { setSidebarOpen(false); return; }
    const ok = await confirmDiscard(
      "You have unsaved changes on this page. Switch sections and discard them?",
    );
    if (!ok) return;
    setActive(id);
    setSidebarOpen(false);
  }

  const currentItem = visibleNav.find(n => n.id === active) ?? visibleNav[0];

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Dark Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-40 w-60 bg-gray-950 text-white flex flex-col transition-transform duration-200
        lg:static lg:translate-x-0
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        {/* Brand */}
        <div className="px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center font-bold text-sm shrink-0">{leader.logoInitial}</div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{leader.siteTitle}</p>
              <p className="text-xs text-gray-400 truncate">{tAdmin(lang, "Admin Panel")}</p>
            </div>
          </div>
        </div>

        {/* User info */}
        {me && (
          isMinister ? (
            <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
              <img
                src={leader.photoUrl}
                alt=""
                className="w-10 h-10 rounded-full object-cover border-2 border-[#d4af37] shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{lc(lang, leader.nameEn, leader.nameTa)}</p>
                <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#d4af37] text-gray-900">
                  <Crown className="w-2.5 h-2.5" />{lc(lang, "Minister", "அமைச்சர்")}
                </span>
              </div>
            </div>
          ) : (
            <div className="px-4 py-3 border-b border-white/10">
              <p className="text-sm font-medium truncate">{me.name}</p>
              <p className="text-xs text-gray-400 capitalize truncate">{me.role.replace(/_/g, " ")}</p>
            </div>
          )
        )}

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {groupedNav.map(({ group, items }) => {
            const GroupIcon = group.icon;
            const isActiveGroup = activeGroupId === group.id;
            // Active group is always expanded so the user never loses
            // their place after a refresh or hash deep-link.
            const isCollapsed = !isActiveGroup && collapsedGroups.has(group.id);
            return (
              <div key={group.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  data-testid={`admin-nav-group-${group.id}`}
                  aria-expanded={!isCollapsed}
                  className={`
                    w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-colors
                    ${isActiveGroup
                      ? "text-primary/80 bg-primary/10"
                      : "text-gray-500 hover:text-gray-300 hover:bg-white/5"}
                  `}
                >
                  <GroupIcon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{group.label}</span>
                  <span className="ml-auto flex items-center gap-1 text-gray-600 font-normal normal-case tracking-normal">
                    <span className="text-[10px]">{items.length}</span>
                    {isCollapsed
                      ? <ChevronRight className="w-3 h-3" />
                      : <ChevronDown className="w-3 h-3" />}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="mt-0.5 ml-1 pl-2 border-l border-white/8 space-y-0.5">
                    {items.map((item) => {
                      const Icon = item.icon;
                      const isActive = active === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => navigate(item.id)}
                          data-testid={`admin-nav-${item.id}`}
                          className={`
                            w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm font-medium transition-all text-left
                            ${isActive
                              ? "bg-primary text-white shadow-sm"
                              : "text-gray-400 hover:text-white hover:bg-white/10"}
                          `}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{item.label}</span>
                          {isActive && <ChevronRight className="w-3 h-3 ml-auto shrink-0 opacity-70" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="px-2 py-3 border-t border-white/10">
          <button
            onClick={logout}
            data-testid="logout-btn"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/10 transition-all"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-20">
          <button
            onClick={() => setSidebarOpen(s => !s)}
            className="lg:hidden p-1.5 rounded-md hover:bg-gray-100 transition-colors"
          >
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          {currentItem && (
            <div className="flex items-center gap-2">
              <currentItem.icon className="w-4 h-4 text-primary" />
              <h1 className="font-semibold text-sm text-gray-900">{currentItem.label}</h1>
            </div>
          )}
          <div className="ml-auto">
            <span className="text-xs text-muted-foreground hidden sm:inline">{leader.constituencyEn} Constituency</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 sm:p-6 overflow-auto">
          {active === "minister-home"       && <MinisterHome lang={lang} />}
          {active === "pa-home"             && <PaHome lang={lang} />}
          {active === "minister-events"     && <MinisterReadOnly lang={lang} section="events" />}
          {active === "minister-activities" && <MinisterReadOnly lang={lang} section="activities" />}
          {active === "minister-promises"   && <MinisterReadOnly lang={lang} section="promises" />}
          {active === "minister-press"      && <MinisterReadOnly lang={lang} section="press" />}
          {active === "leader-dashboard" && <LeaderDashboard lang={lang} readOnly={role === "grievance_officer" || role === "pa_staff" || role === "minister"} />}
          {active === "dashboard"    && <Dashboard lang={lang} />}
          {active === "tasks"        && <TasksAdmin lang={lang} />}
          {active === "calendar"     && <CalendarAdmin lang={lang} />}
          {active === "appointments" && <AppointmentsAdmin lang={lang} role={role} />}
          {active === "grievances"   && <GrievanceOfficer lang={lang} token={token} userRole={role} />}
          {active === "assignments"  && <AssignmentsAdmin token={token} />}
          {active === "map"          && (
            <Suspense fallback={<div className="text-sm text-muted-foreground">Loading map…</div>}>
              <ConstituencyMap
                lang={lang}
                adminMode
                officerWardIds={isOfficer ? officerWardIds : undefined}
                officerAreaIds={isOfficer ? officerAreaIds : undefined}
                officerPollingStationIds={isOfficer ? officerPollingStationIds : undefined}
                height="calc(100vh - 130px)"
                heatPoints={isAdminRole ? mapHeatPoints : undefined}
              />
            </Suspense>
          )}
          {active === "analytics"   && (
            <Analytics
              lang={lang}
              officerWardIds={isOfficer ? officerWardIds : undefined}
              officerAreaIds={isOfficer ? officerAreaIds : undefined}
              officerPollingStationIds={isOfficer ? officerPollingStationIds : undefined}
            />
          )}
          {active === "news"         && <NewsAdmin />}
          {active === "press"        && <PressReleasesAdmin />}
          {active === "events"       && <EventsAdmin />}
          {active === "activities"   && <ActivitiesAdmin />}
          {active === "gallery"      && <GalleryAdmin />}
          {active === "banners"      && <BannersAdmin />}
          {active === "volunteers"   && <VolunteersAdmin />}
          {active === "constituency" && (
            <div className="space-y-6">
              <ConstituencyAdmin />
              <div className="border-t pt-4">
                <HierarchyAdmin />
              </div>
              <details className="border-t pt-4 group">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground select-none">
                  Legacy ward coordinator list (flat view)
                </summary>
                <div className="mt-3">
                  <WardAdmin />
                </div>
              </details>
            </div>
          )}
          {active === "faqs"         && <FaqsAdmin />}
          {active === "home"         && <HomeAdmin />}
          {active === "about"        && <AboutAdmin />}
          {active === "settings"     && <SiteSettingsAdmin />}
          {active === "social"       && <SocialMediaAdmin />}
          {active === "promises"     && <PromisesAdmin />}
          {active === "broadcast"    && <BroadcastAdmin />}
          {active === "ai-tools"     && <AiToolsAdmin lang={lang} role={role} />}
          {active === "press-coverage" && <PressCoverageAdmin />}
          {active === "sla"          && <SlaAdmin />}
          {active === "escalations"  && <EscalationsAdmin />}
          {active === "heatmap"      && <HeatmapAdmin />}
          {active === "map3d"        && <Map3DAdmin />}
          {active === "outreach"     && <OutreachScorecardAdmin />}
          {active === "audit"        && <AuditLogAdmin />}
          {active === "voters"       && <VoterRollAdmin />}
          {active === "voters-search" && <VotersAdmin lang={lang} />}
          {active === "voter-tags" && <VoterTagsAdmin />}
          {active === "voter-exports" && <VoterExportsAdmin />}
        </main>
      </div>
      {/* Floating AI assistant widget — visible to all admin roles */}
      <AskAiWidget />
    </div>
  );
}
