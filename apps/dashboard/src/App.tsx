import { Portfolios } from "./Portfolios.js";
import type { PortfolioSummary } from "../../../packages/research/src/portfolio-engine.js";
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

interface PaperTradingData {
  strategyId: string;
  costScenarioId: string;
  entriesTriggered: number;
  openPositions: number;
  closedPositions: number;
  censoredPositions: number;
  unresolvedMigrationPositions: number;
  winningClosedTrades: number;
  losingClosedTrades: number;
  winRatePct: number;
  grossPnlSol: number;
  totalPumpFeesSol: number;
  totalTxCostsSol: number;
  netPnlSol: number;
  averagePnlSol: number;
  medianPnlSol: number;
  profitFactor: number;
  averageWinSol: number;
  averageLossSol: number;
  maxWinSol: number;
  maxLossSol: number;
  averageHoldSec: number;
  pnlByExitReason?: {
    takeProfit: { count: number; netPnlSol: number; winRatePct: number };
    stopLoss: { count: number; netPnlSol: number };
    timeout: { count: number; netPnlSol: number; winRatePct: number };
  };
  pnlByTokenAgeBucket?: {
    age5to15s: { count: number; netPnlSol: number; winRatePct: number };
    age15to60s: { count: number; netPnlSol: number; winRatePct: number };
    age60sPlus: { count: number; netPnlSol: number; winRatePct: number };
  };
  pnlByOrganicSpeedBucket?: {
    fastUnder10s: { count: number; netPnlSol: number; winRatePct: number };
    medium10to30s: { count: number; netPnlSol: number; winRatePct: number };
    steady30sPlus: { count: number; netPnlSol: number; winRatePct: number };
  };
  activePositionsSummary?: Array<{
    mint: string;
    openedAtIso: string;
    tokenAgeSec: number;
    currentRealSol: number;
    unrealizedNetReturnPct: number;
    mfePct: number;
    maePct: number;
    status: string;
  }>;
  strategyDefinition?: {
    id?: string;
    strategyId?: string;
    thesis?: string;
    name?: string;
    description?: string;
    entryRules?: {
      sessionLaunchRequired?: boolean;
      realSolThresholdSol?: number;
      firstCrossingOnly?: boolean;
      minTokenAgeMs?: number;
      minObservedTrades?: number;
      reboundCondition?: string;
      sellVolumeFilter?: string;
      higherLowFilter?: string;
    };
  };
  recentClosedTrades?: Array<{
    mint: string;
    openedAtIso: string;
    closedAtIso: string;
    holdDurationSec: number;
    exitReason: string;
    grossPnlSol: number;
    feesSol: number;
    netPnlSol: number;
    netReturnPct: number;
  }>;
}

interface MarketParticipantData {
  disclaimer: string;
  feeCoverageDisclaimer: string;
  totalObservedWallets: number;
  cleanEligibleWallets: number;
  partialWallets: number;
  unresolvedWallets: number;
  cleanClosedWalletCount: number;
  cleanClosedWinningWalletCount: number;
  cleanClosedTraderWinRatePct: number;
  cleanMarkedWalletCount: number;
  cleanMarkedPositivePnlCount: number;
  cleanMarkedPositivePnlRatePct: number;
  realizedProfitableCount: number;
  realizedLossCount: number;
  openProfitableCount: number;
  openUnderwaterCount: number;
  flatCount: number;
  totalCleanRealizedPnlSol: number;
  totalCleanUnrealizedPnlSol: number;
  totalCleanMarkedPnlSol: number;
  top1PctWalletsSolVolumeSharePct: number;
  top5WalletsBuyVolumeSol: number;
  top5WalletsBuyVolumeSharePct: number;
  topCleanWinners?: Array<{
    wallet: string;
    markedPnlSol: number;
    realizedPnlSol: number;
    tradeCount: number;
    mintsTraded: number;
  }>;
  topCleanLosers?: Array<{
    wallet: string;
    markedPnlSol: number;
    realizedPnlSol: number;
    tradeCount: number;
    mintsTraded: number;
  }>;
}

interface CreatorAnalyticsData {
  creatorsObserved: number;
  cleanCreatorsCount?: number;
  partialCreatorsCount?: number;
  creatorsSelling: number;
  cleanCreatorsFullyExited?: number;
  creatorsFullyExited: number;
  medianCleanFirstSellDelaySec?: number;
  medianFirstSellDelaySec: number;
  totalObservedCreatorExtractionSol: number;
  medianObservedCreatorExtractionSol: number;
  largestObservedExtractionSol: number;
  p50Sol: number;
  p75Sol: number;
  p90Sol: number;
  p95Sol: number;
  topCreatorExtractions?: Array<{
    creatorWallet: string;
    mint: string;
    netExtractionSol: number;
    firstSellDelaySec: number;
    pctSold: number;
    inventoryQuality?: string;
  }>;
}

const shortenAddress = (addr?: string) => {
  if (!addr || addr === "unknown") return "—";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
};

