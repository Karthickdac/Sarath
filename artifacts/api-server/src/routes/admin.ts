import { Router } from "express";
import { db } from "@workspace/db";
import {
  newsTable, eventsTable, activitiesTable, galleryTable,
  volunteersTable, faqsTable, grievancesTable, usersTable,
  siteConfigTable, auditLogTable, bannersTable, constituencyStatsTable, wardsTable,
  zonesTable, areasTable, streetsTable, pollingStationsTable,
  pincodesTable, pincodeWardsTable,
  officerAssignmentsTable, grievanceRoutingLogTable, volunteerAssignmentsTable,
  tasksTable,
  appointmentsTable, APPOINTMENT_STATUSES, APPOINTMENT_CATEGORIES,
} from "@workspace/db/schema";

import { requireStaff, requireRole, type AuthRequest } from "../lib/auth.js";
import { logRouting } from "../lib/grievance-routing.js";
import { invalidateAiSettings } from "../lib/ai-settings.js";
import { eq, desc, asc, sql, gte, lte, and, inArray } from "drizzle-orm";
import { z } from "zod";
import multer from "multer";
import path from "path";
import sharp from "sharp";
import { uploadAdminImage } from "../lib/objectStorage.js";

// ── Image upload config (CMS forms) ────────────────────────
// Uploads are streamed to Replit Object Storage so they survive redeploys
// and container restarts. Legacy files under artifacts/api-server/uploads/admin
// are still served by app.ts for backwards compatibility.
const adminUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^\.(jpe?g|png|gif|webp|svg)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// Resize/compress raster images before persisting. SVGs and small images pass
// through unchanged. Returns the stored filename and final byte size, plus
// an optional small ~400px WebP thumbnail for snappy listing pages.
const MAX_DIMENSION = 1600;
const THUMB_WIDTH = 400;
const COMPRESS_THRESHOLD_BYTES = 300 * 1024; // skip re-encoding for already-small files

type PersistedUpload = {
  filename: string;
  size: number;
  mimeType: string;
  thumbnailFilename?: string;
};

async function generateThumbnail(srcBuffer: Buffer, baseName: string): Promise<string | undefined> {
  try {
    const thumb = await sharp(srcBuffer, { failOn: "none" })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72, effort: 4 })
      .toBuffer();
    const thumbFilename = `${baseName}.thumb.webp`;
    await uploadAdminImage(thumbFilename, thumb, "image/webp");
    return thumbFilename;
  } catch (e) {
    console.warn("[admin] thumbnail generation failed:", e);
    return undefined;
  }
}

