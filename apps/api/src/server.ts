import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import admin from "firebase-admin";
import { Firestore } from "@google-cloud/firestore";
import { JobsClient, ExecutionsClient } from "@google-cloud/run";
import { generateCollisionResistantSessionId } from "@botwiner/storage";

const app = express();

// Security Headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// Restricted CORS
const ALLOWED_ORIGINS = new Set([
  "https://example.invalid/your-dashboard",
  "https://your-project-id.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080",
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()) : []),
]);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, health probes, server-to-server)
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);

app.use(express.json());

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
const GCP_REGION = process.env.GCP_REGION ?? "europe-west3";
const GCS_BUCKET = process.env.GCS_BUCKET ?? "your-gcs-bucket";
const JOB_NAME = process.env.CLOUD_RUN_JOB_NAME ?? "pump-collector-runner";

// Configuration for owner authorization - fail closed if not configured in production
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim() || undefined;
const OWNER_UID = process.env.OWNER_UID?.trim() || undefined;
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined;

function parseBoolean(val: string | undefined): boolean {
  return typeof val === "string" && val.trim().toLowerCase() === "true";
}
const DISABLE_AUTH = parseBoolean(process.env.DISABLE_AUTH);

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
const executionsClient = new ExecutionsClient();

// Seed authorizedUsers collection with configured owner on boot
async function seedAuthorizedOwner(): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    if (OWNER_EMAIL) {
      await firestore.collection("authorizedUsers").doc(OWNER_EMAIL).set(
        {
          role: "owner",
          email: OWNER_EMAIL,
          updatedAt: nowIso,
        },
        { merge: true }
      );
      console.log(`[API] Authorized owner email registered in Firestore: ${OWNER_EMAIL}`);
    }
    if (OWNER_UID) {
      await firestore.collection("authorizedUsers").doc(OWNER_UID).set(
        {
          role: "owner",
          uid: OWNER_UID,
          updatedAt: nowIso,
        },
        { merge: true }
      );
      console.log(`[API] Authorized owner UID registered in Firestore: ${OWNER_UID}`);
    }
  } catch (error) {
    console.warn("[API] Failed to seed authorizedUsers collection:", error);
  }
}
const isRunningTests =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.argv.some((arg) => arg.includes("--test") || arg.includes("test"));

if (!isRunningTests) {
  void seedAuthorizedOwner();
}

export interface DecodedAuthUser {
  email?: string | undefined;
  uid?: string | undefined;
  isOwnerClaim?: boolean | undefined;
}

export interface DecodedAuthToken {
  uid: string;
  email?: string;
  owner?: boolean;
  [key: string]: unknown;
}

export async function verifyToken(
  token: string,
  options?: {
    verifyFirebaseIdToken?: ((t: string) => Promise<DecodedAuthToken>) | undefined;
    googleOAuthClientId?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
  }
): Promise<DecodedAuthUser> {
  const verifyFb = options?.verifyFirebaseIdToken ?? ((t: string) => admin.auth().verifyIdToken(t));
  const googleClientId = options?.googleOAuthClientId ?? GOOGLE_OAUTH_CLIENT_ID;
  const fetchFn = options?.fetchImpl ?? fetch;

  try {
    const decoded = await verifyFb(token);
    return {
      email: decoded.email,
      uid: decoded.uid,
      isOwnerClaim: decoded.owner === true,
    };
  } catch (fbErr) {
    // If Google ID token fallback is configured, strictly verify issuer, audience, expiration, and email_verified
    if (googleClientId) {
      try {
        const verifyResp = await fetchFn(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
        );
        if (verifyResp.ok) {
          const info = (await verifyResp.json()) as {
            email?: string;
            sub?: string;
            email_verified?: string | boolean;
            aud?: string;
            iss?: string;
            exp?: string | number;
          };
          const isGoogleIssuer =
            info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
          const isAudienceMatch = info.aud === googleClientId;
          const isEmailVerified = info.email_verified === "true" || info.email_verified === true;
          const expSeconds = typeof info.exp === "string" ? Number.parseInt(info.exp, 10) : Number(info.exp);
          const isNotExpired = !Number.isNaN(expSeconds) && expSeconds * 1000 > Date.now();

          if (isGoogleIssuer && isAudienceMatch && isEmailVerified && isNotExpired) {
            return {
              email: info.email,
              uid: info.sub,
              isOwnerClaim: false,
            };
          }
        }
      } catch {
        // Fallback network error: ignore and rethrow fbErr
      }
    }
    throw fbErr;
  }
}