interface PaperTradeRow {
  tradeId?: string;
  mint?: string;
  status?: string;
  openedAtUnixMs?: number;
  entryPriceSol?: number;
  entrySolSpent?: number;
  exitPriceSol?: number;
  exitSolReceived?: number;
  netPnlSol?: number;
  returnPct?: number;
  exitReason?: string;
  closedAtUnixMs?: number;
  [key: string]: unknown;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "graduation" | "paper" | "market">("overview");
  const [activeSession, setActiveSession] = useState<ResearchSession | null>(null);
  const [sessionsHistory, setSessionsHistory] = useState<ResearchSession[]>([]);
  const [gradStats, setGradStats] = useState<GraduationStats | null>(null);
  const [candidates, setCandidates] = useState<GraduationCandidate[]>([]);
  const [portfolioStats, setPortfolioStats] = useState<PortfolioSummary | null>(null);
  const [paperStats, setPaperStats] = useState<PaperTradingData | null>(null);
  const [marketStats, setMarketStats] = useState<MarketParticipantData | null>(null);
  const [creatorStats, setCreatorStats] = useState<CreatorAnalyticsData | null>(null);
  const [paperTradesList, setPaperTradesList] = useState<PaperTradeRow[]>([]);
  const [selectedSession, setSelectedSession] = useState<ResearchSession | null>(null);

  // Start Session Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState(3600); // 1 hour default
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // Custom token auth state
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

