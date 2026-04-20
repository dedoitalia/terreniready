"use client";

import dynamic from "next/dynamic";
import JSZip from "jszip";
import { useEffect, useRef, useState } from "react";

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

type LiveScanState = {
  status: "running" | "completed" | "failed";
  logs: ScanJobLogEntry[];
  error: string | null;
};

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

function buildScanStreamUrl(
  provinceIds: ProvinceId[],
  categoryIds: SourceCategoryId[],
) {
  const params = new URLSearchParams();

  provinceIds.forEach((provinceId) => {
    params.append("provinceIds", provinceId);
  });
  categoryIds.forEach((categoryId) => {
    params.append("categoryIds", categoryId);
  });

  return `/api/scan/stream?${params.toString()}`;
}

function appendLogEntry(
  previous: LiveScanState | null,
  entry: ScanJobLogEntry,
): LiveScanState {
  return {
    status: previous?.status ?? "running",
    error: previous?.error ?? null,
    logs: [...(previous?.logs ?? []), entry].slice(-120),
  };
}

function createLogEntry(message: string): ScanJobLogEntry {
  return {
    timestamp: new Date().toISOString(),
    message,
  };
}

function buildCsv(data: ScanResponse) {
  const rows = [
    [
      "provincia",
      "terreno",
      "uso_agricolo",
      "distanza_metri",
      "superficie_mq",
      "fonte",
      "tipo_fonte",
      "lat",
      "lng",
      "osm_url",
    ],
    ...data.terrains.map((terrain) => [
      PROVINCE_MAP[terrain.provinceId].name,
      terrain.name,
      landuseLabel(terrain.landuse),
      Math.round(terrain.distanceMeters).toString(),
      terrain.areaSqm ? terrain.areaSqm.toString() : "",
      terrain.closestSourceName,
      SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId].label,
      terrain.center.lat.toFixed(6),
      terrain.center.lng.toFixed(6),
      `https://www.openstreetmap.org/way/${terrain.osmId}`,
    ]),
  ];

  return rows
    .map((row) =>
      row
        .map((cell) => `"${cell.replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\n");
}

function latestRunHeadline(data: ScanResponse | null, latestLog?: ScanJobLogEntry) {
  if (!data) {
    return latestLog?.message ?? "Nessun evento registrato";
  }

  const hasPartialCoverage = data.meta.warnings.some((warning) =>
    warning.toLowerCase().includes("parzial"),
  );

  if (data.terrains.length === 0) {
    return hasPartialCoverage
      ? `Scansione parziale: ${data.sources.length} fonti caricate, copertura terreni incompleta.`
      : `Scansione completata: ${data.sources.length} fonti, nessun terreno trovato.`;
  }

  if (hasPartialCoverage) {
    return `Scansione parziale: ${data.sources.length} fonti e ${data.terrains.length} terreni, copertura terreni incompleta.`;
  }

  return `Scansione completata: ${data.sources.length} fonti e ${data.terrains.length} terreni restituiti.`;
}

function loadingContextCopy(
  selectedProvinceCount: number,
  categoryIds: SourceCategoryId[],
  isLongRunningScan: boolean,
) {
  if (isLongRunningScan) {
    if (categoryIds.length === 1 && categoryIds[0] === "fuel") {
      return "I distributori sono gia acquisiti dal dataset ufficiale MIMIT; il motore sta ancora completando terreni agricoli e filtri urbani sui provider geospaziali pubblici.";
    }

    return "Il job è ancora vivo sul server. Continuo a leggere i log e a completare i passaggi residui su fonti e terreni, senza interrompere la scansione.";
  }

  if (categoryIds.length === 1 && categoryIds[0] === "fuel") {
    return "I distributori arrivano dal dataset ufficiale MIMIT; in questa fase sto verificando terreni agricoli e filtri urbani nel buffer selezionato.";
  }

  if (categoryIds.includes("fuel")) {
    return "Le fonti carburante arrivano da MIMIT, mentre le altre categorie e i terreni passano ancora dai provider geospaziali pubblici.";
  }

  if (selectedProvinceCount > 1 || categoryIds.length > 1) {
    return "Con più province o categorie la pipeline può richiedere più tempo.";
  }

  return "Sto cercando fonti e terreni agricoli nel buffer selezionato.";
}

function terrainPlacemark(terrain: TerrainFeature) {
  const coordinates = terrain.coordinates
    .map(([lng, lat]) => `${lng},${lat},0`)
    .join(" ");

  return `
    <Placemark>
      <name>${terrain.name}</name>
      <description><![CDATA[
        Provincia: ${PROVINCE_MAP[terrain.provinceId].name}<br/>
        Uso: ${landuseLabel(terrain.landuse)}<br/>
        Distanza: ${Math.round(terrain.distanceMeters)} m<br/>
        Superficie: ${
          terrain.areaSqm ? terrain.areaSqm.toLocaleString("it-IT") : "n.d."
        } m²<br/>
        Fonte: ${terrain.closestSourceName}
      ]]></description>
      <Style>
        <LineStyle><color>ff2f5d22</color><width>2</width></LineStyle>
        <PolyStyle><color>6670c16d</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordinates}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
}