// Auth Middleware: requires valid Firebase ID token (or strict Google OAuth token if configured) and verifies owner identity
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (DISABLE_AUTH) {
    console.warn("[API] WARNING: Auth is disabled via DISABLE_AUTH=true");
    next();
    return;
  }

  if (!OWNER_EMAIL && !OWNER_UID) {
    res.status(503).json({
      error: "Server authorization configuration missing: OWNER_EMAIL or OWNER_UID must be configured on the server.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (token.length === 0) {
    res.status(401).json({ error: "Missing or invalid Bearer token" });
    return;
  }

  try {
    const verified = await verifyToken(token);
    const isOwner =
      (OWNER_EMAIL !== undefined && verified.email === OWNER_EMAIL) ||
      (OWNER_UID !== undefined && verified.uid === OWNER_UID) ||
      verified.isOwnerClaim === true;

    if (!isOwner) {
      res.status(403).json({
        error: `Forbidden: caller (${verified.email ?? verified.uid}) is not an authorized owner.`,
      });
      return;
    }

    (req as Request & { user?: DecodedAuthUser }).user = verified;
    next();
  } catch (error) {
    res.status(401).json({
      error: "Invalid ID token",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

interface StartSessionBody {
  durationSeconds?: number | string;
  mode?: string;
  provider?: string;
}

interface StopSessionBody {
  sessionId?: string;
}

// Public Minimal Health Check (no metadata or sensitive info)
app.get(["/healthz", "/api/healthz", "/api/health"], (_req, res) => {
  res.json({ status: "ok" });
});

// Protected Session Status Check (requires auth)
app.get("/api/sessions/status", requireAuth, async (_req, res) => {
  try {
    const lockRef = firestore.collection("researchControl").doc("activeSession");
    const lockDoc = await lockRef.get();
    const now = Date.now();
    let active = false;
    let activeSession: Record<string, unknown> | null = null;

    if (lockDoc.exists) {
      const data = lockDoc.data() as {
        sessionId?: string;
        lastHeartbeatAt?: string;
        startedAt?: string;
        status?: string;
        [key: string]: unknown;
      };

      if (data.status === "starting" || data.status === "running" || data.status === "reconnecting") {
        const hbTime = data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).getTime() : 0;
        const startTime = data.startedAt ? new Date(data.startedAt).getTime() : 0;
        const recentTime = Math.max(hbTime, startTime);

        if (now - recentTime < 90_000) {
          active = true;
          if (data.sessionId) {
            const sDoc = await firestore.collection("researchSessions").doc(data.sessionId).get();
            if (sDoc.exists) {
              activeSession = { id: sDoc.id, ...sDoc.data() };
            } else {
              activeSession = data;
            }
          }
        }
      }
    }

    res.json({ active, activeSession });
  } catch (error) {
    res.status(500).json({
      error: "Failed to check session status",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Session History (requires auth)
app.get("/api/sessions/history", requireAuth, async (_req, res) => {
  try {
    const snapshot = await firestore
      .collection("researchSessions")
      .orderBy("startedAt", "desc")
      .limit(30)
      .get();
    const sessions = snapshot.docs.map((d) => ({ sessionId: d.id, ...d.data() }));
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch sessions history",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Live Graduation Stats (requires auth)
app.get("/api/sessions/:sessionId/stats", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const doc = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("stats")
      .doc("current")
      .get();
    res.json({ stats: doc.exists ? doc.data() : null });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch session stats",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Live Graduation Candidates (requires auth)
app.get("/api/sessions/:sessionId/graduations", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const snapshot = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("graduations")
      .orderBy("realSolLamports", "desc")
      .limit(30)
      .get();
    const graduations = snapshot.docs.map((d) => ({ mint: d.id, ...d.data() }));
    res.json({ graduations });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch graduations",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Paper Trading Stats
app.get("/api/sessions/:sessionId/stats/paper-trading", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const doc = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("stats")
      .doc("paperTrading")
      .get();
    res.json({ paperTrading: doc.exists ? doc.data() : null });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch paper trading stats",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Market PnL Stats
app.get("/api/sessions/:sessionId/stats/market-pnl", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const doc = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("stats")
      .doc("marketPnl")
      .get();
    res.json({ marketPnl: doc.exists ? doc.data() : null });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch market pnl stats",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Creator Analytics Stats
app.get("/api/sessions/:sessionId/stats/creator-analytics", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const doc = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("stats")
      .doc("creatorAnalytics")
      .get();
    res.json({ creatorAnalytics: doc.exists ? doc.data() : null });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch creator analytics",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Paper Trades List
app.get("/api/sessions/:sessionId/paper-trades", requireAuth, async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId parameter is required" });
      return;
    }
    const snapshot = await firestore
      .collection("researchSessions")
      .doc(sessionId)
      .collection("paperTrades")
      .orderBy("openedAtUnixMs", "desc")
      .limit(50)
      .get();
    const paperTrades = snapshot.docs.map((d) => ({ tradeId: d.id, ...d.data() }));
    res.json({ paperTrades });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch paper trades",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Protected Start Session (with atomic concurrency lock)
app.post("/api/sessions/start", requireAuth, async (req, res) => {
  const sessionId = generateCollisionResistantSessionId("session");
  const lockRef = firestore.collection("researchControl").doc("activeSession");
  const sessionRef = firestore.collection("researchSessions").doc(sessionId);

  try {
    const body = req.body as StartSessionBody;
    const durationSeconds = body.durationSeconds ?? 3600;
    const mode = typeof body.mode === "string" ? body.mode : "graduation-research";
    const provider = typeof body.provider === "string" ? body.provider : "helius";

    const dur = Number(durationSeconds);
    if (!Number.isFinite(dur) || dur < 60 || dur > 86400) {
      res.status(400).json({ error: "durationSeconds must be between 60 (1m) and 86400 (24h)" });
      return;
    }

    const nowIso = new Date().toISOString();

    // 1. Atomic Concurrency Lock Check via Firestore Transaction
    await firestore.runTransaction(async (transaction) => {
      const lockDoc = await transaction.get(lockRef);
      const now = Date.now();

      if (lockDoc.exists) {
        const data = lockDoc.data() as {
          sessionId?: string;
          lastHeartbeatAt?: string;
          startedAt?: string;
          status?: string;
        };

        if (data.status === "starting" || data.status === "running" || data.status === "reconnecting") {
          const hbTime = data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).getTime() : 0;
          const startTime = data.startedAt ? new Date(data.startedAt).getTime() : 0;
          const recentTime = Math.max(hbTime, startTime);

          if (now - recentTime < 90_000) {
            throw new Error(`ACTIVE_SESSION_EXISTS:${data.sessionId ?? "unknown"}`);
          }
        }
      }

      // Claim lock document
      transaction.set(lockRef, {
        sessionId,
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        status: "starting",
        executionName: null,
        operationName: null,
      });

      // Create initial session document in same atomic transaction
      transaction.set(sessionRef, {
        sessionId,
        mode,
        status: "starting",
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
    });

    // 2. Dispatch Cloud Run Job
    const jobFullName = `projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
    console.log(`[API] Dispatching Cloud Run Job ${jobFullName} for session ${sessionId} (${dur}s)`);

    try {
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

      const operationName = operation.name ?? null;
      const executionName = operation.metadata?.name ?? null;

      // Update session doc and lock with execution identity
      await Promise.all([
        sessionRef.update({
          operationName,
          executionName,
        }),
        lockRef.update({
          operationName,
          executionName,
        }),
      ]);

      res.json({
        success: true,
        sessionId,
        status: "starting",
        requestedDurationSec: dur,
        operationName,
        executionName,
      });
    } catch (dispatchError) {
      // Release lock on dispatch failure so system is not stuck
      await lockRef.set(
        {
          status: "failed",
          error: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
          failedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      await sessionRef.update({
        status: "failed",
        latestError: dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
        completedAt: new Date().toISOString(),
      });
      throw dispatchError;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith("ACTIVE_SESSION_EXISTS:")) {
      const activeId = msg.split(":")[1];
      res.status(409).json({
        error: "A research session is already active",
        activeSessionId: activeId,
      });
      return;
    }

    console.error("[API] Failed to start research session:", error);
    res.status(500).json({
      error: "Failed to dispatch research session",
      details: msg,
    });
  }
});

// Protected Stop Session (Authenticates owner, cancels Cloud Run execution, waits for termination, releases lock)
app.post("/api/sessions/stop", requireAuth, async (req, res) => {
  try {
    const body = req.body as StopSessionBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const sessionRef = firestore.collection("researchSessions").doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      res.status(404).json({ error: `Session ${sessionId} not found` });
      return;
    }

    const sessionData = sessionDoc.data() as {
      status?: string;
      executionName?: string | null;
      operationName?: string | null;
      [key: string]: unknown;
    };

    if (sessionData.status === "completed" || sessionData.status === "cancelled" || sessionData.status === "failed") {
      res.json({
        success: true,
        sessionId,
        status: sessionData.status,
        message: "Session is already finalized",
      });
      return;
    }

    const jobFullName = `projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/jobs/${JOB_NAME}`;
    let targetExecutionName = sessionData.executionName ?? null;

    // If executionName was not stored, resolve it from Cloud Run executions list
    if (!targetExecutionName) {
      try {
        const [executions] = await executionsClient.listExecutions({ parent: jobFullName });
        for (const ex of executions) {
          const envs = ex.template?.containers?.[0]?.env ?? [];
          const sessionEnv = envs.find((e) => e.name === "RESEARCH_SESSION_ID");
          if (sessionEnv && sessionEnv.value === sessionId) {
            targetExecutionName = ex.name ?? null;
            break;
          }
        }
      } catch (listErr) {
        console.warn("[API] Failed to list executions to find target execution:", listErr);
      }
    }

    // Cancel Cloud Run execution if located
    if (targetExecutionName) {
      console.log(`[API] Cancelling Cloud Run execution ${targetExecutionName} for session ${sessionId}`);
      try {
        await executionsClient.cancelExecution({ name: targetExecutionName });

        // Wait up to 12 seconds for Cloud Run execution to observe cancellation/termination
        const waitStart = Date.now();
        while (Date.now() - waitStart < 12_000) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          try {
            const [ex] = await executionsClient.getExecution({ name: targetExecutionName });
            const completedCondition = ex.conditions?.find((c) => c.type === "Completed");
            const isFinished = Boolean(
              ex.completionTime ||
              ex.deleteTime ||
              (completedCondition && (completedCondition.state === "CONDITION_SUCCEEDED" || completedCondition.state === "CONDITION_FAILED")) ||
              (ex.runningCount !== null && ex.runningCount !== undefined && ex.runningCount === 0 && !ex.reconciling)
            );
            if (isFinished) {
              console.log(`[API] Execution ${targetExecutionName} confirmed stopped/cancelled`);
              break;
            }
          } catch {
            break;
          }
        }
      } catch (cancelError) {
        console.warn(`[API] cancelExecution returned warning/error for ${targetExecutionName}:`, cancelError);
      }
    } else {
      console.warn(`[API] Could not resolve execution name for session ${sessionId}, updating state directly`);
    }

    const nowIso = new Date().toISOString();

    // Release active lock and update session doc
    const lockRef = firestore.collection("researchControl").doc("activeSession");
    await Promise.all([
      sessionRef.update({
        status: "cancelled",
        completedAt: nowIso,
      }),
      lockRef.set(
        {
          sessionId,
          status: "cancelled",
          cancelledAt: nowIso,
        },
        { merge: true }
      ),
    ]);

    res.json({
      success: true,
      sessionId,
      status: "cancelled",
      executionName: targetExecutionName,
    });
  } catch (error) {
    console.error("[API] Failed to stop session:", error);
    res.status(500).json({
      error: "Failed to stop session",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

const PORT = Number(process.env.PORT ?? 8080);
if (!isRunningTests) {
  app.listen(PORT, () => {
    console.log(`[botwiner-api] listening on port ${PORT}`);
  });
}
