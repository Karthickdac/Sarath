import { useEffect, useMemo, useState, useCallback } from "react";
import { adminApi } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  CalendarCheck, Search, Download, X, ChevronLeft, ChevronRight,
  Clock, CheckCircle, CalendarClock, CheckCheck, XCircle, RotateCcw,
  Phone, Mail, MapPin, Users as UsersIcon, Loader2, Trash2, List, CalendarDays,
  Sparkles, Pencil,
} from "lucide-react";
import type { Language } from "@/lib/i18n";

interface AppointmentsAdminProps { lang: Language; role: string; }

interface Appointment {
  id: number;
  ticketNo: string;
  name: string;
  phone: string;
  email: string | null;
  category: string;
  subject: string;
  description: string | null;
  ward: string | null;
  address: string | null;
  partySize: number | null;
  status: string;
  preferredDate: string | null;
  preferredTime: string | null;
  alternateDate: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  location: string | null;
  decisionNote: string | null;
  rejectionReason: string | null;
  notificationMessage: string | null;
  handledByName: string | null;
  completedAt: string | null;
  aiPriorityScore: number | null;
  createdAt: string;
  updatedAt: string;
}

const STATUSES = ["Pending", "Approved", "Rescheduled", "Completed", "Rejected", "Cancelled"];
const CATEGORIES = ["Constituency Meeting", "Grievance Hearing", "Official Visit", "Media", "General"];

