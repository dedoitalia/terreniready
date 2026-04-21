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

function decompressIfNeeded(data: string | ArrayBuffer): string {
  if (typeof data === "string") {
    return data;
  }

  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

function openInNewTab(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.click();
}

export default function TerreniDashboard() {
  const abortControllerRef = useRef<AbortController | null>(null);

  const [selectedProvinces, setSelectedProvinces] = useState<ProvinceId[]>([]);
  const [selectedCategories, setSelectedCategories] =
    useState<SourceCategoryId[]>(SOURCE_CATEGORIES);

  const [liveState, setLiveState] = useState<LiveScanState | null>(null);
  const [scanErrorMessage, setError] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<{
    status: "running" | "completed" | "failed";
    logs: ScanJobLogEntry[];
    error: string | null;
  } | null>(null);

  const [terrains, setTerrains] = useState<TerrainFeature[]>([]);
  const [selectedTerrainId, setSelectedTerrainId] = useState<string | null>(
    null
  );
  const [terrainSortMode, setTerrainSortMode] =
    useState<TerrainSortMode>("distance-asc");
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [longScanWarningVisible, setLongScanWarningVisible] = useState(false);

  const logIdRef = useRef(0);

  const selectedTerrain = useMemo(
    () =>
      selectedTerrainId
        ? terrains.find((t) => t.id === selectedTerrainId)
        : null,
    [selectedTerrainId, terrains]
  );

  const clearStreamReconnectWatchdog = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const streamScan = useCallback(async () => {
    clearStreamReconnectWatchdog();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLiveState({
      status: "running",
      logs: [],
      error: null,
    });
    setScanJob({
      status: "running",
      logs: [],
      error: null,
    });
    setTerrains([]);
    setSelectedTerrainId(null);
    setError(null);
    setLoadingSeconds(0);
    setLongScanWarningVisible(false);

    const loadingInterval = setInterval(() => {
      setLoadingSeconds((prev) => prev + 1);
    }, 1000);

    try {
      const response = await fetch("/api/terreni/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          provinces: selectedProvinces,
          categories: selectedCategories,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${errorBody || response.statusText}`
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;

            const payload = parseStreamPayload<ScanStreamEvent>(line);

            if (!payload) continue;

            if (payload.type === "log") {
              const entry = payload.data;
              setLiveState((prev) => {
                if (!prev) return prev;
                const newLogs = [
                  ...prev.logs,
                  {
                    id: logIdRef.current++,
                    timestamp: entry.timestamp,
                    level: entry.level,
                    scope: entry.scope,
                    message: entry.message,
                  },
                ];
                if (newLogs.length > MAX_LOG_ENTRIES) {
                  newLogs.shift();
                }
                return { ...prev, logs: newLogs };
              });

              setScanJob((prev) => {
                if (!prev) return prev;
                const newLogs = [
                  ...prev.logs,
                  {
                    id: logIdRef.current,
                    timestamp: entry.timestamp,
                    level: entry.level,
                    scope: entry.scope,
                    message: entry.message,
                  },
                ];
                return { ...prev, logs: newLogs };
              });
            }

            if (payload.type === "result") {
              const terrain = payload.data;
              setTerrains((prev) => [...prev, terrain]);
            }

            if (payload.type === "error") {
              const errorData = payload.data;
              setLiveState((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  status: "failed",
                  error: errorData.message,
                };
              });

              setScanJob((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  status: "failed",
                  error: errorData.message,
                };
              });

              setError(errorData.message);
            }

            if (payload.type === "done") {
              clearInterval(loadingInterval);
              const scanResponse = payload.data as ScanResponse;

              setLiveState((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  status: "completed",
                };
              });

              setScanJob((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  status: "completed",
                };
              });

              setError(
                scanResponse.message ||
                  `Scansione completata. Trovati ${scanResponse.count} terreni.`
              );
            }
          }
        }
      } finally {
        clearInterval(loadingInterval);
      }
    } catch (e) {
      clearInterval(loadingInterval);

      if (e instanceof Error) {
        if (e.name === "AbortError") {
          setScanJob((current) => ({
            status: "failed",
            error: "Scansione annullata dall'utente. Il motore server si ferma al prossimo checkpoint (tipicamente entro 30 secondi).",
            logs: current?.logs ?? [],
          }));
          setError(
            "Scansione annullata. I risultati parziali ricevuti prima dell'annullamento sono ancora visibili qui sopra."
          );
        } else {
          setScanJob((current) => ({
            status: "failed",
            error: e.message,
            logs: current?.logs ?? [],
          }));
          setError(e.message);
        }
      } else {
        setScanJob((current) => ({
          status: "failed",
          error: "Errore sconosciuto",
          logs: current?.logs ?? [],
        }));
        setError("Errore sconosciuto");
      }
    }
  }, [selectedProvinces, selectedCategories, clearStreamReconnectWatchdog]);

  const cancelScan = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (loadingSeconds > LONG_SCAN_THRESHOLD_SECONDS) {
        setLongScanWarningVisible(true);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [loadingSeconds]);

  const handleProvinceToggle = useCallback((province: ProvinceId) => {
    setSelectedProvinces((prev) => toggleItem(prev, province));
  }, []);

  const handleCategoryToggle = useCallback((category: SourceCategoryId) => {
    setSelectedCategories((prev) => toggleItem(prev, category));
  }, []);

  const handleTerrainSelect = useCallback((id: string | null) => {
    setSelectedTerrainId(id);
  }, []);

  const handleSort = useCallback((mode: TerrainSortMode) => {
    setTerrainSortMode(mode);
  }, []);

  const sortedTerrains = useMemo(() => {
    const result = [...terrains];

    if (terrainSortMode === "distance-asc") {
      result.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    } else if (terrainSortMode === "comune-asc") {
      result.sort((a, b) => (a.comune || "").localeCompare(b.comune || ""));
    } else if (terrainSortMode === "comune-desc") {
      result.sort((a, b) => (b.comune || "").localeCompare(a.comune || ""));
    } else if (terrainSortMode === "area-desc") {
      result.sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
    } else if (terrainSortMode === "area-asc") {
      result.sort((a, b) => (a.area ?? 0) - (b.area ?? 0));
    }

    return result;
  }, [terrains, terrainSortMode]);

  const handleDownloadTerrains = useCallback(() => {
    const data = sortedTerrains.map((t) => ({
      id: t.id,
      Comune: t.comune,
      "Superficie (m²)": t.area,
      "Distanza dalla fonte (m)": t.distance,
      Latitudine: t.geometry.coordinates[1],
      Longitudine: t.geometry.coordinates[0],
      Foglio: t.foglio,
      Particella: t.particella,
      Subalterno: t.subalterno,
      "Categoria catastale": t.categoria,
      "Classe catastale": t.classe,
      "Rendita catastale": t.rendita,
      Indirizzo: t.indirizzo,
    }));

    const csv = [
      Object.keys(data[0]).join(","),
      ...data.map((row) =>
        Object.values(row)
          .map((v) => {
            if (v === null || v === undefined) {
              return "";
            }
            const s = String(v);
            return s.includes(",") ? `"${s}"` : s;
          })
          .join(",")
      ),
    ].join("\n");

    downloadBlob(csv, "text/csv", "terreni.csv");
  }, [sortedTerrains]);

  const handleDownloadMap = useCallback(async () => {
    if (!selectedTerrain) {
      return;
    }

    const [lng, lat] = selectedTerrain.geometry.coordinates;

    openInNewTab(
      `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=18`
    );
  }, [selectedTerrain]);

  return (
    <Fragment>
      <div className="terrain-container relative flex h-screen w-full flex-col overflow-hidden bg-white lg:flex-row">
        <div className="lg:border-r-default flex flex-shrink-0 flex-col gap-4 overflow-y-auto bg-[var(--background-secondary)] p-6 lg:max-w-md">
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Province</h2>
            <div className="flex flex-col gap-2">
              {PROVINCES.map((province) => (
                <label
                  key={province}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedProvinces.includes(province)}
                    onChange={() => handleProvinceToggle(province)}
                    className="terrain-checkbox h-4 w-4"
                  />
                  <span className="text-sm">
                    {PROVINCE_MAP.get(province) || province}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Categorie</h2>
            <div className="flex flex-col gap-2">
              {SOURCE_CATEGORIES.map((category) => (
                <label
                  key={category}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(category)}
                    onChange={() => handleCategoryToggle(category)}
                    className="terrain-checkbox h-4 w-4"
                  />
                  <span className="text-sm">
                    {SOURCE_CATEGORY_MAP.get(category) || category}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {scanJob && scanJob.status === "running" && (
              <button
                onClick={cancelScan}
                className="terrain-button terrain-button-red flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium"
              >
                Annulla scansione
              </button>
            )}

            {!scanJob || scanJob.status !== "running" ? (
              <button
                onClick={streamScan}
                disabled={selectedProvinces.length === 0}
                className="terrain-button terrain-button-primary flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium disabled:opacity-50"
              >
                Avvia scansione
              </button>
            ) : null}
          </div>

          {scanErrorMessage && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {scanErrorMessage}
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2">
            <h2 className="text-base font-semibold">
              Risultati ({sortedTerrains.length})
            </h2>

            {sortedTerrains.length > 0 && (
              <div className="flex flex-col gap-2">
                <select
                  value={terrainSortMode}
                  onChange={(e) => handleSort(e.target.value as TerrainSortMode)}
                  className="terrain-select rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="distance-asc">
                    Distanza (ascendente)
                  </option>
                  <option value="comune-asc">Comune (A-Z)</option>
                  <option value="comune-desc">Comune (Z-A)</option>
                  <option value="area-desc">Superficie (maggiore)</option>
                  <option value="area-asc">Superficie (minore)</option>
                </select>

                <button
                  onClick={handleDownloadTerrains}
                  className="terrain-button terrain-button-secondary flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium"
                >
                  Scarica CSV
                </button>
              </div>
            )}

            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {sortedTerrains.map((terrain) => (
                <button
                  key={terrain.id}
                  onClick={() => handleTerrainSelect(terrain.id)}
                  className={`rounded-lg border border-transparent p-3 text-left text-sm transition-colors ${
                    selectedTerrainId === terrain.id
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                >
                  <div className="font-medium">{terrain.comune}</div>
                  <div className="text-xs text-gray-600">
                    {formatSqm(terrain.area)} •{" "}
                    {formatMeters(terrain.distance ?? 0)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="relative flex flex-1 flex-col overflow-hidden bg-gray-100">
          {scanJob && (
            <div className="flex flex-col gap-3 border-b border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  {scanJob.status === "running"
                    ? `Scansione in corso... (${loadingSeconds}s)`
                    : scanJob.status === "completed"
                      ? "Scansione completata"
                      : "Scansione fallita"}
                </h3>
                {longScanWarningVisible && (
                  <span className="text-xs text-orange-600">
                    (Scansione lunga - riprovare con meno aree o categorie)
                  </span>
                )}
              </div>

              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto rounded-lg bg-gray-50 p-3 text-xs font-mono">
                {scanJob.logs.map((log) => (
                  <div
                    key={log.id}
                    className={`${
                      log.level === "error"
                        ? "text-red-600"
                        : log.level === "warn"
                          ? "text-orange-600"
                          : "text-gray-600"
                    }`}
                  >
                    <span className="font-semibold">[{log.scope}]</span>{" "}
                    {log.message}
                  </div>
                ))}
              </div>

              {scanJob.error && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                  {scanJob.error}
                </div>
              )}
            </div>
          )}

          {selectedTerrain && (
            <div className="border-b border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{selectedTerrain.comune}</h3>
                  <p className="text-xs text-gray-600">
                    {selectedTerrain.indirizzo || "Indirizzo non disponibile"}
                  </p>
                </div>
                <button
                  onClick={handleDownloadMap}
                  className="terrain-button terrain-button-secondary flex h-9 flex-shrink-0 items-center justify-center rounded-lg px-3 text-sm font-medium"
                >
                  Mappa
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="block font-semibold text-gray-600">
                    Superficie
                  </span>
                  <span className="block">{formatSqm(selectedTerrain.area)}</span>
                </div>
                <div>
                  <span className="block font-semibold text-gray-600">
                    Distanza
                  </span>
                  <span className="block">
                    {formatMeters(selectedTerrain.distance ?? 0)}
                  </span>
                </div>
                <div>
                  <span className="block font-semibold text-gray-600">
                    Foglio
                  </span>
                  <span className="block">{selectedTerrain.foglio}</span>
                </div>
                <div>
                  <span className="block font-semibold text-gray-600">
                    Particella
                  </span>
                  <span className="block">{selectedTerrain.particella}</span>
                </div>
                <div>
                  <span className="block font-semibold text-gray-600">
                    Categoria
                  </span>
                  <span className="block">{selectedTerrain.categoria}</span>
                </div>
                <div>
                  <span className="block font-semibold text-gray-600">
                    Classe
                  </span>
                  <span className="block">{selectedTerrain.classe}</span>
                </div>
                <div className="col-span-2">
                  <span className="block font-semibold text-gray-600">
                    Rendita
                  </span>
                  <span className="block">{selectedTerrain.rendita}</span>
                </div>
              </div>
            </div>
          )}

          <TerrainMap
            terrain={selectedTerrain}
            terrains={sortedTerrains}
            onTerrainSelect={handleTerrainSelect}
          />
        </div>
      </div>
    </Fragment>
  );
}
