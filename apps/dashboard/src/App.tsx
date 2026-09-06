import { Portfolios } from "./Portfolios.js";
import { ResearchCommandCenter } from "./ResearchCommandCenter.js";
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

// ─── Types ────────────────────────────────────────────────────────────────────

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
  segmentDurationSeconds?: number;
  totalSegmentsExpected?: number;
  currentSegmentIndex?: number;
  currentSegmentId?: string;
  checkpointPath?: string | null;
}

interface SegmentDoc {
  segmentId: string;
  segmentIndex: number;
  status: string;
  startedAt?: string;
  completedAt?: string;
  checkpointedAt?: string;
  checkpointPath?: string;
  chunksWritten?: number;
  handoffGapMs?: number;
  handoffOverlapCount?: number;
  lastCommittedChunkIndex?: number;
  error?: string | null;
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

// ─── Utilities ────────────────────────────────────────────────────────────────

type TabId = "overview" | "portfolios" | "strategy" | "market" | "data";

const shortenAddress = (addr?: string) => {
  if (!addr || addr === "unknown") return "—";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
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

const pnlCls = (v?: number | null) =>
  v == null ? "" : v >= 0 ? "pnl-pos" : "pnl-neg";

const pnlSign = (v?: number | null) => (v != null && v > 0 ? "+" : "");

function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="table-empty">
        {text}
      </td>
    </tr>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{status}</span>;
}

function Chip({
  children,
  color,
  small,
}: {
  children: React.ReactNode;
  color?: string;
  small?: boolean;
}) {
  return (
    <span
      className="chip"
      style={{
        ...(color ? { color, borderColor: `${color}44` } : {}),
        ...(small ? { fontSize: "0.7rem", padding: "0.1rem 0.35rem" } : {}),
      }}
    >
      {children}
    </span>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
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
  const [sessionSegments, setSessionSegments] = useState<SegmentDoc[]>([]);
  const [isLoadingSegments, setIsLoadingSegments] = useState(false);
  const [selectedPortfolioStats, setSelectedPortfolioStats] = useState<PortfolioSummary | null>(null);
  const [selectedPaperStats, setSelectedPaperStats] = useState<PaperTradingData | null>(null);
  const [selectedMarketStats, setSelectedMarketStats] = useState<MarketParticipantData | null>(null);
  const [selectedCreatorStats, setSelectedCreatorStats] = useState<CreatorAnalyticsData | null>(null);
  const [selectedGradStats, setSelectedGradStats] = useState<GraduationStats | null>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDuration, setSelectedDuration] = useState(3600);
  const [selectedSegmentDuration, setSelectedSegmentDuration] = useState(1800);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const [authToken, setAuthToken] = useState<string>(
    () => localStorage.getItem("botwiner_token") || ""
  );
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

  // Polling fallback
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
          const statsRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/stats`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (statsRes.ok) {
            const stData = (await statsRes.json()) as { stats?: GraduationStats | null };
            if (isMounted && stData.stats) setGradStats(stData.stats);
          }

          const gradsRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/graduations`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (gradsRes.ok) {
            const gData = (await gradsRes.json()) as { graduations?: GraduationCandidate[] };
            if (isMounted && Array.isArray(gData.graduations)) setCandidates(gData.graduations);
          }

          const portfoliosRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/stats/portfolios`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (portfoliosRes.ok) {
            const data = (await portfoliosRes.json()) as { portfolios: PortfolioSummary | null };
            if (isMounted) setPortfolioStats(data.portfolios);
          }

          const paperRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/stats/paper-trading`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (paperRes.ok) {
            const pData = (await paperRes.json()) as { paperTrading?: PaperTradingData | null };
            if (isMounted && pData.paperTrading) setPaperStats(pData.paperTrading);
          }

          const marketRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/stats/market-pnl`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (marketRes.ok) {
            const mData = (await marketRes.json()) as { marketPnl?: MarketParticipantData | null };
            if (isMounted && mData.marketPnl) setMarketStats(mData.marketPnl);
          }

          const creatorRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/stats/creator-analytics`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (creatorRes.ok) {
            const cData = (await creatorRes.json()) as { creatorAnalytics?: CreatorAnalyticsData | null };
            if (isMounted && cData.creatorAnalytics) setCreatorStats(cData.creatorAnalytics);
          }

          const tradesRes = await fetch(
            `/api/sessions/${activeSession.sessionId}/paper-trades`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
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

  // Firestore live listeners
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
        const active = list.find(
          (s) =>
            s.status === "running" ||
            s.status === "starting" ||
            s.status === "reconnecting"
        );
        setActiveSession(active || null);
      },
      (error) => console.warn("Firestore subscription status:", error.message)
    );

