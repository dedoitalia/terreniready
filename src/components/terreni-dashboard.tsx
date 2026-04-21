"use client";

import dynamic from "next/dynamic";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PROVINCES, PROVINCE_MAP } from "@/lib/province-data";
import {
  SOURCE_CATEGORIES,
  SOURCE_CATEGORY_MAP,
  landuseLabel,
} from "@/lib/source-types";
import type {
  ProvinceId,
  ScanJobLogEntry,
  ScanResponse,
  ScanStreamEvent,
  SourceCategoryId,
  SourceFeature,
  TerrainFeature,
} from "@/types/scan";

const TerrainMap = dynamic(() => import("@/components/terrain-map"), {
  ssr: false,
  loading: () => (
    <div className="terrain-shell flex h-[62vh] items-center justify-center rounded-[30px] px-6 text-sm text-[var(--muted-strong)] lg:h-[calc(100vh-12rem)]">
      Carico l&apos;atlante operativo territoriale...
    </div>
  ),
});

const LONG_SCAN_THRESHOLD_SECONDS = 180;
const MAX_LOG_ENTRIES = 120;

type LiveScanState = {
  status: "running" | "completed" | "failed";
  logs: ScanJobLogEntry[];
  error: string | null;
};

type TerrainSortMode =
  | "distance-asc"
  | "comune-asc"
  | "comune-desc"
  | "area-desc"
  | "area-asc";

