import { useEffect, useState } from "react";
import {
  auth,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  db,
  collection,
  doc,
  query,
  orderBy,
  limit,
  onSnapshot,
  type User,
} from "./firebase.js";

interface ResearchSession {
  sessionId: string;
  mode: string;
  status: "queued" | "starting" | "running" | "reconnecting" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string;
  lastHeartbeatAt: string;
  completedAt: string | null;
  requestedDurationSec: number | null;
  elapsedSec: number;
  provider: string;
  region: string;
  currentChunk: number;
  totalEvents: number;
  launchesDetected: number;
  tradesDetected: number;
  failedTxObserved: number;
  parserErrors: number;
  disconnectCount: number;
  reconnectCount: number;
  bytesPersisted: number;
  latestEventAt: string | null;
  latestError: string | null;
}

interface GraduationStats {
  tokensTracked: number;
  curve50PlusCount: number;
  curve60PlusCount: number;
  curve70PlusCount: number;
  curve80PlusCount: number;
  nearGraduationCount: number;
  graduationsDetected: number;
  organicGraduationsDetected: number;
  instantBundleGraduationsDetected: number;
  migrationsDetected: number;
}

interface GraduationCandidate {
  mint: string;
  creatorWallet: string;
  curveProgressPct: number;
  currentRealSolLamports: string;
  maxRealSolLamports: string;
  tradeCount: number;
  classification: "organic" | "instant-bundle" | "unknown";
  graduated: boolean;
  updatedAt: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeSession, setActiveSession] = useState<ResearchSession | null>(null);
  const [sessionsHistory, setSessionsHistory] = useState<ResearchSession[]>([]);
  const [gradStats, setGradStats] = useState<GraduationStats | null>(null);
  const [candidates, setCandidates] = useState<GraduationCandidate[]>([]);
  const [selectedSession, setSelectedSession] = useState<ResearchSession | null>(null);

  // Start Session Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState(3600); // 1 hour default
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // Custom token auth state (for owner identity/bearer token)
  const [authToken, setAuthToken] = useState<string>(() => localStorage.getItem("botwiner_token") || "");
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");

  const getEffectiveToken = async (): Promise<string> => {
    if (user) {
      try {
        const idTok = await user.getIdToken();
        if (idTok) return idTok;
      } catch {
        // fallback
      }
    }
    return authToken;
  };

  // Auth listener
  useEffect(() => {
    return onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
  }, []);

  // Polling fallback to authenticated API endpoints when token is present
  useEffect(() => {
    let isMounted = true;

    const pollApi = async () => {
      const token = await getEffectiveToken();
      if (!token) return;

      try {
        // Fetch session status
        const statusRes = await fetch("/api/sessions/status", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (statusRes.ok) {
          const sData = (await statusRes.json()) as { activeSession?: ResearchSession | null };
          if (isMounted && sData.activeSession) {
            setActiveSession(sData.activeSession);
          }
        }

        // Fetch sessions history
        const historyRes = await fetch("/api/sessions/history", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (historyRes.ok) {
          const hData = (await historyRes.json()) as { sessions?: ResearchSession[] };
          if (isMounted && Array.isArray(hData.sessions)) {
            setSessionsHistory(hData.sessions);
          }
        }

        // If active session exists, fetch live stats & graduations
        if (activeSession) {
          const statsRes = await fetch(`/api/sessions/${activeSession.sessionId}/stats`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (statsRes.ok) {
            const stData = (await statsRes.json()) as { stats?: GraduationStats | null };
            if (isMounted && stData.stats) setGradStats(stData.stats);
          }

          const gradsRes = await fetch(`/api/sessions/${activeSession.sessionId}/graduations`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (gradsRes.ok) {
            const gData = (await gradsRes.json()) as { graduations?: GraduationCandidate[] };
            if (isMounted && Array.isArray(gData.graduations)) setCandidates(gData.graduations);
          }
        }
      } catch (err) {
        console.warn("API poll warning:", err);
      }
    };

    void pollApi();
    const timer = setInterval(() => {
      void pollApi();
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [authToken, user, activeSession?.sessionId]);

  // Listen to active sessions and session history via Firestore SDK
  useEffect(() => {
    const sessionsRef = collection(db, "researchSessions");
    const q = query(sessionsRef, orderBy("startedAt", "desc"), limit(20));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: ResearchSession[] = [];
        snapshot.forEach((doc) => {
          list.push({ sessionId: doc.id, ...doc.data() } as ResearchSession);
        });
        setSessionsHistory(list);

        // Active session is first one that is running or starting
        const active = list.find((s) => s.status === "running" || s.status === "starting" || s.status === "reconnecting");
        setActiveSession(active || null);
      },
      (error) => {
        // Silently log permission error when client is unauthenticated
        console.warn("Firestore subscription status:", error.message);
      }
    );

    return () => unsubscribe();
  }, []);

  // Listen to live graduation stats of active session
  useEffect(() => {
    if (!activeSession) {
      setGradStats(null);
      return;
    }

    const statsRef = doc(db, "researchSessions", activeSession.sessionId, "stats", "current");
    const unsubscribe = onSnapshot(
      statsRef,
      (snapshot) => {
        if (snapshot.exists()) {
          setGradStats(snapshot.data() as GraduationStats);
        }
      },
      (error) => {
        console.error("Failed to listen to stats:", error);
      }
    );

    return () => unsubscribe();
  }, [activeSession?.sessionId]);

  // Listen to live graduation candidates
  useEffect(() => {
    if (!activeSession) {
      setCandidates([]);
      return;
    }

    const candidatesRef = collection(db, "researchSessions", activeSession.sessionId, "graduations");
    const q = query(candidatesRef, orderBy("realSolLamports", "desc"), limit(30));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: GraduationCandidate[] = [];
        snapshot.forEach((doc) => {
          list.push({ mint: doc.id, ...doc.data() } as GraduationCandidate);
        });
        setCandidates(list);
      },
      (error) => {
        console.error("Failed to listen to candidates:", error);
      }
    );

    return () => unsubscribe();
  }, [activeSession?.sessionId]);

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Auth sign-in failed:", err);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Auth sign-out failed:", err);
    }
  };

  const handleStartSession = async () => {
    setIsStarting(true);
    setStartError(null);

    try {
      const token = await getEffectiveToken();
      const response = await fetch("/api/sessions/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          durationSeconds: selectedDuration,
          mode: "graduation-research",
          provider: "helius",
        }),
      });

      interface StartApiResponse {
        success?: boolean;
        sessionId?: string;
        activeSessionId?: string;
        error?: string;
      }
      const data = (await response.json()) as StartApiResponse;
      if (!response.ok) {
        if (response.status === 409 && data.activeSessionId) {
          setStartError(`A research session (${data.activeSessionId}) is currently active. Only one active session is permitted.`);
        } else {
          setStartError(data.error ?? "Failed to start session");
        }
        setIsStarting(false);
        return;
      }

      setIsModalOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    if (!confirm(`Are you sure you want to stop active session ${sessionId}? Cloud Run execution will be terminated immediately.`)) {
      return;
    }
    setIsStopping(true);
    setStopError(null);

    try {
      const token = await getEffectiveToken();
      const response = await fetch("/api/sessions/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId }),
      });

      interface StopApiResponse {
        success?: boolean;
        sessionId?: string;
        status?: string;
        error?: string;
      }
      const data = (await response.json()) as StopApiResponse;
      if (!response.ok) {
        setStopError(data.error ?? "Failed to stop session");
      }
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStopping(false);
    }
  };

  const formatDuration = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const isLive = activeSession?.status === "running" || activeSession?.status === "reconnecting";

  return (
    <div className="dashboard-container">
      {/* Top Header */}
      <header className="header">
        <div className="brand-section">
          <div className="brand-icon">B</div>
          <div>
            <h1 className="brand-title">BOTWINER RESEARCH</h1>
            <div className="brand-subtitle">Pump.fun Market Data & Graduation Telemetry</div>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={() => setIsModalOpen(true)}
            id="btn-start-session"
          >
            Start Research Session
          </button>

          {authToken ? (
            <div className="user-badge" style={{ borderColor: "rgba(16, 185, 129, 0.4)", background: "rgba(16, 185, 129, 0.1)" }}>
              <span style={{ color: "#34d399", fontWeight: 600 }}>Owner Token Active</span>
              <button
                className="btn btn-secondary"
                style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                onClick={() => {
                  setAuthToken("");
                  localStorage.removeItem("botwiner_token");
                }}
              >
                Clear
              </button>
            </div>
          ) : (
            <button
              className="btn btn-secondary"
              id="btn-auth-token"
              onClick={() => {
                setTokenInput(authToken);
                setIsTokenModalOpen(true);
              }}
            >
              Set Token
            </button>
          )}

          {user ? (
            <div className="user-badge">
              {user.photoURL && <img src={user.photoURL} alt="User avatar" className="user-avatar" />}
              <span>{user.displayName || user.email}</span>
              <button className="btn btn-secondary" onClick={handleSignOut} style={{ padding: "0.3rem 0.6rem" }}>
                Logout
              </button>
            </div>
          ) : (
            <button className="btn btn-secondary" onClick={handleSignIn} id="btn-login">
              Sign In (Google)
            </button>
          )}
        </div>
      </header>

      {/* Active Session Status Card */}
      {stopError && (
        <div className="warning-box" style={{ marginBottom: "1rem", borderColor: "rgba(239, 68, 68, 0.4)", color: "#fca5a5" }}>
          {stopError}
        </div>
      )}

      {activeSession && (
        <section className="status-card">
          <div className="status-header">
            <div className="session-badge-group">
              <span className={`status-pill ${activeSession.status}`}>
                {isLive && <span className="heartbeat-dot"></span>}
                {activeSession.status}
              </span>
              <span className="field-value field-mono" style={{ fontSize: "1rem" }}>
                {activeSession.sessionId}
              </span>
            </div>

            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className="limitation-pill" style={{ background: "rgba(99, 102, 241, 0.15)", color: "#a5b4fc", borderColor: "rgba(99,102,241,0.3)" }}>
                {activeSession.provider.toUpperCase()} RPC
              </span>
              <span className="limitation-pill" style={{ background: "rgba(6, 182, 212, 0.15)", color: "#67e8f9", borderColor: "rgba(6,182,212,0.3)" }}>
                {activeSession.region}
              </span>
              {isLive && (
                <button
                  id="btn-stop-session"
                  className="btn btn-secondary"
                  style={{
                    background: "rgba(239, 68, 68, 0.15)",
                    borderColor: "rgba(239, 68, 68, 0.4)",
                    color: "#fca5a5",
                    padding: "0.3rem 0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    cursor: isStopping ? "not-allowed" : "pointer",
                  }}
                  disabled={isStopping}
                  onClick={() => handleStopSession(activeSession.sessionId)}
                >
                  {isStopping ? "Stopping..." : "Stop Session"}
                </button>
              )}
            </div>
          </div>

          <div className="status-grid">
            <div className="status-field">
              <span className="field-label">Elapsed / Target</span>
              <span className="field-value">
                {formatDuration(activeSession.elapsedSec)} /{" "}
                {activeSession.requestedDurationSec ? formatDuration(activeSession.requestedDurationSec) : "Open"}
              </span>
            </div>

            <div className="status-field">
              <span className="field-label">Last Heartbeat</span>
              <span className="field-value">
                {activeSession.lastHeartbeatAt ? new Date(activeSession.lastHeartbeatAt).toLocaleTimeString() : "—"}
              </span>
            </div>

            <div className="status-field">
              <span className="field-label">Current Chunk</span>
              <span className="field-value field-mono">Chunk #{activeSession.currentChunk}</span>
            </div>

            <div className="status-field">
              <span className="field-label">GCS Storage Written</span>
              <span className="field-value">{formatBytes(activeSession.bytesPersisted)}</span>
            </div>
          </div>
        </section>
      )}

      {/* Key Metric KPIs */}
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total Events</div>
          <div className="kpi-value">{(activeSession?.totalEvents || 0).toLocaleString()}</div>
          <div className="kpi-sub">Normalized stream</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Launches Detected</div>
          <div className="kpi-value" style={{ color: "var(--accent-cyan)" }}>
            {(activeSession?.launchesDetected || 0).toLocaleString()}
          </div>
          <div className="kpi-sub">Pump.fun tokens</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Trades Processed</div>
          <div className="kpi-value" style={{ color: "var(--accent-indigo)" }}>
            {(activeSession?.tradesDetected || 0).toLocaleString()}
          </div>
          <div className="kpi-sub">Curve executions</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Tokens Tracked</div>
          <div className="kpi-value">{gradStats?.tokensTracked || 0}</div>
          <div className="kpi-sub">Active in window</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Reconnects / Disconnects</div>
          <div className="kpi-value" style={{ color: (activeSession?.disconnectCount || 0) > 0 ? "var(--accent-amber)" : "white" }}>
            {activeSession?.reconnectCount || 0} / {activeSession?.disconnectCount || 0}
          </div>
          <div className="kpi-sub">Feed stability</div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Failed / Truncated Txs</div>
          <div className="kpi-value">
            {activeSession?.failedTxObserved || 0} / {activeSession?.parserErrors || 0}
          </div>
          <div className="kpi-sub">RPC notifications</div>
        </div>
      </section>

      {/* Graduation Observability Panel */}
      <section className="section-card">
        <div className="section-header">
          <h2 className="section-title">
            <span>Phase 4C — Bonding Curve Graduation Observability</span>
          </h2>
          <span className="limitation-pill">
            Migration decoding: Limitation noted (IDL revision does not emit migration events; no faked counts)
          </span>
        </div>

        <div className="graduation-grid">
          <div className="grad-box">
            <div className="grad-box-label">&ge; 50 SOL</div>
            <div className="grad-box-value">{gradStats?.curve50PlusCount || 0}</div>
          </div>

          <div className="grad-box">
            <div className="grad-box-label">&ge; 60 SOL</div>
            <div className="grad-box-value">{gradStats?.curve60PlusCount || 0}</div>
          </div>

          <div className="grad-box">
            <div className="grad-box-label">&ge; 70 SOL</div>
            <div className="grad-box-value">{gradStats?.curve70PlusCount || 0}</div>
          </div>

          <div className="grad-box highlight">
            <div className="grad-box-label">&ge; 80 SOL (Near Grad)</div>
            <div className="grad-box-value" style={{ color: "#a5b4fc" }}>
              {gradStats?.nearGraduationCount || 0}
            </div>
          </div>

          <div className="grad-box organic">
            <div className="grad-box-label">Organic Graduations</div>
            <div className="grad-box-value" style={{ color: "#34d399" }}>
              {gradStats?.organicGraduationsDetected || 0}
            </div>
          </div>

          <div className="grad-box bundle">
            <div className="grad-box-label">Instant Bundles</div>
            <div className="grad-box-value" style={{ color: "#f87171" }}>
              {gradStats?.instantBundleGraduationsDetected || 0}
            </div>
          </div>

          <div className="grad-box">
            <div className="grad-box-label">Migrations</div>
            <div className="grad-box-value" style={{ color: "var(--text-muted)" }}>
              {gradStats?.migrationsDetected || 0}
            </div>
          </div>
        </div>

        {/* Near Graduation Candidates Stream */}
        {candidates.length > 0 && (
          <div style={{ marginTop: "1.25rem" }}>
            <h3 style={{ fontSize: "0.85rem", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: "0.5rem" }}>
              Recent Graduation Candidates
            </h3>
            <div className="activity-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mint</th>
                    <th>Curve Progress</th>
                    <th>Real SOL</th>
                    <th>Trades</th>
                    <th>Classification</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.mint}>
                      <td className="mono-cell">{c.mint.slice(0, 6)}...{c.mint.slice(-6)}</td>
                      <td>
                        <span style={{ fontWeight: 600, color: c.curveProgressPct >= 95 ? "#34d399" : "#a5b4fc" }}>
                          {c.curveProgressPct}%
                        </span>
                      </td>
                      <td>{(Number(c.currentRealSolLamports) / 1e9).toFixed(2)} SOL</td>
                      <td>{c.tradeCount}</td>
                      <td>
                        <span className={`status-pill ${c.classification === "organic" ? "running" : c.classification === "instant-bundle" ? "failed" : "starting"}`}>
                          {c.classification}
                        </span>
                      </td>
                      <td>{c.graduated ? "Graduated" : "In Curve"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Session History */}
      <section className="section-card">
        <div className="section-header">
          <h2 className="section-title">Research Sessions History</h2>
        </div>

        <div className="activity-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Events</th>
                <th>Launches</th>
                <th>Storage</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessionsHistory.map((s) => (
                <tr key={s.sessionId}>
                  <td className="mono-cell">{s.sessionId}</td>
                  <td>
                    <span className={`status-pill ${s.status}`} style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}>
                      {s.status}
                    </span>
                  </td>
                  <td>{new Date(s.startedAt).toLocaleDateString()} {new Date(s.startedAt).toLocaleTimeString()}</td>
                  <td>{formatDuration(s.elapsedSec)}</td>
                  <td>{s.totalEvents.toLocaleString()}</td>
                  <td>{s.launchesDetected}</td>
                  <td>{formatBytes(s.bytesPersisted)}</td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "0.25rem 0.6rem", fontSize: "0.75rem" }}
                      onClick={() => setSelectedSession(s)}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Session Details Modal */}
      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Session Details</h3>
              <button className="modal-close" onClick={() => setSelectedSession(null)}>
                &times;
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.85rem" }}>
              <div><strong>Session ID:</strong> <span className="mono-cell">{selectedSession.sessionId}</span></div>
              <div><strong>Status:</strong> {selectedSession.status}</div>
              <div><strong>Provider:</strong> {selectedSession.provider} ({selectedSession.region})</div>
              <div><strong>Elapsed Duration:</strong> {formatDuration(selectedSession.elapsedSec)}</div>
              <div><strong>Total Events:</strong> {selectedSession.totalEvents.toLocaleString()}</div>
              <div><strong>Total Launches:</strong> {selectedSession.launchesDetected.toLocaleString()}</div>
              <div><strong>Total Trades:</strong> {selectedSession.tradesDetected.toLocaleString()}</div>
              <div><strong>Chunks Written:</strong> {selectedSession.currentChunk}</div>
              <div><strong>Compressed Storage:</strong> {formatBytes(selectedSession.bytesPersisted)}</div>
              <div>
                <strong>GCS Storage Location:</strong>
                <div className="mono-cell" style={{ wordBreak: "break-all", background: "var(--bg-elevated)", padding: "0.5rem", borderRadius: "4px", marginTop: "0.25rem" }}>
                  gs://your-gcs-bucket/sessions/{selectedSession.sessionId}/
                </div>
              </div>
            </div>

            <div style={{ marginTop: "1.5rem", textAlign: "right" }}>
              <button className="btn btn-secondary" onClick={() => setSelectedSession(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Start Session Modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Start Autonomous Research Session</h3>
              <button className="modal-close" onClick={() => setIsModalOpen(false)}>
                &times;
              </button>
            </div>

            {startError && <div className="warning-box">{startError}</div>}

            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
              Dispatches a background Cloud Run Job in <strong>europe-west3</strong> to collect and stream Pump.fun market data and graduation metrics to GCS and Firestore.
            </p>

            <div style={{ marginTop: "1rem" }}>
              <label className="field-label">Select Session Duration</label>
              <div className="duration-selector">
                <button
                  className={`duration-btn ${selectedDuration === 300 ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(300)}
                >
                  5 Min (Smoke)
                </button>
                <button
                  className={`duration-btn ${selectedDuration === 3600 ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(3600)}
                >
                  1 Hour
                </button>
                <button
                  className={`duration-btn ${selectedDuration === 7200 ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(7200)}
                >
                  2 Hours
                </button>
                <button
                  className={`duration-btn ${selectedDuration === 14400 ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(14400)}
                >
                  4 Hours
                </button>
                <button
                  className={`duration-btn ${selectedDuration === 21600 ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(21600)}
                >
                  6 Hours
                </button>
              </div>
            </div>

            <div style={{ marginTop: "1.5rem", display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button className="btn btn-secondary" onClick={() => setIsModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleStartSession}
                disabled={isStarting}
              >
                {isStarting ? "Dispatching..." : "Launch Cloud Session"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Token Auth Modal */}
      {isTokenModalOpen && (
        <div className="modal-overlay" onClick={() => setIsTokenModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "540px" }}>
            <div className="modal-header">
              <h2 className="modal-title">Authenticate as Owner</h2>
              <button className="btn-close" onClick={() => setIsTokenModalOpen(false)}>
                &times;
              </button>
            </div>

            <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "1rem" }}>
              Enter a valid Firebase ID Token or Google Identity Token for <strong>obada.dallo95@gmail.com</strong>.
            </p>

            <textarea
              className="token-input"
              rows={5}
              placeholder="Paste ID Token here (e.g. from gcloud auth print-identity-token)"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              style={{
                width: "100%",
                background: "rgba(15, 23, 42, 0.6)",
                border: "1px solid var(--border-color)",
                borderRadius: "6px",
                color: "#f8fafc",
                fontFamily: "monospace",
                fontSize: "0.8rem",
                padding: "0.75rem",
                resize: "vertical",
              }}
            />

            <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button className="btn btn-secondary" onClick={() => setIsTokenModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const cleaned = tokenInput.trim();
                  setAuthToken(cleaned);
                  if (cleaned) {
                    localStorage.setItem("botwiner_token", cleaned);
                  } else {
                    localStorage.removeItem("botwiner_token");
                  }
                  setIsTokenModalOpen(false);
                }}
              >
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