    return () => unsubscribe();
  }, []);

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

    const unsubPortfolios = onSnapshot(
      doc(db, "researchSessions", activeSession.sessionId, "stats", "portfolios"),
      (snap) => setPortfolioStats(snap.exists() ? (snap.data() as PortfolioSummary) : null),
      (err) => console.warn("Portfolio stats error:", err.message)
    );

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
      query(
        collection(db, "researchSessions", activeSession.sessionId, "graduations"),
        orderBy("realSolLamports", "desc"),
        limit(30)
      ),
      (snap) => {
        const list: GraduationCandidate[] = [];
        snap.forEach((d) => list.push({ mint: d.id, ...d.data() } as GraduationCandidate));
        setCandidates(list);
      },
      (err) => console.warn("Candidates error:", err.message)
    );

    const unsubTrades = onSnapshot(
      query(
        collection(db, "researchSessions", activeSession.sessionId, "paperTrades"),
        orderBy("openedAtUnixMs", "desc"),
        limit(50)
      ),
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
      if (!token) throw new Error("Authorization required. Please sign in or provide a token.");

      const response = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          durationSeconds: selectedDuration,
          segmentDurationSeconds: selectedSegmentDuration,
          mode: "graduation-research",
          provider: "helius",
        }),
      });

      interface StartApiResponse {
        sessionId?: string;
        error?: string;
      }
      const data = (await response.json()) as StartApiResponse;
      if (!response.ok) throw new Error(data.error || "Failed to start session");
      setIsModalOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  };

  const handleResumeSession = async (sessionId: string) => {
    setIsStarting(true);
    setStartError(null);
    try {
      const token = await getEffectiveToken();
      if (!token) throw new Error("Authorization required. Please sign in or provide a token.");
      const response = await fetch(`/api/sessions/${sessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      interface ResumeApiResponse {
        sessionId?: string;
        segmentIndex?: number;
        segmentId?: string;
        error?: string;
      }
      const data = (await response.json()) as ResumeApiResponse;
      if (!response.ok) throw new Error(data.error || "Failed to resume session");
      setSelectedSession(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    if (!selectedSession) {
      setSessionSegments([]);
      setSelectedPortfolioStats(null);
      setSelectedPaperStats(null);
      setSelectedMarketStats(null);
      setSelectedCreatorStats(null);
      setSelectedGradStats(null);
      return;
    }
    let isMounted = true;
    setIsLoadingSegments(true);
    void getEffectiveToken()
      .then((tok) => {
        const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
        const sessId = selectedSession.sessionId;

        // Fetch segments
        void fetch(`/api/sessions/${sessId}/segments`, { headers })
          .then(async (r) => (r.ok ? (r.json() as Promise<{ segments?: SegmentDoc[] }>) : { segments: [] }))
          .then((data: { segments?: SegmentDoc[] }) => {
            if (isMounted && data.segments) setSessionSegments(data.segments);
          })
          .catch((err: unknown) => console.warn("Failed to load session segments:", err));

        // If this is a historical session, load detailed analytics on-demand
        if (sessId !== activeSession?.sessionId) {
          void fetch(`/api/sessions/${sessId}/stats/portfolios`, { headers })
            .then(async (r) => (r.ok ? (r.json() as Promise<{ portfolios?: PortfolioSummary | null }>) : null))
            .then((data: { portfolios?: PortfolioSummary | null } | null) => {
              if (isMounted && data?.portfolios) setSelectedPortfolioStats(data.portfolios);
            })
            .catch(() => {});

          void fetch(`/api/sessions/${sessId}/stats/paper-trading`, { headers })
            .then(async (r) => (r.ok ? (r.json() as Promise<{ paperTrading?: PaperTradingData | null }>) : null))
            .then((data: { paperTrading?: PaperTradingData | null } | null) => {
              if (isMounted && data?.paperTrading) setSelectedPaperStats(data.paperTrading);
            })
            .catch(() => {});

          void fetch(`/api/sessions/${sessId}/stats/market-pnl`, { headers })
            .then(async (r) => (r.ok ? (r.json() as Promise<{ marketPnl?: MarketParticipantData | null }>) : null))
            .then((data: { marketPnl?: MarketParticipantData | null } | null) => {
              if (isMounted && data?.marketPnl) setSelectedMarketStats(data.marketPnl);
            })
            .catch(() => {});

          void fetch(`/api/sessions/${sessId}/stats/creator-analytics`, { headers })
            .then(async (r) => (r.ok ? (r.json() as Promise<{ creatorAnalytics?: CreatorAnalyticsData | null }>) : null))
            .then((data: { creatorAnalytics?: CreatorAnalyticsData | null } | null) => {
              if (isMounted && data?.creatorAnalytics) setSelectedCreatorStats(data.creatorAnalytics);
            })
            .catch(() => {});

          void fetch(`/api/sessions/${sessId}/stats`, { headers })
            .then(async (r) => (r.ok ? (r.json() as Promise<{ stats?: GraduationStats | null }>) : null))
            .then((data: { stats?: GraduationStats | null } | null) => {
              if (isMounted && data?.stats) setSelectedGradStats(data.stats);
            })
            .catch(() => {});
        }
      })
      .finally(() => {
        if (isMounted) setIsLoadingSegments(false);
      });
    return () => {
      isMounted = false;
    };
  }, [selectedSession?.sessionId, activeSession?.sessionId]);

  const handleStopSession = async (sessionId: string) => {
    if (!confirm(`Stop active session ${sessionId}?`)) return;
    setIsStopping(true);
    setStopError(null);
    try {
      const token = await getEffectiveToken();
      if (!token) throw new Error("Authorization required.");
      const response = await fetch("/api/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId }),
      });
      interface StopApiResponse { sessionId?: string; status?: string; error?: string; }
      const data = (await response.json()) as StopApiResponse;
      if (!response.ok) setStopError(data.error ?? "Failed to stop session");
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStopping(false);
    }
  };

  const isLive =
    activeSession?.status === "running" || activeSession?.status === "reconnecting";

  // ── Health indicator ─────────────────────────────────────────────────────────
  const healthOk =
    isLive &&
    !activeSession?.latestError &&
    (activeSession?.disconnectCount ?? 0) === 0;
  const healthWarn =
    isLive && !activeSession?.latestError && (activeSession?.disconnectCount ?? 0) > 0;
  const healthErr = isLive && !!activeSession?.latestError;
  const healthColor = healthErr
    ? "var(--accent-rose)"
    : healthWarn
    ? "var(--accent-amber)"
    : healthOk
    ? "var(--accent-emerald)"
    : "var(--text-muted)";
  const healthLabel = healthErr ? "ERROR" : healthWarn ? "DEGRADED" : healthOk ? "HEALTHY" : "IDLE";

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  const TABS: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "portfolios", label: "Portfolios" },
    { id: "strategy", label: "Strategy Research" },
    { id: "market", label: "Market Intelligence" },
    { id: "data", label: "Data / Session" },
  ];

  return (
    <div className="dashboard-container">
      {/* ── Top Header ────────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="brand-section">
          <div className="brand-icon">B</div>
          <div>
            <h1 className="brand-title">BOTWINER RESEARCH</h1>
            <div className="brand-subtitle">Pump.fun Live Paper Trading &amp; Market Analytics</div>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={() => setIsModalOpen(true)}
            id="btn-start-session"
          >
            Start Session
          </button>

          {authToken ? (
            <div
              className="user-badge"
              style={{ borderColor: "rgba(16, 185, 129, 0.4)", background: "rgba(16, 185, 129, 0.1)" }}
            >
              <span style={{ color: "#34d399", fontWeight: 600 }}>Token Active</span>
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
              {user.photoURL && (
                <img src={user.photoURL} alt="User avatar" className="user-avatar" />
              )}
              <span>{user.displayName || user.email}</span>
              <button
                className="btn btn-secondary"
                onClick={handleSignOut}
                style={{ padding: "0.3rem 0.6rem" }}
              >
                Logout
              </button>
            </div>
          ) : (
            <button className="btn btn-secondary" onClick={handleSignIn} id="btn-login">
              Sign In
            </button>
          )}
        </div>
      </header>

      {/* ── Active session status bar ─────────────────────────────────────────── */}
      {stopError && (
        <div
          className="warning-box"
          style={{ marginBottom: "1rem", borderColor: "rgba(239,68,68,0.4)", color: "#fca5a5" }}
        >
          {stopError}
        </div>
      )}

      {activeSession && (
        <section className="status-card">
          {/* Row 1: identity + controls */}
          <div className="status-header">
            <div className="session-badge-group">
              <StatusPill status={activeSession.status} />
              {isLive && <span className="heartbeat-dot" />}
              <span className="field-mono" style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                {activeSession.sessionId}
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <Chip color="var(--accent-indigo)">{activeSession.provider.toUpperCase()} RPC</Chip>
              <Chip color="var(--accent-cyan)">{activeSession.region}</Chip>
              <span
                className="chip"
                style={{
                  color: healthColor,
                  borderColor: `${healthColor}44`,
                  fontWeight: 600,
                  fontSize: "0.7rem",
                }}
              >
                {healthLabel}
              </span>
              {isLive && (
                <button
                  id="btn-stop-session"
                  className="btn btn-secondary"
                  style={{
                    background: "rgba(239,68,68,0.12)",
                    borderColor: "rgba(239,68,68,0.35)",
                    color: "#fca5a5",
                    padding: "0.25rem 0.65rem",
                    fontSize: "0.8rem",
                  }}
                  disabled={isStopping}
                  onClick={() => handleStopSession(activeSession.sessionId)}
                >
                  {isStopping ? "Stopping…" : "Stop"}
                </button>
              )}
            </div>
          </div>

          {/* Row 2: compact metrics */}
          <div className="status-grid">
            <div className="status-field">
              <span className="field-label">Elapsed / Target</span>
              <span className="field-value">
                {formatDuration(activeSession.elapsedSec)} /{" "}
                {activeSession.requestedDurationSec
                  ? formatDuration(activeSession.requestedDurationSec)
                  : "Open"}
              </span>
            </div>
            <div className="status-field">
              <span className="field-label">Events</span>
              <span className="field-value">
                {(activeSession.totalEvents || 0).toLocaleString()}
              </span>
            </div>
            <div className="status-field">
              <span className="field-label">Launches</span>
              <span className="field-value">{activeSession.launchesDetected || 0}</span>
            </div>
            <div className="status-field">
              <span className="field-label">Storage</span>
              <span className="field-value">{formatBytes(activeSession.bytesPersisted)}</span>
            </div>
            <div className="status-field">
              <span className="field-label">Chunk</span>
              <span className="field-value field-mono">#{activeSession.currentChunk}</span>
            </div>
            <div className="status-field">
              <span className="field-label">Heartbeat</span>
              <span className="field-value">
                {activeSession.lastHeartbeatAt
                  ? new Date(activeSession.lastHeartbeatAt).toLocaleTimeString()
                  : "—"}
              </span>
            </div>
            <div className="status-field">
              <span className="field-label">Reconnects</span>
              <span
                className="field-value"
                style={{
                  color: (activeSession.disconnectCount || 0) > 0
                    ? "var(--accent-amber)"
                    : undefined,
                }}
              >
                {activeSession.reconnectCount || 0} / {activeSession.disconnectCount || 0}
              </span>
            </div>
            {activeSession.latestError && (
              <div className="status-field" style={{ gridColumn: "1 / -1" }}>
                <span className="field-label" style={{ color: "var(--accent-rose)" }}>
                  Error
                </span>
                <span className="field-value" style={{ color: "#fca5a5", fontFamily: "var(--font-mono)" }}>
                  {activeSession.latestError}
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Tab navigation ────────────────────────────────────────────────────── */}
      <nav className="tabs-nav" id="main-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
            id={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 1 — OVERVIEW
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "overview" && (
        <>
          {/* Session health headline */}
          <section className="kpi-grid">
            <KpiCard
              label="Total Events"
              value={(activeSession?.totalEvents || 0).toLocaleString()}
              sub="Normalized stream"
            />
            <KpiCard
              label="Launches"
              value={(activeSession?.launchesDetected || 0).toLocaleString()}
              sub="Pump.fun tokens"
              color="var(--accent-cyan)"
            />
            <KpiCard
              label="Trades"
              value={(activeSession?.tradesDetected || 0).toLocaleString()}
              sub="Curve executions"
              color="var(--accent-indigo)"
            />
            <KpiCard
              label="Tokens Tracked"
              value={gradStats?.tokensTracked || 0}
              sub="Active in window"
            />
            <KpiCard
              label="Graduations"
              value={gradStats?.graduationsDetected || 0}
              sub={`Organic: ${gradStats?.organicGraduationsDetected || 0} · Bundles: ${gradStats?.instantBundleGraduationsDetected || 0}`}
              color="var(--accent-emerald)"
            />
            <KpiCard
              label="Storage Written"
              value={formatBytes(activeSession?.bytesPersisted ?? 0)}
              sub={`Chunk #${activeSession?.currentChunk ?? 0}`}
            />
          </section>

          {/* Portfolio headline */}
          {portfolioStats && (
            <section className="section-card" style={{ marginBottom: "1.25rem" }}>
              <div className="section-header">
                <h2 className="section-title">Portfolio Headline (5 SOL / balanced / baseline-50sol-v1)</h2>
                <Chip color="var(--accent-amber)" small>Hypothetical</Chip>
              </div>
              {(() => {
                const p = portfolioStats.portfolios.find(
                  (pp) =>
                    pp.startingSol === 5 &&
                    pp.riskMode === "balanced" &&
                    pp.strategyId === "baseline-50sol-v1"
                );
                if (!p) return <p className="note-text">Select the Portfolios tab for full analysis.</p>;
                return (
                  <div className="kpi-grid" style={{ marginTop: "0.75rem" }}>
                    <KpiCard label="Current Equity" value={`${p.equitySol.toFixed(4)} SOL`} />
                    <KpiCard
                      label="Net PnL"
                      value={`${pnlSign(p.netPnlSol)}${p.netPnlSol.toFixed(4)} SOL`}
                      color={p.netPnlSol >= 0 ? "var(--accent-emerald)" : "var(--accent-rose)"}
                    />
                    <KpiCard
                      label="Return %"
                      value={`${pnlSign(p.returnPct)}${p.returnPct.toFixed(2)}%`}
                      color={p.returnPct >= 0 ? "var(--accent-emerald)" : "var(--accent-rose)"}
                    />
                    <KpiCard
                      label="Win Rate"
                      value={`${p.winRatePct.toFixed(1)}%`}
                      sub={`${p.trades} closed trades`}
                      color={p.winRatePct >= 50 ? "var(--accent-emerald)" : "var(--accent-rose)"}
                    />
                  </div>
                );
              })()}
            </section>
          )}

          {/* Strategy baseline headline */}
          {paperStats && (
            <section className="section-card" style={{ marginBottom: "1.25rem" }}>
              <div className="section-header">
                <h2 className="section-title">Strategy Research Headline</h2>
                <Chip color="var(--accent-cyan)" small>
                  {paperStats.strategyId}
                </Chip>
              </div>
              <div className="kpi-grid" style={{ marginTop: "0.75rem" }}>
                <KpiCard
                  label="Net PnL (SOL)"
                  value={`${pnlSign(paperStats.netPnlSol)}${paperStats.netPnlSol} SOL`}
                  color={pnlCls(paperStats.netPnlSol) === "pnl-pos" ? "var(--accent-emerald)" : "var(--accent-rose)"}
                />
                <KpiCard
                  label="Win Rate"
                  value={`${paperStats.winRatePct}%`}
                  sub={`${paperStats.winningClosedTrades}W / ${paperStats.losingClosedTrades}L`}
                  color={paperStats.winRatePct >= 50 ? "var(--accent-emerald)" : "var(--accent-rose)"}
                />
                <KpiCard
                  label="Closed / Open"
                  value={`${paperStats.closedPositions} / ${paperStats.openPositions}`}
                />
                <KpiCard label="Profit Factor" value={paperStats.profitFactor} />
              </div>
            </section>
          )}

          {/* Graduation summary */}
          <section className="section-card" style={{ marginBottom: "1.25rem" }}>
            <div className="section-header">
              <h2 className="section-title">Graduation Funnel</h2>
              <Chip color="var(--text-muted)" small>Migration decoding limited by IDL</Chip>
            </div>
            <div className="graduation-grid" style={{ marginTop: "0.75rem" }}>
              {[
                { label: "≥ 50 SOL", value: gradStats?.curve50PlusCount || 0 },
                { label: "≥ 60 SOL", value: gradStats?.curve60PlusCount || 0 },
                { label: "≥ 70 SOL", value: gradStats?.curve70PlusCount || 0 },
                { label: "≥ 80 SOL", value: gradStats?.nearGraduationCount || 0, highlight: true },
                { label: "Organic Grads", value: gradStats?.organicGraduationsDetected || 0, color: "var(--accent-emerald)" },
                { label: "Instant Bundles", value: gradStats?.instantBundleGraduationsDetected || 0, color: "var(--accent-rose)" },
              ].map((item) => (
                <div key={item.label} className={`grad-box${item.highlight ? " highlight" : ""}`}>
                  <div className="grad-box-label">{item.label}</div>
                  <div className="grad-box-value" style={item.color ? { color: item.color } : undefined}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Feed quality */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Feed Quality</h2>
            </div>
            <div className="kpi-grid" style={{ marginTop: "0.75rem" }}>
              <KpiCard
                label="Failed Txs Observed"
                value={(activeSession?.failedTxObserved || 0).toLocaleString()}
                sub="RPC notifications"
              />
              <KpiCard
                label="Parser Errors"
                value={activeSession?.parserErrors || 0}
                color={
                  (activeSession?.parserErrors || 0) > 0 ? "var(--accent-rose)" : undefined
                }
              />
              <KpiCard
                label="Disconnects / Reconnects"
                value={`${activeSession?.disconnectCount || 0} / ${activeSession?.reconnectCount || 0}`}
                color={
                  (activeSession?.disconnectCount || 0) > 0 ? "var(--accent-amber)" : undefined
                }
              />
            </div>
          </section>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 2 — PORTFOLIOS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "portfolios" && <Portfolios data={portfolioStats} />}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 3 — STRATEGY RESEARCH
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "strategy" && (
        <>
          {/* Frozen strategy banner */}
          <div className="research-banner">
            <div>
              <div className="banner-title">PAPER TRADING — NO REAL FUNDS</div>
              <div className="banner-subtitle">
                Strategy: {paperStats?.strategyId || "organic-50sol-continuation-v1"} ·
                Cost Scenario: {paperStats?.costScenarioId || "paper-medium-v1"}
              </div>
            </div>
            <Chip color="var(--accent-emerald)">Causal 0.10 SOL Quotes</Chip>
          </div>

          {/* Strategy spec */}
          <section className="section-card" style={{ marginBottom: "1.25rem" }}>
            <div className="section-header">
              <h2 className="section-title" style={{ color: "var(--accent-cyan)" }}>
                organic-50sol-continuation-v1
              </h2>
              <Chip color="var(--accent-emerald)">Frozen Rule</Chip>
            </div>
            <div className="spec-grid">
              <div>
                <span className="field-label">Thesis</span>
                <span className="field-value">
                  Graduation / Curve-Progress Momentum — enters on first organic crossing from &lt;50 SOL
                  to ≥50 SOL real reserves for tokens launched in session.
                </span>
              </div>
              <div className="spec-pills">
                <Chip>Min Age: ≥ 5s</Chip>
                <Chip>Min Trades: ≥ 5</Chip>
                <Chip>Size: 0.10 SOL fixed</Chip>
                <Chip>Instant Bundle: Disallowed</Chip>
                <Chip color="var(--accent-emerald)">Rebound Filter: NONE</Chip>
                <Chip color="var(--accent-emerald)">Sell-Vol Filter: NONE</Chip>
                <Chip color="var(--accent-emerald)">Higher-Low Filter: NONE</Chip>
                <Chip>TP: +30% net</Chip>
                <Chip>SL: −20% net</Chip>
                <Chip>Timeout: 5 min</Chip>
              </div>
            </div>
          </section>

          {/* KPI grid */}
          <section className="kpi-grid">
            <KpiCard
              label="Open Positions"
              value={paperStats?.openPositions ?? 0}
              sub={`Triggered: ${paperStats?.entriesTriggered ?? 0}`}
              color="var(--accent-cyan)"
            />
            <KpiCard
              label="Closed Trades"
              value={paperStats?.closedPositions ?? 0}
              sub={`Censored: ${paperStats?.censoredPositions ?? 0} · Migration: ${paperStats?.unresolvedMigrationPositions ?? 0}`}
            />
            <KpiCard
              label="Win Rate %"
              value={`${paperStats?.winRatePct ?? 0}%`}
              sub={`${paperStats?.winningClosedTrades ?? 0}W / ${paperStats?.losingClosedTrades ?? 0}L`}
              color={
                (paperStats?.winRatePct ?? 0) >= 50
                  ? "var(--accent-emerald)"
                  : "var(--accent-rose)"
              }
            />
            <KpiCard
              label="Net PnL (SOL)"
              value={`${pnlSign(paperStats?.netPnlSol)}${paperStats?.netPnlSol ?? 0} SOL`}
              sub={`Gross: ${paperStats?.grossPnlSol ?? 0} SOL`}
              color={
                pnlCls(paperStats?.netPnlSol) === "pnl-pos"
                  ? "var(--accent-emerald)"
                  : "var(--accent-rose)"
              }
            />
            <KpiCard
              label="Protocol + Tx Fees"
              value={`${(
                (paperStats?.totalPumpFeesSol ?? 0) + (paperStats?.totalTxCostsSol ?? 0)
              ).toFixed(6)} SOL`}
              sub={`Pump: ${paperStats?.totalPumpFeesSol ?? 0} · Tx: ${paperStats?.totalTxCostsSol ?? 0}`}
              color="var(--accent-amber)"
            />
            <KpiCard
              label="Profit Factor"
              value={paperStats?.profitFactor ?? 0}
              sub={`Avg Hold: ${paperStats?.averageHoldSec ?? 0}s`}
            />
          </section>

          {/* Breakdown row */}
          <div className="breakdown-row">
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle">By Exit Reason</h3>
              <div className="breakdown-list">
                <div className="breakdown-item">
                  <span>Take Profit (+30%)</span>
                  <span className="pnl-pos">
                    {paperStats?.pnlByExitReason?.takeProfit.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.takeProfit.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>Stop Loss (−20%)</span>
                  <span className="pnl-neg">
                    {paperStats?.pnlByExitReason?.stopLoss.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.stopLoss.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>Timeout (5m)</span>
                  <span>
                    {paperStats?.pnlByExitReason?.timeout.count ?? 0} trades (
                    {paperStats?.pnlByExitReason?.timeout.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle">By Token Age at Trigger</h3>
              <div className="breakdown-list">
                <div className="breakdown-item">
                  <span>5s – 15s</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age5to15s.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age5to15s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>15s – 60s</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age15to60s.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age15to60s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>60s+</span>
                  <span>
                    {paperStats?.pnlByTokenAgeBucket?.age60sPlus.count ?? 0} trades (
                    {paperStats?.pnlByTokenAgeBucket?.age60sPlus.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle">By Speed to 50 SOL</h3>
              <div className="breakdown-list">
                <div className="breakdown-item">
                  <span>Fast (&lt;10s)</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.fastUnder10s.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.fastUnder10s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>Medium (10–30s)</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.medium10to30s.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.medium10to30s.netPnlSol ?? 0} SOL)
                  </span>
                </div>
                <div className="breakdown-item">
                  <span>Steady (30s+)</span>
                  <span>
                    {paperStats?.pnlByOrganicSpeedBucket?.steady30sPlus.count ?? 0} trades (
                    {paperStats?.pnlByOrganicSpeedBucket?.steady30sPlus.netPnlSol ?? 0} SOL)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Open positions */}
          <section className="section-card" style={{ marginTop: "1.5rem" }}>
            <div className="section-header">
              <h2 className="section-title">Open Positions</h2>
              <Chip small>{paperStats?.activePositionsSummary?.length ?? 0} active</Chip>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    {["Mint", "Opened", "Age", "Entry Real SOL", "Unrealised %", "MFE %", "MAE %", "Status"].map(
                      (h) => <th key={h}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {!paperStats?.activePositionsSummary ||
                  paperStats.activePositionsSummary.length === 0 ? (
                    <EmptyRow cols={8} text="No paper positions currently open." />
                  ) : (
                    paperStats.activePositionsSummary.map((p) => (
                      <tr key={p.mint}>
                        <td className="field-mono">{shortenAddress(p.mint)}</td>
                        <td>{new Date(p.openedAtIso).toLocaleTimeString()}</td>
                        <td>{p.tokenAgeSec}s</td>
                        <td className="field-mono">{p.currentRealSol.toFixed(2)} SOL</td>
                        <td className={`field-mono ${pnlCls(p.unrealizedNetReturnPct)}`}>
                          {pnlSign(p.unrealizedNetReturnPct)}
                          {p.unrealizedNetReturnPct.toFixed(2)}%
                        </td>
                        <td className="field-mono pnl-pos">+{p.mfePct.toFixed(2)}%</td>
                        <td className="field-mono pnl-neg">{p.maePct.toFixed(2)}%</td>
                        <td>
                          <Chip small color="var(--accent-cyan)">{p.status}</Chip>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Closed trades */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Recent Closed Trades</h2>
              <Chip small>
                {paperTradesList.length > 0
                  ? paperTradesList.length
                  : paperStats?.recentClosedTrades?.length ?? 0}{" "}
                closed
              </Chip>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    {["Mint", "Hold", "Exit", "Gross PnL", "Fees", "Net PnL (SOL)", "Return %"].map(
                      (h) => <th key={h}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {!paperStats?.recentClosedTrades ||
                  paperStats.recentClosedTrades.length === 0 ? (
                    <EmptyRow cols={7} text="No paper trades closed yet." />
                  ) : (
                    paperStats.recentClosedTrades.map((t, idx) => (
                      <tr key={idx}>
                        <td className="field-mono">{shortenAddress(t.mint)}</td>
                        <td>{t.holdDurationSec}s</td>
                        <td>
                          <Chip
                            small
                            color={
                              t.exitReason === "take-profit"
                                ? "var(--accent-emerald)"
                                : t.exitReason === "stop-loss"
                                ? "var(--accent-rose)"
                                : "var(--text-muted)"
                            }
                          >
                            {t.exitReason}
                          </Chip>
                        </td>
                        <td className="field-mono">{t.grossPnlSol.toFixed(6)}</td>
                        <td className="field-mono">{t.feesSol.toFixed(6)}</td>
                        <td className={`field-mono ${pnlCls(t.netPnlSol)}`}>
                          {pnlSign(t.netPnlSol)}
                          {t.netPnlSol.toFixed(6)}
                        </td>
                        <td className={`field-mono ${pnlCls(t.netReturnPct)}`}>
                          {pnlSign(t.netReturnPct)}
                          {t.netReturnPct.toFixed(2)}%
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Graduation candidates */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Graduation Candidates (≥ 50 SOL or Graduated)</h2>
              <Chip small>{candidates.length} detected</Chip>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    {["Mint", "Creator", "Current SOL", "Peak SOL", "Progress", "Trades", "Class", "Status", "Updated"].map(
                      (h) => <th key={h}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {candidates.length === 0 ? (
                    <EmptyRow cols={9} text="No tokens have crossed ≥ 50 SOL yet." />
                  ) : (
                    candidates.map((c) => {
                      const curSol = Number(BigInt(c.currentRealSolLamports || "0")) / 1e9;
                      const peakSol = Number(BigInt(c.maxRealSolLamports || "0")) / 1e9;
                      return (
                        <tr key={c.mint}>
                          <td className="field-mono">{shortenAddress(c.mint)}</td>
                          <td className="field-mono">{shortenAddress(c.creatorWallet)}</td>
                          <td className="field-mono">{curSol.toFixed(2)}</td>
                          <td className="field-mono">{peakSol.toFixed(2)}</td>
                          <td>
                            <div className="progress-bar-bg">
                              <div
                                className="progress-bar-fill"
                                style={{ width: `${Math.min(100, c.curveProgressPct)}%` }}
                              />
                            </div>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                              {c.curveProgressPct.toFixed(1)}%
                            </span>
                          </td>
                          <td>{c.tradeCount}</td>
                          <td>
                            <Chip
                              small
                              color={
                                c.classification === "organic"
                                  ? "var(--accent-emerald)"
                                  : c.classification === "instant-bundle"
                                  ? "var(--accent-rose)"
                                  : "var(--text-muted)"
                              }
                            >
                              {c.classification}
                            </Chip>
                          </td>
                          <td>
                            {c.graduated ? (
                              <Chip small color="var(--accent-emerald)">GRADUATED</Chip>
                            ) : (
                              <Chip small color="var(--accent-indigo)">BONDING</Chip>
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

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 4 — MARKET INTELLIGENCE
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "market" && (
        <>
          <div className="disclaimer-banner">
            <div>
              <strong>Methodology:</strong>{" "}
              {marketStats?.disclaimer ||
                "Session-scoped estimate. External transaction costs may be incomplete. Mid-session inventory is excluded from clean profitability metrics."}
            </div>
            <div style={{ marginTop: "0.35rem", fontSize: "0.775rem", color: "#fca5a5" }}>
              <strong>Fee Coverage:</strong>{" "}
              {marketStats?.feeCoverageDisclaimer ||
                "Estimated curve trading PnL before Pump protocol fees and unobserved external transaction costs."}
            </div>
          </div>

          {/* Participant KPIs */}
          <section className="kpi-grid">
            <KpiCard
              label="Observed Wallets"
              value={marketStats?.totalObservedWallets ?? 0}
              sub={`Clean: ${marketStats?.cleanEligibleWallets ?? 0} · Partial: ${marketStats?.partialWallets ?? 0}`}
            />
            <KpiCard
              label="Clean Closed Win Rate"
              value={`${marketStats?.cleanClosedTraderWinRatePct ?? 0}%`}
              sub={`N = ${marketStats?.cleanClosedWalletCount ?? 0} (${marketStats?.cleanClosedWinningWalletCount ?? 0} winners)`}
              color={
                (marketStats?.cleanClosedTraderWinRatePct ?? 0) >= 50
                  ? "var(--accent-emerald)"
                  : "var(--accent-rose)"
              }
            />
            <KpiCard
              label="Marked Positive PnL"
              value={`${marketStats?.cleanMarkedPositivePnlRatePct ?? 0}%`}
              sub={`${marketStats?.cleanMarkedPositivePnlCount ?? 0} / ${marketStats?.cleanMarkedWalletCount ?? 0} marked`}
              color="var(--accent-cyan)"
            />
            <KpiCard
              label="Realized"
              value={
                <>
                  <span className="pnl-pos">{marketStats?.realizedProfitableCount ?? 0}W</span>
                  {" / "}
                  <span className="pnl-neg">{marketStats?.realizedLossCount ?? 0}L</span>
                </>
              }
              sub="Fully closed positions"
            />
            <KpiCard
              label="Open Inventory"
              value={
                <>
                  <span className="pnl-pos">{marketStats?.openProfitableCount ?? 0}</span>
                  {" / "}
                  <span className="pnl-neg">{marketStats?.openUnderwaterCount ?? 0}</span>
                </>
              }
              sub="Profit / underwater"
            />
            <KpiCard
              label="Clean Marked PnL"
              value={`${pnlSign(marketStats?.totalCleanMarkedPnlSol)}${marketStats?.totalCleanMarkedPnlSol ?? 0} SOL`}
              sub={`Realized: ${marketStats?.totalCleanRealizedPnlSol ?? 0} SOL`}
              color={
                pnlCls(marketStats?.totalCleanMarkedPnlSol) === "pnl-pos"
                  ? "var(--accent-emerald)"
                  : "var(--accent-rose)"
              }
            />
          </section>

          {/* Whale + Creator */}
          <div className="breakdown-row">
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle">Wallet Concentration</h3>
              <div className="breakdown-list">
                <div className="breakdown-item">
                  <span>Top 1% Wallets — Volume Share</span>
                  <strong className="field-mono">
                    {marketStats?.top1PctWalletsSolVolumeSharePct ?? 0}%
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>Top 5 Wallets — Buy Volume</span>
                  <strong className="field-mono">
                    {marketStats?.top5WalletsBuyVolumeSol ?? 0} SOL (
                    {marketStats?.top5WalletsBuyVolumeSharePct ?? 0}%)
                  </strong>
                </div>
              </div>
            </div>

            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle">Creator SOL Extraction</h3>
              <div className="breakdown-list">
                <div className="breakdown-item">
                  <span>Creators Clean / Partial</span>
                  <strong>
                    {creatorStats?.cleanCreatorsCount ?? creatorStats?.creatorsObserved ?? 0} /{" "}
                    {creatorStats?.partialCreatorsCount ?? 0} (Total:{" "}
                    {creatorStats?.creatorsObserved ?? 0})
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>Selling / Fully Exited</span>
                  <strong>
                    {creatorStats?.creatorsSelling ?? 0} /{" "}
                    {creatorStats?.cleanCreatorsFullyExited ?? creatorStats?.creatorsFullyExited ?? 0}
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>Median First-Sell Delay</span>
                  <strong className="field-mono">
                    {creatorStats?.medianCleanFirstSellDelaySec ?? creatorStats?.medianFirstSellDelaySec ?? 0}s
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>Total Net Extracted</span>
                  <strong className="field-mono" style={{ color: "#f87171" }}>
                    {creatorStats?.totalObservedCreatorExtractionSol ?? 0} SOL
                  </strong>
                </div>
                <div className="breakdown-item">
                  <span>p50 / p90 / Max</span>
                  <span className="field-mono" style={{ fontSize: "0.8rem" }}>
                    {creatorStats?.p50Sol ?? 0} / {creatorStats?.p90Sol ?? 0} /{" "}
                    {creatorStats?.largestObservedExtractionSol ?? 0} SOL
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Top winners / losers */}
          <div className="breakdown-row" style={{ marginTop: "1.5rem" }}>
            <div className="section-card" style={{ marginBottom: 0 }}>
              <h3 className="section-subtitle" style={{ color: "var(--accent-emerald)" }}>
                Top Clean Winning Wallets
              </h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      {["Wallet", "Marked PnL", "Realized PnL", "Trades", "Mints"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!marketStats?.topCleanWinners || marketStats.topCleanWinners.length === 0 ? (
                      <EmptyRow cols={5} text="No clean winners observed." />
                    ) : (
                      marketStats.topCleanWinners.map((w, idx) => (
                        <tr key={idx}>
                          <td className="field-mono">{shortenAddress(w.wallet)}</td>
                          <td className="field-mono pnl-pos">+{w.markedPnlSol.toFixed(4)}</td>
                          <td className="field-mono">+{w.realizedPnlSol.toFixed(4)}</td>
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
              <h3 className="section-subtitle" style={{ color: "var(--accent-rose)" }}>
                Top Clean Losing Wallets
              </h3>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      {["Wallet", "Marked PnL", "Realized PnL", "Trades", "Mints"].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!marketStats?.topCleanLosers || marketStats.topCleanLosers.length === 0 ? (
                      <EmptyRow cols={5} text="No clean losers observed." />
                    ) : (
                      marketStats.topCleanLosers.map((w, idx) => (
                        <tr key={idx}>
                          <td className="field-mono">{shortenAddress(w.wallet)}</td>
                          <td className="field-mono pnl-neg">{w.markedPnlSol.toFixed(4)}</td>
                          <td className="field-mono">{w.realizedPnlSol.toFixed(4)}</td>
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

          {/* Creator extractions */}
          <section className="section-card" style={{ marginTop: "1.5rem" }}>
            <div className="section-header">
              <h2 className="section-title">Largest Creator Extraction Events</h2>
              <Chip small>{creatorStats?.topCreatorExtractions?.length ?? 0} recorded</Chip>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    {["Creator", "Mint", "Quality", "Net SOL", "First Sell", "% Sold"].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!creatorStats?.topCreatorExtractions ||
                  creatorStats.topCreatorExtractions.length === 0 ? (
                    <EmptyRow cols={6} text="No creator extraction events observed." />
                  ) : (
                    creatorStats.topCreatorExtractions.map((e, idx) => (
                      <tr key={idx}>
                        <td className="field-mono">{shortenAddress(e.creatorWallet)}</td>
                        <td className="field-mono">{shortenAddress(e.mint)}</td>
                        <td>
                          <Chip
                            small
                            color={
                              e.inventoryQuality === "CLEAN"
                                ? "var(--accent-emerald)"
                                : "var(--text-muted)"
                            }
                          >
                            {e.inventoryQuality || "CLEAN"}
                          </Chip>
                        </td>
                        <td className="field-mono pnl-neg">
                          +{e.netExtractionSol.toFixed(4)}
                        </td>
                        <td className="field-mono">{e.firstSellDelaySec}s</td>
                        <td>
                          {e.pctSold !== undefined ? `${e.pctSold.toFixed(1)}%` : "—"}
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

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 5 — DATA / SESSION DETAILS
         ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "data" && (
        <>
          {/* Active session operational details */}
          {activeSession && (
            <section className="section-card" style={{ marginBottom: "1.25rem" }}>
              <div className="section-header">
                <h2 className="section-title">Active Session</h2>
                <StatusPill status={activeSession.status} />
              </div>
              <div className="data-grid">
                {[
                  ["Session ID", activeSession.sessionId, true],
                  ["Provider", activeSession.provider],
                  ["Region", activeSession.region],
                  ["Mode", activeSession.mode],
                  ["Started At", new Date(activeSession.startedAt).toLocaleString()],
                  ["Elapsed / Target", `${formatDuration(activeSession.elapsedSec)} / ${activeSession.requestedDurationSec ? formatDuration(activeSession.requestedDurationSec) : "Open"}`],
                  ["Last Heartbeat", activeSession.lastHeartbeatAt ? new Date(activeSession.lastHeartbeatAt).toLocaleString() : "—"],
                  ["Total Events", activeSession.totalEvents.toLocaleString()],
                  ["Launches", activeSession.launchesDetected.toLocaleString()],
                  ["Trades", activeSession.tradesDetected.toLocaleString()],
                  ["Failed Txs", activeSession.failedTxObserved.toLocaleString()],
                  ["Parser Errors", activeSession.parserErrors],
                  ["Disconnects / Reconnects", `${activeSession.disconnectCount} / ${activeSession.reconnectCount}`],
                  ["Current Chunk", `#${activeSession.currentChunk}`],
                  ["GCS Bytes Persisted", formatBytes(activeSession.bytesPersisted)],
                  ["Latest Error", activeSession.latestError ?? "—"],
                ].map(([label, value, mono]) => (
                  <div key={label as string} className="data-row">
                    <span className="field-label">{label}</span>
                    <span className={`field-value${mono ? " field-mono" : ""}`}>{value}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Sessions history table */}
          <section className="section-card">
            <div className="section-header">
              <h2 className="section-title">Sessions History</h2>
              <Chip small>{sessionsHistory.length} recorded</Chip>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    {["Session ID", "Status", "Started", "Duration", "Events", "Launches", "Storage", ""].map(
                      (h) => <th key={h}>{h}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sessionsHistory.length === 0 ? (
                    <EmptyRow cols={8} text="No sessions yet." />
                  ) : (
                    sessionsHistory.map((s) => (
                      <tr key={s.sessionId}>
                        <td className="field-mono" style={{ fontSize: "0.78rem" }}>
                          {s.sessionId}
                        </td>
                        <td>
                          <StatusPill status={s.status} />
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

      {/* ── Modals ────────────────────────────────────────────────────────────── */}

      {/* Start session modal */}
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
              <strong>Cost-Controlled Research Run:</strong> Spins up Cloud Run job, streams
              Pump.fun WebSocket feed to chunked GCS storage, executes live causal paper trading,
              and aggregates participant analytics.
            </div>

            <label className="field-label">Target Duration & Architecture</label>
            <div className="duration-selector">
              {[
                { label: "3m (Smoke)", val: 180, segVal: 180 },
                { label: "15m (1 Seg)", val: 900, segVal: 900 },
                { label: "30m (3 × 10m Validation)", val: 1800, segVal: 600 },
                { label: "1 Hour (2 × 30m)", val: 3600, segVal: 1800 },
                { label: "6 Hours (12 × 30m)", val: 21600, segVal: 1800 },
                { label: "24 Hours (48 × 30m)", val: 86400, segVal: 1800 },
              ].map((d) => (
                <button
                  key={d.val}
                  type="button"
                  className={`duration-btn ${selectedDuration === d.val ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedDuration(d.val);
                    setSelectedSegmentDuration(d.segVal);
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {startError && (
              <div
                className="warning-box"
                style={{ borderColor: "rgba(239,68,68,0.4)", color: "#fca5a5" }}
              >
                {startError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
              <button className="btn btn-secondary" onClick={() => setIsModalOpen(false)} disabled={isStarting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleStartSession}
                disabled={isStarting}
                id="btn-modal-confirm-start"
              >
                {isStarting ? "Starting…" : "Launch Cloud Run Job"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Token modal */}
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
              Enter your Firebase ID token or Google ID token. Stored locally and sent in the
              Authorization header to authenticated API endpoints.
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
                resize: "vertical",
              }}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="eyJhbGciOiJSUzI1NiIs…"
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

      {/* Professional Research Command Center */}
      {selectedSession && (
        <ResearchCommandCenter
          session={selectedSession}
          segments={sessionSegments}
          portfoliosData={
            selectedSession.sessionId === activeSession?.sessionId
              ? portfolioStats
              : (selectedPortfolioStats ?? portfolioStats)
          }
          paperTradingData={
            selectedSession.sessionId === activeSession?.sessionId
              ? paperStats
              : (selectedPaperStats ?? paperStats)
          }
          marketData={
            selectedSession.sessionId === activeSession?.sessionId
              ? marketStats
              : (selectedMarketStats ?? marketStats)
          }
          creatorData={
            selectedSession.sessionId === activeSession?.sessionId
              ? creatorStats
              : (selectedCreatorStats ?? creatorStats)
          }
          graduationStats={
            selectedSession.sessionId === activeSession?.sessionId
              ? gradStats
              : (selectedGradStats ?? gradStats)
          }
          onClose={() => setSelectedSession(null)}
          onResume={handleResumeSession}
          isResuming={isStarting}
          isLoading={isLoadingSegments}
        />
      )}
    </div>
  );
}
