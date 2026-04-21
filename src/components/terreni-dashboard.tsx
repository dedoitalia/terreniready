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
  const nextLogs = previous?.logs ?? [];
  // Piu efficiente di [...prev, entry].slice(-120): evita la copia del
  // vettore completo quando siamo gia al cap di 120 elementi.
  const capped =
    nextLogs.length >= MAX_LOG_ENTRIES
      ? nextLogs.slice(nextLogs.length - MAX_LOG_ENTRIES + 1)
      : nextLogs;

  return {
    status: previous?.status ?? "running",
    error: previous?.error ?? null,
    logs: [...capped, entry],
  };
}

function createLogEntry(message: string): ScanJobLogEntry {
  return {
    timestamp: new Date().toISOString(),
    message,
  };
}

function terrainMapUrl(terrain: TerrainFeature) {
  return (
    terrain.referenceUrl ??
    `https://www.google.com/maps?q=${terrain.center.lat.toFixed(6)},${terrain.center.lng.toFixed(6)}`
  );
}

function sourceComuneLabel(source: ScanResponse["sources"][number] | undefined) {
  if (!source) {
    return null;
  }

  const comune =
    source.tags.comune?.trim() ||
    source.tags["addr:city"]?.trim() ||
    source.address?.split(",").at(-1)?.trim();

  return comune || null;
}

function terrainComuneLabel(
  terrain: TerrainFeature,
  sourceById: Map<string, ScanResponse["sources"][number]>,
) {
  return (
    sourceComuneLabel(sourceById.get(terrain.closestSourceId)) ??
    PROVINCE_MAP[terrain.provinceId].name
  );
}

function terrainSortLabel(sortMode: TerrainSortMode) {
  switch (sortMode) {
    case "comune-asc":
      return "Comune A-Z";
    case "comune-desc":
      return "Comune Z-A";
    case "area-desc":
      return "Superficie maggiore";
    case "area-asc":
      return "Superficie minore";
    default:
      return "Vicinanza";
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeCdata(value: string) {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

function buildCsv(data: ScanResponse) {
  const rows = [
    [
      "provincia",
      "terreno",
      "classe_terreno",
      "distanza_metri",
      "superficie_mq",
      "fonte",
      "tipo_fonte",
      "lat",
      "lng",
      "provider_terreno",
      "link_mappa",
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
      terrain.providerLabel,
      terrainMapUrl(terrain),
    ]),
  ];

  return rows
    .map((row) =>
      row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","),
    )
    .join("\n");
}

function latestRunHeadline(
  data: ScanResponse | null,
  latestLog?: ScanJobLogEntry,
) {
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
      return "I distributori sono gia acquisiti dal dataset ufficiale MIMIT; il motore sta completando particelle catastali e filtro anti-urbano nel buffer selezionato.";
    }

    return "Il job è ancora vivo sul server. Continuo a leggere i log e a completare i passaggi residui su fonti, particelle catastali e filtro anti-urbano.";
  }

  if (categoryIds.length === 1 && categoryIds[0] === "fuel") {
    return "I distributori arrivano dal dataset ufficiale MIMIT; in questa fase sto verificando particelle catastali e filtro anti-urbano nel buffer selezionato.";
  }

  if (categoryIds.includes("fuel")) {
    return "Le fonti carburante arrivano da MIMIT, mentre le altre categorie e il filtro anti-urbano passano ancora dai provider geospaziali pubblici.";
  }

  if (selectedProvinceCount > 1 || categoryIds.length > 1) {
    return "Con più province o categorie la pipeline può richiedere più tempo.";
  }

  return "Sto cercando fonti e particelle catastali nel buffer selezionato.";
}