async function persistAdminUpload(file: Express.Multer.File): Promise<PersistedUpload> {
  const ext = path.extname(file.originalname).toLowerCase();
  const baseName = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const writeBuffer = async (
    filename: string,
    buf: Buffer,
    mime: string,
    thumbnailFilename?: string,
  ): Promise<PersistedUpload> => {
    await uploadAdminImage(filename, buf, mime);
    return { filename, size: buf.length, mimeType: mime, thumbnailFilename };
  };

  // Pass-through for SVG and animated GIF — sharp doesn't usefully compress these here.
  // SVGs are already tiny and resolution-independent; GIFs may be animated and we
  // don't want to drop frames. No thumbnail is generated for these.
  if (ext === ".svg" || ext === ".gif") {
    const mime = MIME_BY_EXT[ext] ?? file.mimetype;
    return writeBuffer(`${baseName}${ext}`, file.buffer, mime);
  }

  // Try to read metadata; if sharp can't decode it, fall back to original bytes.
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(file.buffer).metadata();
  } catch {
    const mime = MIME_BY_EXT[ext] ?? file.mimetype;
    return writeBuffer(`${baseName}${ext}`, file.buffer, mime);
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const needsRecompress = file.buffer.length > COMPRESS_THRESHOLD_BYTES;

  // Always try to produce a small WebP thumbnail for raster images, even when
  // the original passes through unchanged — listing pages still benefit.
  const thumbnailFilename = await generateThumbnail(file.buffer, baseName);

  if (!needsResize && !needsRecompress) {
    const mime = MIME_BY_EXT[ext] ?? file.mimetype;
    return writeBuffer(`${baseName}${ext}`, file.buffer, mime, thumbnailFilename);
  }

  const pipeline = sharp(file.buffer, { failOn: "none" }).rotate();
  if (needsResize) {
    pipeline.resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Re-encode as WebP for best size/quality tradeoff while preserving alpha.
  const out = await pipeline.webp({ quality: 82, effort: 4 }).toBuffer();
  return writeBuffer(`${baseName}.webp`, out, "image/webp", thumbnailFilename);
}

/** Accepts an http(s) URL OR a server-relative path under /api/storage, /uploads, or /api/uploads. */
const ImageRef = z
  .string()
  .refine(
    (v) =>
      v === "" ||
      /^https?:\/\//i.test(v) ||
      v.startsWith("/api/storage/") ||
      v.startsWith("/uploads/") ||
      v.startsWith("/api/uploads/"),
    { message: "Must be a URL or an /api/storage/ path" },
  );

// ── Role constants used across routes ──────────────────────
const CMS_ROLES       = ["super_admin", "admin", "pa_staff", "media_team"] as const;
const EVENTS_ROLES    = ["super_admin", "admin", "pa_staff", "media_team", "constituency_coordinator"] as const;
const VOLUNTEER_ROLES = ["super_admin", "admin", "grievance_officer", "constituency_coordinator"] as const;
const WARD_ROLES      = ["super_admin", "admin", "constituency_coordinator"] as const;

const router = Router();

router.use(requireStaff);

async function logAudit(req: AuthRequest, action: string, target: string, detail?: string) {
  try {
    await db.insert(auditLogTable).values({
      actorId: req.user?.id ?? null,
      actorName: req.user?.name ?? "Unknown",
      action,
      target,
      detail: detail ?? null,
    });
  } catch {
    // audit log is non-critical
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/admin/dashboard — KPI + chart data
// ──────────────────────────────────────────────────────────
router.get("/admin/dashboard", async (_req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      [{ totalGrievances }],
      [{ openGrievances }],
      [{ resolvedGrievances }],
      [{ totalVolunteers }],
      [{ pendingVolunteers }],
      [{ approvedVolunteers }],
      [{ newVolunteersThisWeek }],
      [{ grievancesNewToday }],
      [{ grievancesResolvedToday }],
      [{ broadcastReach }],
      [{ eventsThisMonth }],
      [{ totalNews }],
      [{ totalActivities }],
      [{ totalGallery }],
      [{ avgResolutionHours }],
      grievancesByCategory,
      grievancesByStatus,
      grievancesByPriority,
      recentAuditLog,
    ] = await Promise.all([
      db.select({ totalGrievances: sql<number>`count(*)::int` }).from(grievancesTable),
      db.select({ openGrievances: sql<number>`count(*)::int` }).from(grievancesTable)
        .where(sql`status NOT IN ('Resolved','Closed')`),
      db.select({ resolvedGrievances: sql<number>`count(*)::int` }).from(grievancesTable)
        .where(sql`status IN ('Resolved','Closed')`),
      db.select({ totalVolunteers: sql<number>`count(*)::int` }).from(volunteersTable),
      db.select({ pendingVolunteers: sql<number>`count(*)::int` }).from(volunteersTable)
        .where(eq(volunteersTable.status, "pending")),
      db.select({ approvedVolunteers: sql<number>`count(*)::int` }).from(volunteersTable)
        .where(eq(volunteersTable.status, "approved")),
      db.select({ newVolunteersThisWeek: sql<number>`count(*)::int` }).from(volunteersTable)
        .where(gte(volunteersTable.createdAt, weekAgo)),
      db.select({ grievancesNewToday: sql<number>`count(*)::int` }).from(grievancesTable)
        .where(gte(grievancesTable.createdAt, startOfToday)),
      db.select({ grievancesResolvedToday: sql<number>`count(*)::int` }).from(grievancesTable)
        .where(sql`resolved_at >= ${startOfToday}`),
      // Broadcast reach = total audience across social channels (latest follower
      // snapshot per account). Returns 0 when no social accounts/snapshots exist.
      db.execute(sql`
        SELECT coalesce(sum(followers), 0)::int AS "broadcastReach" FROM (
          SELECT DISTINCT ON (account_id) followers
          FROM social_stats_snapshots
          ORDER BY account_id, captured_at DESC
        ) latest
      `).then((r) => r.rows as Array<{ broadcastReach: number }>),
      db.select({ eventsThisMonth: sql<number>`count(*)::int` }).from(eventsTable)
        .where(gte(eventsTable.eventDate, startOfMonth)),
      db.select({ totalNews: sql<number>`count(*)::int` }).from(newsTable),
      db.select({ totalActivities: sql<number>`count(*)::int` }).from(activitiesTable),
      db.select({ totalGallery: sql<number>`count(*)::int` }).from(galleryTable),
      // Avg resolution time in hours for resolved/closed grievances
      db.select({
        avgResolutionHours: sql<number>`
          coalesce(
            round(
              avg(extract(epoch from (resolved_at - created_at)) / 3600)::numeric, 1
            )::float, 0
          )
        `,
      }).from(grievancesTable)
        .where(sql`status IN ('Resolved','Closed') AND resolved_at IS NOT NULL`),
      db.select({ category: grievancesTable.category, count: sql<number>`count(*)::int` })
        .from(grievancesTable).groupBy(grievancesTable.category).orderBy(desc(sql`count(*)`)).limit(10),
      db.select({ status: grievancesTable.status, count: sql<number>`count(*)::int` })
        .from(grievancesTable).groupBy(grievancesTable.status),
      db.select({ priority: grievancesTable.priority, count: sql<number>`count(*)::int` })
        .from(grievancesTable).groupBy(grievancesTable.priority),
      db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt)).limit(20),
    ]);

    // Monthly trend: last 6 months of grievance submissions
    const monthlyRows = await db.select({
      month: sql<string>`to_char(created_at, 'YYYY-MM')`,
      submitted: sql<number>`count(*)::int`,
      resolved: sql<number>`sum(case when status in ('Resolved','Closed') then 1 else 0 end)::int`,
    }).from(grievancesTable)
      .where(gte(grievancesTable.createdAt, new Date(now.getFullYear(), now.getMonth() - 5, 1)))
      .groupBy(sql`to_char(created_at, 'YYYY-MM')`)
      .orderBy(sql`to_char(created_at, 'YYYY-MM')`);

    const resolutionRate = totalGrievances > 0 ? Math.round((resolvedGrievances / totalGrievances) * 100) : 0;

    res.json({
      kpi: {
        totalGrievances,
        openGrievances,
        resolvedGrievances,
        resolutionRate,
        avgResolutionHours,
        totalVolunteers,
        pendingVolunteers,
        approvedVolunteers,
        newVolunteersThisWeek,
        grievancesNewToday,
        grievancesResolvedToday,
        broadcastReach,
        eventsThisMonth,
        totalNews,
        totalActivities,
        totalGallery,
      },
      grievancesByCategory,
      grievancesByStatus,
      grievancesByPriority,
      monthlyTrend: monthlyRows,
      recentAuditLog: recentAuditLog.map(l => ({ ...l, createdAt: l.createdAt.toISOString() })),
    });
  } catch (err) {
    console.error("[admin] dashboard error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/admin/upload — image upload for CMS forms
// ──────────────────────────────────────────────────────────
router.post(
  "/admin/upload",
  requireRole(...CMS_ROLES, "constituency_coordinator"),
  (req: AuthRequest, res, next) => {
    adminUpload.single("file")(req, res, async (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        res.status(400).json({ error: msg });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded (field name: 'file')" });
        return;
      }
      try {
        const saved = await persistAdminUpload(req.file);
        // /api/storage/admin/* serves directly from Replit Object Storage (where
        // the file was just written). It is mounted under /api so the dev/prod
        // path-based proxy (which only routes /api to this service) can reach it.
        const url = `/api/storage/admin/${saved.filename}`;
        const thumbnailUrl = saved.thumbnailFilename
          ? `/api/storage/admin/${saved.thumbnailFilename}`
          : null;
        logAudit(req, "UPLOAD", `image:${saved.filename}`, `${req.file.originalname} (${req.file.size}→${saved.size} bytes)`).catch(() => null);
        res.status(201).json({
          url,
          thumbnailUrl,
          filename: saved.filename,
          thumbnailFilename: saved.thumbnailFilename ?? null,
          originalName: req.file.originalname,
          size: saved.size,
          originalSize: req.file.size,
          mimeType: saved.mimeType,
        });
        next?.();
      } catch (e) {
        console.error("[admin] upload processing error:", e);
        res.status(500).json({ error: "Failed to process image" });
      }
    });
  },
);

// ──────────────────────────────────────────────────────────
// NEWS CRUD
// ──────────────────────────────────────────────────────────
const NewsBody = z.object({
  title: z.string().min(2),
  titleTa: z.string().optional().nullable(),
  content: z.string().min(10),
  contentTa: z.string().optional().nullable(),
  imageUrl: ImageRef.optional().nullable(),
  thumbnailUrl: ImageRef.optional().nullable(),
  category: z.string().default("general"),
  featured: z.boolean().default(false),
  publishedAt: z.string().optional().nullable(),
});

router.post("/admin/news", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = NewsBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { publishedAt, imageUrl, thumbnailUrl, ...rest } = body.data;
    const [item] = await db.insert(newsTable).values({
      ...rest,
      imageUrl: imageUrl || null,
      thumbnailUrl: thumbnailUrl || null,
      publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
    }).returning();
    await logAudit(req, "CREATE", `news:${item.id}`, item.title);
    res.status(201).json({ ...item, publishedAt: item.publishedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] news create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/news/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = NewsBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { publishedAt, imageUrl, thumbnailUrl, ...rest } = body.data;
    const [item] = await db.update(newsTable).set({
      ...rest,
      ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      ...(thumbnailUrl !== undefined && { thumbnailUrl: thumbnailUrl || null }),
      ...(publishedAt !== undefined && { publishedAt: publishedAt ? new Date(publishedAt) : null }),
    }).where(eq(newsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `news:${id}`, item.title);
    res.json({ ...item, publishedAt: item.publishedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] news update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/news/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(newsTable).where(eq(newsTable.id, id));
    await logAudit(req, "DELETE", `news:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] news delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// EVENTS CRUD
// ──────────────────────────────────────────────────────────
const EventBody = z.object({
  title: z.string().min(2),
  titleTa: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  descriptionTa: z.string().optional().nullable(),
  imageUrl: ImageRef.optional().nullable(),
  thumbnailUrl: ImageRef.optional().nullable(),
  venue: z.string().min(2),
  eventDate: z.string(),
  endDate: z.string().optional().nullable(),
  category: z.string().default("general"),
});

router.post("/admin/events", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = EventBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { imageUrl, thumbnailUrl, endDate, ...rest } = body.data;
    const [item] = await db.insert(eventsTable).values({
      ...rest,
      imageUrl: imageUrl || null,
      thumbnailUrl: thumbnailUrl || null,
      eventDate: new Date(rest.eventDate),
      endDate: endDate ? new Date(endDate) : null,
    }).returning();
    await logAudit(req, "CREATE", `events:${item.id}`, item.title);
    res.status(201).json({ ...item, eventDate: item.eventDate.toISOString(), endDate: item.endDate?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] events create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/events/:id", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = EventBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { imageUrl, thumbnailUrl, eventDate, endDate, ...rest } = body.data;
    const [item] = await db.update(eventsTable).set({
      ...rest,
      ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      ...(thumbnailUrl !== undefined && { thumbnailUrl: thumbnailUrl || null }),
      ...(eventDate && { eventDate: new Date(eventDate) }),
      ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : null }),
    }).where(eq(eventsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `events:${id}`, item.title);
    res.json({ ...item, eventDate: item.eventDate.toISOString(), endDate: item.endDate?.toISOString() ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] events update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/events/:id", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(eventsTable).where(eq(eventsTable.id, id));
    await logAudit(req, "DELETE", `events:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] events delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// ACTIVITIES CRUD
// ──────────────────────────────────────────────────────────
const ActivityBody = z.object({
  title: z.string().min(2),
  titleTa: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  descriptionTa: z.string().optional().nullable(),
  imageUrl: ImageRef.optional().nullable(),
  thumbnailUrl: ImageRef.optional().nullable(),
  activityDate: z.string(),
  location: z.string().optional().nullable(),
  category: z.string().default("general"),
});

router.post("/admin/activities", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = ActivityBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { imageUrl, thumbnailUrl, ...rest } = body.data;
    const [item] = await db.insert(activitiesTable).values({
      ...rest,
      imageUrl: imageUrl || null,
      thumbnailUrl: thumbnailUrl || null,
      activityDate: new Date(rest.activityDate),
    }).returning();
    await logAudit(req, "CREATE", `activities:${item.id}`, item.title);
    res.status(201).json({ ...item, activityDate: item.activityDate.toISOString(), createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] activities create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/activities/:id", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = ActivityBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { imageUrl, thumbnailUrl, activityDate, ...rest } = body.data;
    const [item] = await db.update(activitiesTable).set({
      ...rest,
      ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
      ...(thumbnailUrl !== undefined && { thumbnailUrl: thumbnailUrl || null }),
      ...(activityDate && { activityDate: new Date(activityDate) }),
    }).where(eq(activitiesTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `activities:${id}`, item.title);
    res.json({ ...item, activityDate: item.activityDate.toISOString(), createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] activities update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/activities/:id", requireRole(...EVENTS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(activitiesTable).where(eq(activitiesTable.id, id));
    await logAudit(req, "DELETE", `activities:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] activities delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GALLERY CRUD + REORDER
// ──────────────────────────────────────────────────────────
const GalleryBody = z.object({
  title: z.string().min(1),
  mediaUrl: ImageRef,
  thumbnailUrl: ImageRef.optional().nullable(),
  mediaType: z.enum(["photo", "video"]).default("photo"),
  album: z.string().optional().nullable(),
  displayOrder: z.number().int().default(0),
});

router.post("/admin/gallery", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = GalleryBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { thumbnailUrl, ...rest } = body.data;
    const [item] = await db.insert(galleryTable).values({
      ...rest,
      thumbnailUrl: thumbnailUrl || null,
    }).returning();
    await logAudit(req, "CREATE", `gallery:${item.id}`, item.title);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] gallery create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/gallery/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = GalleryBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { thumbnailUrl, ...rest } = body.data;
    const [item] = await db.update(galleryTable).set({
      ...rest,
      ...(thumbnailUrl !== undefined && { thumbnailUrl: thumbnailUrl || null }),
    }).where(eq(galleryTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `gallery:${id}`, item.title);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] gallery update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/gallery/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(galleryTable).where(eq(galleryTable.id, id));
    await logAudit(req, "DELETE", `gallery:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] gallery delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// VOLUNTEERS MANAGEMENT
// ──────────────────────────────────────────────────────────
router.get("/admin/volunteers", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"))));
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const conditions = status ? [eq(volunteersTable.status, status)] : [];
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [items, [{ total }]] = await Promise.all([
      db.select().from(volunteersTable).where(where).orderBy(desc(volunteersTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(volunteersTable).where(where),
    ]);
    const totalPages = Math.ceil(total / limit);
    res.json({
      items: items.map(v => ({ ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString() })),
      total,
      page,
      totalPages,
    });
  } catch (err) {
    console.error("[admin] volunteers list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/volunteers/:id/status", requireRole(...VOLUNTEER_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = z.object({ status: z.enum(["approved", "rejected", "pending"]) }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid status" }); return; }
    const [item] = await db.update(volunteersTable).set({ status: body.data.status })
      .where(eq(volunteersTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE_STATUS", `volunteer:${id}`, `${item.name} → ${body.data.status}`);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] volunteer status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// FAQs CRUD
// ──────────────────────────────────────────────────────────
const FaqBody = z.object({
  question: z.string().min(5),
  questionTa: z.string().optional().nullable(),
  answer: z.string().min(5),
  answerTa: z.string().optional().nullable(),
  order: z.number().int().default(0),
});

router.get("/admin/faqs", async (_req, res) => {
  try {
    const faqs = await db.select().from(faqsTable).orderBy(asc(faqsTable.order));
    res.json(faqs.map(f => ({ ...f, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString() })));
  } catch (err) {
    console.error("[admin] faqs list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/faqs", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = FaqBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.insert(faqsTable).values(body.data).returning();
    await logAudit(req, "CREATE", `faq:${item.id}`, item.question);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] faq create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/faqs/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = FaqBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.update(faqsTable).set(body.data).where(eq(faqsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `faq:${id}`, item.question);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] faq update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/faqs/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(faqsTable).where(eq(faqsTable.id, id));
    await logAudit(req, "DELETE", `faq:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] faq delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// BULK GRIEVANCE ACTIONS
// ──────────────────────────────────────────────────────────
router.post("/admin/grievances/bulk-status", requireRole("super_admin", "admin", "grievance_officer"), async (req: AuthRequest, res) => {
  try {
    const body = z.object({
      ids: z.array(z.number().int()).min(1).max(200),
      status: z.enum(["Submitted", "Under Review", "Assigned", "In Progress", "Resolved", "Closed"]),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { ids, status } = body.data;
    const updated = await db.update(grievancesTable)
      .set({ status, ...(status === "Resolved" ? { resolvedAt: new Date() } : {}) })
      .where(inArray(grievancesTable.id, ids))
      .returning({ id: grievancesTable.id });
    await logAudit(req, "BULK_UPDATE", `grievances:${ids.join(",")}`, `→ ${status}`);
    res.json({ updated: updated.length });
  } catch (err) {
    console.error("[admin] bulk grievance status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// ABOUT CMS (site_config key-value store)
// ──────────────────────────────────────────────────────────
router.get("/admin/about", async (_req, res) => {
  try {
    const [row] = await db.select().from(siteConfigTable).where(eq(siteConfigTable.key, "about")).limit(1);
    if (!row) { res.json(null); return; }
    res.json(JSON.parse(row.value));
  } catch (err) {
    console.error("[admin] about get:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const OptionalUrl = z
  .string()
  .trim()
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), { message: "Must be a valid http(s) URL" });

const AboutBody = z.object({
  name: z.string().trim().min(1, "Name is required"),
  nameTa: z.string().default(""),
  designation: z.string().trim().min(1, "Designation is required"),
  designationTa: z.string().default(""),
  constituency: z.string().trim().min(1, "Constituency is required"),
  constituencyTa: z.string().default(""),
  party: z.string().trim().min(1, "Party is required"),
  partyTa: z.string().default(""),
  photoUrl: ImageRef.default(""),
  bioBrief: z.string().trim().min(1, "Brief bio is required"),
  bioBriefTa: z.string().default(""),
  bioFull: z.string().default(""),
  bioFullTa: z.string().default(""),
  education: z.string().default(""),
  born: z.string().default(""),
  phone: z.string().trim().min(1, "Phone is required"),
  email: z.string().trim().email("Invalid email address"),
  officeAddress: z.string().default(""),
  officeAddressTa: z.string().default(""),
  facebook: OptionalUrl.default(""),
  twitter: OptionalUrl.default(""),
  instagram: OptionalUrl.default(""),
  youtube: OptionalUrl.default(""),
  highlights: z.array(z.object({
    title: z.string().default(""),
    titleTa: z.string().default(""),
    value: z.string().default(""),
    icon: z.string().default("Star"),
  })).default([]),
});

router.put("/admin/about", requireRole("super_admin", "admin", "pa_staff"), async (req: AuthRequest, res) => {
  try {
    const parsed = AboutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid", details: parsed.error.issues });
      return;
    }
    const value = JSON.stringify(parsed.data);
    const existing = await db.select({ id: siteConfigTable.id }).from(siteConfigTable)
      .where(eq(siteConfigTable.key, "about")).limit(1);
    if (existing.length > 0) {
      await db.update(siteConfigTable).set({ value }).where(eq(siteConfigTable.key, "about"));
    } else {
      await db.insert(siteConfigTable).values({ key: "about", value });
    }
    await logAudit(req, "UPDATE", "site_config:about");
    res.json(parsed.data);
  } catch (err) {
    console.error("[admin] about update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// SITE SETTINGS (social links, contact info)
// ──────────────────────────────────────────────────────────
router.get("/admin/settings", async (_req, res) => {
  try {
    const rows = await db.select().from(siteConfigTable)
      .where(sql`key IN ('social_links','contact_info','emergency_contacts','home_hero','milestone_targets','ai_settings')`);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    res.json(result);
  } catch (err) {
    console.error("[admin] settings get:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Internal-only path: must start with "/" and contain no scheme or host.
// Prevents stored hostile hrefs (javascript:, http://evil) from reaching the
// public Home page CTAs via the home_hero settings blob.
const InternalPath = z.string().trim().regex(/^\/[^\s]*$/, "Must be a relative path starting with /");

const HomeHeroBody = z.object({
  badge: z.string().default(""),
  badgeTa: z.string().default(""),
  headline: z.string().trim().min(1, "Headline is required"),
  headlineTa: z.string().default(""),
  subheadline: z.string().trim().min(1, "Subheadline is required"),
  subheadlineTa: z.string().default(""),
  description: z.string().trim().min(1, "Description is required"),
  descriptionTa: z.string().default(""),
  primaryCtaLabel: z.string().trim().min(1, "Primary CTA label required"),
  primaryCtaLabelTa: z.string().default(""),
  primaryCtaHref: InternalPath,
  secondaryCtaLabel: z.string().trim().min(1, "Secondary CTA label required"),
  secondaryCtaLabelTa: z.string().default(""),
  secondaryCtaHref: InternalPath,
  photoUrl: ImageRef.default(""),
  statsHeadline: z.string().default(""),
  statsHeadlineTa: z.string().default(""),
  statsSubheadline: z.string().default(""),
  statsSubheadlineTa: z.string().default(""),
  grievanceCtaTitle: z.string().default(""),
  grievanceCtaTitleTa: z.string().default(""),
  grievanceCtaBody: z.string().default(""),
  grievanceCtaBodyTa: z.string().default(""),
  volunteerCtaTitle: z.string().default(""),
  volunteerCtaTitleTa: z.string().default(""),
  volunteerCtaBody: z.string().default(""),
  volunteerCtaBodyTa: z.string().default(""),
}).strict();

// AI settings blob (model config, prompt overrides, feature toggles). All fields
// optional — loadAiSettings() merges with defaults and clamps numeric ranges on read.
const AiSettingsBody = z.object({
  modelName: z.string().trim().min(1).max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(100).max(8000).optional(),
  featureToggles: z.object({
    autoTriage: z.boolean(),
    resolutionSuggestion: z.boolean(),
    postGenerator: z.boolean(),
    pressRelease: z.boolean(),
    headlineSuggestion: z.boolean(),
    appointmentScoring: z.boolean(),
  }).partial().optional(),
  promptTemplates: z.object({
    triage: z.string().max(4000),
    resolution: z.string().max(4000),
    socialPost: z.string().max(4000),
    pressRelease: z.string().max(4000),
    headline: z.string().max(4000),
    activityExpand: z.string().max(4000),
    appointmentScore: z.string().max(4000),
  }).partial().optional(),
}).strip();

router.put("/admin/settings/:key", requireRole("super_admin", "admin"), async (req: AuthRequest, res) => {
  try {
    const key = req.params["key"] as string;
    const allowed = ["social_links", "contact_info", "emergency_contacts", "home_hero", "milestone_targets", "ai_settings"];
    if (!allowed.includes(key)) { res.status(400).json({ error: "Invalid settings key" }); return; }
    let body: unknown = req.body;
    if (key === "home_hero") {
      const parsed = HomeHeroBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid", details: parsed.error.issues });
        return;
      }
      body = parsed.data;
    } else if (key === "ai_settings") {
      const parsed = AiSettingsBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid", details: parsed.error.issues });
        return;
      }
      body = parsed.data;
    }
    const value = JSON.stringify(body);
    const existing = await db.select({ id: siteConfigTable.id }).from(siteConfigTable)
      .where(eq(siteConfigTable.key, key)).limit(1);
    if (existing.length > 0) {
      await db.update(siteConfigTable).set({ value }).where(eq(siteConfigTable.key, key));
    } else {
      await db.insert(siteConfigTable).values({ key, value });
    }
    // AI behaviour is read from a short-lived cache — bust it on save.
    if (key === "ai_settings") invalidateAiSettings();
    await logAudit(req, "UPDATE", `site_config:${key}`);
    res.json(req.body);
  } catch (err) {
    console.error("[admin] settings update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// AUDIT LOG (paginated)
// ──────────────────────────────────────────────────────────
router.get("/admin/audit-log", requireRole("super_admin", "admin"), async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "50"))));
    const logs = await db.select().from(auditLogTable).orderBy(desc(auditLogTable.createdAt)).limit(limit);
    res.json(logs.map(l => ({ ...l, createdAt: l.createdAt.toISOString() })));
  } catch (err) {
    console.error("[admin] audit-log:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// BANNERS CRUD
// ──────────────────────────────────────────────────────────
const BannerBody = z.object({
  title: z.string().min(1),
  titleTa: z.string().optional().nullable(),
  subtitle: z.string().optional().nullable(),
  subtitleTa: z.string().optional().nullable(),
  ctaText: z.string().optional().nullable(),
  ctaUrl: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});

router.get("/admin/banners", async (_req, res) => {
  try {
    const items = await db.select().from(bannersTable).orderBy(bannersTable.displayOrder, desc(bannersTable.createdAt));
    res.json(items.map(b => ({ ...b, createdAt: b.createdAt.toISOString(), updatedAt: b.updatedAt.toISOString() })));
  } catch (err) {
    console.error("[admin] banners list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/banners", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = BannerBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.insert(bannersTable).values(body.data).returning();
    await logAudit(req, "CREATE", `banner:${item.id}`, item.title);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] banner create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/banners/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = BannerBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.update(bannersTable).set(body.data).where(eq(bannersTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `banner:${id}`, item.title);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] banner update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/banners/:id", requireRole(...CMS_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(bannersTable).where(eq(bannersTable.id, id));
    await logAudit(req, "DELETE", `banner:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] banner delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// CONSTITUENCY STATS
// ──────────────────────────────────────────────────────────
router.get("/admin/constituency-stats", async (_req, res) => {
  try {
    const [row] = await db.select().from(constituencyStatsTable).orderBy(asc(constituencyStatsTable.id)).limit(1);
    res.json(row ?? null);
  } catch (err) {
    console.error("[admin] constituency-stats get:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const ConstituencyStatsBody = z.object({
  roadsBuiltKm: z.number().default(0),
  waterProjectsCompleted: z.number().int().default(0),
  schoolsUpgraded: z.number().int().default(0),
  healthClinicsOpened: z.number().int().default(0),
  jobsCreated: z.number().int().default(0),
  beneficiariesServed: z.number().int().default(0),
  totalProjects: z.number().int().default(0),
  completedProjects: z.number().int().default(0),
  ongoingProjects: z.number().int().default(0),
});

router.put("/admin/constituency-stats", requireRole("super_admin", "admin", "constituency_coordinator"), async (req: AuthRequest, res) => {
  try {
    const body = ConstituencyStatsBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const existing = await db.select({ id: constituencyStatsTable.id }).from(constituencyStatsTable).limit(1);
    let row;
    if (existing.length > 0) {
      [row] = await db.update(constituencyStatsTable).set(body.data).where(eq(constituencyStatsTable.id, existing[0].id)).returning();
    } else {
      [row] = await db.insert(constituencyStatsTable).values(body.data).returning();
    }
    await logAudit(req, "UPDATE", "constituency_stats");
    res.json(row);
  } catch (err) {
    console.error("[admin] constituency-stats update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// WARDS CRUD
// ──────────────────────────────────────────────────────────
const WardBody = z.object({
  name: z.string().min(1),
  area: z.string().optional().nullable(),
  coordinatorName: z.string().optional().nullable(),
  coordinatorPhone: z.string().optional().nullable(),
  coordinatorEmail: z.string().optional().nullable(),
  population: z.number().int().optional().nullable(),
  households: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.get("/admin/wards", async (_req, res) => {
  try {
    const wards = await db.select().from(wardsTable).orderBy(wardsTable.name);
    res.json(wards.map(w => ({ ...w, createdAt: w.createdAt.toISOString(), updatedAt: w.updatedAt.toISOString() })));
  } catch (err) {
    console.error("[admin] wards list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/wards", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = WardBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.insert(wardsTable).values(body.data).returning();
    await logAudit(req, "CREATE", `ward:${item.id}`, item.name);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] ward create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/wards/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = WardBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.update(wardsTable).set(body.data).where(eq(wardsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `ward:${id}`, item.name);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] ward update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/wards/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(wardsTable).where(eq(wardsTable.id, id));
    await logAudit(req, "DELETE", `ward:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] ward delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// BULK GRIEVANCE ASSIGN
// ──────────────────────────────────────────────────────────
router.post("/admin/grievances/bulk-assign", requireRole("super_admin", "admin", "grievance_officer"), async (req: AuthRequest, res) => {
  try {
    const body = z.object({
      ids: z.array(z.number().int()).min(1).max(200),
      officerId: z.number().int(),
      officerName: z.string().min(1),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { ids, officerId, officerName } = body.data;

    // Snapshot previous assignees so each routing-log row can record
    // the accurate from→to transition (manual reassignment audit trail).
    const before = await db.select({ id: grievancesTable.id, assignedTo: grievancesTable.assignedTo })
      .from(grievancesTable).where(inArray(grievancesTable.id, ids));
    const prevById = new Map(before.map(r => [r.id, r.assignedTo]));

    const updated = await db.update(grievancesTable)
      .set({ assignedTo: officerId, status: "Assigned" })
      .where(inArray(grievancesTable.id, ids))
      .returning({ id: grievancesTable.id });

    // One routing-log row per grievance, marking reason=reassign when
    // there was a previous owner, otherwise reason=manual (first assign).
    const actorName = req.user?.name ?? req.user?.email ?? "system";
    const actorId = req.user?.id ?? null;
    await Promise.all(updated.map(g => logRouting({
      grievanceId: g.id,
      fromOfficerId: prevById.get(g.id) ?? null,
      toOfficerId: officerId,
      reason: prevById.get(g.id) ? "reassign" : "manual",
      matchedScope: "none",
      matchedScopeId: null,
      changedBy: actorId,
      changedByName: actorName,
      note: `Bulk assign → ${officerName}`,
    })));

    await logAudit(req, "BULK_ASSIGN", `grievances:${ids.join(",")}`, `→ ${officerName}`);
    res.json({ updated: updated.length });
  } catch (err) {
    console.error("[admin] bulk grievance assign:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GRIEVANCES CSV EXPORT
// ──────────────────────────────────────────────────────────
router.get("/admin/grievances/export", async (_req, res) => {
  try {
    const rows = await db.select().from(grievancesTable).orderBy(desc(grievancesTable.createdAt)).limit(2000);
    const headers = ["ID", "Ticket No", "Name", "Phone", "Category", "Priority", "Status", "Ward", "Description", "Submitted"];
    const csv = [
      headers.map(h => `"${h}"`).join(","),
      ...rows.map(r => [
        r.id, r.ticketNo ?? "", r.name, r.phone, r.category, r.priority, r.status,
        r.ward ?? "", (r.description ?? "").replace(/"/g, '""'), new Date(r.createdAt).toLocaleDateString("en-IN"),
      ].map(v => `"${v}"`).join(",")),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="grievances-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[admin] grievances export:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// CONSTITUENCY HIERARCHY (Zones / Wards / Areas / Streets /
// Polling Stations / Pincodes) — staff CRUD
// ──────────────────────────────────────────────────────────

// Full tree (Zone → Ward → Area → Street + booth counts per ward)
router.get("/admin/hierarchy/tree", requireRole(...WARD_ROLES), async (_req, res) => {
  try {
    const [zones, wards, areas, streets, boothCountsRows] = await Promise.all([
      db.select().from(zonesTable).orderBy(asc(zonesTable.name)),
      db.select().from(wardsTable).orderBy(asc(wardsTable.name)),
      db.select().from(areasTable).orderBy(asc(areasTable.name)),
      db.select().from(streetsTable).orderBy(asc(streetsTable.name)),
      db.select({
        wardId: pollingStationsTable.wardId,
        count: sql<number>`count(*)::int`,
      }).from(pollingStationsTable).groupBy(pollingStationsTable.wardId),
    ]);

    const boothCounts = new Map<number, number>();
    for (const r of boothCountsRows) if (r.wardId != null) boothCounts.set(r.wardId, r.count);

    const tree = zones.map(z => ({
      ...z,
      createdAt: z.createdAt.toISOString(),
      updatedAt: z.updatedAt.toISOString(),
      wards: wards.filter(w => w.zoneId === z.id).map(w => ({
        ...w,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
        boothCount: boothCounts.get(w.id) ?? 0,
        areas: areas.filter(a => a.wardId === w.id).map(a => ({
          ...a,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
          streets: streets.filter(s => s.areaId === a.id).map(s => ({
            ...s,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          })),
        })),
      })),
    }));

    // Wards with no zone (orphaned) bucket so staff can re-home them
    const orphanWards = wards.filter(w => w.zoneId == null);

    res.json({ zones: tree, orphanWards: orphanWards.map(w => ({
      ...w,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
      boothCount: boothCounts.get(w.id) ?? 0,
      areas: areas.filter(a => a.wardId === w.id).map(a => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        streets: streets.filter(s => s.areaId === a.id).map(s => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
      })),
    })) });
  } catch (err) {
    console.error("[admin] hierarchy tree:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Polling stations for a single ward (loaded on expand to keep tree light)
router.get("/admin/hierarchy/wards/:id/polling-stations", requireRole(...WARD_ROLES), async (req, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid ward id" }); return; }
    const rows = await db.select().from(pollingStationsTable)
      .where(eq(pollingStationsTable.wardId, id))
      .orderBy(asc(pollingStationsTable.slNo), asc(pollingStationsTable.boothNo));
    res.json(rows.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })));
  } catch (err) {
    console.error("[admin] hierarchy ward booths:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Zones CRUD ──
const ZoneBody = z.object({
  name: z.string().min(1),
  nameTa: z.string().optional().nullable(),
  slug: z.string().min(1),
  type: z.enum(["corporation", "rural"]).default("corporation"),
  description: z.string().optional().nullable(),
});

router.post("/admin/hierarchy/zones", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = ZoneBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.insert(zonesTable).values(body.data).returning();
    await logAudit(req, "CREATE", `zone:${item.id}`, item.name);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] zone create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/hierarchy/zones/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = ZoneBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [item] = await db.update(zonesTable).set(body.data).where(eq(zonesTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `zone:${id}`, item.name);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] zone update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/zones/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    // Block delete when wards still reference this zone
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(wardsTable).where(eq(wardsTable.zoneId, id));
    if (count > 0) {
      res.status(409).json({ error: `Cannot delete: ${count} ward(s) still in this zone. Move them first.` });
      return;
    }
    await db.delete(zonesTable).where(eq(zonesTable.id, id));
    await logAudit(req, "DELETE", `zone:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] zone delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Hierarchy ward CRUD (extends the older /admin/wards with bilingual + zone fields) ──
const HWardBody = z.object({
  name: z.string().min(1),
  nameTa: z.string().optional().nullable(),
  slug: z.string().optional().nullable(),
  wardType: z.string().optional().nullable(),
  zoneId: z.number().int().optional().nullable(),
  area: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  coordinatorName: z.string().optional().nullable(),
  coordinatorPhone: z.string().optional().nullable(),
  coordinatorEmail: z.string().optional().nullable(),
  population: z.number().int().optional().nullable(),
  households: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post("/admin/hierarchy/wards", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = HWardBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.zoneId != null) {
      const [z] = await db.select({ id: zonesTable.id }).from(zonesTable).where(eq(zonesTable.id, body.data.zoneId));
      if (!z) { res.status(400).json({ error: "Parent zone does not exist" }); return; }
    }
    const [item] = await db.insert(wardsTable).values(body.data).returning();
    await logAudit(req, "CREATE", `ward:${item.id}`, item.name);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] hierarchy ward create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/hierarchy/wards/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = HWardBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.zoneId != null) {
      const [z] = await db.select({ id: zonesTable.id }).from(zonesTable).where(eq(zonesTable.id, body.data.zoneId));
      if (!z) { res.status(400).json({ error: "Parent zone does not exist" }); return; }
    }
    const [item] = await db.update(wardsTable).set(body.data).where(eq(wardsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `ward:${id}`, item.name);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] hierarchy ward update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/wards/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const [{ areaCount }] = await db.select({ areaCount: sql<number>`count(*)::int` })
      .from(areasTable).where(eq(areasTable.wardId, id));
    const [{ boothCount }] = await db.select({ boothCount: sql<number>`count(*)::int` })
      .from(pollingStationsTable).where(eq(pollingStationsTable.wardId, id));
    if (areaCount > 0 || boothCount > 0) {
      res.status(409).json({
        error: `Cannot delete: ${areaCount} area(s) and ${boothCount} booth(s) still attached. Remove or reassign them first.`,
      });
      return;
    }
    // Detach pincode mappings (they're descriptive, safe to remove)
    await db.delete(pincodeWardsTable).where(eq(pincodeWardsTable.wardId, id));
    await db.delete(wardsTable).where(eq(wardsTable.id, id));
    await logAudit(req, "DELETE", `ward:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] hierarchy ward delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Areas CRUD ──
const AreaBody = z.object({
  wardId: z.number().int(),
  name: z.string().min(1),
  nameTa: z.string().optional().nullable(),
  areaType: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post("/admin/hierarchy/areas", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = AreaBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [w] = await db.select({ id: wardsTable.id }).from(wardsTable).where(eq(wardsTable.id, body.data.wardId));
    if (!w) { res.status(400).json({ error: "Parent ward does not exist" }); return; }
    const [item] = await db.insert(areasTable).values(body.data).returning();
    await logAudit(req, "CREATE", `area:${item.id}`, item.name);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] area create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/hierarchy/areas/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = AreaBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.wardId != null) {
      const [w] = await db.select({ id: wardsTable.id }).from(wardsTable).where(eq(wardsTable.id, body.data.wardId));
      if (!w) { res.status(400).json({ error: "Parent ward does not exist" }); return; }
    }
    const [item] = await db.update(areasTable).set(body.data).where(eq(areasTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `area:${id}`, item.name);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] area update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/areas/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(streetsTable).where(eq(streetsTable.areaId, id));
    if (count > 0) {
      res.status(409).json({ error: `Cannot delete: ${count} street(s) still in this area.` });
      return;
    }
    // Detach booths that reference this area (booths still belong to ward)
    await db.update(pollingStationsTable).set({ areaId: null }).where(eq(pollingStationsTable.areaId, id));
    await db.delete(areasTable).where(eq(areasTable.id, id));
    await logAudit(req, "DELETE", `area:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] area delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Streets CRUD ──
const StreetBody = z.object({
  areaId: z.number().int(),
  name: z.string().min(1),
  nameTa: z.string().optional().nullable(),
  pincode: z.string().optional().nullable(),
});

router.post("/admin/hierarchy/streets", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = StreetBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const [a] = await db.select({ id: areasTable.id }).from(areasTable).where(eq(areasTable.id, body.data.areaId));
    if (!a) { res.status(400).json({ error: "Parent area does not exist" }); return; }
    const [item] = await db.insert(streetsTable).values(body.data).returning();
    await logAudit(req, "CREATE", `street:${item.id}`, item.name);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] street create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/hierarchy/streets/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = StreetBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.areaId != null) {
      const [a] = await db.select({ id: areasTable.id }).from(areasTable).where(eq(areasTable.id, body.data.areaId));
      if (!a) { res.status(400).json({ error: "Parent area does not exist" }); return; }
    }
    const [item] = await db.update(streetsTable).set(body.data).where(eq(streetsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `street:${id}`, item.name);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] street update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/streets/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(streetsTable).where(eq(streetsTable.id, id));
    await logAudit(req, "DELETE", `street:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] street delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Polling Stations CRUD ──
const BoothBody = z.object({
  boothNo: z.string().min(1),
  slNo: z.number().int().optional().nullable(),
  name: z.string().min(1),
  nameTa: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  addressTa: z.string().optional().nullable(),
  wardId: z.number().int().optional().nullable(),
  areaId: z.number().int().optional().nullable(),
  pincode: z.string().optional().nullable(),
  voterType: z.enum(["all", "men_only", "women_only"]).default("all"),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  source: z.string().optional().nullable(),
});

router.post("/admin/hierarchy/polling-stations", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = BoothBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.wardId != null) {
      const [w] = await db.select({ id: wardsTable.id }).from(wardsTable).where(eq(wardsTable.id, body.data.wardId));
      if (!w) { res.status(400).json({ error: "Parent ward does not exist" }); return; }
    }
    if (body.data.areaId != null) {
      const [a] = await db.select({ id: areasTable.id, wardId: areasTable.wardId }).from(areasTable).where(eq(areasTable.id, body.data.areaId));
      if (!a) { res.status(400).json({ error: "Parent area does not exist" }); return; }
      if (body.data.wardId != null && a.wardId !== body.data.wardId) {
        res.status(400).json({ error: "Area does not belong to the selected ward" }); return;
      }
    }
    const [item] = await db.insert(pollingStationsTable).values(body.data).returning();
    await logAudit(req, "CREATE", `polling_station:${item.id}`, `Booth ${item.boothNo} – ${item.name}`);
    res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] booth create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/admin/hierarchy/polling-stations/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = BoothBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (body.data.wardId != null) {
      const [w] = await db.select({ id: wardsTable.id }).from(wardsTable).where(eq(wardsTable.id, body.data.wardId));
      if (!w) { res.status(400).json({ error: "Parent ward does not exist" }); return; }
    }
    if (body.data.areaId != null) {
      const [a] = await db.select({ id: areasTable.id, wardId: areasTable.wardId }).from(areasTable).where(eq(areasTable.id, body.data.areaId));
      if (!a) { res.status(400).json({ error: "Parent area does not exist" }); return; }
      // Determine the effective wardId for this booth (incoming or existing) and require area to match.
      let effectiveWardId = body.data.wardId ?? null;
      if (effectiveWardId == null) {
        const [existing] = await db.select({ wardId: pollingStationsTable.wardId }).from(pollingStationsTable).where(eq(pollingStationsTable.id, id));
        effectiveWardId = existing?.wardId ?? null;
      }
      if (effectiveWardId != null && a.wardId !== effectiveWardId) {
        res.status(400).json({ error: "Area does not belong to the booth's ward" }); return;
      }
    }
    const [item] = await db.update(pollingStationsTable).set(body.data).where(eq(pollingStationsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `polling_station:${id}`, `Booth ${item.boothNo}`);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] booth update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/polling-stations/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(pollingStationsTable).where(eq(pollingStationsTable.id, id));
    await logAudit(req, "DELETE", `polling_station:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] booth delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Pincodes (with many-to-many ward associations) ──
router.get("/admin/hierarchy/pincodes", requireRole(...WARD_ROLES), async (_req, res) => {
  try {
    const [pincodes, mappings] = await Promise.all([
      db.select().from(pincodesTable).orderBy(asc(pincodesTable.code)),
      db.select().from(pincodeWardsTable),
    ]);
    res.json(pincodes.map(p => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      wardIds: mappings.filter(m => m.pincodeId === p.id).map(m => m.wardId),
    })));
  } catch (err) {
    console.error("[admin] pincodes list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PincodeBody = z.object({
  code: z.string().regex(/^\d{6}$/, "Pincode must be 6 digits"),
  label: z.string().optional().nullable(),
  labelTa: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  wardIds: z.array(z.number().int()).default([]),
});

// Validate that every wardId in `ids` exists; returns null on success or an error string.
async function validateWardIds(ids: number[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const unique = Array.from(new Set(ids));
  const found = await db.select({ id: wardsTable.id }).from(wardsTable).where(inArray(wardsTable.id, unique));
  if (found.length !== unique.length) {
    const foundSet = new Set(found.map(w => w.id));
    const missing = unique.filter(id => !foundSet.has(id));
    return `Unknown ward id(s): ${missing.join(", ")}`;
  }
  return null;
}

router.post("/admin/hierarchy/pincodes", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = PincodeBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { wardIds, ...rest } = body.data;
    const uniqueWardIds = Array.from(new Set(wardIds));
    const wardErr = await validateWardIds(uniqueWardIds);
    if (wardErr) { res.status(400).json({ error: wardErr }); return; }
    const item = await db.transaction(async (tx) => {
      const [created] = await tx.insert(pincodesTable).values(rest).returning();
      if (uniqueWardIds.length > 0) {
        await tx.insert(pincodeWardsTable).values(uniqueWardIds.map(wid => ({ pincodeId: created.id, wardId: wid })));
      }
      return created;
    });
    await logAudit(req, "CREATE", `pincode:${item.id}`, item.code);
    res.status(201).json({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      wardIds: uniqueWardIds,
    });
  } catch (err: unknown) {
    const msg = (err as { code?: string })?.code === "23505" ? "Pincode already exists" : "Internal server error";
    console.error("[admin] pincode create:", err);
    res.status(msg === "Internal server error" ? 500 : 409).json({ error: msg });
  }
});

router.put("/admin/hierarchy/pincodes/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = PincodeBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const { wardIds, ...rest } = body.data;
    const uniqueWardIds = wardIds === undefined ? undefined : Array.from(new Set(wardIds));
    if (uniqueWardIds !== undefined) {
      const wardErr = await validateWardIds(uniqueWardIds);
      if (wardErr) { res.status(400).json({ error: wardErr }); return; }
    }
    const item = await db.transaction(async (tx) => {
      const [updated] = await tx.update(pincodesTable).set(rest).where(eq(pincodesTable.id, id)).returning();
      if (!updated) return null;
      if (uniqueWardIds !== undefined) {
        await tx.delete(pincodeWardsTable).where(eq(pincodeWardsTable.pincodeId, id));
        if (uniqueWardIds.length > 0) {
          await tx.insert(pincodeWardsTable).values(uniqueWardIds.map(wid => ({ pincodeId: id, wardId: wid })));
        }
      }
      return updated;
    });
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    const finalWardIds = uniqueWardIds ?? (await db.select().from(pincodeWardsTable)
      .where(eq(pincodeWardsTable.pincodeId, id))).map(m => m.wardId);
    await logAudit(req, "UPDATE", `pincode:${id}`, item.code);
    res.json({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      wardIds: finalWardIds,
    });
  } catch (err) {
    console.error("[admin] pincode update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/hierarchy/pincodes/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(pincodeWardsTable).where(eq(pincodeWardsTable.pincodeId, id));
    await db.delete(pincodesTable).where(eq(pincodesTable.id, id));
    await logAudit(req, "DELETE", `pincode:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] pincode delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// OFFICER ASSIGNMENTS (Task #17)
// ──────────────────────────────────────────────────────────
//
// CRUD for officer→ward/area/booth assignments. Used by the auto-router
// (resolveOwnerForGrievance) and by the admin Assignments matrix screen.
// All routes are gated by WARD_ROLES (super_admin / admin / coordinator).

const AssignmentBody = z.object({
  userId: z.number().int().positive(),
  wardId: z.number().int().positive().optional().nullable(),
  areaId: z.number().int().positive().optional().nullable(),
  pollingStationId: z.number().int().positive().optional().nullable(),
  roleLabel: z.string().max(80).optional().nullable(),
  isActive: z.boolean().optional(),
}).refine(
  (v) => !!(v.wardId || v.areaId || v.pollingStationId),
  { message: "At least one of wardId, areaId, or pollingStationId is required" },
);

// GET /admin/my-assignments — any staff can read their own assignments.
// Used by the embedded constituency map's "show only my ward" toggle so
// grievance officers (who are not in WARD_ROLES) can still scope the map.
//
// Returns:
//   - items: raw assignment rows (ward / area / pollingStation granularity)
//   - wardIds: derived union of every ward implied by those rows. Direct
//       wardId rows contribute themselves; areaId rows resolve through
//       areas.ward_id; pollingStationId rows resolve through
//       polling_stations.ward_id. The map uses this to scope ward and
//       booth filtering regardless of assignment granularity.
//   - pollingStationIds: explicit booth-level scope for officers
//       assigned to specific polling stations.
router.get("/admin/my-assignments", requireStaff, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.id;
    if (!uid) { res.status(401).json({ error: "Unauthorized" }); return; }
    const items = await db
      .select({
        id: officerAssignmentsTable.id,
        userId: officerAssignmentsTable.userId,
        wardId: officerAssignmentsTable.wardId,
        areaId: officerAssignmentsTable.areaId,
        pollingStationId: officerAssignmentsTable.pollingStationId,
      })
      .from(officerAssignmentsTable)
      .where(eq(officerAssignmentsTable.userId, uid));

    const wardIds = new Set<number>();
    const areaIds = new Set<number>();
    const pollingStationIds = new Set<number>();
    for (const r of items) {
      if (r.wardId != null) wardIds.add(r.wardId);
      if (r.areaId != null) areaIds.add(r.areaId);
      if (r.pollingStationId != null) pollingStationIds.add(r.pollingStationId);
    }
    if (areaIds.size > 0) {
      const rows = await db
        .select({ wardId: areasTable.wardId })
        .from(areasTable)
        .where(inArray(areasTable.id, Array.from(areaIds)));
      for (const r of rows) if (r.wardId != null) wardIds.add(r.wardId);
    }
    if (pollingStationIds.size > 0) {
      const rows = await db
        .select({ wardId: pollingStationsTable.wardId })
        .from(pollingStationsTable)
        .where(inArray(pollingStationsTable.id, Array.from(pollingStationIds)));
      for (const r of rows) if (r.wardId != null) wardIds.add(r.wardId);
    }

    res.json({
      items,
      wardIds: Array.from(wardIds),
      areaIds: Array.from(areaIds),
      pollingStationIds: Array.from(pollingStationIds),
    });
  } catch (err) {
    console.error("[admin] my-assignments error:", err);
    res.status(500).json({ error: "Failed to load assignments" });
  }
});

router.get("/admin/assignments", requireRole(...WARD_ROLES), async (req, res) => {
  try {
    const userIdParam = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
    const wardIdParam = req.query.wardId ? parseInt(String(req.query.wardId), 10) : null;
    const onlyActive = String(req.query.activeOnly ?? "") === "1";

    const conditions = [];
    if (userIdParam) conditions.push(eq(officerAssignmentsTable.userId, userIdParam));
    if (wardIdParam) conditions.push(eq(officerAssignmentsTable.wardId, wardIdParam));
    if (onlyActive) conditions.push(eq(officerAssignmentsTable.isActive, true));
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: officerAssignmentsTable.id,
        userId: officerAssignmentsTable.userId,
        userName: usersTable.name,
        userEmail: usersTable.email,
        userRole: usersTable.role,
        wardId: officerAssignmentsTable.wardId,
        wardName: wardsTable.name,
        areaId: officerAssignmentsTable.areaId,
        areaName: areasTable.name,
        pollingStationId: officerAssignmentsTable.pollingStationId,
        boothNo: pollingStationsTable.boothNo,
        boothName: pollingStationsTable.name,
        roleLabel: officerAssignmentsTable.roleLabel,
        isActive: officerAssignmentsTable.isActive,
        createdAt: officerAssignmentsTable.createdAt,
      })
      .from(officerAssignmentsTable)
      .leftJoin(usersTable, eq(usersTable.id, officerAssignmentsTable.userId))
      .leftJoin(wardsTable, eq(wardsTable.id, officerAssignmentsTable.wardId))
      .leftJoin(areasTable, eq(areasTable.id, officerAssignmentsTable.areaId))
      .leftJoin(pollingStationsTable, eq(pollingStationsTable.id, officerAssignmentsTable.pollingStationId))
      .where(where)
      .orderBy(desc(officerAssignmentsTable.createdAt));

    res.json({
      items: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  } catch (err) {
    console.error("[admin] assignments list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/assignments", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = AssignmentBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }

    const [u] = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(eq(usersTable.id, body.data.userId)).limit(1);
    if (!u) { res.status(400).json({ error: "User does not exist" }); return; }

    // Cross-validate ward → area → booth consistency
    if (body.data.areaId && body.data.wardId) {
      const [a] = await db.select({ wardId: areasTable.wardId }).from(areasTable)
        .where(eq(areasTable.id, body.data.areaId)).limit(1);
      if (!a || a.wardId !== body.data.wardId) {
        res.status(400).json({ error: "Area does not belong to selected ward" }); return;
      }
    }
    if (body.data.pollingStationId && body.data.wardId) {
      const [b] = await db.select({ wardId: pollingStationsTable.wardId }).from(pollingStationsTable)
        .where(eq(pollingStationsTable.id, body.data.pollingStationId)).limit(1);
      if (b && b.wardId != null && b.wardId !== body.data.wardId) {
        res.status(400).json({ error: "Polling station does not belong to selected ward" }); return;
      }
    }

    try {
      const [item] = await db.insert(officerAssignmentsTable).values({
        userId: body.data.userId,
        wardId: body.data.wardId ?? null,
        areaId: body.data.areaId ?? null,
        pollingStationId: body.data.pollingStationId ?? null,
        roleLabel: body.data.roleLabel ?? null,
        isActive: body.data.isActive ?? true,
      }).returning();
      await logAudit(req, "CREATE", `officer_assignment:${item.id}`, `${u.name} → ward=${item.wardId ?? "-"} area=${item.areaId ?? "-"} booth=${item.pollingStationId ?? "-"}`);
      res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/uniq|duplicate/i.test(msg)) {
        res.status(409).json({ error: "This officer already has an assignment with the same scope" });
        return;
      }
      throw e;
    }
  } catch (err) {
    console.error("[admin] assignment create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/assignments/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = z.object({
      isActive: z.boolean().optional(),
      roleLabel: z.string().max(80).optional().nullable(),
      userId: z.number().int().positive().optional(),
      wardId: z.number().int().positive().optional().nullable(),
      areaId: z.number().int().positive().optional().nullable(),
      pollingStationId: z.number().int().positive().optional().nullable(),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    if (Object.keys(body.data).length === 0) {
      res.status(400).json({ error: "No fields to update" }); return;
    }

    // Re-validate scope consistency after merging the patch with the
    // existing record. PATCH may change just one of ward/area/booth, so
    // the merged shape is what must be coherent.
    if (body.data.wardId !== undefined || body.data.areaId !== undefined ||
        body.data.pollingStationId !== undefined) {
      const [existing] = await db.select().from(officerAssignmentsTable)
        .where(eq(officerAssignmentsTable.id, id)).limit(1);
      if (!existing) { res.status(404).json({ error: "Not found" }); return; }
      const merged = {
        wardId: body.data.wardId !== undefined ? body.data.wardId : existing.wardId,
        areaId: body.data.areaId !== undefined ? body.data.areaId : existing.areaId,
        pollingStationId: body.data.pollingStationId !== undefined
          ? body.data.pollingStationId : existing.pollingStationId,
      };
      if (merged.areaId && merged.wardId) {
        const [a] = await db.select({ wardId: areasTable.wardId }).from(areasTable)
          .where(eq(areasTable.id, merged.areaId)).limit(1);
        if (!a || a.wardId !== merged.wardId) {
          res.status(400).json({ error: "Area does not belong to selected ward" }); return;
        }
      }
      if (merged.pollingStationId && merged.wardId) {
        const [b] = await db.select({ wardId: pollingStationsTable.wardId })
          .from(pollingStationsTable)
          .where(eq(pollingStationsTable.id, merged.pollingStationId)).limit(1);
        if (b && b.wardId != null && b.wardId !== merged.wardId) {
          res.status(400).json({ error: "Polling station does not belong to selected ward" }); return;
        }
      }
    }

    const [item] = await db.update(officerAssignmentsTable).set(body.data)
      .where(eq(officerAssignmentsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `officer_assignment:${id}`, `active=${item.isActive}`);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] assignment patch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/assignments/bulk-reassign — move many assignments from one
// officer to another in a single call. Used by the Assignments admin UI
// when an officer leaves, goes on leave, etc.
router.post("/admin/assignments/bulk-reassign", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = z.object({
      assignmentIds: z.array(z.number().int().positive()).min(1).max(200),
      toUserId: z.number().int().positive(),
    }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }

    const [u] = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(eq(usersTable.id, body.data.toUserId)).limit(1);
    if (!u) { res.status(400).json({ error: "Target user does not exist" }); return; }

    const updated = await db.update(officerAssignmentsTable)
      .set({ userId: body.data.toUserId })
      .where(inArray(officerAssignmentsTable.id, body.data.assignmentIds))
      .returning({ id: officerAssignmentsTable.id });

    if (updated.length === 0) {
      res.status(404).json({ error: "No matching assignments found for the provided IDs" });
      return;
    }
    if (updated.length !== body.data.assignmentIds.length) {
      // Partial match — not fatal, but worth surfacing so the caller can refresh.
      const missing = body.data.assignmentIds.filter(id => !updated.find(u2 => u2.id === id));
      await logAudit(req, "UPDATE", `officer_assignments:bulk`, `Reassigned ${updated.length}/${body.data.assignmentIds.length} → ${u.name} (missing: ${missing.join(",")})`);
      res.status(207).json({ updated: updated.length, requested: body.data.assignmentIds.length, missing, toUserId: body.data.toUserId });
      return;
    }
    await logAudit(req, "UPDATE", `officer_assignments:bulk`, `Reassigned ${updated.length} → ${u.name}`);
    res.json({ updated: updated.length, toUserId: body.data.toUserId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/uniq|duplicate/i.test(msg)) {
      res.status(409).json({ error: "One or more reassignments collide with existing scopes" });
      return;
    }
    console.error("[admin] bulk reassign:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/assignments/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(officerAssignmentsTable).where(eq(officerAssignmentsTable.id, id));
    await logAudit(req, "DELETE", `officer_assignment:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] assignment delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Volunteer assignments CRUD (mirrors officer assignments) ──
router.get("/admin/volunteer-assignments", requireRole(...WARD_ROLES), async (req, res) => {
  try {
    const volunteerId = req.query.volunteerId ? parseInt(String(req.query.volunteerId), 10) : null;
    const wardId = req.query.wardId ? parseInt(String(req.query.wardId), 10) : null;
    const conditions = [];
    if (volunteerId) conditions.push(eq(volunteerAssignmentsTable.volunteerId, volunteerId));
    if (wardId) conditions.push(eq(volunteerAssignmentsTable.wardId, wardId));
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select({
      id: volunteerAssignmentsTable.id,
      volunteerId: volunteerAssignmentsTable.volunteerId,
      volunteerName: volunteersTable.name,
      volunteerPhone: volunteersTable.phone,
      wardId: volunteerAssignmentsTable.wardId,
      wardName: wardsTable.name,
      areaId: volunteerAssignmentsTable.areaId,
      areaName: areasTable.name,
      pollingStationId: volunteerAssignmentsTable.pollingStationId,
      boothNo: pollingStationsTable.boothNo,
      boothName: pollingStationsTable.name,
      isActive: volunteerAssignmentsTable.isActive,
      createdAt: volunteerAssignmentsTable.createdAt,
    })
    .from(volunteerAssignmentsTable)
    .leftJoin(volunteersTable, eq(volunteersTable.id, volunteerAssignmentsTable.volunteerId))
    .leftJoin(wardsTable, eq(wardsTable.id, volunteerAssignmentsTable.wardId))
    .leftJoin(areasTable, eq(areasTable.id, volunteerAssignmentsTable.areaId))
    .leftJoin(pollingStationsTable, eq(pollingStationsTable.id, volunteerAssignmentsTable.pollingStationId))
    .where(where)
    .orderBy(desc(volunteerAssignmentsTable.createdAt));
    res.json({ items: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })) });
  } catch (err) {
    console.error("[admin] volunteer assignments list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/volunteer-assignments", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = z.object({
      volunteerId: z.number().int().positive(),
      wardId: z.number().int().positive().optional().nullable(),
      areaId: z.number().int().positive().optional().nullable(),
      pollingStationId: z.number().int().positive().optional().nullable(),
      isActive: z.boolean().optional(),
    }).refine(v => !!(v.wardId || v.areaId || v.pollingStationId),
      { message: "At least one of wardId, areaId, pollingStationId is required" })
      .safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }

    const [v] = await db.select({ id: volunteersTable.id, name: volunteersTable.name })
      .from(volunteersTable).where(eq(volunteersTable.id, body.data.volunteerId)).limit(1);
    if (!v) { res.status(400).json({ error: "Volunteer does not exist" }); return; }

    if (body.data.areaId && body.data.wardId) {
      const [a] = await db.select({ wardId: areasTable.wardId }).from(areasTable)
        .where(eq(areasTable.id, body.data.areaId)).limit(1);
      if (!a || a.wardId !== body.data.wardId) {
        res.status(400).json({ error: "Area does not belong to selected ward" }); return;
      }
    }
    if (body.data.pollingStationId && body.data.wardId) {
      const [b] = await db.select({ wardId: pollingStationsTable.wardId })
        .from(pollingStationsTable).where(eq(pollingStationsTable.id, body.data.pollingStationId)).limit(1);
      if (b && b.wardId != null && b.wardId !== body.data.wardId) {
        res.status(400).json({ error: "Polling station does not belong to selected ward" }); return;
      }
    }

    try {
      const [item] = await db.insert(volunteerAssignmentsTable).values({
        volunteerId: body.data.volunteerId,
        wardId: body.data.wardId ?? null,
        areaId: body.data.areaId ?? null,
        pollingStationId: body.data.pollingStationId ?? null,
        isActive: body.data.isActive ?? true,
      }).returning();
      await logAudit(req, "CREATE", `volunteer_assignment:${item.id}`, `${v.name} → ward=${item.wardId ?? "-"} area=${item.areaId ?? "-"} booth=${item.pollingStationId ?? "-"}`);
      res.status(201).json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/uniq|duplicate/i.test(msg)) {
        res.status(409).json({ error: "This volunteer already has an assignment with the same scope" });
        return;
      }
      throw e;
    }
  } catch (err) {
    console.error("[admin] volunteer assignment create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/volunteer-assignments/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = z.object({ isActive: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid" }); return; }
    if (Object.keys(body.data).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    const [item] = await db.update(volunteerAssignmentsTable).set(body.data)
      .where(eq(volunteerAssignmentsTable.id, id)).returning();
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    await logAudit(req, "UPDATE", `volunteer_assignment:${id}`, `active=${item.isActive}`);
    res.json({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
  } catch (err) {
    console.error("[admin] volunteer assignment patch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/volunteer-assignments/:id", requireRole(...WARD_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(volunteerAssignmentsTable).where(eq(volunteerAssignmentsTable.id, id));
    await logAudit(req, "DELETE", `volunteer_assignment:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] volunteer assignment delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /admin/analytics/grievances — heatmap + analytics
// ──────────────────────────────────────────────────────────
const ANALYTICS_ROLES = ["super_admin", "admin", "constituency_coordinator"] as const;
const ANALYTICS_TTL_MS = 60_000;
const analyticsCache = new Map<string, { at: number; payload: unknown }>();

router.get(
  "/admin/analytics/grievances",
  requireRole(...ANALYTICS_ROLES),
  async (req, res) => {
    try {
      const q = z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        category: z.string().optional(),
        status: z.string().optional(),
        officerIds: z.string()
          .optional()
          .transform(v => v ? v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n)) : undefined),
      }).safeParse(req.query);
      if (!q.success) { res.status(400).json({ error: "Invalid filters" }); return; }
      const f = q.data;
      const cacheKey = JSON.stringify(f);
      const hit = analyticsCache.get(cacheKey);
      if (hit && Date.now() - hit.at < ANALYTICS_TTL_MS) {
        res.json(hit.payload);
        return;
      }

      const fromDate = f.from ? new Date(f.from) : null;
      const toDate = f.to ? new Date(f.to) : null;
      if (toDate && !isNaN(toDate.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(f.to ?? "")) {
        toDate.setUTCHours(23, 59, 59, 999);
      }
      const conds = [] as ReturnType<typeof eq>[];
      if (fromDate && !isNaN(fromDate.getTime())) conds.push(gte(grievancesTable.createdAt, fromDate));
      if (toDate && !isNaN(toDate.getTime())) conds.push(lte(grievancesTable.createdAt, toDate));
      if (f.category) conds.push(eq(grievancesTable.category, f.category));
      if (f.status) conds.push(eq(grievancesTable.status, f.status));
      if (f.officerIds && f.officerIds.length > 0) conds.push(inArray(grievancesTable.assignedTo, f.officerIds));
      const where = conds.length > 0 ? and(...conds) : undefined;

      // Resolve effective ward via polling_station -> area fallback,
      // and grab GPS coords from polling_station with ward centroid fallback.
      const effectiveWardId = sql<number | null>`coalesce(${pollingStationsTable.wardId}, ${areasTable.wardId})`;
      // Prefer the citizen's own GPS pin, then fall back to the booth's coords,
      // then the ward centroid — so heatmap covers reports outside any booth.
      const lat = sql<number | null>`coalesce(${grievancesTable.latitude}, ${pollingStationsTable.latitude}, ${wardsTable.latitude})`;
      const lng = sql<number | null>`coalesce(${grievancesTable.longitude}, ${pollingStationsTable.longitude}, ${wardsTable.longitude})`;

      const rows = await db
        .select({
          id: grievancesTable.id,
          status: grievancesTable.status,
          category: grievancesTable.category,
          assignedTo: grievancesTable.assignedTo,
          createdAt: grievancesTable.createdAt,
          resolvedAt: grievancesTable.resolvedAt,
          wardId: effectiveWardId,
          lat,
          lng,
        })
        .from(grievancesTable)
        .leftJoin(pollingStationsTable, eq(grievancesTable.pollingStationId, pollingStationsTable.id))
        .leftJoin(areasTable, eq(grievancesTable.areaId, areasTable.id))
        .leftJoin(wardsTable, eq(wardsTable.id, sql`coalesce(${pollingStationsTable.wardId}, ${areasTable.wardId})`))
        .where(where);

      const byWardMap = new Map<number, { count: number; resolvedSeconds: number; resolvedCount: number }>();
      const byCategoryMap = new Map<string, number>();
      const byStatusMap = new Map<string, number>();
      const byOfficerMap = new Map<number, { count: number; open: number }>();
      const byWardCategoryMap = new Map<string, number>(); // key = wardId|category
      const heatBuckets = new Map<string, { lat: number; lng: number; weight: number }>();
      let unmappedCount = 0;

      // Trend buckets: pick granularity from the resolved date range so the
      // chart stays readable for both 7-day and 2-year windows.
      let minTs = Number.POSITIVE_INFINITY;
      let maxTs = Number.NEGATIVE_INFINITY;
      for (const r of rows) {
        if (r.createdAt) {
          const t = r.createdAt.getTime();
          if (t < minTs) minTs = t;
          if (t > maxTs) maxTs = t;
        }
        if (r.resolvedAt) {
          const t = r.resolvedAt.getTime();
          if (t < minTs) minTs = t;
          if (t > maxTs) maxTs = t;
        }
      }
      const rangeStartTs = fromDate && !isNaN(fromDate.getTime()) ? fromDate.getTime() : (Number.isFinite(minTs) ? minTs : Date.now());
      const rangeEndTs = toDate && !isNaN(toDate.getTime()) ? toDate.getTime() : (Number.isFinite(maxTs) ? maxTs : Date.now());
      const rangeDays = Math.max(1, Math.ceil((rangeEndTs - rangeStartTs) / 86_400_000));
      const granularity: "day" | "week" | "month" =
        rangeDays <= 31 ? "day" : rangeDays <= 180 ? "week" : "month";

      const bucketKey = (d: Date): string => {
        const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        if (granularity === "day") {
          return u.toISOString().slice(0, 10);
        }
        if (granularity === "week") {
          // ISO week: Monday-start; key = Monday of that week (YYYY-MM-DD)
          const day = u.getUTCDay(); // 0..6, 0=Sun
          const diff = (day + 6) % 7; // days since Monday
          u.setUTCDate(u.getUTCDate() - diff);
          return u.toISOString().slice(0, 10);
        }
        // month: YYYY-MM-01
        return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, "0")}-01`;
      };
      const trendMap = new Map<string, { submitted: number; resolved: number }>();
      const seedBucket = (k: string) => {
        if (!trendMap.has(k)) trendMap.set(k, { submitted: 0, resolved: 0 });
      };
      // Pre-seed buckets across the full range so the chart shows zero-points
      // (avoids visual gaps when a week/day has no activity).
      const seedStart = new Date(rangeStartTs);
      const seedEnd = new Date(rangeEndTs);
      const startKey = bucketKey(seedStart);
      const endKey = bucketKey(seedEnd);
      let cursor = new Date(`${startKey}T00:00:00.000Z`);
      const stop = new Date(`${endKey}T00:00:00.000Z`);
      // Cap at 366 buckets defensively
      let safety = 366;
      while (cursor.getTime() <= stop.getTime() && safety-- > 0) {
        seedBucket(bucketKey(cursor));
        if (granularity === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
        else if (granularity === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
        else cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      }

      for (const r of rows) {
        if (r.wardId != null) {
          const cur = byWardMap.get(r.wardId) ?? { count: 0, resolvedSeconds: 0, resolvedCount: 0 };
          cur.count += 1;
          if (r.resolvedAt && r.createdAt) {
            cur.resolvedSeconds += (r.resolvedAt.getTime() - r.createdAt.getTime()) / 1000;
            cur.resolvedCount += 1;
          }
          byWardMap.set(r.wardId, cur);
          if (r.category) {
            const wcKey = `${r.wardId}|${r.category}`;
            byWardCategoryMap.set(wcKey, (byWardCategoryMap.get(wcKey) ?? 0) + 1);
          }
        }
        if (r.category) byCategoryMap.set(r.category, (byCategoryMap.get(r.category) ?? 0) + 1);
        if (r.status) byStatusMap.set(r.status, (byStatusMap.get(r.status) ?? 0) + 1);
        if (r.assignedTo != null) {
          const cur = byOfficerMap.get(r.assignedTo) ?? { count: 0, open: 0 };
          cur.count += 1;
          if (r.status && !["Resolved", "Closed"].includes(r.status)) cur.open += 1;
          byOfficerMap.set(r.assignedTo, cur);
        }
        if (r.lat != null && r.lng != null) {
          const key = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
          const cur = heatBuckets.get(key) ?? { lat: r.lat, lng: r.lng, weight: 0 };
          cur.weight += 1;
          heatBuckets.set(key, cur);
        } else {
          unmappedCount += 1;
        }
        if (r.createdAt) {
          const k = bucketKey(r.createdAt);
          seedBucket(k);
          trendMap.get(k)!.submitted += 1;
        }
        if (r.resolvedAt) {
          const k = bucketKey(r.resolvedAt);
          seedBucket(k);
          trendMap.get(k)!.resolved += 1;
        }
      }
      const trend = Array.from(trendMap.entries())
        .map(([bucket, v]) => ({ bucket, submitted: v.submitted, resolved: v.resolved }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));

      const officerIds = Array.from(byOfficerMap.keys());
      const officerNames = officerIds.length > 0
        ? await db.select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
            .from(usersTable).where(inArray(usersTable.id, officerIds))
        : [];
      const officerNameById = new Map(officerNames.map(u => [u.id, { name: u.name, role: u.role }]));

      const wardIds = Array.from(byWardMap.keys());
      const wardMeta = wardIds.length > 0
        ? await db.select({ id: wardsTable.id, name: wardsTable.name, nameTa: wardsTable.nameTa })
            .from(wardsTable).where(inArray(wardsTable.id, wardIds))
        : [];
      const wardMetaById = new Map(wardMeta.map(w => [w.id, w]));

      const byWard = Array.from(byWardMap.entries())
        .map(([id, v]) => ({
          wardId: id,
          name: wardMetaById.get(id)?.name ?? `Ward ${id}`,
          nameTa: wardMetaById.get(id)?.nameTa ?? null,
          count: v.count,
          avgResolutionHours: v.resolvedCount > 0
            ? Math.round((v.resolvedSeconds / v.resolvedCount / 3600) * 10) / 10
            : null,
        }))
        .sort((a, b) => b.count - a.count);

      const byCategory = Array.from(byCategoryMap.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);

      const byStatus = Array.from(byStatusMap.entries())
        .map(([status, count]) => ({ status, count }));

      const byOfficer = Array.from(byOfficerMap.entries())
        .map(([id, v]) => ({
          officerId: id,
          name: officerNameById.get(id)?.name ?? `User #${id}`,
          role: officerNameById.get(id)?.role ?? null,
          total: v.count,
          open: v.open,
        }))
        .sort((a, b) => b.total - a.total);

      const payload = {
        filters: f,
        totals: {
          grievances: rows.length,
          mapped: rows.length - unmappedCount,
          unmapped: unmappedCount,
        },
        heatPoints: Array.from(heatBuckets.values()),
        byWard,
        byWardTop10: byWard.slice(0, 10),
        byWardCategory: Array.from(byWardCategoryMap.entries()).map(([key, count]) => {
          const [wardIdStr, category] = key.split("|");
          const wid = Number(wardIdStr);
          return {
            wardId: wid,
            wardName: wardMetaById.get(wid)?.name ?? `Ward ${wid}`,
            wardNameTa: wardMetaById.get(wid)?.nameTa ?? null,
            category,
            count,
          };
        }),
        byCategory,
        byStatus,
        byOfficer,
        trend,
        trendGranularity: granularity,
        cachedAt: new Date().toISOString(),
        cacheTtlSeconds: ANALYTICS_TTL_MS / 1000,
      };
      analyticsCache.set(cacheKey, { at: Date.now(), payload });
      if (analyticsCache.size > 64) {
        const oldestKey = analyticsCache.keys().next().value;
        if (oldestKey) analyticsCache.delete(oldestKey);
      }
      res.json(payload);
    } catch (err) {
      console.error("[admin] analytics error:", err);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  },
);

router.get("/admin/analytics/officers", requireRole(...ANALYTICS_ROLES), async (_req, res) => {
  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
      .from(usersTable)
      .where(sql`role IN ('grievance_officer','constituency_coordinator','admin','super_admin')`)
      .orderBy(asc(usersTable.name));
    res.json({ items: rows });
  } catch (err) {
    console.error("[admin] analytics/officers error:", err);
    res.status(500).json({ error: "Failed to load officers" });
  }
});

// ──────────────────────────────────────────────────────────
// TASKS (internal team to-do) CRUD
// ──────────────────────────────────────────────────────────
const TASK_ROLES = ["super_admin", "admin", "minister", "pa_staff"] as const;

const TASK_STATUS_VALUES = ["todo", "in_progress", "done", "cancelled"] as const;
const TASK_PRIORITY_VALUES = ["high", "medium", "low"] as const;
const TASK_CATEGORY_VALUES = ["follow_up", "visit_prep", "grievance_action", "content", "official", "personal"] as const;
const TASK_LINK_VALUES = ["grievance", "appointment", "event"] as const;

const TaskBody = z.object({
  title: z.string().min(2),
  description: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  dueTime: z.string().optional().nullable(),
  priority: z.enum(TASK_PRIORITY_VALUES).default("medium"),
  status: z.enum(TASK_STATUS_VALUES).default("todo"),
  category: z.enum(TASK_CATEGORY_VALUES).default("follow_up"),
  assignedTo: z.number().int().optional().nullable(),
  linkedEntityType: z.enum(TASK_LINK_VALUES).optional().nullable(),
  linkedEntityId: z.number().int().optional().nullable(),
  reminderAt: z.string().optional().nullable(),
});

// Parse an incoming date string safely. Returns undefined when the value is a
// non-empty but unparseable string so callers can reject with 400 instead of
// letting an Invalid Date reach the DB layer (which surfaces as a 500).
function parseDateField(v: string | null | undefined): Date | null | undefined {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function serializeTask(t: typeof tasksTable.$inferSelect, assigneeName?: string | null, creatorName?: string | null) {
  return {
    ...t,
    assigneeName: assigneeName ?? null,
    creatorName: creatorName ?? null,
    dueDate: t.dueDate?.toISOString() ?? null,
    reminderAt: t.reminderAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// List staff users for the assignee dropdown
router.get("/admin/tasks/assignees", requireRole(...TASK_ROLES), async (_req, res) => {
  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
      .from(usersTable)
      .orderBy(asc(usersTable.name));
    res.json({ items: rows });
  } catch (err) {
    console.error("[admin] tasks/assignees:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/tasks", requireRole(...TASK_ROLES), async (req: AuthRequest, res) => {
  try {
    const { status, priority, assignedTo, mine } = req.query;
    const conds = [];
    if (mine === "1" && req.user?.id) conds.push(eq(tasksTable.assignedTo, req.user.id));
    else if (assignedTo) conds.push(eq(tasksTable.assignedTo, parseInt(String(assignedTo), 10)));
    if (status) conds.push(eq(tasksTable.status, String(status)));
    if (priority) conds.push(eq(tasksTable.priority, String(priority)));

    const assignee = usersTable;
    const rows = await db
      .select({
        task: tasksTable,
        assigneeName: assignee.name,
      })
      .from(tasksTable)
      .leftJoin(assignee, eq(tasksTable.assignedTo, assignee.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`${tasksTable.dueDate} asc nulls last`, desc(tasksTable.createdAt));

    res.json({ items: rows.map((r) => serializeTask(r.task, r.assigneeName)) });
  } catch (err) {
    console.error("[admin] tasks list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/tasks", requireRole(...TASK_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = TaskBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const d = body.data;
    const dueDate = parseDateField(d.dueDate);
    const reminderAt = parseDateField(d.reminderAt);
    if (dueDate === undefined || reminderAt === undefined) {
      res.status(400).json({ error: "Invalid date value" }); return;
    }
    const [item] = await db.insert(tasksTable).values({
      title: d.title,
      description: d.description ?? null,
      dueDate,
      dueTime: d.dueTime ?? null,
      priority: d.priority,
      status: d.status,
      category: d.category,
      assignedTo: d.assignedTo ?? null,
      createdBy: req.user?.id ?? null,
      linkedEntityType: d.linkedEntityType ?? null,
      linkedEntityId: d.linkedEntityId ?? null,
      reminderAt,
      completedAt: d.status === "done" ? new Date() : null,
    }).returning();
    await logAudit(req, "CREATE", `task:${item.id}`, item.title);
    res.status(201).json(serializeTask(item));
  } catch (err) {
    console.error("[admin] task create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/admin/tasks/:id", requireRole(...TASK_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const body = TaskBody.partial().safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid", details: body.error.issues }); return; }
    const d = body.data;
    if (Object.keys(d).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const [existing] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const patch: Partial<typeof tasksTable.$inferInsert> = {};
    if (d.title !== undefined) patch.title = d.title;
    if (d.description !== undefined) patch.description = d.description ?? null;
    if (d.dueDate !== undefined) {
      const dd = parseDateField(d.dueDate);
      if (dd === undefined) { res.status(400).json({ error: "Invalid date value" }); return; }
      patch.dueDate = dd;
    }
    if (d.dueTime !== undefined) patch.dueTime = d.dueTime ?? null;
    if (d.priority !== undefined) patch.priority = d.priority;
    if (d.category !== undefined) patch.category = d.category;
    if (d.assignedTo !== undefined) patch.assignedTo = d.assignedTo ?? null;
    if (d.linkedEntityType !== undefined) patch.linkedEntityType = d.linkedEntityType ?? null;
    if (d.linkedEntityId !== undefined) patch.linkedEntityId = d.linkedEntityId ?? null;
    if (d.reminderAt !== undefined) {
      const ra = parseDateField(d.reminderAt);
      if (ra === undefined) { res.status(400).json({ error: "Invalid date value" }); return; }
      patch.reminderAt = ra;
    }
    if (d.status !== undefined) {
      patch.status = d.status;
      // Stamp / clear completedAt when crossing the done boundary.
      if (d.status === "done" && existing.status !== "done") patch.completedAt = new Date();
      if (d.status !== "done" && existing.status === "done") patch.completedAt = null;
    }

    const [item] = await db.update(tasksTable).set(patch).where(eq(tasksTable.id, id)).returning();
    if (d.status !== undefined && d.status !== existing.status) {
      await logAudit(req, "UPDATE", `task:${id}`, `status ${existing.status} → ${d.status}`);
    } else {
      await logAudit(req, "UPDATE", `task:${id}`, item.title);
    }
    res.json(serializeTask(item));
  } catch (err) {
    console.error("[admin] task update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin/tasks/:id", requireRole(...TASK_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(tasksTable).where(eq(tasksTable.id, id));
    await logAudit(req, "DELETE", `task:${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] task delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/assignments/routing-log", requireRole(...WARD_ROLES), async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
    const grievanceId = req.query.grievanceId ? parseInt(String(req.query.grievanceId), 10) : null;
    const rows = await db.select().from(grievanceRoutingLogTable)
      .where(grievanceId ? eq(grievanceRoutingLogTable.grievanceId, grievanceId) : undefined)
      .orderBy(desc(grievanceRoutingLogTable.createdAt))
      .limit(limit);
    res.json({ items: rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })) });
  } catch (err) {
    console.error("[admin] routing log:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// APPOINTMENTS (staff) — list / detail / decide / delete / export
// GETs are restricted to the appointment read roles (incl. minister read-only).
// Mutations are restricted to the appointment-managing roles; DELETE is super_admin.
// ──────────────────────────────────────────────────────────
const APPT_MANAGE_ROLES = ["super_admin", "admin", "pa_staff"] as const;
// Read access additionally includes the minister (read-only view of their schedule).
const APPT_READ_ROLES = ["super_admin", "admin", "pa_staff", "minister"] as const;

function serializeAppointment(a: typeof appointmentsTable.$inferSelect) {
  return {
    ...a,
    preferredDate: a.preferredDate?.toISOString() ?? null,
    scheduledDate: a.scheduledDate?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// GET /api/admin/appointments — paginated list with optional filters
router.get("/admin/appointments", requireRole(...APPT_READ_ROLES), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
    const category = typeof req.query.category === "string" && req.query.category ? req.query.category : null;
    const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
    const from = typeof req.query.from === "string" && req.query.from ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" && req.query.to ? new Date(req.query.to) : null;

    const conds = [];
    if (status) conds.push(eq(appointmentsTable.status, status));
    if (category) conds.push(eq(appointmentsTable.category, category));
    if (q) conds.push(sql`(${appointmentsTable.name} ILIKE ${`%${q}%`} OR ${appointmentsTable.ticketNo} ILIKE ${`%${q}%`} OR ${appointmentsTable.subject} ILIKE ${`%${q}%`} OR ${appointmentsTable.phone} ILIKE ${`%${q}%`})`);
    // Filter by scheduled date window when provided (calendar view month range),
    // falling back to preferred date when not yet scheduled.
    if (from && !Number.isNaN(from.getTime())) conds.push(sql`COALESCE(${appointmentsTable.scheduledDate}, ${appointmentsTable.preferredDate}) >= ${from.toISOString()}`);
    if (to && !Number.isNaN(to.getTime())) conds.push(sql`COALESCE(${appointmentsTable.scheduledDate}, ${appointmentsTable.preferredDate}) <= ${to.toISOString()}`);
    const where = conds.length ? and(...conds) : undefined;

    const [rows, [{ total }]] = await Promise.all([
      db.select().from(appointmentsTable).where(where)
        .orderBy(desc(appointmentsTable.createdAt))
        .limit(limit).offset((page - 1) * limit),
      db.select({ total: sql<number>`count(*)::int` }).from(appointmentsTable).where(where),
    ]);

    res.json({
      items: rows.map(serializeAppointment),
      page, limit, total: Number(total),
      totalPages: Math.max(1, Math.ceil(Number(total) / limit)),
    });
  } catch (err) {
    console.error("[admin] appointments list:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/appointments/stats — small KPI summary for widgets
router.get("/admin/appointments/stats", requireRole(...APPT_READ_ROLES), async (_req, res) => {
  try {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
    const byStatus = await db.select({ status: appointmentsTable.status, n: sql<number>`count(*)::int` })
      .from(appointmentsTable).groupBy(appointmentsTable.status);
    const [{ todayCount }] = await db.select({ todayCount: sql<number>`count(*)::int` })
      .from(appointmentsTable)
      .where(and(
        inArray(appointmentsTable.status, ["Approved", "Rescheduled"]),
        gte(appointmentsTable.scheduledDate, startOfToday),
        lte(appointmentsTable.scheduledDate, endOfToday),
      ));
    res.json({
      byStatus: byStatus.map(r => ({ status: r.status, count: Number(r.n) })),
      today: Number(todayCount),
    });
  } catch (err) {
    console.error("[admin] appointments stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/appointments/export — CSV
router.get("/admin/appointments/export", requireRole(...APPT_READ_ROLES), async (_req, res) => {
  try {
    const rows = await db.select().from(appointmentsTable).orderBy(desc(appointmentsTable.createdAt)).limit(2000);
    const headers = ["ID", "Ticket No", "Name", "Phone", "Category", "Subject", "Status", "Preferred", "Alternate", "Scheduled", "Location", "Submitted"];
    const csv = [
      headers.map(h => `"${h}"`).join(","),
      ...rows.map(r => [
        r.id, r.ticketNo, r.name, r.phone, r.category, (r.subject ?? "").replace(/"/g, '""'), r.status,
        r.preferredDate ? new Date(r.preferredDate).toLocaleDateString("en-IN") : "",
        r.alternateDate ? new Date(r.alternateDate).toLocaleDateString("en-IN") : "",
        r.scheduledDate ? new Date(r.scheduledDate).toLocaleDateString("en-IN") : "",
        (r.location ?? "").replace(/"/g, '""'),
        new Date(r.createdAt).toLocaleDateString("en-IN"),
      ].map(v => `"${v}"`).join(",")),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="appointments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[admin] appointments export:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/appointments/:id — single
router.get("/admin/appointments/:id", requireRole(...APPT_READ_ROLES), async (req, res) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const [appt] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, id)).limit(1);
    if (!appt) { res.status(404).json({ error: "Not found" }); return; }
    res.json(serializeAppointment(appt));
  } catch (err) {
    console.error("[admin] appointment get:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function genApptTicket(): string {
  const year = new Date().getFullYear();
  const rand = String(Math.floor(Math.random() * 90000) + 10000);
  return `APT-${year}-${rand}`;
}

const AppointmentCreateBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(40),
  email: z.string().max(200).optional().nullable(),
  address: z.string().max(2000).optional().nullable(),
  ward: z.string().max(200).optional().nullable(),
  category: z.enum(APPOINTMENT_CATEGORIES).optional(),
  subject: z.string().min(1).max(500),
  description: z.string().max(5000).optional().nullable(),
  partySize: z.number().int().min(1).max(1000).optional(),
  preferredDate: z.string().optional().nullable(),
  preferredTime: z.string().optional().nullable(),
  alternateDate: z.string().optional().nullable(),
  scheduledDate: z.string().optional().nullable(),
  scheduledTime: z.string().optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
});

// POST /api/admin/appointments — staff books on behalf of a citizen (e.g. phone-in)
router.post("/admin/appointments", requireRole(...APPT_MANAGE_ROLES), async (req: AuthRequest, res) => {
  try {
    const body = AppointmentCreateBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid request", details: body.error.issues }); return; }
    const d = body.data;

    const toDate = (s: string | null | undefined): Date | null | "INVALID" => {
      if (s === undefined || s === null || s === "") return null;
      const dt = new Date(s);
      return Number.isNaN(dt.getTime()) ? "INVALID" : dt;
    };
    const preferredDate = toDate(d.preferredDate);
    if (preferredDate === "INVALID") { res.status(400).json({ error: "Invalid preferredDate" }); return; }
    const alternateDate = toDate(d.alternateDate);
    if (alternateDate === "INVALID") { res.status(400).json({ error: "Invalid alternateDate" }); return; }
    const scheduledDate = toDate(d.scheduledDate);
    if (scheduledDate === "INVALID") { res.status(400).json({ error: "Invalid scheduledDate" }); return; }

    let ticketNo = genApptTicket();
    const existing = await db.select({ id: appointmentsTable.id }).from(appointmentsTable)
      .where(eq(appointmentsTable.ticketNo, ticketNo)).limit(1);
    if (existing.length > 0) ticketNo = genApptTicket();

    const status = d.status ?? "Pending";
    const scheduledStatus = status === "Approved" || status === "Rescheduled" || status === "Completed";

    const [appointment] = await db.insert(appointmentsTable).values({
      ticketNo,
      name: d.name,
      phone: d.phone,
      email: d.email ?? null,
      address: d.address ?? null,
      ward: d.ward ?? null,
      category: d.category ?? "General",
      subject: d.subject,
      description: d.description ?? null,
      partySize: d.partySize ?? 1,
      preferredDate,
      preferredTime: d.preferredTime ?? null,
      alternateDate,
      scheduledDate,
      scheduledTime: d.scheduledTime ?? null,
      location: d.location ?? null,
      status,
      handledBy: scheduledStatus ? (req.user?.id ?? null) : null,
      handledByName: scheduledStatus ? (req.user?.name ?? null) : null,
      completedAt: status === "Completed" ? new Date() : null,
    }).returning();

    await logAudit(req, "appointment:create", `appointment#${appointment.id} (${appointment.ticketNo})`, undefined);

    res.status(201).json(serializeAppointment(appointment));

    // Async AI priority scoring — fire-and-forget
    setImmediate(() => {
      import("./ai.js").then(({ scoreAppointment }) => scoreAppointment(appointment.id)).catch(() => {});
    });
  } catch (err) {
    console.error("[admin] appointment create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const AppointmentPatchBody = z.object({
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  category: z.enum(APPOINTMENT_CATEGORIES).optional(),
  scheduledDate: z.string().optional().nullable(),
  scheduledTime: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  decisionNote: z.string().optional().nullable(),
  rejectionReason: z.string().optional().nullable(),
  notificationMessage: z.string().optional().nullable(),
  // Editable requester / request details (correct a citizen's booking)
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(40).optional(),
  email: z.string().max(200).optional().nullable(),
  address: z.string().max(2000).optional().nullable(),
  ward: z.string().max(200).optional().nullable(),
  subject: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional().nullable(),
  partySize: z.number().int().min(1).max(1000).optional(),
  preferredDate: z.string().optional().nullable(),
  preferredTime: z.string().optional().nullable(),
  alternateDate: z.string().optional().nullable(),
});

// PATCH /api/admin/appointments/:id — decide (approve/reschedule/reject/complete/cancel) + edit
router.patch("/admin/appointments/:id", requireRole(...APPT_MANAGE_ROLES), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = AppointmentPatchBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Invalid request", details: body.error.issues }); return; }

    const [existing] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const d = body.data;
    const patch: Record<string, unknown> = {};
    if (d.category !== undefined) patch.category = d.category;
    if (d.location !== undefined) patch.location = d.location;
    if (d.decisionNote !== undefined) patch.decisionNote = d.decisionNote;
    if (d.rejectionReason !== undefined) patch.rejectionReason = d.rejectionReason;
    if (d.notificationMessage !== undefined) patch.notificationMessage = d.notificationMessage;
    if (d.scheduledTime !== undefined) patch.scheduledTime = d.scheduledTime;
    // Editable requester / request details
    if (d.name !== undefined) patch.name = d.name;
    if (d.phone !== undefined) patch.phone = d.phone;
    if (d.email !== undefined) patch.email = d.email;
    if (d.address !== undefined) patch.address = d.address;
    if (d.ward !== undefined) patch.ward = d.ward;
    if (d.subject !== undefined) patch.subject = d.subject;
    if (d.description !== undefined) patch.description = d.description;
    if (d.partySize !== undefined) patch.partySize = d.partySize;
    if (d.preferredTime !== undefined) patch.preferredTime = d.preferredTime;
    if (d.scheduledDate !== undefined) {
      if (d.scheduledDate === null) {
        patch.scheduledDate = null;
      } else {
        const sd = new Date(d.scheduledDate);
        if (Number.isNaN(sd.getTime())) {
          res.status(400).json({ error: "Invalid scheduledDate" });
          return;
        }
        patch.scheduledDate = sd;
      }
    }
    if (d.preferredDate !== undefined) {
      if (d.preferredDate === null) {
        patch.preferredDate = null;
      } else {
        const pd = new Date(d.preferredDate);
        if (Number.isNaN(pd.getTime())) {
          res.status(400).json({ error: "Invalid preferredDate" });
          return;
        }
        patch.preferredDate = pd;
      }
    }
    if (d.alternateDate !== undefined) {
      if (d.alternateDate === null) {
        patch.alternateDate = null;
      } else {
        const ad = new Date(d.alternateDate);
        if (Number.isNaN(ad.getTime())) {
          res.status(400).json({ error: "Invalid alternateDate" });
          return;
        }
        patch.alternateDate = ad;
      }
    }
    if (d.status !== undefined) {
      patch.status = d.status;
      patch.handledBy = req.user?.id ?? null;
      patch.handledByName = req.user?.name ?? null;
      if (d.status === "Completed") patch.completedAt = new Date();
    }

    const [updated] = await db.update(appointmentsTable).set(patch)
      .where(eq(appointmentsTable.id, id)).returning();

    await logAudit(req, d.status ? `appointment:${d.status.toLowerCase()}` : "appointment:update",
      `appointment#${id} (${existing.ticketNo})`, d.decisionNote ?? d.rejectionReason ?? undefined);

    res.json(serializeAppointment(updated));
  } catch (err) {
    console.error("[admin] appointment patch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/appointments/:id — super_admin only
router.delete("/admin/appointments/:id", requireRole("super_admin"), async (req: AuthRequest, res) => {
  try {
    const id = parseInt(req.params["id"] as string, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const [existing] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    await db.delete(appointmentsTable).where(eq(appointmentsTable.id, id));
    await logAudit(req, "appointment:delete", `appointment#${id} (${existing.ticketNo})`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] appointment delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