const STATUS_META: Record<string, { ta: string; cls: string; icon: typeof Clock }> = {
  Pending: { ta: "நிலுவையில்", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300", icon: Clock },
  Approved: { ta: "அங்கீகரிக்கப்பட்டது", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300", icon: CheckCircle },
  Rescheduled: { ta: "மறுதிட்டமிடப்பட்டது", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300", icon: CalendarClock },
  Completed: { ta: "முடிக்கப்பட்டது", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300", icon: CheckCheck },
  Rejected: { ta: "நிராகரிக்கப்பட்டது", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300", icon: XCircle },
  Cancelled: { ta: "ரத்து செய்யப்பட்டது", cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", icon: RotateCcw },
};

export default function AppointmentsAdmin({ lang, role }: AppointmentsAdminProps) {
  const readOnly = role === "minister";
  const canDelete = role === "super_admin";
  const lc = (en: string, ta: string) => (lang === "ta" ? ta : en);

  const [view, setView] = useState<"list" | "calendar">("list");
  const [items, setItems] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [selected, setSelected] = useState<Appointment | null>(null);
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [calItems, setCalItems] = useState<Appointment[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getAppointments({
        page, limit: 20,
        status: statusFilter === "all" ? undefined : statusFilter,
        category: categoryFilter === "all" ? undefined : categoryFilter,
        q: qDebounced || undefined,
      });
      setItems(res.items ?? []);
      setTotalPages(res.totalPages ?? 1);
      setTotal(res.total ?? 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, categoryFilter, qDebounced]);

  useEffect(() => { if (view === "list") load(); }, [view, load]);
  useEffect(() => { setPage(1); }, [statusFilter, categoryFilter, qDebounced]);

  // Calendar month data
  const loadCalendar = useCallback(async () => {
    const from = new Date(calMonth);
    const to = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0, 23, 59, 59);
    try {
      const res = await adminApi.getAppointments({ limit: 100, from: from.toISOString(), to: to.toISOString() });
      const items = (res.items ?? []).filter((a: any) => a.status === "Approved" || a.status === "Rescheduled");
      setCalItems(items);
    } catch {
      setCalItems([]);
    }
  }, [calMonth]);

  useEffect(() => { if (view === "calendar") loadCalendar(); }, [view, loadCalendar]);

  async function handleExport() {
    try {
      const csv = await adminApi.exportAppointmentsCSV();
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `appointments-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }

  function refreshAfterMutation() {
    if (view === "list") load(); else loadCalendar();
  }

  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN") : "—");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">{lc("Appointments", "சந்திப்புகள்")}</h2>
          {!loading && view === "list" && <span className="text-sm text-muted-foreground">({total})</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => setView("list")}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === "list" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              data-testid="button-view-list"
            >
              <List className="w-4 h-4" />{lc("List", "பட்டியல்")}
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${view === "calendar" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              data-testid="button-view-calendar"
            >
              <CalendarDays className="w-4 h-4" />{lc("Calendar", "நாட்காட்டி")}
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={handleExport} data-testid="button-export-appointments">
            <Download className="w-4 h-4 mr-1.5" />{lc("CSV", "CSV")}
          </Button>
        </div>
      </div>

      {view === "list" && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={lc("Search name, ticket, phone...", "பெயர், எண், தொலைபேசி...")}
                className="pl-8"
                data-testid="input-search-appointments"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]" data-testid="select-filter-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{lc("All statuses", "எல்லா நிலைகள்")}</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{lc(s, STATUS_META[s]?.ta ?? s)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-filter-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{lc("All purposes", "எல்லா நோக்கங்கள்")}</SelectItem>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
          <div className="border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">{lc("Ticket", "எண்")}</th>
                    <th className="px-4 py-2.5 font-medium">{lc("Name", "பெயர்")}</th>
                    <th className="px-4 py-2.5 font-medium hidden md:table-cell">{lc("Purpose", "நோக்கம்")}</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">{lc("Preferred", "விரும்பியது")}</th>
                    <th className="px-4 py-2.5 font-medium hidden lg:table-cell">{lc("Scheduled", "திட்டமிட்டது")}</th>
                    <th className="px-4 py-2.5 font-medium">{lc("Status", "நிலை")}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
                  ) : items.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">{lc("No appointments found", "சந்திப்புகள் இல்லை")}</td></tr>
                  ) : items.map((a) => {
                    const meta = STATUS_META[a.status] ?? STATUS_META.Pending;
                    const StatusIcon = meta.icon;
                    return (
                      <tr key={a.id} onClick={() => setSelected(a)} className="border-t hover:bg-muted/30 cursor-pointer" data-testid={`row-appointment-${a.id}`}>
                        <td className="px-4 py-2.5 font-mono text-xs text-primary">{a.ticketNo}</td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium flex items-center gap-1.5">
                            {a.name}
                            {a.aiPriorityScore !== null && a.aiPriorityScore !== undefined && (
                              <span title={`AI Priority: ${a.aiPriorityScore}/5`}
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                  a.aiPriorityScore >= 4 ? "bg-red-100 text-red-700" :
                                  a.aiPriorityScore >= 3 ? "bg-amber-100 text-amber-700" :
                                  "bg-green-100 text-green-700"
                                }`}>AI:{a.aiPriorityScore}/5</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{a.phone}</div>
                        </td>
                        <td className="px-4 py-2.5 hidden md:table-cell">{a.category}</td>
                        <td className="px-4 py-2.5 hidden lg:table-cell text-muted-foreground">{fmtDate(a.preferredDate)} {a.preferredTime ?? ""}</td>
                        <td className="px-4 py-2.5 hidden lg:table-cell text-muted-foreground">{fmtDate(a.scheduledDate)} {a.scheduledTime ?? ""}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${meta.cls}`}>
                            <StatusIcon className="w-3 h-3" />{lc(a.status, meta.ta)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
              <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
            </div>
          )}
        </>
      )}

      {view === "calendar" && (
        <CalendarView
          lang={lang}
          month={calMonth}
          items={calItems}
          onPrev={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          onNext={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
          onSelect={setSelected}
        />
      )}

      {selected && (
        <AppointmentDrawer
          lang={lang}
          readOnly={readOnly}
          canDelete={canDelete}
          appointment={selected}
          onClose={() => setSelected(null)}
          onMutated={(updated) => {
            setSelected(updated);
            refreshAfterMutation();
          }}
          onDeleted={() => {
            setSelected(null);
            refreshAfterMutation();
          }}
        />
      )}
    </div>
  );
}

// ── Tailwind month calendar (no external lib) ──
function CalendarView({ lang, month, items, onPrev, onNext, onSelect }: {
  lang: Language; month: Date; items: Appointment[];
  onPrev: () => void; onNext: () => void; onSelect: (a: Appointment) => void;
}) {
  const lc = (en: string, ta: string) => (lang === "ta" ? ta : en);
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstDay = new Date(year, mon, 1).getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const byDay = useMemo(() => {
    const map: Record<number, Appointment[]> = {};
    for (const a of items) {
      const ref = a.scheduledDate ?? a.preferredDate;
      if (!ref) continue;
      const d = new Date(ref);
      if (d.getMonth() === mon && d.getFullYear() === year) {
        (map[d.getDate()] ??= []).push(a);
      }
    }
    return map;
  }, [items, mon, year]);

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthName = month.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", { month: "long", year: "numeric" });
  const dows = lang === "ta"
    ? ["ஞா", "தி", "செ", "பு", "வி", "வெ", "ச"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="border rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <Button variant="outline" size="sm" onClick={onPrev}><ChevronLeft className="w-4 h-4" /></Button>
        <h3 className="font-semibold capitalize">{monthName}</h3>
        <Button variant="outline" size="sm" onClick={onNext}><ChevronRight className="w-4 h-4" /></Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground mb-1">
        {dows.map((d) => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} className="min-h-[80px]" />;
          const dayDate = new Date(year, mon, d); dayDate.setHours(0, 0, 0, 0);
          const isToday = dayDate.getTime() === today.getTime();
          const appts = byDay[d] ?? [];
          return (
            <div key={d} className={`min-h-[80px] border rounded-lg p-1 ${isToday ? "border-primary bg-primary/5" : "border-border"}`}>
              <div className={`text-xs font-medium mb-0.5 ${isToday ? "text-primary" : ""}`}>{d}</div>
              <div className="space-y-0.5">
                {appts.slice(0, 3).map((a) => {
                  const meta = STATUS_META[a.status] ?? STATUS_META.Pending;
                  return (
                    <button
                      key={a.id}
                      onClick={() => onSelect(a)}
                      className={`w-full text-left text-[10px] px-1 py-0.5 rounded truncate ${meta.cls}`}
                      data-testid={`cal-appt-${a.id}`}
                      title={`${a.name} — ${a.subject}`}
                    >
                      {a.scheduledTime ?? a.preferredTime ?? ""} {a.name}
                    </button>
                  );
                })}
                {appts.length > 3 && <div className="text-[10px] text-muted-foreground px-1">+{appts.length - 3} {lc("more", "மேலும்")}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Detail drawer with decision actions ──
function AppointmentDrawer({ lang, readOnly, canDelete, appointment, onClose, onMutated, onDeleted }: {
  lang: Language; readOnly: boolean; canDelete: boolean; appointment: Appointment;
  onClose: () => void; onMutated: (a: Appointment) => void; onDeleted: () => void;
}) {
  const lc = (en: string, ta: string) => (lang === "ta" ? ta : en);
  const a = appointment;
  const meta = STATUS_META[a.status] ?? STATUS_META.Pending;

  const [scheduledDate, setScheduledDate] = useState(a.scheduledDate ? a.scheduledDate.slice(0, 10) : (a.preferredDate ? a.preferredDate.slice(0, 10) : ""));
  const [scheduledTime, setScheduledTime] = useState(a.scheduledTime ?? a.preferredTime ?? "");
  const [location, setLocation] = useState(a.location ?? "");
  const [decisionNote, setDecisionNote] = useState(a.decisionNote ?? "");
  const [rejectionReason, setRejectionReason] = useState(a.rejectionReason ?? "");
  const [notificationMessage, setNotificationMessage] = useState(a.notificationMessage ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [slotHint, setSlotHint] = useState("");

  // Editable booking details
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name ?? "");
  const [phone, setPhone] = useState(a.phone ?? "");
  const [email, setEmail] = useState(a.email ?? "");
  const [ward, setWard] = useState(a.ward ?? "");
  const [address, setAddress] = useState(a.address ?? "");
  const [category, setCategory] = useState(a.category ?? "General");
  const [subject, setSubject] = useState(a.subject ?? "");
  const [description, setDescription] = useState(a.description ?? "");
  const [partySize, setPartySize] = useState(String(a.partySize ?? 1));
  const [preferredDate, setPreferredDate] = useState(a.preferredDate ? a.preferredDate.slice(0, 10) : "");
  const [preferredTime, setPreferredTime] = useState(a.preferredTime ?? "");
  const [alternateDate, setAlternateDate] = useState(a.alternateDate ? a.alternateDate.slice(0, 10) : "");

  async function handleSuggestSlot() {
    setSuggesting(true);
    setErr("");
    setSlotHint("");
    try {
      const res = await adminApi.suggestSlot(a.id) as { slot?: { date?: string; time?: string; reason?: string } };
      const slot = res?.slot;
      if (slot?.date) setScheduledDate(slot.date.slice(0, 10));
      if (slot?.time) setScheduledTime(slot.time);
      if (slot?.reason) setSlotHint(slot.reason);
    } catch (e) {
      setErr(e instanceof Error ? e.message : lc("Suggestion failed", "பரிந்துரை தோல்வி"));
    } finally {
      setSuggesting(false);
    }
  }

  async function mutate(patch: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setErr("");
    try {
      const updated = await adminApi.updateAppointment(a.id, patch);
      onMutated(updated as Appointment);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : lc("Update failed", "புதுப்பிப்பு தோல்வி"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails() {
    const size = parseInt(partySize, 10);
    const ok = await mutate({
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() || null,
      ward: ward.trim() || null,
      address: address.trim() || null,
      category,
      subject: subject.trim(),
      description: description.trim() || null,
      partySize: Number.isFinite(size) && size > 0 ? size : 1,
      preferredDate: preferredDate || null,
      preferredTime: preferredTime || null,
      alternateDate: alternateDate || null,
    });
    if (ok) setEditing(false);
  }

  const approve = () => mutate({ status: "Approved", scheduledDate: scheduledDate || null, scheduledTime: scheduledTime || null, location: location || null, decisionNote: decisionNote || null, notificationMessage: notificationMessage || null });
  const reschedule = () => mutate({ status: "Rescheduled", scheduledDate: scheduledDate || null, scheduledTime: scheduledTime || null, location: location || null, decisionNote: decisionNote || null, notificationMessage: notificationMessage || null });
  const reject = () => mutate({ status: "Rejected", rejectionReason: rejectionReason || null, notificationMessage: notificationMessage || null });
  const complete = () => mutate({ status: "Completed", decisionNote: decisionNote || null });
  const cancel = () => mutate({ status: "Cancelled", decisionNote: decisionNote || null });

  async function handleDelete() {
    if (!window.confirm(lc("Delete this appointment permanently?", "இந்த சந்திப்பை நிரந்தரமாக நீக்கவா?"))) return;
    setBusy(true);
    try {
      await adminApi.deleteAppointment(a.id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : lc("Delete failed", "நீக்க முடியவில்லை"));
      setBusy(false);
    }
  }

  const StatusIcon = meta.icon;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="appointment-drawer">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-background h-full overflow-y-auto shadow-xl border-l">
        <div className="sticky top-0 bg-background border-b px-5 py-4 flex items-center justify-between">
          <div>
            <p className="font-mono text-sm text-primary">{a.ticketNo}</p>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold mt-1 ${meta.cls}`}>
              <StatusIcon className="w-3 h-3" />{lc(a.status, meta.ta)}
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="w-5 h-5" /></Button>
        </div>

        <div className="p-5 space-y-4">
          {/* Requester */}
          <div className="space-y-1.5">
            {!editing && <h3 className="text-lg font-bold">{a.name}</h3>}
            {!editing && <p className="text-sm flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground" />{a.phone}</p>}
            {!editing && a.email && <p className="text-sm flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground" />{a.email}</p>}
            {!editing && (a.ward || a.address) && <p className="text-sm flex items-center gap-2"><MapPin className="w-4 h-4 text-muted-foreground" />{[a.ward, a.address].filter(Boolean).join(", ")}</p>}
            {!editing && a.partySize ? <p className="text-sm flex items-center gap-2"><UsersIcon className="w-4 h-4 text-muted-foreground" />{a.partySize} {lc("people", "பேர்")}</p> : null}
            {!readOnly && !editing && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setEditing(true)} data-testid="button-edit-details">
                <Pencil className="w-3.5 h-3.5 mr-1" />{lc("Edit details", "விவரங்களை திருத்து")}
              </Button>
            )}
          </div>

          {editing ? (
            <div className="border-t pt-3 space-y-3" data-testid="edit-details-form">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Name", "பெயர்")}</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-edit-name" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Phone", "தொலைபேசி")}</label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-edit-phone" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Email", "மின்னஞ்சல்")}</label>
                <Input value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-edit-email" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Ward", "வார்டு")}</label>
                  <Input value={ward} onChange={(e) => setWard(e.target.value)} data-testid="input-edit-ward" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Party size", "நபர்கள்")}</label>
                  <Input type="number" min={1} value={partySize} onChange={(e) => setPartySize(e.target.value)} data-testid="input-edit-partysize" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Address", "முகவரி")}</label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} data-testid="input-edit-address" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Purpose", "நோக்கம்")}</label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger data-testid="select-edit-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Subject", "தலைப்பு")}</label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="input-edit-subject" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Description", "விவரம்")}</label>
                <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-edit-description" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Preferred date", "விரும்பிய தேதி")}</label>
                  <Input type="date" value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} data-testid="input-edit-preferred-date" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Preferred time", "விரும்பிய நேரம்")}</label>
                  <Input type="time" value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} data-testid="input-edit-preferred-time" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Alternate date", "மாற்று தேதி")}</label>
                <Input type="date" value={alternateDate} onChange={(e) => setAlternateDate(e.target.value)} data-testid="input-edit-alternate-date" />
              </div>
              {err && <p className="text-sm text-red-600">{err}</p>}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={saveDetails} data-testid="button-save-details">
                  {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}{lc("Save", "சேமி")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(false); setErr(""); }} data-testid="button-cancel-edit">
                  {lc("Cancel", "ரத்து")}
                </Button>
              </div>
            </div>
          ) : (
          <div className="border-t pt-3 space-y-2 text-sm">
            <p><span className="font-medium">{lc("Purpose:", "நோக்கம்:")}</span> {a.category}</p>
            <p><span className="font-medium">{lc("Subject:", "தலைப்பு:")}</span> {a.subject}</p>
            {a.description && <p className="text-muted-foreground whitespace-pre-wrap">{a.description}</p>}
            <p className="text-xs text-muted-foreground">
              {lc("Preferred:", "விரும்பியது:")} {a.preferredDate ? new Date(a.preferredDate).toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN") : "—"} {a.preferredTime ?? ""}
            </p>
            {a.alternateDate && (
              <p className="text-xs text-muted-foreground">
                {lc("Alternate:", "மாற்று:")} {new Date(a.alternateDate).toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN")}
              </p>
            )}
            {a.handledByName && <p className="text-xs text-muted-foreground">{lc("Handled by:", "கையாண்டவர்:")} {a.handledByName}</p>}
          </div>
          )}

          {readOnly ? (
            <div className="border-t pt-3 space-y-2 text-sm">
              {a.scheduledDate && <p><span className="font-medium">{lc("Scheduled:", "திட்டமிட்டது:")}</span> {new Date(a.scheduledDate).toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN")} {a.scheduledTime ?? ""}</p>}
              {a.location && <p><span className="font-medium">{lc("Location:", "இடம்:")}</span> {a.location}</p>}
              {a.decisionNote && <p className="text-muted-foreground">{a.decisionNote}</p>}
              {a.rejectionReason && <p className="text-red-600">{a.rejectionReason}</p>}
            </div>
          ) : (
            <div className="border-t pt-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{lc("Manage", "நிர்வகி")}</p>
                <Button variant="outline" size="sm" onClick={handleSuggestSlot} disabled={suggesting || busy} data-testid="button-suggest-slot">
                  {suggesting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
                  {lc("Suggest slot", "நேரம் பரிந்துரை")}
                </Button>
              </div>
              {slotHint && <p className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">{slotHint}</p>}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Date", "தேதி")}</label>
                  <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} data-testid="input-drawer-date" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{lc("Time", "நேரம்")}</label>
                  <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} data-testid="input-drawer-time" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Location", "இடம்")}</label>
                <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={lc("Meeting venue", "சந்திப்பு இடம்")} data-testid="input-drawer-location" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Note to citizen", "குடிமகனுக்கு குறிப்பு")}</label>
                <Textarea rows={2} value={notificationMessage} onChange={(e) => setNotificationMessage(e.target.value)} placeholder={lc("Shown to the requester when they track", "கண்காணிக்கும்போது தெரியும்")} data-testid="input-drawer-notification" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{lc("Internal note", "உள் குறிப்பு")}</label>
                <Textarea rows={2} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} data-testid="input-drawer-note" />
              </div>

              {err && <p className="text-sm text-red-600">{err}</p>}

              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={approve} className="bg-green-600 hover:bg-green-700" data-testid="button-approve">
                  <CheckCircle className="w-4 h-4 mr-1" />{lc("Approve", "அங்கீகரி")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={reschedule} data-testid="button-reschedule">
                  <CalendarClock className="w-4 h-4 mr-1" />{lc("Reschedule", "மறுதிட்டம்")}
                </Button>
                <Button size="sm" disabled={busy} onClick={complete} className="bg-emerald-600 hover:bg-emerald-700" data-testid="button-complete">
                  <CheckCheck className="w-4 h-4 mr-1" />{lc("Complete", "முடி")}
                </Button>
              </div>

              <div className="border-t pt-3 space-y-2">
                <label className="text-xs text-muted-foreground">{lc("Rejection reason", "நிராகரிப்பு காரணம்")}</label>
                <Textarea rows={2} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} data-testid="input-drawer-rejection" />
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={busy} onClick={reject} data-testid="button-reject">
                    <XCircle className="w-4 h-4 mr-1" />{lc("Reject", "நிராகரி")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={cancel} data-testid="button-cancel-appt">
                    <RotateCcw className="w-4 h-4 mr-1" />{lc("Cancel", "ரத்து")}
                  </Button>
                </div>
              </div>

              {canDelete && (
                <div className="border-t pt-3">
                  <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" disabled={busy} onClick={handleDelete} data-testid="button-delete-appt">
                    <Trash2 className="w-4 h-4 mr-1" />{lc("Delete", "நீக்கு")}
                  </Button>
                </div>
              )}

              {busy && <div className="flex justify-center"><Loader2 className="w-4 h-4 animate-spin" /></div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