function terrainPlacemark(terrain: TerrainFeature) {
  const coordinates = terrain.coordinates
    .filter(
      (coordinate): coordinate is [number, number] =>
        Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]),
    )
    .map(([lng, lat]) => `${lng},${lat},0`);

  if (coordinates.length < 4) {
    return null;
  }

  const description = safeCdata(`
        Provincia: ${PROVINCE_MAP[terrain.provinceId].name}<br/>
        Classe: ${landuseLabel(terrain.landuse)}<br/>
        Distanza: ${Math.round(terrain.distanceMeters)} m<br/>
        Superficie: ${
          terrain.areaSqm ? terrain.areaSqm.toLocaleString("it-IT") : "n.d."
        } m²<br/>
        Fonte: ${terrain.closestSourceName}<br/>
        Provider: ${terrain.providerLabel}
      `.trim());

  return `
    <Placemark>
      <name>${escapeXml(terrain.name)}</name>
      <description><![CDATA[${description}]]></description>
      <Style>
        <LineStyle><color>ff2f5d22</color><width>2</width></LineStyle>
        <PolyStyle><color>6670c16d</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordinates.join(" ")}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
}

async function downloadTerrainKmz(terrains: TerrainFeature[], filename: string) {
  const placemarks = terrains
    .map(terrainPlacemark)
    .filter((placemark): placemark is string => placemark !== null);

  if (placemarks.length === 0) {
    throw new Error("Nessuna geometria valida da esportare in KMZ.");
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml("TerreniReady Export")}</name>
    ${placemarks.join("\n")}
  </Document>
</kml>`;

  // JSZip pesa ~95 KB gzip e serve SOLO per il bottone KMZ che molti utenti
  // non premono. Il dynamic import lo tira giu solo al momento del click
  // tramite un chunk separato, togliendo peso al bundle iniziale.
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("doc.kml", kml);

  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "application/vnd.google-earth.kmz", filename);
}

async function downloadKmz(data: ScanResponse) {
  await downloadTerrainKmz(data.terrains, "terreniready-export.kmz");
}