  // Polling fallback to authenticated API endpoints
  useEffect(() => {
    let isMounted = true;

    const pollApi = async () => {
      const token = await getEffectiveToken();
      if (!token) return;

      try {
        const statusRes = await fetch("/api/sessions/status", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (statusRes.ok) {
          const sData = (await statusRes.json()) as { activeSession?: ResearchSession | null };
          if (isMounted && sData.activeSession) {
            setActiveSession(sData.activeSession);
          }
        }

        const historyRes = await fetch("/api/sessions/history", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (historyRes.ok) {
          const hData = (await historyRes.json()) as { sessions?: ResearchSession[] };
          if (isMounted && Array.isArray(hData.sessions)) {
            setSessionsHistory(hData.sessions);
          }
        }

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

          const portfoliosRes = await fetch(`/api/sessions/${activeSession.sessionId}/stats/portfolios`, { headers: { Authorization: `Bearer ${token}` } });
          if (portfoliosRes.ok) {
            const data = await portfoliosRes.json() as { portfolios: PortfolioSummary | null };
            if (isMounted) setPortfolioStats(data.portfolios);
          }
          const paperRes = await fetch(`/api/sessions/${activeSession.sessionId}/stats/paper-trading`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (paperRes.ok) {
            const pData = (await paperRes.json()) as { paperTrading?: PaperTradingData | null };
            if (isMounted && pData.paperTrading) setPaperStats(pData.paperTrading);
          }

          const marketRes = await fetch(`/api/sessions/${activeSession.sessionId}/stats/market-pnl`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (marketRes.ok) {
            const mData = (await marketRes.json()) as { marketPnl?: MarketParticipantData | null };
            if (isMounted && mData.marketPnl) setMarketStats(mData.marketPnl);
          }

          const creatorRes = await fetch(`/api/sessions/${activeSession.sessionId}/stats/creator-analytics`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (creatorRes.ok) {
            const cData = (await creatorRes.json()) as { creatorAnalytics?: CreatorAnalyticsData | null };
            if (isMounted && cData.creatorAnalytics) setCreatorStats(cData.creatorAnalytics);
          }

          const tradesRes = await fetch(`/api/sessions/${activeSession.sessionId}/paper-trades`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (tradesRes.ok) {
            const tData = (await tradesRes.json()) as { paperTrades?: PaperTradeRow[] };
            if (isMounted && Array.isArray(tData.paperTrades)) setPaperTradesList(tData.paperTrades);
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
        snapshot.forEach((d) => {
          list.push({ sessionId: d.id, ...d.data() } as ResearchSession);
        });
        setSessionsHistory(list);

        const active = list.find((s) => s.status === "running" || s.status === "starting" || s.status === "reconnecting");
        setActiveSession(active || null);
      },
      (error) => {
        console.warn("Firestore subscription status:", error.message);
      }
    );

    return () => unsubscribe();
  }, []);

  // Listen to live stats of active session
  useEffect(() => {
    if (!activeSession) {
      setGradStats(null);
      setPaperStats(null);
      setPortfolioStats(null);
      setMarketStats(null);
      setCreatorStats(null);
      setCandidates([]);
      setPaperTradesList([]);
      return;
    }

    const unsubGrad = onSnapshot(
      doc(db, "researchSessions", activeSession.sessionId, "stats", "current"),
      (snap) => {
        if (snap.exists()) setGradStats(snap.data() as GraduationStats);
      },
      (err) => console.warn("Grad stats error:", err.message)
    );

    const unsubPortfolios = onSnapshot(doc(db, "researchSessions", activeSession.sessionId, "stats", "portfolios"),
      snap => setPortfolioStats(snap.exists() ? snap.data() as PortfolioSummary : null),
      err => console.warn("Portfolio stats error:", err.message));
    const unsubPaper = onSnapshot(
      doc(db, "researchSessions", activeSession.sessionId, "stats", "paperTrading"),
      (snap) => {
        if (snap.exists()) setPaperStats(snap.data() as PaperTradingData);
      },
      (err) => console.warn("Paper stats error:", err.message)
    );

    const unsubMarket = onSnapshot(
      doc(db, "researchSessions", activeSession.sessionId, "stats", "marketPnl"),
      (snap) => {
        if (snap.exists()) setMarketStats(snap.data() as MarketParticipantData);
      },
      (err) => console.warn("Market stats error:", err.message)
    );

    const unsubCreator = onSnapshot(
      doc(db, "researchSessions", activeSession.sessionId, "stats", "creatorAnalytics"),
      (snap) => {
        if (snap.exists()) setCreatorStats(snap.data() as CreatorAnalyticsData);
      },
      (err) => console.warn("Creator stats error:", err.message)
    );

    const unsubCandidates = onSnapshot(
      query(collection(db, "researchSessions", activeSession.sessionId, "graduations"), orderBy("realSolLamports", "desc"), limit(30)),
      (snap) => {
        const list: GraduationCandidate[] = [];
        snap.forEach((d) => list.push({ mint: d.id, ...d.data() } as GraduationCandidate));
        setCandidates(list);
      },
      (err) => console.warn("Candidates error:", err.message)
    );

    const unsubTrades = onSnapshot(
      query(collection(db, "researchSessions", activeSession.sessionId, "paperTrades"), orderBy("openedAtUnixMs", "desc"), limit(50)),
      (snap) => {
        const list: PaperTradeRow[] = [];
        snap.forEach((d) => list.push({ tradeId: d.id, ...(d.data() as PaperTradeRow) }));
        setPaperTradesList(list);
      },
      (err) => console.warn("Trades error:", err.message)
    );

    return () => {
      unsubGrad();
      unsubPaper();
      unsubPortfolios();
      unsubMarket();
      unsubCreator();
      unsubCandidates();
      unsubTrades();
    };
  }, [activeSession?.sessionId]);

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
  };

  const handleStartSession = async () => {
    setIsStarting(true);
    setStartError(null);
    try {
      const token = await getEffectiveToken();
      if (!token) {
        throw new Error("Authorization required. Please sign in or provide a token.");
      }

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
        sessionId?: string;
        error?: string;
      }
      const data = (await response.json()) as StartApiResponse;
      if (!response.ok) {
        throw new Error(data.error || "Failed to start session");
      }

      setIsModalOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    if (!confirm(`Are you sure you want to stop active session ${sessionId}?`)) return;

    setIsStopping(true);
    setStopError(null);
    try {
      const token = await getEffectiveToken();
      if (!token) {
        throw new Error("Authorization required. Please sign in or provide a token.");
      }

      const response = await fetch("/api/sessions/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId }),
      });

      interface StopApiResponse {
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
            <div className="brand-subtitle">Pump.fun Live Paper Trading & Market Analytics</div>
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

      {/* Tabs Navigation */}
      <nav className="tabs-nav" id="main-tabs">
        <button
          className={`tab-btn ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
          id="tab-overview"
        >
          1. Overview & Collector
        </button>
        <button
          className={`tab-btn ${activeTab === "graduation" ? "active" : ""}`}
          onClick={() => setActiveTab("graduation")}
          id="tab-graduation"
        >
          2. Graduation Research
        </button>
        <button
          className={`tab-btn ${activeTab === "paper" ? "active" : ""}`}
          onClick={() => setActiveTab("paper")}
          id="tab-paper"
        >
          3. Live Paper Trading
        </button>
        <button
          className={`tab-btn ${activeTab === "market" ? "active" : ""}`}
          onClick={() => setActiveTab("market")}
          id="tab-market"
        >
          4. Market Intelligence
        </button>
      </nav>

      {/* TAB 1: OVERVIEW & COLLECTOR */}
      {activeTab === "overview" && (
        <>
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

          {/* Sessions History Table */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Research Sessions History</h2>
              <span className="field-value field-mono" style={{ fontSize: "0.85rem" }}>
                {sessionsHistory.length} Recorded
              </span>
            </div>

            <div className="table-container">
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
                  {sessionsHistory.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                        No research sessions found. Click &quot;Start Research Session&quot; to begin.
                      </td>
                    </tr>
                  ) : (
                    sessionsHistory.map((s) => (
                      <tr key={s.sessionId}>
                        <td className="field-mono">{s.sessionId}</td>
                        <td>
                          <span className={`status-pill ${s.status}`} style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}>
                            {s.status}
                          </span>
                        </td>
                        <td>{new Date(s.startedAt).toLocaleString()}</td>
                        <td>{formatDuration(s.elapsedSec)}</td>
                        <td>{s.totalEvents.toLocaleString()}</td>
                        <td>{s.launchesDetected.toLocaleString()}</td>
                        <td>{formatBytes(s.bytesPersisted)}</td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
                            onClick={() => setSelectedSession(s)}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* TAB 2: GRADUATION RESEARCH */}
      {activeTab === "graduation" && (
        <>
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
          </section>

          {/* Live Candidates Table */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">
                <span>Graduation Candidates (&ge; 50 SOL or Graduated)</span>
              </h2>
              <span className="field-value field-mono" style={{ fontSize: "0.85rem" }}>
                {candidates.length} Detected
              </span>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mint</th>
                    <th>Creator</th>
                    <th>Current Real SOL</th>
                    <th>Peak Real SOL</th>
                    <th>Curve Progress</th>
                    <th>Trades</th>
                    <th>Classification</th>
                    <th>Status</th>
                    <th>Last Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                        No tokens have crossed &ge; 50 SOL yet in this active session.
                      </td>
                    </tr>
                  ) : (
                    candidates.map((c) => {
                      const curSol = Number(BigInt(c.currentRealSolLamports || "0")) / 1e9;
                      const peakSol = Number(BigInt(c.maxRealSolLamports || "0")) / 1e9;
                      return (
                        <tr key={c.mint}>
                          <td className="field-mono">{shortenAddress(c.mint)}</td>
                          <td className="field-mono">{shortenAddress(c.creatorWallet)}</td>
                          <td className="field-mono">{curSol.toFixed(2)} SOL</td>
                          <td className="field-mono">{peakSol.toFixed(2)} SOL</td>
                          <td>
                            <div className="progress-bar-bg">
                              <div
                                className="progress-bar-fill"
                                style={{ width: `${Math.min(100, c.curveProgressPct)}%` }}
                              ></div>
                            </div>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                              {c.curveProgressPct.toFixed(1)}%
                            </span>
                          </td>
                          <td>{c.tradeCount}</td>
                          <td>
                            <span
                              className={`status-pill ${
                                c.classification === "organic"
                                  ? "running"
                                  : c.classification === "instant-bundle"
                                    ? "failed"
                                    : "queued"
                              }`}
                              style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}
                            >
                              {c.classification}
                            </span>
                          </td>
                          <td>
                            {c.graduated ? (
                              <span style={{ color: "#34d399", fontWeight: 600 }}>GRADUATED</span>
                            ) : (
                              <span style={{ color: "#a5b4fc" }}>BONDING</span>
                            )}
                          </td>
                          <td>{new Date(c.updatedAt).toLocaleTimeString()}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* TAB 3: LIVE PAPER TRADING */}
      {activeTab === "paper" && <Portfolios data={portfolioStats} />}
      {activeTab === "paper" && (
        <>
          <div className="research-banner">
            <div>
              <div className="banner-title">PAPER TRADING — NO REAL FUNDS</div>
              <div className="banner-subtitle">
                Strategy: {paperStats?.strategyId || "organic-50sol-continuation-v1"} | Cost Scenario: {paperStats?.costScenarioId || "paper-medium-v1"}
              </div>
            </div>
            <div className="limitation-pill" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#34d399", borderColor: "rgba(16, 185, 129, 0.4)" }}>
              Causal 0.10 SOL Quotes
            </div>
          </div>

          {/* Canonical Strategy Specification */}
          <div className="section-card" style={{ marginBottom: "1.25rem", background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--accent-cyan)" }}>
                Strategy Specification: organic-50sol-continuation-v1
              </div>
              <span className="status-pill running" style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}>
                Frozen Rule
              </span>
            </div>
            <div style={{ fontSize: "0.825rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              <div><strong>Thesis:</strong> Graduation / Curve-Progress Momentum (enters on first organic crossing from &lt;50 SOL to &ge;50 SOL real reserves for tokens launched in session).</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "0.35rem" }}>
                <span>&bull; Min Age: <strong>&ge; 5s</strong></span>
                <span>&bull; Min Trades: <strong>&ge; 5</strong></span>
                <span>&bull; Instant Bundle: <strong>Disallowed (&lt;1.5s / same slot)</strong></span>
                <span>&bull; Position Sizing: <strong>0.10 SOL fixed input</strong></span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "0.35rem", color: "var(--text-muted)" }}>
                <span>&bull; Rebound Filter: <strong style={{ color: "#34d399" }}>NONE (0)</strong></span>
                <span>&bull; Sell-Volume Filter: <strong style={{ color: "#34d399" }}>NONE (0)</strong></span>
                <span>&bull; Higher-Low Filter: <strong style={{ color: "#34d399" }}>NONE (0)</strong></span>
                <span>&bull; Exits: <strong>+30% Net TP | -20% Net SL | 5m Timeout</strong></span>
              </div>
            </div>
          </div>

          {/* Paper Trading KPIs */}
          <section className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Open Positions</div>
              <div className="kpi-value" style={{ color: "var(--accent-cyan)" }}>
                {paperStats?.openPositions ?? 0}
              </div>
              <div className="kpi-sub">Triggered: {paperStats?.entriesTriggered ?? 0}</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Closed Trades</div>
              <div className="kpi-value">{paperStats?.closedPositions ?? 0}</div>
              <div className="kpi-sub">
                Censored: {paperStats?.censoredPositions ?? 0} | Migration: {paperStats?.unresolvedMigrationPositions ?? 0}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Win Rate %</div>
              <div className="kpi-value" style={{ color: (paperStats?.winRatePct ?? 0) >= 50 ? "#34d399" : "#f87171" }}>
                {paperStats?.winRatePct ?? 0}%
              </div>
              <div className="kpi-sub">
                {paperStats?.winningClosedTrades ?? 0}W / {paperStats?.losingClosedTrades ?? 0}L (Closed only)
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Net PnL (SOL)</div>
              <div className={`kpi-value ${(paperStats?.netPnlSol ?? 0) >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                {(paperStats?.netPnlSol ?? 0) > 0 ? "+" : ""}
                {paperStats?.netPnlSol ?? 0} SOL
              </div>
              <div className="kpi-sub">Gross: {paperStats?.grossPnlSol ?? 0} SOL</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Total Protocol & Tx Fees</div>
              <div className="kpi-value" style={{ color: "var(--accent-amber)" }}>
                {(((paperStats?.totalPumpFeesSol ?? 0) + (paperStats?.totalTxCostsSol ?? 0))).toFixed(6)} SOL
              </div>
              <div className="kpi-sub">
                Pump: {paperStats?.totalPumpFeesSol ?? 0} | Tx: {paperStats?.totalTxCostsSol ?? 0}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Profit Factor / Hold</div>
              <div className="kpi-value">{paperStats?.profitFactor ?? 0}</div>
              <div className="kpi-sub">Avg Hold: {paperStats?.averageHoldSec ?? 0}s</div>
            </div>
          </section>

          {/* Performance Breakdowns */}
          <div className="breakdown-row">
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "0.95rem", marginBottom: "0.75rem" }}>
                PnL by Exit Reason
              </h3>
              <div style={{ fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Take Profit (+30%):</span>
                  <span className="pnl-pos">
                    {paperStats?.pnlByExitReason?.takeProfit.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.takeProfit.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Stop Loss (-20%):</span>
                  <span className="pnl-neg">
                    {paperStats?.pnlByExitReason?.stopLoss.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.stopLoss.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Timeout (5m):</span>
                  <span>
                    {paperStats?.pnlByExitReason?.timeout.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.timeout.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "0.95rem", marginBottom: "0.75rem" }}>
                PnL by Token Age at Trigger
              </h3>
              <div style={{ fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>5s – 15s:</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age5to15s.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age5to15s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>15s – 60s:</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age15to60s.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age15to60s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>60s+:</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age60sPlus.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age60sPlus.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "0.95rem", marginBottom: "0.75rem" }}>
                PnL by Speed to 50 SOL
              </h3>
              <div style={{ fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Fast (&lt;10s):</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.fastUnder10s.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.fastUnder10s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Medium (10s – 30s):</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.medium10to30s.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.medium10to30s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Steady (30s+):</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.steady30sPlus.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.steady30sPlus.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Active Open Positions Table */}
          <section className="section-card" style={{ marginTop: "1.5rem" }}>
            <div className="section-header">
              <h2 className="section-title">Live Active Open Positions</h2>
              <span className="field-value field-mono" style={{ fontSize: "0.85rem" }}>
                {paperStats?.activePositionsSummary?.length ?? 0} Active
              </span>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mint</th>
                    <th>Opened</th>
                    <th>Token Age</th>
                    <th>Entry Real SOL</th>
                    <th>Unrealized Return %</th>
                    <th>MFE %</th>
                    <th>MAE %</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {!paperStats?.activePositionsSummary || paperStats.activePositionsSummary.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                        No paper positions currently open.
                      </td>
                    </tr>
                  ) : (
                    paperStats.activePositionsSummary.map((p) => (
                      <tr key={p.mint}>
                        <td className="field-mono">{shortenAddress(p.mint)}</td>
                        <td>{new Date(p.openedAtIso).toLocaleTimeString()}</td>
                        <td>{p.tokenAgeSec}s</td>
                        <td className="field-mono">{p.currentRealSol.toFixed(2)} SOL</td>
                        <td className={`field-mono ${p.unrealizedNetReturnPct >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                          {p.unrealizedNetReturnPct > 0 ? "+" : ""}
                          {p.unrealizedNetReturnPct.toFixed(2)}%
                        </td>
                        <td className="field-mono pnl-pos">+{p.mfePct.toFixed(2)}%</td>
                        <td className="field-mono pnl-neg">{p.maePct.toFixed(2)}%</td>
                        <td>
                          <span className="status-pill running" style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}>
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Recent Closed Trades Table */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Recent Closed Paper Trades</h2>
              <span className="field-value field-mono" style={{ fontSize: "0.85rem" }}>
                {paperTradesList.length > 0 ? paperTradesList.length : paperStats?.recentClosedTrades?.length ?? 0} Closed
              </span>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mint</th>
                    <th>Hold</th>
                    <th>Exit Reason</th>
                    <th>Gross PnL</th>
                    <th>Fees (Pump+Tx)</th>
                    <th>Net PnL (SOL)</th>
                    <th>Net Return %</th>
                  </tr>
                </thead>
                <tbody>
                  {!paperStats?.recentClosedTrades || paperStats.recentClosedTrades.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                        No paper trades closed yet.
                      </td>
                    </tr>
                  ) : (
                    paperStats.recentClosedTrades.map((t, idx) => (
                      <tr key={idx}>
                        <td className="field-mono">{shortenAddress(t.mint)}</td>
                        <td>{t.holdDurationSec}s</td>
                        <td>
                          <span
                            className={`status-pill ${
                              t.exitReason === "take-profit"
                                ? "running"
                                : t.exitReason === "stop-loss"
                                  ? "failed"
                                  : "queued"
                            }`}
                            style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}
                          >
                            {t.exitReason}
                          </span>
                        </td>
                        <td className="field-mono">{t.grossPnlSol.toFixed(6)} SOL</td>
                        <td className="field-mono">{t.feesSol.toFixed(6)} SOL</td>
                        <td className={`field-mono ${t.netPnlSol >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                          {t.netPnlSol > 0 ? "+" : ""}
                          {t.netPnlSol.toFixed(6)} SOL
                        </td>
                        <td className={`field-mono ${t.netReturnPct >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                          {t.netReturnPct > 0 ? "+" : ""}
                          {t.netReturnPct.toFixed(2)}%
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* TAB 4: MARKET PARTICIPANT INTELLIGENCE */}
      {activeTab === "market" && (
        <>
          <div className="disclaimer-banner">
            <div>
              <strong>Methodology Notice:</strong> {marketStats?.disclaimer || "Session-scoped estimate. External transaction costs may be incomplete. Mid-session inventory is excluded from clean profitability metrics. Estimated curve trading PnL before Pump protocol fees and unobserved external transaction costs."}
            </div>
            <div style={{ marginTop: "0.35rem", fontSize: "0.775rem", color: "#f87171" }}>
              <strong>Fee Coverage Disclaimer:</strong> {marketStats?.feeCoverageDisclaimer || "Estimated curve trading PnL before Pump protocol fees and unobserved external transaction costs."}
            </div>
          </div>

          {/* Participant Cohort KPIs */}
          <section className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Observed Wallets</div>
              <div className="kpi-value">{marketStats?.totalObservedWallets ?? 0}</div>
              <div className="kpi-sub">
                Clean: {marketStats?.cleanEligibleWallets ?? 0} | Partial: {marketStats?.partialWallets ?? 0}
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Clean Closed Trader Win Rate</div>
              <div
                className="kpi-value"
                style={{
                  color: (marketStats?.cleanClosedTraderWinRatePct ?? 0) >= 50 ? "#34d399" : "#f87171",
                }}
              >
                {marketStats?.cleanClosedTraderWinRatePct ?? 0}%
              </div>
              <div className="kpi-sub">
                N = {marketStats?.cleanClosedWalletCount ?? 0} eligible wallets ({marketStats?.cleanClosedWinningWalletCount ?? 0} winners)
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Clean Marked Positive PnL</div>
              <div className="kpi-value" style={{ color: "var(--accent-cyan)" }}>
                {marketStats?.cleanMarkedPositivePnlRatePct ?? 0}%
              </div>
              <div className="kpi-sub">
                {marketStats?.cleanMarkedPositivePnlCount ?? 0} of {marketStats?.cleanMarkedWalletCount ?? 0} marked wallets
              </div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Realized Distribution</div>
              <div className="kpi-value" style={{ fontSize: "1.2rem" }}>
                <span className="pnl-pos">{marketStats?.realizedProfitableCount ?? 0} Win</span> /{" "}
                <span className="pnl-neg">{marketStats?.realizedLossCount ?? 0} Loss</span>
              </div>
              <div className="kpi-sub">Fully closed positions</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Open Inventory State</div>
              <div className="kpi-value" style={{ fontSize: "1.2rem" }}>
                <span className="pnl-pos">{marketStats?.openProfitableCount ?? 0} Profit</span> /{" "}
                <span className="pnl-neg">{marketStats?.openUnderwaterCount ?? 0} Under</span>
              </div>
              <div className="kpi-sub">Active token holders</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Clean Marked PnL (SOL)</div>
              <div className={`kpi-value ${(marketStats?.totalCleanMarkedPnlSol ?? 0) >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                {(marketStats?.totalCleanMarkedPnlSol ?? 0) > 0 ? "+" : ""}
                {marketStats?.totalCleanMarkedPnlSol ?? 0} SOL
              </div>
              <div className="kpi-sub">Realized: {marketStats?.totalCleanRealizedPnlSol ?? 0} SOL</div>
            </div>
          </section>

          {/* Whale Concentration & Creator Extraction */}
          <div className="breakdown-row">
            {/* Whale Concentration */}
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
                Whale & Concentration Intelligence
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                    <span style={{ color: "var(--text-secondary)" }}>Top 1% Wallets Volume Share:</span>
                    <strong className="field-mono">{marketStats?.top1PctWalletsSolVolumeSharePct ?? 0}%</strong>
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                    <span style={{ color: "var(--text-secondary)" }}>Top 5 Wallets Buy Volume:</span>
                    <strong className="field-mono">
                      {marketStats?.top5WalletsBuyVolumeSol ?? 0} SOL ({marketStats?.top5WalletsBuyVolumeSharePct ?? 0}%)
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            {/* Creator Analytics Summary */}
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
                Observed Creator Net SOL Extraction
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Creators Clean / Partial:</span>
                  <strong>
                    {creatorStats?.cleanCreatorsCount ?? creatorStats?.creatorsObserved ?? 0} Clean / {creatorStats?.partialCreatorsCount ?? 0} Partial (Total: {creatorStats?.creatorsObserved ?? 0})
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Selling / Clean Fully Exited:</span>
                  <strong>
                    {creatorStats?.creatorsSelling ?? 0} Selling / {creatorStats?.cleanCreatorsFullyExited ?? creatorStats?.creatorsFullyExited ?? 0} Fully Exited
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Median First-Sell Delay:</span>
                  <strong className="field-mono">
                    {creatorStats?.medianCleanFirstSellDelaySec ?? creatorStats?.medianFirstSellDelaySec ?? 0}s (Clean) | {creatorStats?.medianFirstSellDelaySec ?? 0}s (All)
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Total Net SOL Extracted:</span>
                  <strong className="field-mono pnl-neg" style={{ color: "#f87171" }}>
                    {creatorStats?.totalObservedCreatorExtractionSol ?? 0} SOL
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Extraction Percentiles (p50 / p90 / Max):</span>
                  <span className="field-mono" style={{ fontSize: "0.8rem" }}>
                    {creatorStats?.p50Sol ?? 0} / {creatorStats?.p90Sol ?? 0} / {creatorStats?.largestObservedExtractionSol ?? 0} SOL
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Top Clean Winners and Losers */}
          <div className="breakdown-row" style={{ marginTop: "1.5rem" }}>
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "0.95rem", color: "#34d399", marginBottom: "0.75rem" }}>
                Top Clean Winning Wallets
              </h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Marked PnL</th>
                      <th>Realized PnL</th>
                      <th>Trades</th>
                      <th>Mints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!marketStats?.topCleanWinners || marketStats.topCleanWinners.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "1rem" }}>
                          No clean winners observed.
                        </td>
                      </tr>
                    ) : (
                      marketStats.topCleanWinners.map((w, idx) => (
                        <tr key={idx}>
                          <td className="field-mono">{shortenAddress(w.wallet)}</td>
                          <td className="field-mono pnl-pos">+{w.markedPnlSol.toFixed(4)} SOL</td>
                          <td className="field-mono">+{w.realizedPnlSol.toFixed(4)} SOL</td>
                          <td>{w.tradeCount}</td>
                          <td>{w.mintsTraded}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-title" style={{ fontSize: "0.95rem", color: "#f87171", marginBottom: "0.75rem" }}>
                Top Clean Losing Wallets
              </h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Marked PnL</th>
                      <th>Realized PnL</th>
                      <th>Trades</th>
                      <th>Mints</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!marketStats?.topCleanLosers || marketStats.topCleanLosers.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: "1rem" }}>
                          No clean losers observed.
                        </td>
                      </tr>
                    ) : (
                      marketStats.topCleanLosers.map((w, idx) => (
                        <tr key={idx}>
                          <td className="field-mono">{shortenAddress(w.wallet)}</td>
                          <td className="field-mono pnl-neg">{w.markedPnlSol.toFixed(4)} SOL</td>
                          <td className="field-mono">{w.realizedPnlSol.toFixed(4)} SOL</td>
                          <td>{w.tradeCount}</td>
                          <td>{w.mintsTraded}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Top Creator Extractions Table */}
          <section className="section-card" style={{ marginTop: "1.5rem" }}>
            <div className="section-header">
              <h2 className="section-title">Largest Observed Creator Extraction Events</h2>
              <span className="field-value field-mono" style={{ fontSize: "0.85rem" }}>
                {creatorStats?.topCreatorExtractions?.length ?? 0} Recorded
              </span>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Creator</th>
                    <th>Mint</th>
                    <th>Quality</th>
                    <th>Net SOL Extracted</th>
                    <th>First Sell Delay</th>
                    <th>% Inventory Sold</th>
                  </tr>
                </thead>
                <tbody>
                  {!creatorStats?.topCreatorExtractions || creatorStats.topCreatorExtractions.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>
                        No creator extraction events observed.
                      </td>
                    </tr>
                  ) : (
                    creatorStats.topCreatorExtractions.map((e, idx) => (
                      <tr key={idx}>
                        <td className="field-mono">{shortenAddress(e.creatorWallet)}</td>
                        <td className="field-mono">{shortenAddress(e.mint)}</td>
                        <td>
                          <span
                            className={`status-pill ${e.inventoryQuality === "CLEAN" ? "running" : "queued"}`}
                            style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                          >
                            {e.inventoryQuality || "CLEAN"}
                          </span>
                        </td>
                        <td className="field-mono pnl-neg" style={{ color: "#f87171" }}>
                          +{e.netExtractionSol.toFixed(4)} SOL
                        </td>
                        <td className="field-mono">{e.firstSellDelaySec}s</td>
                        <td>{e.pctSold !== undefined ? `${e.pctSold.toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* Start Session Modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Start Research Capture Session</h3>
              <button className="modal-close" onClick={() => setIsModalOpen(false)}>
                &times;
              </button>
            </div>

            <div className="warning-box">
              <strong>Cost-Controlled Research Run:</strong> Spins up Cloud Run job, streams Pump.fun WebSocket
              feed to chunked GCS storage, executes live causal paper trading, and aggregates participant analytics.
            </div>

            <label className="field-label">Target Duration</label>
            <div className="duration-selector">
              {[
                { label: "3m (Smoke)", val: 180 },
                { label: "15m", val: 900 },
                { label: "1 Hour", val: 3600 },
                { label: "6 Hours", val: 21600 },
              ].map((d) => (
                <button
                  key={d.val}
                  type="button"
                  className={`duration-btn ${selectedDuration === d.val ? "selected" : ""}`}
                  onClick={() => setSelectedDuration(d.val)}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {startError && (
              <div className="warning-box" style={{ borderColor: "rgba(239, 68, 68, 0.4)", color: "#fca5a5" }}>
                {startError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
              <button className="btn btn-secondary" onClick={() => setIsModalOpen(false)} disabled={isStarting}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleStartSession} disabled={isStarting} id="btn-modal-confirm-start">
                {isStarting ? "Starting..." : "Launch Cloud Run Job"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Token Modal */}
      {isTokenModalOpen && (
        <div className="modal-overlay" onClick={() => setIsTokenModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Set Authorization Token</h3>
              <button className="modal-close" onClick={() => setIsTokenModalOpen(false)}>
                &times;
              </button>
            </div>

            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginBottom: "1rem" }}>
              Enter your Firebase ID token or Google ID token. This will be stored locally in your browser and sent
              in the Authorization header to authenticated API endpoints.
            </p>

            <textarea
              style={{
                width: "100%",
                height: "100px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-sm)",
                color: "white",
                padding: "0.5rem",
                fontFamily: "var(--font-mono)",
                fontSize: "0.8rem",
                marginBottom: "1rem",
              }}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="eyJhbGciOiJSUzI1NiIs..."
            />

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button className="btn btn-secondary" onClick={() => setIsTokenModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setAuthToken(tokenInput.trim());
                  localStorage.setItem("botwiner_token", tokenInput.trim());
                  setIsTokenModalOpen(false);
                }}
              >
                Save Token
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Details Modal */}
      {selectedSession && (
        <div className="modal-overlay" onClick={() => setSelectedSession(null)}>
          <div className="modal-content" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Session Details</h3>
              <button className="modal-close" onClick={() => setSelectedSession(null)}>
                &times;
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.875rem" }}>
              <div>
                <span className="field-label">Session ID</span>
                <span className="field-value field-mono">{selectedSession.sessionId}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <span className="field-label">Status</span>
                  <span className={`status-pill ${selectedSession.status}`}>{selectedSession.status}</span>
                </div>
                <div>
                  <span className="field-label">Duration</span>
                  <span className="field-value">{formatDuration(selectedSession.elapsedSec)}</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <span className="field-label">Started At</span>
                  <span className="field-value">{new Date(selectedSession.startedAt).toLocaleString()}</span>
                </div>
                <div>
                  <span className="field-label">Completed At</span>
                  <span className="field-value">
                    {selectedSession.completedAt ? new Date(selectedSession.completedAt).toLocaleString() : "—"}
                  </span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <span className="field-label">Total Events</span>
                  <span className="field-value">{selectedSession.totalEvents.toLocaleString()}</span>
                </div>
                <div>
                  <span className="field-label">Launches Detected</span>
                  <span className="field-value">{selectedSession.launchesDetected.toLocaleString()}</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <div>
                  <span className="field-label">GCS Chunks Persisted</span>
                  <span className="field-value">{selectedSession.currentChunk} chunks</span>
                </div>
                <div>
                  <span className="field-label">Total Size</span>
                  <span className="field-value">{formatBytes(selectedSession.bytesPersisted)}</span>
                </div>
              </div>
              {selectedSession.latestError && (
                <div className="warning-box" style={{ borderColor: "rgba(239,68,68,0.4)", color: "#fca5a5" }}>
                  <strong>Error:</strong> {selectedSession.latestError}
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
              <button className="btn btn-secondary" onClick={() => setSelectedSession(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