async function downloadKmz(data: ScanResponse) {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>TerreniReady Export</name>
    ${data.terrains.map(terrainPlacemark).join("\n")}
  </Document>
</kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);

  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "application/vnd.google-earth.kmz", "terreniready-export.kmz");
}

export default function TerreniDashboard() {
  const [selectedProvinceIds, setSelectedProvinceIds] = useState<ProvinceId[]>([
    "PT",
  ]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<SourceCategoryId[]>(
    ["fuel", "bodyshop", "repair"],
  );
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [scanJob, setScanJob] = useState<LiveScanState | null>(null);
  const [activeTerrainId, setActiveTerrainId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dossierOffset, setDossierOffset] = useState(0);
  const streamRef = useRef<EventSource | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamReconnectNoticeRef = useRef(false);
  const dossierSectionRef = useRef<HTMLElement | null>(null);
  const dossierRailRef = useRef<HTMLElement | null>(null);
  const terrainRowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const activeTerrain = scanData?.terrains.find(
    (terrain) => terrain.id === activeTerrainId,
  );

  const selectedProvinceNames = selectedProvinceIds.map(
    (provinceId) => PROVINCE_MAP[provinceId].name,
  );
  const selectedProvinceSummary =
    selectedProvinceNames.length > 0
      ? selectedProvinceNames.join(" · ")
      : "Nessuna provincia selezionata";

  const selectedCategoryLabels = selectedCategoryIds.map(
    (categoryId) => SOURCE_CATEGORY_MAP[categoryId].label,
  );
  const selectedCategorySummary =
    selectedCategoryLabels.length > 0
      ? selectedCategoryLabels.join(" · ")
      : "Nessuna categoria selezionata";

  const latestLog = scanJob?.logs.at(-1);
  const latestHeadline = latestRunHeadline(scanData, latestLog);
  const warningCount = scanData?.meta.warnings.length ?? 0;
  const isLongRunningScan = loading && loadingSeconds >= LONG_SCAN_THRESHOLD_SECONDS;

  useEffect(() => {
    if (!loading) {
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loading]);

  useEffect(() => {
    return () => {
      if (streamReconnectTimerRef.current) {
        window.clearTimeout(streamReconnectTimerRef.current);
      }

      streamRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const updateDossierOffset = () => {
      if (typeof window === "undefined" || window.innerWidth < 1280) {
        setDossierOffset(0);
        return;
      }

      const section = dossierSectionRef.current;
      const rail = dossierRailRef.current;
      const activeRow = activeTerrainId
        ? terrainRowRefs.current.get(activeTerrainId)
        : null;

      if (!section || !rail || !activeRow) {
        setDossierOffset(0);
        return;
      }

      const sectionRect = section.getBoundingClientRect();
      const rowRect = activeRow.getBoundingClientRect();
      const rowTopWithinSection = rowRect.top - sectionRect.top;
      const desiredOffset = Math.max(0, rowTopWithinSection - 8);
      const maxOffset = Math.max(0, section.scrollHeight - rail.offsetHeight);

      setDossierOffset(Math.min(Math.round(desiredOffset), maxOffset));
    };

    const frameId = window.requestAnimationFrame(updateDossierOffset);
    window.addEventListener("resize", updateDossierOffset);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateDossierOffset);
    };
  }, [activeTerrainId, scanData?.terrains.length]);

  function clearStreamReconnectWatchdog() {
    if (streamReconnectTimerRef.current) {
      window.clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }

    streamReconnectNoticeRef.current = false;
  }

  async function runScan() {
    if (selectedProvinceIds.length === 0) {
      setError("Seleziona almeno una provincia.");
      return;
    }

    if (selectedCategoryIds.length === 0) {
      setError("Seleziona almeno una tipologia di fonte emissiva.");
      return;
    }

    setLoading(true);
    setLoadingSeconds(0);
    setError(null);
    setScanJob({
      status: "running",
      logs: [],
      error: null,
    });
    clearStreamReconnectWatchdog();

    streamRef.current?.close();
    const eventSource = new EventSource(
      buildScanStreamUrl(selectedProvinceIds, selectedCategoryIds),
    );
    streamRef.current = eventSource;

    const closeCurrentStream = () => {
      if (streamRef.current === eventSource) {
        streamRef.current = null;
      }

      clearStreamReconnectWatchdog();
      eventSource.close();
    };

    eventSource.onopen = () => {
      if (streamRef.current !== eventSource) {
        return;
      }

      const hadReconnectNotice = streamReconnectNoticeRef.current;
      clearStreamReconnectWatchdog();

      if (hadReconnectNotice) {
        setScanJob((current) =>
          appendLogEntry(
            current,
            createLogEntry(
              "Connessione live ristabilita, continuo a seguire la scansione.",
            ),
          ),
        );
      }
    };

    eventSource.addEventListener("log", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      if (!payload || payload.type !== "log") {
        return;
      }

      setScanJob((current) => appendLogEntry(current, payload.entry));
    });

    eventSource.addEventListener("status", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      if (!payload || payload.type !== "status") {
        return;
      }

      setScanJob((current) => ({
        status: payload.status,
        error: current?.error ?? null,
        logs: current?.logs ?? [],
      }));
    });

    eventSource.addEventListener("result", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      if (!payload || payload.type !== "result") {
        return;
      }

      setScanData(payload.result);
      setActiveTerrainId(payload.result.terrains[0]?.id);
      setLoading(false);
      setLoadingSeconds(0);
      setScanJob((current) => ({
        status: "completed",
        error: null,
        logs: current?.logs ?? [],
      }));
      closeCurrentStream();
    });

    eventSource.addEventListener("scan-error", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      const message =
        payload && payload.type === "scan-error"
          ? payload.message
          : "La scansione si è interrotta sul server.";

      setError(message);
      setLoading(false);
      setLoadingSeconds(0);
      setScanJob((current) => ({
        status: "failed",
        error: message,
        logs: current?.logs ?? [],
      }));
      closeCurrentStream();
    });

    eventSource.onerror = () => {
      if (streamRef.current !== eventSource) {
        return;
      }

      if (eventSource.readyState === EventSource.CONNECTING) {
        if (!streamReconnectNoticeRef.current) {
          streamReconnectNoticeRef.current = true;
          setScanJob((current) =>
            appendLogEntry(
              current,
              createLogEntry(
                "Connessione live instabile, provo a ristabilire il flusso senza perdere la scansione.",
              ),
            ),
          );
        }

        if (streamReconnectTimerRef.current) {
          window.clearTimeout(streamReconnectTimerRef.current);
        }

        streamReconnectTimerRef.current = window.setTimeout(() => {
          if (streamRef.current !== eventSource) {
            return;
          }

          if (eventSource.readyState === EventSource.OPEN) {
            return;
          }

          const message =
            "La connessione live resta instabile da troppo tempo. Riprova tra pochi secondi.";

          setError(message);
          setLoading(false);
          setLoadingSeconds(0);
          setScanJob((current) => ({
            status: "failed",
            error: message,
            logs: current?.logs ?? [],
          }));
          closeCurrentStream();
        }, 15_000);

        return;
      }

      const message =
        "La connessione live con il motore di scansione si è chiusa prima del risultato. Riprova.";

      setError(message);
      setLoading(false);
      setLoadingSeconds(0);
      setScanJob((current) => ({
        status: "failed",
        error: message,
        logs: current?.logs ?? [],
      }));
      closeCurrentStream();
    };
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute left-[-14rem] top-[-10rem] h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(circle,rgba(214,192,103,0.38),transparent_72%)] blur-3xl" />
        <div className="absolute right-[-8rem] top-[10rem] h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(76,108,81,0.22),transparent_70%)] blur-3xl" />
        <div className="absolute bottom-[-12rem] left-[20%] h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgba(150,114,86,0.14),transparent_72%)] blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto flex max-w-[1680px] flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-8">
        <header className="terrain-shell terrain-shell-hero px-6 py-6 lg:px-8 lg:py-8">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.22fr)_360px] xl:items-end">
            <div className="space-y-5">
              <div className="terrain-keyline terrain-keyline-dark">
                TerreniReady / land intelligence suite
              </div>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_250px] lg:items-end">
                <div>
                  <h1 className="max-w-5xl text-[clamp(2.85rem,5vw,5.35rem)] font-semibold leading-[0.94] tracking-[-0.055em] text-[#f6f2e8]">
                    Un atlante operativo per leggere territorio, particelle e
                    prossimità emissiva come un unico dossier.
                  </h1>
                  <p className="mt-5 max-w-3xl text-base leading-7 text-[#d8e3d4] lg:text-lg">
                    Ho ricostruito il SaaS intorno alla filosofia già presente nel
                    prodotto: cartografia, agricoltura, catasto e analisi fondiaria.
                    Il risultato è una control room più netta, più editoriale e più
                    coerente in tutte le sue superfici.
                  </p>
                </div>
                <div className="rounded-[28px] border border-white/10 bg-white/6 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur">
                  <div className="terrain-keyline terrain-keyline-dark">
                    Workflow
                  </div>
                  <div className="mt-4 space-y-3 text-sm leading-6 text-[#e5eee0]">
                    <p>1. Selezione geografica delle province target.</p>
                    <p>2. Ingest di fonti da dataset ufficiali e provider geospaziali.</p>
                    <p>3. Matching spaziale dei terreni agricoli nel buffer.</p>
                    <p>4. Lettura in mappa, tabella ed export del dossier.</p>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <span className="terrain-chip terrain-chip-dark">
                  MIMIT + provider geospaziali
                </span>
                <span className="terrain-chip terrain-chip-dark">
                  Overlay catastale WMS ufficiale
                </span>
                <span className="terrain-chip terrain-chip-dark">
                  Raggio operativo 350 m
                </span>
                <span className="terrain-chip terrain-chip-dark">
                  Export CSV + KMZ
                </span>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-[30px] border border-white/10 bg-black/12 p-5 backdrop-blur">
                <div className="terrain-keyline terrain-keyline-dark">
                  Filosofia del tema
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-[-0.04em] text-white">
                  Territorio come tavolo operativo
                </h2>
                <p className="mt-3 text-sm leading-6 text-[#dde6d8]">
                  Il linguaggio grafico adesso unisce ledger tecnico, mappa
                  satellitare, griglia catastale e scheda asset, così ogni gesto
                  dell&apos;utente resta dentro una narrativa unica: analizzare,
                  verificare e shortlistare.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[24px] border border-white/10 bg-white/8 p-4 backdrop-blur">
                  <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9ab096]">
                    Province live
                  </div>
                  <div className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-white">
                    {selectedProvinceIds.length}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-white/8 p-4 backdrop-blur">
                  <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9ab096]">
                    Fonti monitorate
                  </div>
                  <div className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-white">
                    {selectedCategoryIds.length}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-white/8 p-4 backdrop-blur">
                  <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9ab096]">
                    Stato scan
                  </div>
                  <div className="mt-3 text-sm font-medium leading-6 text-[#edf2e7]">
                    {loading
                      ? `In corso da ${loadingSeconds}s`
                      : scanJob?.status === "completed"
                        ? "Ultima scansione completata"
                        : scanJob?.status === "failed"
                          ? "Ultima scansione fallita"
                          : "Pronto al lancio"}
                  </div>
                </div>
                <div className="rounded-[24px] border border-white/10 bg-white/8 p-4 backdrop-blur">
                  <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9ab096]">
                    Ultimo log
                  </div>
                  <div className="mt-3 text-sm font-medium leading-6 text-[#edf2e7]">
                    {latestLog?.message ?? "Nessuna esecuzione ancora registrata"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="grid gap-6 xl:grid-cols-[410px_minmax(0,1fr)]">
          <aside className="space-y-5">
            <section className="terrain-shell p-5 lg:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="terrain-keyline">Mission control</div>
                  <h2 className="mt-3 text-[2rem] font-semibold tracking-[-0.045em] text-[var(--foreground)]">
                    Radar territoriale
                  </h2>
                  <p className="mt-3 max-w-md text-sm leading-6 text-[var(--muted)]">
                    Qui si imposta il perimetro operativo del dossier: provincia,
                    tipologia emissiva e azioni di scansione o export.
                  </p>
                </div>
                <div className="rounded-[22px] border border-[var(--line)] bg-[rgba(255,255,255,0.55)] px-4 py-3 text-right shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                  <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
                    Buffer
                  </div>
                  <div className="mt-1 font-mono text-sm text-[var(--foreground)]">
                    350 m
                  </div>
                </div>
              </div>

              <div className="mt-7 space-y-7">
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="terrain-keyline">Ambito geografico</div>
                      <h3 className="mt-2 text-lg font-semibold text-[var(--foreground)]">
                        Province toscane
                      </h3>
                    </div>
                    <span className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.55)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-strong)]">
                      {selectedProvinceIds.length} attive
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {PROVINCES.map((province) => {
                      const checked = selectedProvinceIds.includes(province.id);

                      return (
                        <button
                          key={province.id}
                          type="button"
                          onClick={() =>
                            setSelectedProvinceIds((current) =>
                              toggleItem(current, province.id),
                            )
                          }
                          className={`rounded-[22px] border px-4 py-3 text-left transition ${
                            checked
                              ? "border-[rgba(17,31,21,0.12)] bg-[linear-gradient(135deg,#1a2b1d,#304735)] text-white shadow-[0_18px_35px_rgba(18,27,19,0.2)]"
                              : "border-[var(--line)] bg-[rgba(255,255,255,0.55)] text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] hover:border-[rgba(44,66,49,0.22)] hover:bg-[rgba(255,255,255,0.78)]"
                          }`}
                        >
                          <div className="font-semibold">{province.name}</div>
                          <div
                            className={`mt-1 text-xs ${
                              checked ? "text-[#c9d6c4]" : "text-[var(--muted)]"
                            }`}
                          >
                            {province.id}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="terrain-keyline">Sorgenti</div>
                      <h3 className="mt-2 text-lg font-semibold text-[var(--foreground)]">
                        Fonti emissive
                      </h3>
                    </div>
                    <span className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.55)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-strong)]">
                      {selectedCategoryIds.length} tipi
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {SOURCE_CATEGORIES.map((category) => {
                      const checked = selectedCategoryIds.includes(category.id);

                      return (
                        <button
                          key={category.id}
                          type="button"
                          onClick={() =>
                            setSelectedCategoryIds((current) =>
                              toggleItem(current, category.id),
                            )
                          }
                          className={`w-full rounded-[24px] border p-4 text-left transition ${
                            checked
                              ? "border-[rgba(17,31,21,0.08)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(231,236,223,0.96))] shadow-[0_18px_35px_rgba(25,33,24,0.08)]"
                              : "border-[var(--line)] bg-[rgba(255,255,255,0.5)] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] hover:bg-[rgba(255,255,255,0.74)]"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <span
                              className="mt-1 h-3.5 w-3.5 rounded-full ring-4 ring-white/60"
                              style={{ backgroundColor: category.color }}
                            />
                            <div>
                              <div className="font-semibold text-[var(--foreground)]">
                                {category.label}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                                {category.description}
                              </p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            </section>

            <section className="terrain-shell terrain-shell-dark p-5 lg:p-6">
              <div className="terrain-keyline terrain-keyline-dark">
                Scan engine
              </div>
              <h2 className="mt-3 text-[1.85rem] font-semibold tracking-[-0.04em] text-white">
                Lancia la ricognizione
              </h2>
              <p className="mt-3 text-sm leading-6 text-[#cfdbcb]">
                La scansione interroga le fonti pubbliche, costruisce il buffer
                spaziale e rientra con il set dei terreni agricoli rilevati.
              </p>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <button
                  type="button"
                  onClick={runScan}
                  disabled={loading}
                  className="terrain-button-primary"
                >
                  {loading ? "Scansione in corso..." : "Avvia scansione reale"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!scanData) {
                      return;
                    }

                    downloadBlob(
                      `\ufeff${buildCsv(scanData)}`,
                      "text/csv;charset=utf-8",
                      "terreniready-export.csv",
                    );
                  }}
                  disabled={!scanData || scanData.terrains.length === 0}
                  className="terrain-button-secondary terrain-button-secondary-dark"
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!scanData || scanData.terrains.length === 0) {
                      return;
                    }

                    void downloadKmz(scanData);
                  }}
                  disabled={!scanData || scanData.terrains.length === 0}
                  className="terrain-button-secondary terrain-button-secondary-dark sm:col-span-2 xl:col-span-1"
                >
                  Export KMZ
                </button>
              </div>

              {loading ? (
                <div className="mt-5 rounded-[24px] border border-white/10 bg-white/6 p-4 text-sm leading-6 text-[#edf2e7]">
                  <div className="flex items-center justify-between gap-3">
                    <span>
                      {isLongRunningScan
                        ? "Scansione estesa in monitoraggio."
                        : "Scansione live in esecuzione."}
                    </span>
                    <span className="font-mono text-xs">{loadingSeconds}s</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full bg-[linear-gradient(90deg,#d6c46f,#8ea76a)] transition-[width]"
                      style={{
                        width: `${Math.min(92, Math.max(12, loadingSeconds * 3))}%`,
                      }}
                    />
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[#c1d0be]">
                    {loadingContextCopy(
                      selectedProvinceIds.length,
                      selectedCategoryIds,
                      isLongRunningScan,
                    )}
                  </p>
                  {latestLog ? (
                    <p className="mt-2 rounded-2xl bg-black/12 px-3 py-2 text-xs leading-5 text-[#e5ede1]">
                      Ultimo step: {latestLog.message}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <div className="mt-5 rounded-[24px] border border-[rgba(235,140,123,0.25)] bg-[rgba(176,72,56,0.18)] px-4 py-4 text-sm leading-6 text-[#ffe3db]">
                  {error}
                </div>
              ) : null}
            </section>

            {scanJob ? (
              <section className="terrain-shell p-5 lg:p-6">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <div className="terrain-keyline">Timeline</div>
                    <h2 className="mt-3 text-[1.8rem] font-semibold tracking-[-0.04em] text-[var(--foreground)]">
                      Log scansione
                    </h2>
                  </div>
                  <span className="rounded-full border border-[var(--line)] bg-[rgba(255,255,255,0.65)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted-strong)]">
                    {scanJob.status}
                  </span>
                </div>

                <div className="mt-5 max-h-72 overflow-auto rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.56)] p-4">
                  <div className="relative space-y-4 border-l border-[rgba(28,43,30,0.12)] pl-4">
                    {scanJob.logs.map((entry) => (
                      <div key={`${entry.timestamp}-${entry.message}`} className="relative">
                        <span className="absolute -left-[1.15rem] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--accent-strong)] ring-4 ring-[rgba(255,255,255,0.7)]" />
                        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                          {new Date(entry.timestamp).toLocaleTimeString("it-IT")}
                        </div>
                        <div className="mt-1 text-sm leading-6 text-[var(--muted-strong)]">
                          {entry.message}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            ) : null}

            <section className="terrain-shell p-5 lg:p-6">
              <div className="terrain-keyline">Compliance note</div>
              <h2 className="mt-3 text-[1.6rem] font-semibold tracking-[-0.04em] text-[var(--foreground)]">
                Stato del dataset
              </h2>
              <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                In questa versione la pipeline usa solo dati pubblici reali. I
                proprietari, i nomi e i codici fiscali non sono presenti: per quel
                livello serve una connessione catastale convenzionata.
              </p>
            </section>
          </aside>

          <section className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="terrain-stat-card">
                <div className="terrain-keyline">Fonti intercettate</div>
                <div className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[var(--foreground)]">
                  {scanData?.meta.totalSources ?? 0}
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  POI emissivi rilevati nelle province correnti.
                </p>
              </div>
              <div className="terrain-stat-card">
                <div className="terrain-keyline">Terreni candidati</div>
                <div className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[var(--foreground)]">
                  {scanData?.meta.totalTerrains ?? 0}
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Poligoni agricoli agganciati alla fonte più vicina.
                </p>
              </div>
              <div className="terrain-stat-card">
                <div className="terrain-keyline">Raggio operativo</div>
                <div className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[var(--foreground)]">
                  {scanData?.meta.radiusMeters ?? 350}m
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Buffer costante per il matching territoriale.
                </p>
              </div>
              <div className="terrain-stat-card">
                <div className="terrain-keyline">Warning pipeline</div>
                <div className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[var(--foreground)]">
                  {warningCount}
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Segnalazioni tecniche su query o copertura dati.
                </p>
              </div>
            </div>

            {scanData?.meta.warnings.map((warning) => (
              <div
                key={warning}
                className="terrain-shell border-[rgba(122,100,31,0.2)] bg-[linear-gradient(180deg,rgba(255,248,225,0.92),rgba(244,236,195,0.84))] px-5 py-4 text-sm leading-6 text-[#6b5920]"
              >
                {warning}
              </div>
            ))}

            <section className="terrain-shell p-3 sm:p-4">
              <div className="rounded-[28px] border border-[rgba(24,39,27,0.1)] bg-[rgba(255,255,255,0.44)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.78)] sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div className="max-w-2xl">
                    <div className="terrain-keyline">Atlante operativo</div>
                    <h2 className="mt-3 text-[2.25rem] font-semibold tracking-[-0.05em] text-[var(--foreground)]">
                      Mappa, catasto e matching nello stesso stage
                    </h2>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                      Lo stage cartografico è il centro della piattaforma: layer
                      satellitari, particelle catastali e geometrie dei terreni sono
                      messi nello stesso linguaggio visivo.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="terrain-mini-card">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        Province
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selectedProvinceNames.length > 0 ? (
                          selectedProvinceNames.map((provinceName) => (
                            <span key={provinceName} className="terrain-inline-pill">
                              {provinceName}
                            </span>
                          ))
                        ) : (
                          <span className="text-sm font-medium leading-6 text-[var(--muted-strong)]">
                            Nessuna provincia selezionata
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="terrain-mini-card">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        Fonti
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selectedCategoryLabels.length > 0 ? (
                          selectedCategoryLabels.map((categoryLabel) => (
                            <span key={categoryLabel} className="terrain-inline-pill">
                              {categoryLabel}
                            </span>
                          ))
                        ) : (
                          <span className="text-sm font-medium leading-6 text-[var(--muted-strong)]">
                            Nessuna categoria selezionata
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="terrain-mini-card">
                      <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
                        Stato
                      </div>
                      <div className="mt-3 space-y-2">
                        <div className="text-base font-semibold leading-6 text-[var(--muted-strong)]">
                          {loading ? "Scan in corso" : "Stato pipeline"}
                        </div>
                        <div className="text-sm leading-6 text-[var(--muted)]">
                          {loading ? (
                            <>
                              da{" "}
                              <span className="font-mono text-[var(--muted-strong)]">
                                {loadingSeconds}s
                              </span>
                            </>
                          ) : (
                            latestLog?.message ?? "In attesa di una scansione"
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-5">
                  <TerrainMap
                    selectedProvinceIds={selectedProvinceIds}
                    sources={scanData?.sources ?? []}
                    terrains={scanData?.terrains ?? []}
                    activeTerrainId={activeTerrainId}
                    onSelectTerrainId={setActiveTerrainId}
                  />
                </div>
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="terrain-mini-card p-5">
                <div className="terrain-keyline">Copertura corrente</div>
                <div className="mt-3 text-lg font-semibold text-[var(--foreground)]">
                  {scanData
                    ? `${scanData.sources.length} fonti e ${scanData.terrains.length} terreni`
                    : "Nessun run ancora eseguito"}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  La lista a destra si sincronizza con la mappa e con la scheda del
                  terreno attivo.
                </p>
              </div>
              <div className="terrain-mini-card p-5">
                <div className="terrain-keyline">Ultimo evento</div>
                <div className="mt-3 text-lg font-semibold text-[var(--foreground)]">
                  {latestHeadline}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  {scanData?.meta.warnings.some((warning) =>
                    warning.toLowerCase().includes("parzial"),
                  )
                    ? "Le fonti utili sono state caricate, ma una parte della copertura terreni o dei filtri urbani resta incompleta: i dettagli sono nella timeline e nei warning operativi."
                    : "Ogni step del job e leggibile anche dalla timeline nella colonna di comando."}
                </p>
              </div>
              <div className="terrain-mini-card p-5">
                <div className="terrain-keyline">Terreno attivo</div>
                <div className="mt-3 text-lg font-semibold text-[var(--foreground)]">
                  {activeTerrain?.name ?? "Seleziona un poligono"}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  La scheda dossier in basso raccoglie distanza, superficie e fonte
                  associata.
                </p>
              </div>
            </div>
          </section>
        </main>

        <section
          ref={dossierSectionRef}
          className="grid gap-6 xl:items-start xl:grid-cols-[minmax(0,1fr)_390px]"
        >
          <div className="terrain-shell p-5 lg:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="terrain-keyline">Registro operativo</div>
                <h2 className="mt-3 text-[2.1rem] font-semibold tracking-[-0.045em] text-[var(--foreground)]">
                  Ledger dei terreni ordinati per vicinanza
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
                  Ogni riga è un poligono agricolo OSM con la sua fonte emissiva più
                  vicina. La selezione aggiorna la mappa e la scheda dossier.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="terrain-chip">{selectedProvinceSummary}</span>
                <span className="terrain-chip">{selectedCategorySummary}</span>
              </div>
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-y-2.5">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
                    <th className="px-4 pb-1">Terreno</th>
                    <th className="px-4 pb-1">Provincia</th>
                    <th className="px-4 pb-1">Uso</th>
                    <th className="px-4 pb-1">Distanza</th>
                    <th className="px-4 pb-1">Superficie</th>
                    <th className="px-4 pb-1">Fonte vicina</th>
                  </tr>
                </thead>
                <tbody>
                  {(scanData?.terrains ?? []).length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.55)] px-5 py-8 text-center text-sm leading-6 text-[var(--muted)]"
                      >
                        Nessun terreno ancora presente. Avvia una scansione per
                        riempire il ledger operativo.
                      </td>
                    </tr>
                  ) : (
                    (scanData?.terrains ?? []).map((terrain) => {
                      const active = terrain.id === activeTerrainId;

                      return (
                        <tr
                          key={terrain.id}
                          ref={(node) => {
                            if (node) {
                              terrainRowRefs.current.set(terrain.id, node);
                              return;
                            }

                            terrainRowRefs.current.delete(terrain.id);
                          }}
                          onClick={() => setActiveTerrainId(terrain.id)}
                          className={`cursor-pointer rounded-[24px] transition ${
                            active
                              ? "bg-[linear-gradient(135deg,#18281c,#2d4330)] text-white shadow-[0_18px_40px_rgba(22,31,23,0.18)]"
                              : "bg-[rgba(255,255,255,0.56)] text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] hover:bg-[rgba(255,255,255,0.78)]"
                          }`}
                        >
                          <td className="rounded-l-[24px] px-4 py-4 font-semibold">
                            {terrain.name}
                          </td>
                          <td className="px-4 py-4">
                            {PROVINCE_MAP[terrain.provinceId].name}
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={`rounded-full px-3 py-1 text-xs font-medium ${
                                active
                                  ? "bg-white/10 text-[#d8e4d4]"
                                  : "bg-[rgba(214,221,205,0.7)] text-[var(--muted-strong)]"
                              }`}
                            >
                              {landuseLabel(terrain.landuse)}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            {formatMeters(terrain.distanceMeters)}
                          </td>
                          <td className="px-4 py-4">{formatSqm(terrain.areaSqm)}</td>
                          <td className="rounded-r-[24px] px-4 py-4">
                            <div>{terrain.closestSourceName}</div>
                            <div
                              className={`mt-1 text-xs ${
                                active ? "text-[#c7d6c5]" : "text-[var(--muted)]"
                              }`}
                            >
                              {
                                SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId]
                                  .label
                              }
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside
            ref={dossierRailRef}
            className="terrain-shell terrain-shell-dark terrain-dossier-rail p-6"
            style={{
              transform:
                dossierOffset > 0 ? `translateY(${dossierOffset}px)` : undefined,
            }}
          >
            <div className="terrain-keyline terrain-keyline-dark">
              Asset dossier
            </div>
            <h2 className="mt-3 text-[2rem] font-semibold tracking-[-0.045em] text-white">
              Scheda terreno
            </h2>

            {activeTerrain ? (
              <div className="mt-5 space-y-5 text-sm leading-6 text-[#e4ece0]">
                <div className="rounded-[26px] border border-white/8 bg-white/6 p-5">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                    Nome asset
                  </div>
                  <div className="mt-2 text-2xl font-semibold leading-tight text-white">
                    {activeTerrain.name}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-[22px] border border-white/8 bg-white/6 p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Provincia
                    </div>
                    <div className="mt-2 font-semibold text-white">
                      {PROVINCE_MAP[activeTerrain.provinceId].name}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-white/6 p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Uso
                    </div>
                    <div className="mt-2 font-semibold text-white">
                      {landuseLabel(activeTerrain.landuse)}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-white/6 p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Distanza
                    </div>
                    <div className="mt-2 font-semibold text-white">
                      {formatMeters(activeTerrain.distanceMeters)}
                    </div>
                  </div>
                  <div className="rounded-[22px] border border-white/8 bg-white/6 p-4">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Superficie
                    </div>
                    <div className="mt-2 font-semibold text-white">
                      {formatSqm(activeTerrain.areaSqm)}
                    </div>
                  </div>
                </div>

                <div className="rounded-[26px] border border-white/8 bg-white/6 p-5">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                    Fonte più vicina
                  </div>
                  <div className="mt-2 text-lg font-semibold text-white">
                    {activeTerrain.closestSourceName}
                  </div>
                  <div className="mt-1 text-sm text-[#c5d4c3]">
                    {
                      SOURCE_CATEGORY_MAP[activeTerrain.closestSourceCategoryId]
                        .label
                    }
                  </div>
                </div>

                <div className="rounded-[26px] border border-white/8 bg-white/6 p-5">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                    Coordinate centroide
                  </div>
                  <div className="mt-3 font-mono text-sm leading-6 text-[#edf3e9]">
                    {activeTerrain.center.lat.toFixed(6)},{" "}
                    {activeTerrain.center.lng.toFixed(6)}
                  </div>
                  <a
                    href={`https://www.openstreetmap.org/way/${activeTerrain.osmId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex rounded-full border border-[rgba(243,227,142,0.28)] bg-[rgba(243,227,142,0.12)] px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#f3e38e] transition hover:bg-[rgba(243,227,142,0.18)]"
                  >
                    Apri poligono sorgente
                  </a>
                </div>

                <div className="rounded-[26px] border border-white/8 bg-[#111b14] p-5">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                    Step successivi
                  </div>
                  <div className="mt-3 space-y-2 text-sm leading-6 text-[#d3dfd1]">
                    <p>1. Verifica particella sul layer catastale ufficiale.</p>
                    <p>2. Avvia visura o convenzione per proprietario e titolarità.</p>
                    <p>3. Integra urbanistica e readiness nella shortlist finale.</p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-5 text-sm leading-6 text-[#cfdec9]">
                Seleziona un terreno dalla tabella o dalla mappa per riempire il
                dossier fondiario.
              </p>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
