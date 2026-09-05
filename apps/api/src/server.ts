import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import admin from "firebase-admin";
import { Firestore } from "@google-cloud/firestore";
import { JobsClient } from "@google-cloud/run";

const app = express();
app.use(cors());
app.use(express.json());

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
const GCP_REGION = process.env.GCP_REGION ?? "europe-west3";
const GCS_BUCKET = process.env.GCS_BUCKET ?? "your-gcs-bucket";
const JOB_NAME = process.env.CLOUD_RUN_JOB_NAME ?? "pump-collector-runner";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "obada.dallo95@gmail.com";

// Initialize Firebase Admin
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: GCP_PROJECT_ID,
  });
}

const firestore = new Firestore({
  projectId: GCP_PROJECT_ID,
});

const jobsClient = new JobsClient();

// Auth Middleware
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.DISABLE_AUTH === "true") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const parts = authHeader.split("Bearer ");
  const token = parts[1];
  if (!token || token.trim().length === 0) {
    res.status(401).json({ error: "Missing or invalid Bearer token" });
    return;
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token.trim());
    if (decoded.email && decoded.email !== OWNER_EMAIL && !process.env.ALLOW_ANY_EMAIL) {
      res.status(403).json({ error: `Unauthorized email: ${decoded.email}` });
      return;
    }
    (req as Request & { user?: admin.auth.DecodedIdToken }).user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid Firebase ID token", details: error instanceof Error ? error.message : String(error) });
  }
}

interface SessionDocData {
  lastHeartbeatAt?: string;
  status?: string;
  [key: string]: unknown;
}

interface StartSessionBody {
  durationSeconds?: number | string;
  mode?: string;
  provider?: string;
  force?: boolean;
}

interface StopSessionBody {
  sessionId?: string;
}

// Health check endpoint
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Check if any research session is actively running
app.get("/api/sessions/status", async (_req, res) => {
  try {
    const snapshot = await firestore
      .collection("researchSessions")
      .where("status", "in", ["running", "starting"])
      .get();

    const now = Date.now();
    let activeSession: Record<string, unknown> | null = null;

    for (const doc of snapshot.docs) {
      const data = doc.data() as SessionDocData;
      const heartbeatMs = typeof data.lastHeartbeatAt === "string" ? new Date(data.lastHeartbeatAt).getTime() : 0;
      // If heartbeat was received within the last 90 seconds, session is genuinely active
      if (now - heartbeatMs < 90_000) {
        activeSession = { id: doc.id, ...data };
        break;
      }
    }

    res.json({ active: activeSession !== null, activeSession });
  } catch (error) {
    res.status(500).json({ error: "Failed to check session status", details: error instanceof Error ? error.message : String(error) });
  }
});

// Start research session
app.post("/api/sessions/start", requireAuth, async (req, res) => {
  try {
    const body = req.body as StartSessionBody;
    const durationSeconds = body.durationSeconds ?? 3600;
    const mode = typeof body.mode === "string" ? body.mode : "graduation-research";
    const provider = typeof body.provider === "string" ? body.provider : "helius";
    const force = Boolean(body.force);

    const dur = Number(durationSeconds);
    if (!Number.isFinite(dur) || dur < 60 || dur > 86400) {
      res.status(400).json({ error: "durationSeconds must be between 60 (1m) and 86400 (24h)" });
      return;
    }

    // 1. Concurrency check
    if (!force) {
      const activeQuery = await firestore
        .collection("researchSessions")
        .where("status", "in", ["running", "starting"])
        .get();

      const now = Date.now();
      for (const doc of activeQuery.docs) {
        const data = doc.data() as SessionDocData;
        const heartbeatMs = typeof data.lastHeartbeatAt === "string" ? new Date(data.lastHeartbeatAt).getTime() : 0;
        if (now - heartbeatMs < 90_000) {
          res.status(409).json({
            error: "A research session is already active",
            activeSessionId: doc.id,
            lastHeartbeatAt: data.lastHeartbeatAt,
            hint: "Pass { force: true } if you wish to override and launch concurrently",
          });
          return;
        }
      }
    }

    // 2. Generate Session ID
    const dateStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const sessionId = `session-${dateStr}`;

    // 3. Pre-create session doc in Firestore
    const nowIso = new Date().toISOString();
    await firestore.collection("researchSessions").doc(sessionId).set({
      sessionId,
      mode,
      status: "queued",
      createdAt: nowIso,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      completedAt: null,
      requestedDurationSec: dur,
      elapsedSec: 0,
      provider,
      region: GCP_REGION,
      currentChunk: 1,
      totalEvents: 0,
      launchesDetected: 0,
      tradesDetected: 0,
      failedTxObserved: 0,
      parserErrors: 0,
      disconnectCount: 0,
      reconnectCount: 0,
      bytesPersisted: 0,
      latestEventAt: null,
      latestError: null,
    });

    // 4. Trigger Cloud Run Job
    const jobFullName = `projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
    console.log(`[API] Dispatching Cloud Run Job ${jobFullName} for session ${sessionId} (${dur}s)`);

    const [operation] = await jobsClient.runJob({
      name: jobFullName,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "RESEARCH_SESSION_ID", value: sessionId },
              { name: "RESEARCH_DURATION_SECONDS", value: String(dur) },
              { name: "RESEARCH_MODE", value: mode },
              { name: "GCS_BUCKET", value: GCS_BUCKET },
              { name: "GCP_PROJECT_ID", value: GCP_PROJECT_ID },
              { name: "GCP_REGION", value: GCP_REGION },
              { name: "BOTWINER_FEED_PROVIDER", value: provider },
              { name: "BOTWINER_SINK", value: "cloud" },
            ],
          },
        ],
      },
    });

    res.json({
      success: true,
      sessionId,
      status: "starting",
      requestedDurationSec: dur,
      operationName: operation.name,
    });
  } catch (error) {
    console.error("[API] Failed to start research session:", error);
    res.status(500).json({ error: "Failed to dispatch research session", details: error instanceof Error ? error.message : String(error) });
  }
});

// Stop active research session
app.post("/api/sessions/stop", requireAuth, async (req, res) => {
  try {
    const body = req.body as StopSessionBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const docRef = firestore.collection("researchSessions").doc(sessionId);
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({ error: `Session ${sessionId} not found` });
      return;
    }

    await docRef.update({
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    res.json({ success: true, sessionId, status: "cancelled" });
  } catch (error) {
    res.status(500).json({ error: "Failed to stop session", details: error instanceof Error ? error.message : String(error) });
  }
});

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  console.log(`[botwiner-api] listening on port ${PORT}`);
});