function toggleItem<T extends string>(list: T[], value: T) {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

function formatMeters(value: number) {
  return `${Math.round(value).toLocaleString("it-IT")} m`;
}

function formatSqm(value: number | null) {
  if (!value) {
    return "n.d.";
  }

  return `${value.toLocaleString("it-IT")} m²`;
}

function downloadBlob(contents: BlobPart, mimeType: string, filename: string) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

function parseStreamPayload<T>(raw: string) {
  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type Props = {
  provinceId: ProvinceId;
};

export default memo(function TerreniDashboard({ provinceId }: Props) {
  const mapRef = useRef<any>(null);
  const sourceEventSourceRef = useRef<EventSource | null>(null);

  const [scans, setScans] = useState<ScanResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [sourcesTab, setSourcesTab] = useState(false);
  const [filterBy, setFilterBy] = useState<SourceCategoryId[]>([]);
  const [selectedTerrainId, setSelectedTerrainId] = useState<string | null>(null);
  const [expandedTerrainId, setExpandedTerrainId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<TerrainSortMode>("distance-asc");
  const [liveScan, setLiveScan] = useState<LiveScanState | null>(null);
  const [scanStartTime, setScanStartTime] = useState<number | null>(null);
  const [scanDurationSeconds, setScanDurationSeconds] = useState<number | null>(null);

  // Live scan timer
  useEffect(() => {
    if (!liveScan || liveScan.status !== "running") return;
    if (!scanStartTime) return;

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - scanStartTime) / 1000);
      setScanDurationSeconds(elapsed);
    }, 500);

    return () => clearInterval(interval);
  }, [liveScan, scanStartTime]);

  const handleStartScan = useCallback(
    async (filters: SourceCategoryId[]) => {
      setLoading(true);
      setScanStartTime(Date.now());
      setScanDurationSeconds(0);
      setLiveScan({
        status: "running",
        logs: [],
        error: null,
      });

      const eventSource = new EventSource(
        `/api/scan?province=${provinceId}&filters=${filters.join(",")}`
      );

      sourceEventSourceRef.current = eventSource;

      eventSource.addEventListener("data", (event) => {
        const parsed = parseStreamPayload<ScanStreamEvent>(event.data);
        if (!parsed) return;

        if (parsed.type === "log") {
          setLiveScan((prev) => {
            if (!prev) return prev;
            const newLogs = [parsed as ScanJobLogEntry, ...prev.logs];
            return {
              ...prev,
              logs: newLogs.slice(0, MAX_LOG_ENTRIES),
            };
          });
        } else if (parsed.type === "scan") {
          setScans((prev) => {
            const existing = prev.findIndex((s) => s.id === parsed.id);
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = parsed;
              return updated;
            }
            return [parsed, ...prev];
          });
        } else if (parsed.type === "done") {
          setLiveScan((prev) => (prev ? { ...prev, status: "completed" } : null));
          setLoading(false);
          if (eventSource) eventSource.close();
        } else if (parsed.type === "error") {
          setLiveScan((prev) =>
            prev
              ? { ...prev, status: "failed", error: parsed.message }
              : { status: "failed", logs: [], error: parsed.message }
          );
          setLoading(false);
          if (eventSource) eventSource.close();
        }
      });

      eventSource.onerror = () => {
        setLiveScan((prev) =>
          prev
            ? { ...prev, status: "failed", error: "Errore nella connessione" }
            : { status: "failed", logs: [], error: "Errore nella connessione" }
        );
        setLoading(false);
        if (eventSource) eventSource.close();
      };
    },
    [provinceId]
  );

  const handleCancelScan = useCallback(() => {
    if (sourceEventSourceRef.current) {
      sourceEventSourceRef.current.close();
      sourceEventSourceRef.current = null;
    }
    setLoading(false);
    setLiveScan((prev) =>
      prev
        ? {
            ...prev,
            status: "failed",
            error:
              "Scansione annullata dall'utente. Il processo continua sul server ma la UI è stata ripristinata.",
          }
        : null
    );
  }, []);

  const terrains = useMemo(() => {
    const flattened = scans.flatMap((s) =>
      (s.terrains ?? []).map((t) => ({
        ...t,
        scanId: s.id,
      }))
    );

    if (searchQuery) {
      return flattened.filter(
        (t) =>
          (t.nome ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.comune?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
      );
    }

    return flattened;
  }, [scans, searchQuery]);

  const sortedTerrains = useMemo(() => {
    const copy = [...terrains];

    switch (sortMode) {
      case "distance-asc":
        return copy.sort(
          (a, b) => (a.distanceFromAddress ?? Infinity) - (b.distanceFromAddress ?? Infinity)
        );
      case "comune-asc":
        return copy.sort((a, b) => (a.comune ?? "").localeCompare(b.comune ?? ""));
      case "comune-desc":
        return copy.sort((a, b) => (b.comune ?? "").localeCompare(a.comune ?? ""));
      case "area-desc":
        return copy.sort((a, b) => (b.areaM2 ?? 0) - (a.areaM2 ?? 0));
      case "area-asc":
        return copy.sort((a, b) => (a.areaM2 ?? 0) - (b.areaM2 ?? 0));
    }
  }, [terrains, sortMode]);

  const filteredTerrains = useMemo(() => {
    if (filterBy.length === 0) return sortedTerrains;
    return sortedTerrains.filter((t) => filterBy.includes(t.category));
  }, [sortedTerrains, filterBy]);

  const anySourcesWithData = useMemo(
    () =>
      Object.entries(SOURCE_CATEGORY_MAP).some(
        ([, category]) =>
          filteredTerrains.some((t) => t.sources?.some((s) => s.category === category.id)) ??
          false
      ),
    [filteredTerrains]
  );

  const selectedTerrain = useMemo(
    () => filteredTerrains.find((t) => t.id === selectedTerrainId),
    [filteredTerrains, selectedTerrainId]
  );

  const handleTerrainClick = useCallback(
    (id: string) => {
      setSelectedTerrainId(id);
      setExpandedTerrainId(id);
    },
    []
  );

  const handleTerrainVisibilityChange = useCallback((id: string, visible: boolean) => {
    if (mapRef.current?.setTerrainVisibility) {
      mapRef.current.setTerrainVisibility(id, visible);
    }
  }, []);

  const isLongScan = useMemo(
    () =>
      scanDurationSeconds !== null &&
      scanDurationSeconds > LONG_SCAN_THRESHOLD_SECONDS,
    [scanDurationSeconds]
  );

  return (
    <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Map column */}
      <div>
        <TerrainMap
          ref={mapRef}
          provinceId={provinceId}
          scans={scans}
          selectedTerrainId={selectedTerrainId}
        />
      </div>

      {/* Right sidebar */}
      <div className="flex flex-col gap-4 overflow-y-auto">
        {/* Scan controls */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Scansione</h2>
            {loading && (
              <span className="text-xs text-[var(--muted)]">
                {scanDurationSeconds}s
              </span>
            )}
          </div>
          <div className="mb-4 space-y-2">
            {SOURCE_CATEGORIES.map((cat) => (
              <label
                key={cat.id}
                className="flex cursor-pointer items-center gap-2"
              >
                <input
                  type="checkbox"
                  checked={filterBy.includes(cat.id)}
                  onChange={() => setFilterBy((prev) => toggleItem(prev, cat.id))}
                  disabled={loading}
                />
                <span className="text-sm">{cat.name}</span>
              </label>
            ))}
          </div>
          <button
            onClick={() => handleStartScan(filterBy.length === 0 ? [] : filterBy)}
            disabled={loading}
            className="w-full rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Scansione in corso..." : "Avvia scansione"}
          </button>
          {loading && isLongScan && (
            <button
              onClick={handleCancelScan}
              className="mt-2 w-full rounded-lg border border-red-500 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
            >
              Annulla scansione
            </button>
          )}
        </div>

        {/* Live scan logs */}
        {liveScan && (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
            <h3 className="mb-2 text-sm font-semibold">Log scansione</h3>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-black/5 p-2 text-xs font-mono text-[var(--muted)]">
              {liveScan.logs.length === 0 ? (
                <p>In attesa di log...</p>
              ) : (
                liveScan.logs.map((log, idx) => (
                  <div key={idx}>
                    [{log.timestamp}] {log.message}
                  </div>
                ))
              )}
              {liveScan.error && (
                <p className="mt-2 text-red-600">{liveScan.error}</p>
              )}
            </div>
          </div>
        )}

        {/* Terrains list */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Terreni trovati ({filteredTerrains.length})</h2>
          </div>
          <div className="mb-3 space-y-2">
            <input
              type="text"
              placeholder="Cerca per nome o comune..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm placeholder-[var(--muted)]"
            />
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as TerrainSortMode)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            >
              <option value="distance-asc">Distanza (vicini primo)</option>
              <option value="comune-asc">Comune (A-Z)</option>
              <option value="comune-desc">Comune (Z-A)</option>
              <option value="area-desc">Area (grande prima)</option>
              <option value="area-asc">Area (piccolo prima)</option>
            </select>
          </div>
          {filteredTerrains.length === 0 ? (
            <p className="text-center text-sm text-[var(--muted)]">Nessun terreno trovato</p>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {filteredTerrains.map((terrain) => {
                const selected = terrain.id === selectedTerrainId;
                const expanded = terrain.id === expandedTerrainId;
                return (
                  <Fragment key={terrain.id}>
                    <div
                      onClick={() => handleTerrainClick(terrain.id)}
                      className={`cursor-pointer rounded-lg px-3 py-2 transition-colors ${
                        selected
                          ? "bg-[var(--primary)] text-white"
                          : "hover:bg-[var(--bg-tertiary)]"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{terrain.nome}</p>
                          <p className="text-xs text-[var(--muted)]">
                            {terrain.comune}
                            {terrain.distanceFromAddress
                              ? ` • ${formatMeters(terrain.distanceFromAddress)}`
                              : ""}
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={terrain.visible ?? false}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleTerrainVisibilityChange(terrain.id, e.target.checked);
                          }}
                          className="mt-1 cursor-pointer"
                        />
                      </div>
                    </div>
                    {expanded && selectedTerrain && (
                      <div className="rounded-lg bg-[var(--bg-tertiary)] p-3 text-xs">
                        <div className="mb-2 space-y-1">
                          <p>
                            <span className="font-semibold">Area:</span> {formatSqm(selectedTerrain.areaM2)}
                          </p>
                          {selectedTerrain.parcelleCount && (
                            <p>
                              <span className="font-semibold">Particelle:</span>{" "}
                              {selectedTerrain.parcelleCount}
                            </p>
                          )}
                          {selectedTerrain.sources && selectedTerrain.sources.length > 0 && (
                            <>
                              <p className="font-semibold">Fonti trovate:</p>
                              {anySourcesWithData && (
                                <div className="flex gap-2 flex-wrap">
                                  {SOURCE_CATEGORIES.map((cat) => {
                                    const hasData = selectedTerrain.sources?.some(
                                      (s) => s.category === cat.id
                                    );
                                    return hasData ? (
                                      <span
                                        key={cat.id}
                                        className="rounded-full bg-[var(--primary)] px-2 py-0.5 text-white"
                                      >
                                        {landuseLabel(cat.id)}
                                      </span>
                                    ) : null;
                                  })}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {selectedTerrain.geoPoint && (
                          <a
                            href={`https://www.google.com/maps/search/${selectedTerrain.geoPoint.lat},${selectedTerrain.geoPoint.lng}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-block rounded-md bg-blue-500 px-2 py-1 text-white hover:bg-blue-600 hover:text-white hover:no-underline hover:underline focus:bg-blue-600 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-blue-600"
                          >
                            <span className="inline-flex items-center gap-1 hover:bg-white/10">
                              Apri in Google Maps
                            </span>
                          </a>
                        )}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