export default function TerreniDashboard() {
  const [selectedProvinceIds, setSelectedProvinceIds] = useState<ProvinceId[]>([
    "PT",
  ]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<
    SourceCategoryId[]
  >(["fuel", "bodyshop", "repair"]);
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [scanJob, setScanJob] = useState<LiveScanState | null>(null);
  const [activeTerrainId, setActiveTerrainId] = useState<string>();
  const [isTerrainPreviewOpen, setIsTerrainPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [terrainSortMode, setTerrainSortMode] =
    useState<TerrainSortMode>("area-desc");
  const streamRef = useRef<EventSource | null>(null);
  const streamReconnectTimerRef = useRef<number | null>(null);
  const streamReconnectNoticeRef = useRef(false);
  const atlasRef = useRef<HTMLElement | null>(null);
  // Riga "accordion" attiva: la usiamo come ancora per scrollIntoView dopo
  // l'espansione, cosi l'utente vede la scheda completa senza scorrere.
  const activeAccordionRef = useRef<HTMLTableRowElement | null>(null);

  // --- Derivati memoizzati ---------------------------------------------
  // Il ledger dei terreni viene ri-ordinato ad ogni setState (loading,
  // latest log, sort mode). Senza useMemo paghiamo un O(n log n) + la
  // rigenerazione della Map fonti ogni render anche quando scanData non
  // cambia. Blocchiamo queste computazioni dietro le dipendenze reali.

  const sourceById = useMemo(() => {
    const map = new Map<string, ScanResponse["sources"][number]>();
    for (const source of scanData?.sources ?? []) {
      map.set(source.id, source);
    }
    return map;
  }, [scanData?.sources]);

  const activeTerrain = useMemo(
    () =>
      activeTerrainId
        ? scanData?.terrains.find((terrain) => terrain.id === activeTerrainId)
        : undefined,
    [scanData?.terrains, activeTerrainId],
  );

  const activeSource = useMemo(
    () =>
      activeTerrain ? sourceById.get(activeTerrain.closestSourceId) : undefined,
    [activeTerrain, sourceById],
  );

  const sortedTerrains = useMemo(() => {
    const list = scanData?.terrains ?? [];

    if (list.length === 0) {
      return list;
    }

    const comparator = (left: TerrainFeature, right: TerrainFeature) => {
      switch (terrainSortMode) {
        case "comune-asc":
          return terrainComuneLabel(left, sourceById).localeCompare(
            terrainComuneLabel(right, sourceById),
            "it",
          );
        case "comune-desc":
          return terrainComuneLabel(right, sourceById).localeCompare(
            terrainComuneLabel(left, sourceById),
            "it",
          );
        case "area-desc":
          return (right.areaSqm ?? 0) - (left.areaSqm ?? 0);
        case "area-asc":
          return (left.areaSqm ?? 0) - (right.areaSqm ?? 0);
        default:
          return left.distanceMeters - right.distanceMeters;
      }
    };

    return [...list].sort(comparator);
  }, [scanData?.terrains, terrainSortMode, sourceById]);

  const selectedProvinceNames = useMemo(
    () => selectedProvinceIds.map((provinceId) => PROVINCE_MAP[provinceId].name),
    [selectedProvinceIds],
  );

  const selectedCategoryLabels = useMemo(
    () =>
      selectedCategoryIds.map(
        (categoryId) => SOURCE_CATEGORY_MAP[categoryId].label,
      ),
    [selectedCategoryIds],
  );

  const selectedProvinceSummary =
    selectedProvinceNames.length > 0
      ? selectedProvinceNames.join(" · ")
      : "Nessuna provincia selezionata";

  const selectedCategorySummary =
    selectedCategoryLabels.length > 0
      ? selectedCategoryLabels.join(" · ")
      : "Nessuna categoria selezionata";

  const latestLog = scanJob?.logs.at(-1);
  const latestHeadline = latestRunHeadline(scanData, latestLog);
  const warningCount = scanData?.meta.warnings.length ?? 0;
  const noteCount = scanData?.meta.notes?.length ?? 0;
  const isLongRunningScan =
    loading && loadingSeconds >= LONG_SCAN_THRESHOLD_SECONDS;

  // --- Effect timer / cleanup ------------------------------------------
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
    if (!isTerrainPreviewOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsTerrainPreviewOpen(false);
      }
    };

    document.body.classList.add("overflow-hidden");
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.classList.remove("overflow-hidden");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTerrainPreviewOpen]);

  // --- Handlers --------------------------------------------------------
  // useCallback stabilizza le reference passate a TerrainMap (memoized),
  // ai bottoni export e al select di ordinamento: qualsiasi cambiamento
  // di stato smette cosi di invalidare i sottocomponenti pesanti.

  const clearStreamReconnectWatchdog = useCallback(() => {
    if (streamReconnectTimerRef.current) {
      window.clearTimeout(streamReconnectTimerRef.current);
      streamReconnectTimerRef.current = null;
    }

    streamReconnectNoticeRef.current = false;
  }, []);

  const focusActiveTerrainOnAtlas = useCallback(() => {
    atlasRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  // Click su una riga del ledger = toggle dell'accordion.
  // - Stessa riga cliccata di nuovo -> chiude la scheda (activeTerrainId
  //   torna undefined).
  // - Nuova riga -> diventa attiva, la scheda scheda si apre sotto.
  // Dopo il toggle aspettiamo un animation frame (React deve montare la
  // riga accordion nel DOM) e poi scrolliamo la riga attiva in vista:
  // `block: "nearest"` evita salti bruschi se la riga e` gia visibile,
  // scrollando solo quando serve. Rispetta prefers-reduced-motion.
  const selectAndRevealTerrain = useCallback((terrainId: string) => {
    let willBeActive = false;

    setActiveTerrainId((current) => {
      if (current === terrainId) {
        willBeActive = false;
        return undefined;
      }
      willBeActive = true;
      return terrainId;
    });

    if (typeof window === "undefined" || !willBeActive) {
      return;
    }

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const behavior: ScrollBehavior = prefersReducedMotion ? "auto" : "smooth";

    window.requestAnimationFrame(() => {
      activeAccordionRef.current?.scrollIntoView({
        behavior,
        block: "nearest",
        inline: "nearest",
      });
    });
  }, []);

  const handleToggleProvince = useCallback((provinceId: ProvinceId) => {
    setSelectedProvinceIds((current) => toggleItem(current, provinceId));
  }, []);

  const handleToggleCategory = useCallback((categoryId: SourceCategoryId) => {
    setSelectedCategoryIds((current) => toggleItem(current, categoryId));
  }, []);

  const handleExportCsv = useCallback(() => {
    if (!scanData) {
      return;
    }

    downloadBlob(
      `\ufeff${buildCsv(scanData)}`,
      "text/csv;charset=utf-8",
      "terreniready-export.csv",
    );
  }, [scanData]);

  const handleExportKmz = useCallback(() => {
    if (!scanData || scanData.terrains.length === 0) {
      return;
    }

    void downloadKmz(scanData).catch((downloadError) => {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Export KMZ non riuscito. Riprova tra pochi secondi.",
      );
    });
  }, [scanData]);

  const runScan = useCallback(() => {
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

    // Un "partial-result" arriva quando una provincia termina: pushiamo
    // subito sorgenti e terreni correnti per rendere la mappa reattiva
    // senza attendere la chiusura dell'intero job.
    const applyResult = (
      result: ScanResponse,
      options: { final: boolean },
    ) => {
      setScanData(result);
      setActiveTerrainId((current) => {
        if (current && result.terrains.some((terrain) => terrain.id === current)) {
          return current;
        }
        return result.terrains[0]?.id;
      });

      if (!options.final) {
        return;
      }

      setLoading(false);
      setLoadingSeconds(0);
      setScanJob((current) => ({
        status: "completed",
        error: null,
        logs: current?.logs ?? [],
      }));
    };

    eventSource.addEventListener("partial-result", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      if (!payload || payload.type !== "partial-result") {
        return;
      }

      applyResult(payload.result, { final: false });
    });

    eventSource.addEventListener("result", (event) => {
      const payload = parseStreamPayload<ScanStreamEvent>(
        (event as MessageEvent<string>).data,
      );

      if (!payload || payload.type !== "result") {
        return;
      }

      applyResult(payload.result, { final: true });
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
  }, [clearStreamReconnectWatchdog, selectedCategoryIds, selectedProvinceIds]);

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
                  <h1 className="terrain-display-title max-w-5xl text-[clamp(2.85rem,5vw,5.35rem)] text-[#f6f2e8]">
                    Un atlante operativo per leggere territorio, particelle e
                    prossimità emissiva come un unico dossier.
                  </h1>
                  <p className="terrain-copy-lg mt-5 max-w-3xl text-[#dce6d7]">
                    Ho ricostruito il SaaS intorno alla filosofia già presente nel
                    prodotto: cartografia, agricoltura, catasto e analisi fondiaria.
                    Il risultato è una control room più netta, più editoriale e più
                    coerente in tutte le sue superfici.
                  </p>
                </div>
                <div className="terrain-hero-panel p-5">
                  <div className="terrain-keyline terrain-keyline-dark">Workflow</div>
                  <div className="mt-4 space-y-3 text-sm leading-6 text-[#e5eee0]">
                    <p>1. Selezione geografica delle province target.</p>
                    <p>2. Ingest di fonti da dataset ufficiali e provider geospaziali.</p>
                    <p>3. Matching spaziale di particelle catastali e filtri anti-urbani.</p>
                    <p>4. Lettura in mappa, tabella ed export del dossier.</p>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <span className="terrain-chip terrain-chip-dark">
                  MIMIT + catasto ufficiale
                </span>
                <span className="terrain-chip terrain-chip-dark">
                  Overlay catastale WMS ufficiale
                </span>
                <span className="terrain-chip terrain-chip-dark">
                  Raggio operativo 350 m
                </span>
                <span className="terrain-chip terrain-chip-dark">Export CSV + KMZ</span>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="terrain-hero-panel terrain-hero-panel-dark p-5">
                <div className="terrain-keyline terrain-keyline-dark">
                  Filosofia del tema
                </div>
                <h2 className="terrain-panel-title mt-4 text-2xl text-white">
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
                <HeroKpi
                  label="Province live"
                  value={selectedProvinceIds.length.toString()}
                />
                <HeroKpi
                  label="Fonti monitorate"
                  value={selectedCategoryIds.length.toString()}
                />
                <HeroKpi
                  label="Stato scan"
                  valueNode={
                    loading
                      ? `In corso da ${loadingSeconds}s`
                      : scanJob?.status === "completed"
                        ? "Ultima scansione completata"
                        : scanJob?.status === "failed"
                          ? "Ultima scansione fallita"
                          : "Pronto al lancio"
                  }
                />
                <HeroKpi
                  label="Ultimo log"
                  valueNode={
                    latestLog?.message ?? "Nessuna esecuzione ancora registrata"
                  }
                />
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
                  <h2 className="terrain-section-title mt-3 text-[2rem] text-[var(--foreground)]">
                    Radar territoriale
                  </h2>
                  <p className="mt-3 max-w-md text-sm leading-6 text-[var(--muted)]">
                    Qui si imposta il perimetro operativo del dossier: provincia,
                    tipologia emissiva e azioni di scansione o export.
                  </p>
                </div>
                <div className="terrain-choice-card px-4 py-3 text-right">
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
                      <h3 className="terrain-panel-title mt-2 text-lg text-[var(--foreground)]">
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
                          onClick={() => handleToggleProvince(province.id)}
                          className={`rounded-[22px] border px-4 py-3 text-left transition ${
                            checked
                              ? "terrain-choice-card-active text-white"
                              : "terrain-choice-card text-[var(--foreground)]"
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
                      <h3 className="terrain-panel-title mt-2 text-lg text-[var(--foreground)]">
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
                          onClick={() => handleToggleCategory(category.id)}
                          className={`w-full rounded-[24px] border p-4 text-left transition ${
                            checked
                              ? "terrain-choice-card-active text-white"
                              : "terrain-choice-card"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <span
                              className="mt-1 h-3.5 w-3.5 rounded-full ring-4 ring-white/60"
                              style={{ backgroundColor: category.color }}
                            />
                            <div>
                              <div
                                className={`font-semibold ${
                                  checked
                                    ? "text-white"
                                    : "text-[var(--foreground)]"
                                }`}
                              >
                                {category.label}
                              </div>
                              <p
                                className={`mt-1 text-xs leading-5 ${
                                  checked ? "text-[#d8e3d4]" : "text-[var(--muted)]"
                                }`}
                              >
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
              <div className="terrain-keyline terrain-keyline-dark">Scan engine</div>
              <h2 className="terrain-section-title mt-3 text-[1.85rem] text-white">
                Lancia la ricognizione
              </h2>
              <p className="mt-3 text-sm leading-6 text-[#cfdbcb]">
                La scansione interroga le fonti pubbliche, costruisce il buffer
                spaziale e rientra con il set delle particelle catastali rilevate.
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
                  onClick={handleExportCsv}
                  disabled={!scanData || scanData.terrains.length === 0}
                  className="terrain-button-secondary terrain-button-secondary-dark"
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handleExportKmz}
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
                    <h2 className="terrain-section-title mt-3 text-[1.8rem] text-[var(--foreground)]">
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
                      <div
                        key={`${entry.timestamp}-${entry.message}`}
                        className="relative"
                      >
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
              <h2 className="terrain-section-title mt-3 text-[1.6rem] text-[var(--foreground)]">
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
              <StatCard
                title="Fonti intercettate"
                value={scanData?.meta.totalSources ?? 0}
                caption="POI emissivi rilevati nelle province correnti."
              />
              <StatCard
                title="Terreni candidati"
                value={scanData?.meta.totalTerrains ?? 0}
                caption="Particelle catastali agganciate alla fonte più vicina."
                suffix=""
              />
              <StatCard
                title="Raggio operativo"
                value={scanData?.meta.radiusMeters ?? 350}
                caption="Buffer costante per il matching territoriale."
                suffix="m"
              />
              <StatCard
                title="Avvisi tecnici"
                value={warningCount}
                caption="Segnalazioni tecniche su query o copertura dati."
              />
            </div>

            {scanData?.meta.warnings.map((warning) => (
              <div
                key={warning}
                className="terrain-shell terrain-warning-banner px-5 py-4 text-sm leading-6"
              >
                {warning}
              </div>
            ))}

            {(scanData?.meta.notes ?? []).map((note) => (
              <div
                key={note}
                className="terrain-shell terrain-note-banner px-5 py-4 text-sm leading-6"
              >
                {note}
              </div>
            ))}

            <section ref={atlasRef} className="terrain-shell p-3 sm:p-4">
              <div className="terrain-choice-card p-4 sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div className="max-w-2xl">
                    <div className="terrain-keyline">Atlante operativo</div>
                    <h2 className="terrain-section-title mt-3 text-[2.25rem] text-[var(--foreground)]">
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
                            <span
                              key={provinceName}
                              className="terrain-inline-pill"
                            >
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
                            <span
                              key={categoryLabel}
                              className="terrain-inline-pill"
                            >
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
                    onSelectTerrainId={selectAndRevealTerrain}
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
                {noteCount > 0 ? (
                  <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
                    {noteCount} note operative disponibili per cache o provider.
                  </p>
                ) : null}
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

        <section className="terrain-shell p-5 lg:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="terrain-keyline">Registro operativo</div>
              <h2 className="terrain-section-title mt-3 text-[2.1rem] text-[var(--foreground)]">
                Ledger dei terreni
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
                Ogni riga è una particella catastale con la sua fonte emissiva più
                vicina. Clicca una riga per espandere la scheda dettagli inline;
                cliccala di nuovo per chiuderla.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[220px] flex-col gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--muted)]">
                  Ordina per
                </span>
                <select
                  value={terrainSortMode}
                  onChange={(event) =>
                    setTerrainSortMode(event.target.value as TerrainSortMode)
                  }
                  className="terrain-select px-4 py-3 text-sm font-medium text-[var(--foreground)] outline-none transition focus:border-[rgba(44,66,49,0.28)]"
                >
                  <option value="distance-asc">Distanza crescente</option>
                  <option value="comune-asc">Comune A-Z</option>
                  <option value="comune-desc">Comune Z-A</option>
                  <option value="area-desc">Superficie decrescente</option>
                  <option value="area-asc">Superficie crescente</option>
                </select>
              </label>
              <span className="terrain-chip">{selectedProvinceSummary}</span>
              <span className="terrain-chip">{selectedCategorySummary}</span>
              <span className="terrain-chip">
                {terrainSortLabel(terrainSortMode)}
              </span>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="terrain-ledger-table min-w-full">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
                  <th className="px-4 pb-1">Terreno</th>
                  <th className="px-4 pb-1">Comune</th>
                  <th className="px-4 pb-1">Provincia</th>
                  <th className="px-4 pb-1">Uso</th>
                  <th className="px-4 pb-1">Distanza</th>
                  <th className="px-4 pb-1">Superficie</th>
                  <th className="px-4 pb-1">Fonte vicina</th>
                </tr>
              </thead>
              <tbody>
                {sortedTerrains.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.55)] px-5 py-8 text-center text-sm leading-6 text-[var(--muted)]"
                    >
                      Nessun terreno ancora presente. Avvia una scansione per
                      riempire il ledger operativo.
                    </td>
                  </tr>
                ) : (
                  // Ogni riga puo' espandere il proprio accordion inline.
                  // Il Fragment tiene la coppia row+accordion unita nel DOM
                  // della tbody mantenendo la semantica del ledger.
                  sortedTerrains.map((terrain) => {
                    const isActive = terrain.id === activeTerrainId;
                    return (
                      <Fragment key={terrain.id}>
                        <TerrainRow
                          terrain={terrain}
                          active={isActive}
                          comuneLabel={terrainComuneLabel(terrain, sourceById)}
                          onSelect={selectAndRevealTerrain}
                        />
                        {isActive && activeTerrain ? (
                          <tr ref={activeAccordionRef}>
                            <td colSpan={7} className="px-0 pt-2 pb-4">
                              <TerrainAccordion
                                terrain={activeTerrain}
                                source={activeSource}
                                comuneLabel={terrainComuneLabel(
                                  activeTerrain,
                                  sourceById,
                                )}
                                onSelectTerrainId={setActiveTerrainId}
                                onOpenPolygonPreview={() =>
                                  setIsTerrainPreviewOpen(true)
                                }
                                onClose={() => setActiveTerrainId(undefined)}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {isTerrainPreviewOpen && activeTerrain ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,16,11,0.72)] px-4 py-6 backdrop-blur-sm">
            <div className="terrain-preview-shell relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[32px]">
              <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5 text-white">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[#9eb399]">
                    Anteprima poligono
                  </div>
                  <h3 className="terrain-panel-title mt-2 text-2xl">
                    {activeTerrain.name}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#d4dfd1]">
                    Poligono catastale visualizzato nel SaaS con buffer operativo e
                    particelle WMS ufficiali.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsTerrainPreviewOpen(false)}
                  className="inline-flex rounded-full border border-white/12 bg-white/8 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-white/12"
                >
                  Chiudi
                </button>
              </div>

              <div className="grid gap-5 overflow-y-auto px-6 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="min-h-[58vh] overflow-hidden rounded-[28px] border border-white/10 bg-[#0e1711]">
                  <TerrainMap
                    selectedProvinceIds={[activeTerrain.provinceId]}
                    sources={activeSource ? [activeSource] : []}
                    terrains={[activeTerrain]}
                    activeTerrainId={activeTerrain.id}
                    onSelectTerrainId={setActiveTerrainId}
                  />
                </div>

                <div className="space-y-4 text-sm leading-6 text-[#dce7d9]">
                  <div className="terrain-dossier-card terrain-dossier-card-soft p-5">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Sintesi rapida
                    </div>
                    <div className="mt-3 space-y-2">
                      <p>
                        <span className="text-[#9eb399]">Uso:</span>{" "}
                        {landuseLabel(activeTerrain.landuse)}
                      </p>
                      <p>
                        <span className="text-[#9eb399]">Distanza:</span>{" "}
                        {formatMeters(activeTerrain.distanceMeters)}
                      </p>
                      <p>
                        <span className="text-[#9eb399]">Superficie:</span>{" "}
                        {formatSqm(activeTerrain.areaSqm)}
                      </p>
                      <p>
                        <span className="text-[#9eb399]">Comune:</span>{" "}
                        {terrainComuneLabel(activeTerrain, sourceById)}
                      </p>
                    </div>
                  </div>

                  <div className="terrain-dossier-card terrain-dossier-card-soft p-5">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Fonte associata
                    </div>
                    <div className="mt-3 text-base font-semibold text-white">
                      {activeTerrain.closestSourceName}
                    </div>
                    <p className="mt-1 text-sm text-[#d4dfd1]">
                      {
                        SOURCE_CATEGORY_MAP[activeTerrain.closestSourceCategoryId]
                          .label
                      }
                    </p>
                    <p className="mt-2 text-xs text-[#a9bda5]">
                      Provider terreno: {activeTerrain.providerLabel}
                    </p>
                  </div>

                  <div className="terrain-dossier-card p-5">
                    <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
                      Azioni
                    </div>
                    <div className="mt-3 flex flex-col gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setIsTerrainPreviewOpen(false);
                          focusActiveTerrainOnAtlas();
                        }}
                        className="inline-flex justify-center rounded-full border border-[rgba(243,227,142,0.28)] bg-[rgba(243,227,142,0.12)] px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#f3e38e] transition hover:bg-[rgba(243,227,142,0.18)]"
                      >
                        Vai alla mappa principale
                      </button>
                      <a
                        href={terrainMapUrl(activeTerrain)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex justify-center rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-white/10"
                      >
                        Apri centroide in Google Maps
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Sub-components memoizzati ----------------------------------------
// Estrarre le celle ripetute (KPI hero, stat card, row del ledger) evita
// rerender inutili quando cambiano loading/log: React si ferma al livello
// della cella se le prop sono invariate (shallow compare via React.memo).

function HeroKpi({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="terrain-hero-kpi p-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9ab096]">
        {label}
      </div>
      <div className="mt-3 text-sm font-medium leading-6 text-[#edf2e7]">
        {valueNode ?? (
          <span className="text-3xl font-semibold tracking-[-0.05em] text-white">
            {value}
          </span>
        )}
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  caption,
  suffix,
}: {
  title: string;
  value: number;
  caption: string;
  suffix?: string;
}) {
  return (
    <div className="terrain-stat-card">
      <div className="terrain-keyline">{title}</div>
      <div className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[var(--foreground)]">
        {value}
        {suffix ?? ""}
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{caption}</p>
    </div>
  );
}

function DossierCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="terrain-dossier-card terrain-dossier-card-soft p-4">
      <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
        {label}
      </div>
      <div className="mt-2 font-semibold text-white">{value}</div>
    </div>
  );
}

type TerrainRowProps = {
  terrain: TerrainFeature;
  active: boolean;
  comuneLabel: string;
  onSelect: (terrainId: string) => void;
};

// Il ledger puo avere fino a 250 righe: senza memo ogni click sul sort
// re-renderizza tutte. Con memo confrontiamo solo terrain/active/comune.
const TerrainRow = memo(function TerrainRow({
  terrain,
  active,
  comuneLabel,
  onSelect,
}: TerrainRowProps) {
  return (
    <tr
      onClick={() => onSelect(terrain.id)}
      className={`cursor-pointer rounded-[24px] transition ${
        active
          ? "bg-[linear-gradient(135deg,#18281c,#2d4330)] text-white shadow-[0_18px_40px_rgba(22,31,23,0.18)]"
          : "bg-[rgba(255,255,255,0.56)] text-[var(--foreground)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] hover:bg-[rgba(255,255,255,0.78)]"
      }`}
    >
      <td className="rounded-l-[24px] px-4 py-4 font-semibold">{terrain.name}</td>
      <td className="px-4 py-4">{comuneLabel}</td>
      <td className="px-4 py-4">{PROVINCE_MAP[terrain.provinceId].name}</td>
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
      <td className="px-4 py-4">{formatMeters(terrain.distanceMeters)}</td>
      <td className="px-4 py-4">{formatSqm(terrain.areaSqm)}</td>
      <td className="rounded-r-[24px] px-4 py-4">
        <div>{terrain.closestSourceName}</div>
        <div
          className={`mt-1 text-xs ${
            active ? "text-[#c7d6c5]" : "text-[var(--muted)]"
          }`}
        >
          {SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId].label}
        </div>
      </td>
    </tr>
  );
});

// --- Accordion inline --------------------------------------------------
// Riga "detail" che si espande sotto la riga ledger attiva. Occupa tutta
// la larghezza della tabella (colSpan=7) e porta dentro:
// - la mappa centrata sul poligono (layer Satellite + catasto WMS)
// - 4 KPI di sintesi
// - la card fonte emissiva piu vicina
// - gli step successivi operativi
// - i CTA fullscreen e Google Maps
// Tutto dentro una sola "finestra" senza piu navigare tra pannelli.

type TerrainAccordionProps = {
  terrain: TerrainFeature;
  source: SourceFeature | undefined;
  comuneLabel: string;
  onSelectTerrainId: (terrainId: string) => void;
  onOpenPolygonPreview: () => void;
  onClose: () => void;
};

function TerrainAccordion({
  terrain,
  source,
  comuneLabel,
  onSelectTerrainId,
  onOpenPolygonPreview,
  onClose,
}: TerrainAccordionProps) {
  const category = SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId];
  // Memo: la mappa e` dynamic-imported con ssr:false, quindi il rimount
  // tra accordion diversi e` rapido; evitiamo comunque di ricreare gli
  // array prop ad ogni render del parent (i re-render altrimenti
  // invalidano il memo di <TerrainPolygon> / <SourceCircle>).
  const mapTerrains = useMemo(() => [terrain], [terrain]);
  const mapSources = useMemo(() => (source ? [source] : []), [source]);
  const mapProvinces = useMemo(
    () => [terrain.provinceId] as ProvinceId[],
    [terrain.provinceId],
  );

  return (
    <div className="terrain-accordion-panel relative rounded-[28px] border border-[rgba(27,43,30,0.12)] bg-[linear-gradient(180deg,#0f1b14,#1a2c1f)] p-5 text-[#e4ece0] shadow-[0_20px_60px_rgba(11,20,13,0.28)] lg:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#98ae96]">
            Scheda terreno
          </div>
          <h3 className="mt-2 text-2xl font-semibold leading-tight text-white">
            {terrain.name}
          </h3>
          <p className="mt-1 text-sm text-[#c5d4c3]">
            {comuneLabel} · {PROVINCE_MAP[terrain.provinceId].name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi scheda"
          className="self-start rounded-full border border-white/12 bg-white/6 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-white transition hover:bg-white/12"
        >
          Chiudi
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DossierCell label="Uso" value={landuseLabel(terrain.landuse)} />
        <DossierCell label="Distanza" value={formatMeters(terrain.distanceMeters)} />
        <DossierCell label="Superficie" value={formatSqm(terrain.areaSqm)} />
        <DossierCell
          label="Fonti in buffer"
          value={terrain.sourceCountInRange.toString()}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Mappa embedded: un solo terreno + la sua fonte, centrata
            automaticamente dal FitToContent di TerrainMap. L'altezza fissa
            evita layout shift quando i chunk leaflet finiscono di montare. */}
        <div className="terrain-accordion-map overflow-hidden rounded-[24px] border border-white/10 bg-[#0e1711]">
          <TerrainMap
            selectedProvinceIds={mapProvinces}
            sources={mapSources}
            terrains={mapTerrains}
            activeTerrainId={terrain.id}
            onSelectTerrainId={onSelectTerrainId}
          />
        </div>

        <div className="space-y-3">
          <div className="terrain-dossier-card p-5">
            <div className="text-[11px] uppercase tracking-[0.2em] text-[#98ae96]">
              Fonte più vicina
            </div>
            <div className="mt-2 text-lg font-semibold text-white">
              {terrain.closestSourceName}
            </div>
            <div className="mt-1 text-sm text-[#c5d4c3]">{category.label}</div>
            <div className="mt-3 text-xs uppercase tracking-[0.18em] text-[#98ae96]">
              Coordinate centroide
            </div>
            <div className="mt-1 font-mono text-sm leading-6 text-[#edf3e9]">
              {terrain.center.lat.toFixed(6)}, {terrain.center.lng.toFixed(6)}
            </div>
            <div className="mt-2 text-xs leading-5 text-[#b7c7b4]">
              Provider: {terrain.providerLabel}
            </div>
          </div>

          <div className="terrain-dossier-card bg-[#111b14] p-5">
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
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onOpenPolygonPreview}
          className="inline-flex rounded-full border border-[rgba(243,227,142,0.28)] bg-[rgba(243,227,142,0.12)] px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-[#f3e38e] transition hover:bg-[rgba(243,227,142,0.18)]"
        >
          Apri mappa a tutto schermo
        </button>
        <a
          href={terrainMapUrl(terrain)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] text-white transition hover:bg-white/10"
        >
          Apri in Google Maps
        </a>
      </div>
    </div>
  );
}
