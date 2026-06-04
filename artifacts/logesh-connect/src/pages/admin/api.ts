import { getToken } from "@/lib/auth";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

async function authFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const adminApi = {
  getDashboard: () => authFetch("/admin/dashboard"),
  // News
  getNews: (page = 1, limit = 20, category?: string) =>
    authFetch(`/news?page=${page}&limit=${limit}${category ? `&category=${encodeURIComponent(category)}` : ""}`),
  createNews: (data: unknown) => authFetch("/admin/news", { method: "POST", body: JSON.stringify(data) }),
  updateNews: (id: number, data: unknown) => authFetch(`/admin/news/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNews: (id: number) => authFetch(`/admin/news/${id}`, { method: "DELETE" }),
  // Events
  getEvents: (page = 1, limit = 20) => authFetch(`/events?page=${page}&limit=${limit}`),
  createEvent: (data: unknown) => authFetch("/admin/events", { method: "POST", body: JSON.stringify(data) }),
  updateEvent: (id: number, data: unknown) => authFetch(`/admin/events/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteEvent: (id: number) => authFetch(`/admin/events/${id}`, { method: "DELETE" }),
  // Activities
  getActivities: (page = 1, limit = 20) => authFetch(`/activities?page=${page}&limit=${limit}`),
  createActivity: (data: unknown) => authFetch("/admin/activities", { method: "POST", body: JSON.stringify(data) }),
  updateActivity: (id: number, data: unknown) => authFetch(`/admin/activities/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteActivity: (id: number) => authFetch(`/admin/activities/${id}`, { method: "DELETE" }),
  // Gallery
  getGallery: (page = 1, limit = 30, album?: string) =>
    authFetch(`/gallery?page=${page}&limit=${limit}${album ? `&album=${encodeURIComponent(album)}` : ""}`),
  createGallery: (data: unknown) => authFetch("/admin/gallery", { method: "POST", body: JSON.stringify(data) }),
  updateGallery: (id: number, data: unknown) => authFetch(`/admin/gallery/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteGallery: (id: number) => authFetch(`/admin/gallery/${id}`, { method: "DELETE" }),
  // Volunteers
  getVolunteers: (page = 1, status?: string) =>
    authFetch(`/admin/volunteers?page=${page}&limit=20${status ? `&status=${status}` : ""}`),
  updateVolunteerStatus: (id: number, status: string) =>
    authFetch(`/admin/volunteers/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  exportVolunteersCSV: () => authFetch("/admin/volunteers/export"),
  // FAQs
  getFaqs: () => authFetch("/admin/faqs"),
  createFaq: (data: unknown) => authFetch("/admin/faqs", { method: "POST", body: JSON.stringify(data) }),
  updateFaq: (id: number, data: unknown) => authFetch(`/admin/faqs/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteFaq: (id: number) => authFetch(`/admin/faqs/${id}`, { method: "DELETE" }),
  // About CMS
  getAbout: () => authFetch("/admin/about"),
  updateAbout: (data: unknown) => authFetch("/admin/about", { method: "PUT", body: JSON.stringify(data) }),
  // Home Hero CMS (stored under settings key "home_hero")
  getHomeHero: () => authFetch("/admin/settings").then((s: Record<string, unknown>) => (s?.home_hero ?? null)),
  updateHomeHero: (data: unknown) => authFetch(`/admin/settings/home_hero`, { method: "PUT", body: JSON.stringify(data) }),
  // Site Settings
  getSettings: () => authFetch("/admin/settings"),
  updateSetting: (key: string, value: unknown) => authFetch(`/admin/settings/${key}`, { method: "PUT", body: JSON.stringify(value) }),
  // Banners
  getBanners: () => authFetch("/admin/banners"),
  createBanner: (data: unknown) => authFetch("/admin/banners", { method: "POST", body: JSON.stringify(data) }),
  updateBanner: (id: number, data: unknown) => authFetch(`/admin/banners/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteBanner: (id: number) => authFetch(`/admin/banners/${id}`, { method: "DELETE" }),
  // Constituency Stats
  getConstituencyStats: () => authFetch("/admin/constituency-stats"),
  updateConstituencyStats: (data: unknown) => authFetch("/admin/constituency-stats", { method: "PUT", body: JSON.stringify(data) }),
  // Grievances
  getGrievances: (page = 1, status?: string) =>
    authFetch(`/grievances?page=${page}&limit=20${status ? `&status=${status}` : ""}`),
  exportGrievancesCSV: () => authFetch("/admin/grievances/export"),
  bulkGrievanceStatus: (ids: number[], status: string) =>
    authFetch("/admin/grievances/bulk-status", { method: "POST", body: JSON.stringify({ ids, status }) }),
  updateGrievanceStatus: (id: number, status: string, note?: string) =>
    authFetch(`/grievances/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, ...(note ? { note } : {}) }) }),
  // Audit log
  getAuditLog: (limit = 50) => authFetch(`/admin/audit-log?limit=${limit}`),
  // Wards
  getWards: () => authFetch("/admin/wards"),
  createWard: (data: unknown) => authFetch("/admin/wards", { method: "POST", body: JSON.stringify(data) }),
  updateWard: (id: number, data: unknown) => authFetch(`/admin/wards/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteWard: (id: number) => authFetch(`/admin/wards/${id}`, { method: "DELETE" }),
  // Constituency hierarchy
  getHierarchyTree: () => authFetch("/admin/hierarchy/tree"),
  getWardBooths: (wardId: number) => authFetch(`/admin/hierarchy/wards/${wardId}/polling-stations`),
  createZone:   (data: unknown) => authFetch("/admin/hierarchy/zones",   { method: "POST", body: JSON.stringify(data) }),
  updateZone:   (id: number, data: unknown) => authFetch(`/admin/hierarchy/zones/${id}`,   { method: "PUT", body: JSON.stringify(data) }),
  deleteZone:   (id: number) => authFetch(`/admin/hierarchy/zones/${id}`, { method: "DELETE" }),
  createHWard:  (data: unknown) => authFetch("/admin/hierarchy/wards",   { method: "POST", body: JSON.stringify(data) }),
  updateHWard:  (id: number, data: unknown) => authFetch(`/admin/hierarchy/wards/${id}`,   { method: "PUT", body: JSON.stringify(data) }),
  deleteHWard:  (id: number) => authFetch(`/admin/hierarchy/wards/${id}`, { method: "DELETE" }),
  createArea:   (data: unknown) => authFetch("/admin/hierarchy/areas",   { method: "POST", body: JSON.stringify(data) }),
  updateArea:   (id: number, data: unknown) => authFetch(`/admin/hierarchy/areas/${id}`,   { method: "PUT", body: JSON.stringify(data) }),
  deleteArea:   (id: number) => authFetch(`/admin/hierarchy/areas/${id}`, { method: "DELETE" }),
  createStreet: (data: unknown) => authFetch("/admin/hierarchy/streets", { method: "POST", body: JSON.stringify(data) }),
  updateStreet: (id: number, data: unknown) => authFetch(`/admin/hierarchy/streets/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteStreet: (id: number) => authFetch(`/admin/hierarchy/streets/${id}`, { method: "DELETE" }),
  createBooth:  (data: unknown) => authFetch("/admin/hierarchy/polling-stations", { method: "POST", body: JSON.stringify(data) }),
  updateBooth:  (id: number, data: unknown) => authFetch(`/admin/hierarchy/polling-stations/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteBooth:  (id: number) => authFetch(`/admin/hierarchy/polling-stations/${id}`, { method: "DELETE" }),
  getPincodes:  () => authFetch("/admin/hierarchy/pincodes"),
  createPincode: (data: unknown) => authFetch("/admin/hierarchy/pincodes", { method: "POST", body: JSON.stringify(data) }),
  updatePincode: (id: number, data: unknown) => authFetch(`/admin/hierarchy/pincodes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deletePincode: (id: number) => authFetch(`/admin/hierarchy/pincodes/${id}`, { method: "DELETE" }),
  // Voter Roll
  getVoterStats:    () => authFetch("/admin/voters/stats"),
  getVoterCoverage: () => authFetch("/admin/voters/coverage"),
  getVoterImports:  () => authFetch("/admin/voters/imports"),
  getVoterImport:   (id: number, full = false) => authFetch(`/admin/voters/imports/${id}${full ? "?full=1" : ""}`),
  commitVoterImport: (id: number, pollingStationId?: number | null) =>
    authFetch(`/admin/voters/imports/${id}/commit`, {
      method: "POST",
      body: JSON.stringify({ pollingStationId: pollingStationId ?? null }),
    }),
  discardVoterImport: (id: number) =>
    authFetch(`/admin/voters/imports/${id}`, { method: "DELETE" }),
  // Voter editing / deletion (super_admin only)
  patchVoter: (id: number, patch: Record<string, unknown>) =>
    authFetch(`/admin/voters/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteVoter: (id: number) =>
    authFetch(`/admin/voters/${id}`, { method: "DELETE" }),
  bulkDeleteVotersPreview: (filter: Record<string, unknown>) =>
    authFetch(`/admin/voters/bulk-delete/preview`, {
      method: "POST", body: JSON.stringify({ filter }),
    }) as Promise<{ count: number; sampleEpics: string[]; sample: Array<{ epicNumber: string; fullName: string }> }>,
  bulkDeleteVotersByFilter: (filter: Record<string, unknown>, confirmCount: number) =>
    authFetch(`/admin/voters/bulk-delete`, {
      method: "POST", body: JSON.stringify({ filter, confirmCount }),
    }) as Promise<{ ok: boolean; deletedCount: number }>,
  bulkDeleteVotersByIds: (voterIds: number[]) =>
    authFetch(`/admin/voters/bulk-delete`, {
      method: "POST", body: JSON.stringify({ voterIds }),
    }) as Promise<{ ok: boolean; deletedCount: number }>,
  // Voter advanced — duplicates / merge / bulk-ops / contact / relations / timeline / segments / analytics / callsheet
  getVoterDuplicates: (limit = 50) =>
    authFetch(`/admin/voters/duplicates?limit=${limit}`) as Promise<{ groups: Array<{ key: string; nameKey: string; age: number | null; pollingStationId: number | null; count: number; members: Array<Record<string, unknown>> }>; total: number }>,
  mergeVoters: (primaryId: number, duplicateIds: number[]) =>
    authFetch(`/admin/voters/merge`, { method: "POST", body: JSON.stringify({ primaryId, duplicateIds }) }) as Promise<{ ok: boolean; primaryId: number; mergedCount: number }>,
  bulkVoterOp: (body: Record<string, unknown>) =>
    authFetch(`/admin/voters/bulk`, { method: "POST", body: JSON.stringify(body) }) as Promise<{ ok: boolean; affectedCount: number }>,
  getVoterContactLog: (voterId: number) =>
    authFetch(`/admin/voters/${voterId}/contact-log`) as Promise<{ items: Array<Record<string, unknown>> }>,
  createVoterContactLog: (voterId: number, body: Record<string, unknown>) =>
    authFetch(`/admin/voters/${voterId}/contact-log`, { method: "POST", body: JSON.stringify(body) }),
  deleteVoterContactLog: (voterId: number, logId: number) =>
    authFetch(`/admin/voters/${voterId}/contact-log/${logId}`, { method: "DELETE" }),
  getVoterRelations: (voterId: number) =>
    authFetch(`/admin/voters/${voterId}/relations`) as Promise<{ items: Array<Record<string, unknown>> }>,
  createVoterRelation: (voterId: number, body: Record<string, unknown>) =>
    authFetch(`/admin/voters/${voterId}/relations`, { method: "POST", body: JSON.stringify(body) }),
  deleteVoterRelation: (voterId: number, relationId: number) =>
    authFetch(`/admin/voters/${voterId}/relations/${relationId}`, { method: "DELETE" }),
  getVoterTimeline: (voterId: number) =>
    authFetch(`/admin/voters/${voterId}/timeline`) as Promise<{ items: Array<{ kind: string; at: string; data: Record<string, unknown> }> }>,
  getVoterSegments: () =>
    authFetch(`/admin/voter-segments`) as Promise<{ items: Array<Record<string, unknown>> }>,
  createVoterSegment: (body: Record<string, unknown>) =>
    authFetch(`/admin/voter-segments`, { method: "POST", body: JSON.stringify(body) }),
  updateVoterSegment: (id: number, body: Record<string, unknown>) =>
    authFetch(`/admin/voter-segments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteVoterSegment: (id: number) =>
    authFetch(`/admin/voter-segments/${id}`, { method: "DELETE" }),
  refreshVoterSegmentCount: (id: number) =>
    authFetch(`/admin/voter-segments/${id}/refresh-count`, { method: "POST" }) as Promise<{ count: number; lastCountAt: string }>,
  getVoterAnalytics: (wardId?: number) =>
    authFetch(`/admin/voters/analytics${wardId ? `?wardId=${wardId}` : ""}`) as Promise<{
      totalVoters: number;
      byGender: Array<{ gender: string; n: number }>;
      byAgeBand: Array<{ band: string; n: number }>;
      byBooth: Array<{ polling_station_id: number | null; booth_no: string | null; name: string | null; n: number }>;
      byTag: Array<{ id: number; name: string; color: string; n: number }>;
      phoneCoverage: { withPhone: number; total: number; percent: number };
      whatsappOptIn: number;
      grievancesByBooth: Array<{ polling_station_id: number | null; booth_no: string | null; n: number }>;
    }>,
  getVoterCallsheet: (body: Record<string, unknown>) =>
    authFetch(`/admin/voters/callsheet`, { method: "POST", body: JSON.stringify(body) }) as Promise<{ groups: Array<{ key: string; label: string; members: Array<Record<string, unknown>> }>; total: number }>,
  // Multipart upload — bypasses authFetch JSON wrapper.
  uploadVoterPdfs: async (files: File[], expectedBoothNo?: string) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    if (expectedBoothNo) fd.append("expectedBoothNo", expectedBoothNo);
    const token = getToken();
    const res = await fetch(`${BASE}/admin/voters/import`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Upload failed" }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ imports: Array<{ id: number; filename: string; status: string; error?: string }> }>;
  },
  // Grievance bulk assign
  bulkGrievanceAssign: (ids: number[], officerId: number, officerName: string) =>
    authFetch("/admin/grievances/bulk-assign", { method: "POST", body: JSON.stringify({ ids, officerId, officerName }) }),
  // Social media
  getSocialAccounts: () => authFetch("/admin/social/accounts"),
  createSocialAccount: (data: unknown) => authFetch("/admin/social/accounts", { method: "POST", body: JSON.stringify(data) }),
  updateSocialAccount: (id: number, data: unknown) => authFetch(`/admin/social/accounts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSocialAccount: (id: number) => authFetch(`/admin/social/accounts/${id}`, { method: "DELETE" }),
  refreshSocialStats: (id: number) => authFetch(`/admin/social/accounts/${id}/refresh-stats`, { method: "POST" }),
  getLatestSocialStats: () => authFetch("/admin/social/stats/latest"),
  getSocialPosts: (limit = 50) => authFetch(`/admin/social/posts?limit=${limit}`),
  createSocialPost: (data: unknown) => authFetch("/admin/social/posts", { method: "POST", body: JSON.stringify(data) }),
  deleteSocialPost: (id: number) => authFetch(`/admin/social/posts/${id}`, { method: "DELETE" }),
  publishSocialPost: (id: number) => authFetch(`/admin/social/posts/${id}/publish`, { method: "POST" }),
  getSocialCapabilities: () => authFetch("/admin/social/capabilities"),
  getSocialOAuthUrl: (platform: string) => authFetch(`/admin/social/oauth/start/${encodeURIComponent(platform)}`),
  disconnectSocialAccount: (id: number) => authFetch(`/admin/social/accounts/${id}/disconnect`, { method: "POST" }),
  // Promises
  getPromises: () => authFetch("/admin/promises"),
  getPublicPromises: () => authFetch("/promises"),
  createPromise: (data: unknown) => authFetch("/admin/promises", { method: "POST", body: JSON.stringify(data) }),
  updatePromise: (id: number, data: unknown) => authFetch(`/admin/promises/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deletePromise: (id: number) => authFetch(`/admin/promises/${id}`, { method: "DELETE" }),
  // Constituency Development Index
  getCdi: () => authFetch("/admin/cdi"),
  // AI tools
  triageGrievance: (id: number) => authFetch(`/admin/ai/triage-grievance/${id}`, { method: "POST" }),
  similarGrievances: (id: number) => authFetch(`/admin/grievances/${id}/similar`),
  generatePressRelease: (data: unknown) => authFetch("/admin/ai/press-release", { method: "POST", body: JSON.stringify(data) }),
  analyzeSentiment: (data: unknown) => authFetch("/admin/ai/sentiment", { method: "POST", body: JSON.stringify(data) }),
  suggestResolution: (id: number) => authFetch(`/admin/grievances/${id}/suggest-resolution`, { method: "POST" }),
  getSentimentTrend: (days = 30) => authFetch(`/admin/analytics/sentiment-trend?days=${days}`),
  generateSocialPost: (data: unknown) => authFetch("/admin/ai/social-post", { method: "POST", body: JSON.stringify(data) }),
  getHeadlineSuggestions: (data: unknown) => authFetch("/admin/ai/headline-suggestions", { method: "POST", body: JSON.stringify(data) }),
  expandActivity: (data: unknown) => authFetch("/admin/ai/expand-activity", { method: "POST", body: JSON.stringify(data) }),
  askAi: (data: unknown) => authFetch("/admin/ai/ask", { method: "POST", body: JSON.stringify(data) }),
  suggestSlot: (id: number) => authFetch(`/admin/appointments/${id}/suggest-slot`, { method: "POST" }),
  getAiUsageLog: () => authFetch("/admin/ai/usage-log"),
  getAiSettings: () => authFetch("/admin/settings").then((s: Record<string, unknown>) => (s?.ai_settings as Record<string, unknown> | null ?? null)),
  updateAiSettings: (data: unknown) => authFetch("/admin/settings/ai_settings", { method: "PUT", body: JSON.stringify(data) }),
  // Press coverage
  getPressCoverage: () => authFetch("/admin/press-coverage"),
  getPublicPressCoverage: () => authFetch("/press-coverage"),
  refreshPressCoverage: (query?: string) => authFetch("/admin/press-coverage/refresh", { method: "POST", body: JSON.stringify({ query }) }),
  deletePressCoverage: (id: number) => authFetch(`/admin/press-coverage/${id}`, { method: "DELETE" }),
  // Batch-3 analytics
  getSla: (from: string, to: string) => authFetch(`/admin/analytics/sla?from=${from}&to=${to}`),
  getEscalations: () => authFetch("/admin/analytics/escalations"),
  getOutreach: (from: string, to: string) => authFetch(`/admin/analytics/outreach?from=${from}&to=${to}`),
  getHeatmapTimeline: (from: string, to: string) => authFetch(`/admin/analytics/heatmap-timeline?from=${from}&to=${to}`),
  // Tasks (internal team to-do)
  getTasks: (params?: { mine?: boolean; status?: string; priority?: string; assignedTo?: number }) => {
    const q = new URLSearchParams();
    if (params?.mine) q.set("mine", "1");
    if (params?.status) q.set("status", params.status);
    if (params?.priority) q.set("priority", params.priority);
    if (params?.assignedTo != null) q.set("assignedTo", String(params.assignedTo));
    const qs = q.toString();
    return authFetch(`/admin/tasks${qs ? `?${qs}` : ""}`);
  },
  getTaskAssignees: () => authFetch("/admin/tasks/assignees"),
  createTask: (data: unknown) => authFetch("/admin/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: number, data: unknown) => authFetch(`/admin/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id: number) => authFetch(`/admin/tasks/${id}`, { method: "DELETE" }),
  // Appointments
  getAppointments: (params?: { page?: number; limit?: number; status?: string; category?: string; q?: string; from?: string; to?: string }) => {
    const qp = new URLSearchParams();
    if (params?.page) qp.set("page", String(params.page));
    if (params?.limit) qp.set("limit", String(params.limit));
    if (params?.status) qp.set("status", params.status);
    if (params?.category) qp.set("category", params.category);
    if (params?.q) qp.set("q", params.q);
    if (params?.from) qp.set("from", params.from);
    if (params?.to) qp.set("to", params.to);
    const qs = qp.toString();
    return authFetch(`/admin/appointments${qs ? `?${qs}` : ""}`);
  },
  getAppointment: (id: number) => authFetch(`/admin/appointments/${id}`),
  getAppointmentStats: () => authFetch("/admin/appointments/stats"),
  createAppointment: (data: unknown) =>
    authFetch(`/admin/appointments`, { method: "POST", body: JSON.stringify(data) }),
  updateAppointment: (id: number, data: unknown) =>
    authFetch(`/admin/appointments/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteAppointment: (id: number) => authFetch(`/admin/appointments/${id}`, { method: "DELETE" }),
  exportAppointmentsCSV: async () => {
    const token = getToken();
    const res = await fetch(`${BASE}/admin/appointments/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  // Image upload (multipart)
  uploadImage: async (file: File): Promise<{ url: string; filename: string }> => {
    const token = getToken();
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/admin/upload`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
    return data;
  },
};
