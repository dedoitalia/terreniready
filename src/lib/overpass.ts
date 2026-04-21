import {
  booleanPointInPolygon,
  distance,
  lineIntersect,
  lineString,
  point,
  polygon,
} from "@turf/turf";

import { fetchAiaSourcesFromArpat } from "@/lib/aia-arpat";
import { fetchCadastralTerrainsNearSources } from "@/lib/cadastral-wfs";
import { PROVINCE_MAP } from "@/lib/province-data";
import { fetchFuelSourcesFromMimit } from "@/lib/mimit-fuel";
import {
  SOURCE_CATEGORIES,
  SOURCE_CATEGORY_MAP,
} from "@/lib/source-types";
import type {
  BoundingBox,
  ProvinceId,
  ScanProgressEvent,
  ScanResponse,
  SourceCategoryId,
  SourceFeature,
  TerrainFeature,
} from "@/types/scan";

const OVERPASS_ENDPOINTS = [
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const SEARCH_RADIUS_METERS = 350;
const MAX_TERRAINS = 250;
// Cap duro pre-filtro: su provincia grande (Firenze, Siena) il WFS catastale
// puo restituire >1000 particelle candidate. Filtrarle tutte con query
// Overpass e operazioni Turf costa minuti. Prendiamo solo le piu vicine alla
// fonte e lasciamo che il filtro anti-urbano lavori su un set ridotto.
//
// Tunabile via env TERRENI_MAX_PRE_FILTER senza rebuild (Render free usa le
// env vars del servizio).
const MAX_TERRAINS_PRE_FILTER = parsePositiveIntegerEnv(
  "TERRENI_MAX_PRE_FILTER",
  140,
);
const TERRAIN_FILTER_BATCH_SIZE = 120;
const OVERPASS_CACHE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_ENDPOINT_COOLDOWN_MS = 90 * 1000;
const ENDPOINT_RETRY_DELAY_MS = 450;
const OVERPASS_REQUEST_TIMEOUT_MS = 12 * 1000;
// Timeout del filtro anti-urbano: se Overpass non risponde entro questo
// budget rinunciamo a filtrare quel batch e lasciamo passare le
// particelle con un warning. Meglio risultati imperfetti in pochi
// secondi che pipeline bloccata per un provider lento.
//
// Default 20s: su zone dense (Pistoia, Firenze) una query Overpass che
// raccoglie building + urbano + strade su 6 ancore con 350m di buffer
// richiede spesso 10-15s. 20s da` headroom. Tunabile via env
// TERRENI_OBSTACLE_FILTER_SOFT_TIMEOUT_MS.
const OBSTACLE_FILTER_SOFT_TIMEOUT_MS = parsePositiveIntegerEnv(
  "TERRENI_OBSTACLE_FILTER_SOFT_TIMEOUT_MS",
  20 * 1000,
);
const OVERPASS_MAX_CYCLES = 2;
const OVERPASS_CYCLE_BACKOFF_MS = 3_500;
const SCAN_RESULT_CACHE_TTL_MS = 45 * 60 * 1000;
const TERRAIN_OBSTACLE_MARGIN_METERS = 25;
const TERRAIN_OBSTACLE_MIN_RADIUS_METERS = 45;
// Radius di clustering delle ancore: piu grande = meno ancore, quindi
// meno chunk Overpass. A 240m riduciamo i blocchi da 10 a ~4-5 su
// Pistoia (tipico), tagliando il wall-clock del filtro anti-urbano
// praticamente della meta`. Il prezzo e` query piu grosse (piu around),
// ma Overpass regge bene 350m×6 ancore per query.
const TERRAIN_OBSTACLE_CLUSTER_RADIUS_METERS = 240;
const OBSTACLE_ANCHORS_PER_CHUNK = 6;
const OBSTACLE_CHUNK_SPLIT_DEPTH = 2;
// Concurrency knob per la pipeline:
// - province: 2 province lavorano in parallelo, riducendo il wall-clock
//   di scan multi-provincia praticamente della meta`. Overpass ha 4
//   endpoint, quindi 2 province parallele non saturano la pool.
// - obstacle chunks: dentro una provincia i chunk Overpass per il filtro
//   urbano girano in parallelo a coppie. Combinato con il limite
//   provincie resta comunque sotto ~4 richieste Overpass concorrenti.
// Tunabili da env per aggiustare senza rebuild (Render free).
const PROVINCE_CONCURRENCY = parsePositiveIntegerEnv(
  "TERRENI_PROVINCE_CONCURRENCY",
  2,
);
const OBSTACLE_CHUNK_CONCURRENCY = parsePositiveIntegerEnv(
  "TERRENI_OBSTACLE_CONCURRENCY",
  2,
);

const EXCLUDED_URBAN_LANDUSES = new Set(["residential", "industrial", "commercial"]);
const ROAD_SELECTORS = [
  { key: "highway", value: "motorway" },
  { key: "highway", value: "trunk" },
  { key: "highway", value: "primary" },
  { key: "highway", value: "secondary" },
  { key: "highway", value: "tertiary" },
  { key: "highway", value: "unclassified" },
  { key: "highway", value: "residential" },
  { key: "highway", value: "living_street" },
  { key: "highway", value: "service" },
] as const;
const URBAN_AREA_SELECTORS = [
  { key: "landuse", value: "residential" },
  { key: "landuse", value: "industrial" },
  { key: "landuse", value: "commercial" },
] as const;
const MAJOR_ROAD_VALUES = new Set(["motorway", "trunk", "primary", "secondary"]);

type OverpassElement = {
  type: "node" | "way";
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  geometry?: Array<{
    lat: number;
    lon: number;
  }>;
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements: OverpassElement[];
};

type CoordinateRing = Array<[number, number]>;

type CoordinateBounds = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

type CachedOverpassValue = {
  expiresAt: number;
  value: OverpassResponse;
};

type CachedScanResult = {
  expiresAt: number;
  value: ScanResponse;
};

type ProgressReporter = (event: ScanProgressEvent) => void;

type PartialResultReporter = (result: ScanResponse) => void;

type RunScanOptions = {
  reportProgress?: ProgressReporter;
  // Invocata dopo il completamento di ogni provincia con uno snapshot
  // "cumulativo" delle province gia processate. Permette allo streaming
  // SSE di spingere risultati parziali al client senza attendere che
  // anche l'ultima provincia esca dal filtro anti-urbano.
  reportPartialResult?: PartialResultReporter;
  // AbortSignal esterno: il chiamante (rotta SSE, cron, job handler) lo
  // inoltra perche', quando il client chiude la connessione o l'utente
  // clicca "Annulla", i worker di scansione si fermino prima di lanciare
  // altro lavoro. Le richieste Overpass/WFS gia in volo scadono per il
  // loro timeout interno, ma non partono nuove province ne nuovi chunk.
  signal?: AbortSignal;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException(
          typeof signal.reason === "string"
            ? signal.reason
            : "Scansione annullata dal client.",
          "AbortError",
        );
  }
}

type PreparedPolygonObstacle = {
  id: string;
  ring: CoordinateRing;
  bounds: CoordinateBounds;
  feature: ReturnType<typeof polygon>;
  tags: Record<string, string>;
};

type PreparedLineObstacle = {
  id: string;
  coords: CoordinateRing;
  bounds: CoordinateBounds;
  feature: ReturnType<typeof lineString>;
  tags: Record<string, string>;
};

type TerrainObstacleLookup = {
  buildings: PreparedPolygonObstacle[];
  urbanAreas: PreparedPolygonObstacle[];
  roads: PreparedLineObstacle[];
  warning: string | null;
};

type TerrainFilterStats = {
  rejectedByTags: number;
  rejectedByBuildings: number;
  rejectedByUrbanAreas: number;
  rejectedByRoads: number;
};

type TerrainObstacleAnchor = {
  id: string;
  lat: number;
  lng: number;
  probeRadiusMeters: number;
  terrainIds: string[];
};

class OverpassRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassRateLimitError";
  }
}

function parsePositiveIntegerEnv(key: string, fallback: number) {
  const raw = process.env[key];

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

const overpassCache = getGlobalStore<Map<string, CachedOverpassValue>>(
  "__terreniReadyOverpassCache",
  () => new Map(),
);
const overpassInflight = getGlobalStore<Map<string, Promise<OverpassResponse>>>(
  "__terreniReadyOverpassInflight",
  () => new Map(),
);
const endpointCooldowns = getGlobalStore<Map<string, number>>(
  "__terreniReadyOverpassEndpointCooldowns",
  () => new Map(),
);
const scanResultCache = getGlobalStore<Map<string, CachedScanResult>>(
  "__terreniReadyScanResultCache",
  () => new Map(),
);
const scanInflight = getGlobalStore<Map<string, Promise<ScanResponse>>>(
  "__terreniReadyScanInflight",
  () => new Map(),
);

function getGlobalStore<T>(key: string, init: () => T) {
  const globalScope = globalThis as Record<string, unknown>;
  const existing = globalScope[key];

  if (existing) {
    return existing as T;
  }

  const created = init();
  globalScope[key] = created;
  return created;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Worker-pool helper: lancia al massimo `concurrency` task in parallelo,
// ogni worker tira la prossima task appena finisce la precedente.
// Preserva l'ordine dei risultati (results[i] = tasks[i]()). Perfetto per
// bbox catastali, province, chunk Overpass: indipendenti tra loro, ma
// che vogliamo limitare per non martellare il provider condiviso.
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      // Prima di prendere il task successivo, controlla che non sia stato
      // richiesto l'abort. Questo trasforma una cancellazione SSE (il
      // client ha chiuso l'EventSource) in una terminazione ordinata del
      // pool: i task in volo finiscono normalmente, ma non ne partono
      // altri. Tipicamente riduce il tempo di stuck da minuti a secondi.
      throwIfAborted(signal);
      const index = nextIndex++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  const poolSize = Math.min(Math.max(1, concurrency), tasks.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < poolSize; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function reportProgress(reporter: ProgressReporter | undefined, message: string) {
  reporter?.({ message });
}

// Log strutturato su stderr: Render lo cattura nel suo log stream e
// possiamo filtrarlo con livello=error. Evitiamo di rumoreggiare sui
// flussi normali (reportProgress gia parla al client) e logghiamo solo
// errori di rete/provider o abort fuori dai casi attesi. Include
// context oggetto + nome/messaggio dell'errore ed e robusto a non-Error.
type LogContext = Record<string, unknown>;

function logError(message: string, context: LogContext, error?: unknown): void {
  const serialized =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : error !== undefined
        ? { name: "NonError", message: String(error) }
        : undefined;

  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      scope: "overpass",
      message,
      ...context,
      ...(serialized ? { error: serialized } : {}),
    }),
  );
}

function endpointRole(index: number) {
  return index === 0 ? "primario" : `fallback ${index}`;
}

function activeOverpassCooldownCount() {
  const now = Date.now();
  let activeCount = 0;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const cooldownUntil = endpointCooldowns.get(endpoint) ?? 0;

    if (cooldownUntil > now) {
      activeCount += 1;
    }
  }

  return activeCount;
}

function cloneScanResponse(result: ScanResponse) {
  return structuredClone(result);
}

function buildScanCacheKey(
  provinceIds: ProvinceId[],
  categoryIds: SourceCategoryId[],
) {
  return JSON.stringify({
    provinceIds: [...provinceIds].sort(),
    categoryIds: [...categoryIds].sort(),
  });
}

function isRecoverableOverpassError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    message.includes("rate limit") ||
    message.includes("timed out") ||
    message.includes("no overpass endpoint")
  );
}

function parseRetryAfterMs(headerValue: string | null) {
  if (!headerValue) {
    return DEFAULT_ENDPOINT_COOLDOWN_MS;
  }

  const asSeconds = Number(headerValue);

  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return asSeconds * 1000;
  }

  const retryAt = Date.parse(headerValue);

  if (!Number.isNaN(retryAt)) {
    return Math.max(retryAt - Date.now(), DEFAULT_ENDPOINT_COOLDOWN_MS);
  }

  return DEFAULT_ENDPOINT_COOLDOWN_MS;
}

function selectorMatches(
  tags: Record<string, string>,
  selector: { key: string; value?: string },
) {
  const tagValue = tags[selector.key];

  if (tagValue === undefined) {
    return false;
  }

  if (!selector.value) {
    return true;
  }

  return tagValue === selector.value;
}

function bboxString(bbox: BoundingBox) {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}

function buildAreaSelectorStatements(
  selectors: Array<{ key: string; value?: string }>,
  areaReference: string,
  elementTypes: Array<"node" | "way">,
) {
  return selectors
    .flatMap((selector) =>
      elementTypes.map((elementType) => {
        if (selector.value) {
          return `${elementType}["${selector.key}"="${selector.value}"](${areaReference});`;
        }

        return `${elementType}["${selector.key}"](${areaReference});`;
      }),
    )
    .join("\n");
}

async function fetchOverpass(
  query: string,
  reporter?: ProgressReporter,
  contextLabel?: string,
): Promise<OverpassResponse> {
  const now = Date.now();
  const cached = overpassCache.get(query);

  if (cached && cached.expiresAt > now) {
    reportProgress(reporter, `${contextLabel ?? "Query"}: uso cache locale temporanea.`);
    return cached.value;
  }

  const inflight = overpassInflight.get(query);

  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
    let lastError: Error | null = null;
    let sawRateLimit = false;

    for (let cycle = 0; cycle < OVERPASS_MAX_CYCLES; cycle += 1) {
      let attemptedInCycle = false;

      for (const [index, endpoint] of OVERPASS_ENDPOINTS.entries()) {
        const cooldownUntil = endpointCooldowns.get(endpoint) ?? 0;
        const hostname = new URL(endpoint).hostname;
        const role = endpointRole(index);

        if (cooldownUntil > Date.now()) {
          sawRateLimit = true;
          reportProgress(
            reporter,
            `${contextLabel ?? "Query"}: salto ${hostname} (${role}) per cooldown attivo.`,
          );
          continue;
        }

        attemptedInCycle = true;

        try {
          reportProgress(
            reporter,
            `${contextLabel ?? "Query"}: interrogo ${hostname} (${role}).`,
          );
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
          }, OVERPASS_REQUEST_TIMEOUT_MS);
          let response: Response;

          try {
            response = await fetch(endpoint, {
              method: "POST",
              cache: "no-store",
              signal: controller.signal,
              headers: {
                Accept: "application/json",
                "Content-Type": "text/plain;charset=UTF-8",
                "User-Agent":
                  "TerreniReady/0.1 (+https://terreniready.onrender.com; repo:https://github.com/dedoitalia/terreniready)",
              },
              body: query,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          if (response.status === 429) {
            sawRateLimit = true;
            endpointCooldowns.set(
              endpoint,
              Date.now() + parseRetryAfterMs(response.headers.get("retry-after")),
            );
            lastError = new Error(`${endpoint} responded with 429`);
            reportProgress(
              reporter,
              `${contextLabel ?? "Query"}: ${hostname} (${role}) ha risposto 429, passo al prossimo endpoint.`,
            );
            await delay(ENDPOINT_RETRY_DELAY_MS);
            continue;
          }

          if (!response.ok) {
            lastError = new Error(`${endpoint} responded with ${response.status}`);
            reportProgress(
              reporter,
              `${contextLabel ?? "Query"}: ${hostname} (${role}) ha risposto ${response.status}, provo il prossimo endpoint.`,
            );
            continue;
          }

          const json = (await response.json()) as OverpassResponse;

          if (!Array.isArray(json.elements)) {
            lastError = new Error(`${endpoint} returned an invalid payload`);
            continue;
          }

          overpassCache.set(query, {
            expiresAt: Date.now() + OVERPASS_CACHE_TTL_MS,
            value: json,
          });

          return json;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            endpointCooldowns.set(
              endpoint,
              Date.now() + DEFAULT_ENDPOINT_COOLDOWN_MS,
            );
            lastError = new Error(
              `${endpoint} timed out after ${OVERPASS_REQUEST_TIMEOUT_MS}ms`,
            );
            reportProgress(
              reporter,
              `${contextLabel ?? "Query"}: ${hostname} (${role}) non ha risposto entro ${Math.round(OVERPASS_REQUEST_TIMEOUT_MS / 1000)}s, provo il prossimo endpoint.`,
            );
            continue;
          }

          endpointCooldowns.set(
            endpoint,
            Date.now() + DEFAULT_ENDPOINT_COOLDOWN_MS,
          );
          lastError =
            error instanceof Error ? error : new Error("Unknown Overpass error");
          reportProgress(
            reporter,
            `${contextLabel ?? "Query"}: errore rete su ${hostname} (${role}), provo il prossimo endpoint.`,
          );
        }
      }

      if (cycle < OVERPASS_MAX_CYCLES - 1 && (attemptedInCycle || sawRateLimit)) {
        reportProgress(
          reporter,
          `${contextLabel ?? "Query"}: tutti gli endpoint hanno bisogno di respiro, attendo ${Math.round(OVERPASS_CYCLE_BACKOFF_MS / 1000)}s e riprovo.`,
        );
        await delay(OVERPASS_CYCLE_BACKOFF_MS);
      }
    }

    if (cached?.value) {
      reportProgress(
        reporter,
        `${contextLabel ?? "Query"}: tutti gli endpoint sono sotto pressione, riuso il dato cache precedente.`,
      );
      return cached.value;
    }

    if (sawRateLimit) {
      throw new OverpassRateLimitError(
        "Overpass è temporaneamente in rate limit. Aspetta circa 1-2 minuti e riprova.",
      );
    }

    throw lastError ?? new Error("No Overpass endpoint available");
  })();

  overpassInflight.set(query, requestPromise);

  try {
    return await requestPromise;
  } finally {
    overpassInflight.delete(query);
  }
}

function sourceCoordinates(element: OverpassElement) {
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lng: element.lon };
  }

  if (element.center) {
    return { lat: element.center.lat, lng: element.center.lon };
  }

  if (element.geometry?.[0]) {
    return { lat: element.geometry[0].lat, lng: element.geometry[0].lon };
  }

  return null;
}

function ringFromGeometry(geometry: OverpassElement["geometry"]) {
  const coords = coordinatesFromGeometry(geometry);

  if (!coords || coords.length < 3) {
    return null;
  }

  const ring = [...coords];
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push(first);
  }

  if (ring.length < 4) {
    return null;
  }

  return ring;
}

function coordinatesFromGeometry(geometry: OverpassElement["geometry"]) {
  if (!geometry || geometry.length < 2) {
    return null;
  }

  return geometry.map((vertex) => [vertex.lon, vertex.lat] as [number, number]);
}

function boundsFromCoordinates(coords: CoordinateRing): CoordinateBounds {
  const lats = coords.map((coordinate) => coordinate[1]);
  const lngs = coords.map((coordinate) => coordinate[0]);

  return {
    minLat: Math.min(...lats),
    minLng: Math.min(...lngs),
    maxLat: Math.max(...lats),
    maxLng: Math.max(...lngs),
  };
}

function boundsOverlap(left: CoordinateBounds, right: CoordinateBounds) {
  return !(
    left.maxLat < right.minLat ||
    left.minLat > right.maxLat ||
    left.maxLng < right.minLng ||
    left.minLng > right.maxLng
  );
}

function isTerrainHardExcluded(tags: Record<string, string>) {
  const landuse = tags.landuse?.trim().toLowerCase();

  return Boolean(tags.building) || (landuse ? EXCLUDED_URBAN_LANDUSES.has(landuse) : false);
}

function formatAddress(tags: Record<string, string>) {
  const parts = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim(),
    tags["addr:city"],
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : null;
}

function categoryIdsForTags(
  tags: Record<string, string>,
  categoryIds: SourceCategoryId[],
) {
  return categoryIds.filter((categoryId) => {
    const category = SOURCE_CATEGORY_MAP[categoryId];
    return category.selectors.some((selector) => selectorMatches(tags, selector));
  });
}

async function fetchSourcesForProvince(
  provinceId: ProvinceId,
  categoryIds: SourceCategoryId[],
  reporter?: ProgressReporter,
): Promise<SourceFeature[]> {
  const province = PROVINCE_MAP[provinceId];
  const wantFuel = categoryIds.includes("fuel");
  const wantAia = categoryIds.includes("aia");
  // Le categorie OSM sono tutte quelle che NON hanno un provider ad-hoc
  // (fuel -> MIMIT, aia -> ARPAT). Tutte le altre passano da Overpass.
  const overpassCategoryIds = categoryIds.filter(
    (categoryId) => categoryId !== "fuel" && categoryId !== "aia",
  );

  // MIMIT + ARPAT + Overpass sono tre provider indipendenti: li lanciamo
  // tutti in parallelo. MIMIT e ARPAT rispondono in <1s (CSV locale /
  // lista hardcoded), quindi non aggiungono latenza percettibile;
  // nascondono la propria attesa dietro il collo di bottiglia Overpass.
  const [fuelSources, aiaSources, overpassSources] = await Promise.all([
    wantFuel
      ? fetchFuelSourcesFromMimit(provinceId, (message) => {
          reportProgress(reporter, message);
        })
      : Promise.resolve<SourceFeature[]>([]),
    wantAia
      ? fetchAiaSourcesFromArpat(provinceId, (message) => {
          reportProgress(reporter, message);
        })
      : Promise.resolve<SourceFeature[]>([]),
    overpassCategoryIds.length > 0
      ? fetchOverpassSourcesForProvince(
          provinceId,
          overpassCategoryIds,
          reporter,
        )
      : Promise.resolve<SourceFeature[]>([]),
  ]);

  const sources = [...fuelSources, ...aiaSources, ...overpassSources];

  reportProgress(
    reporter,
    `${province.name}: totale fonti raccolte ${sources.length}.`,
  );

  return sources;
}

async function fetchOverpassSourcesForProvince(
  provinceId: ProvinceId,
  categoryIds: SourceCategoryId[],
  reporter?: ProgressReporter,
): Promise<SourceFeature[]> {
  const province = PROVINCE_MAP[provinceId];
  const selectors = categoryIds.flatMap(
    (categoryId) => SOURCE_CATEGORY_MAP[categoryId].selectors,
  );
  reportProgress(
    reporter,
    `${province.name}: avvio ricerca fonti emissive su ${categoryIds.length} categorie.`,
  );
  const query = `
[out:json][timeout:40];
rel["boundary"="administrative"]["admin_level"="6"]["name"="${province.name}"](${bboxString(province.bbox)});
map_to_area -> .provinceArea;
(
${buildAreaSelectorStatements(selectors, "area.provinceArea", ["node", "way"])}
);
out center;
`;

  const data = await fetchOverpass(query, reporter, `${province.name} fonti`);

  const sources = data.elements
    .map((element) => {
      const coordinates = sourceCoordinates(element);
      const tags = element.tags ?? {};
      const matchedCategoryIds = categoryIdsForTags(tags, categoryIds);

      if (!coordinates || matchedCategoryIds.length === 0) {
        return null;
      }

      const primaryCategoryId = matchedCategoryIds[0];
      const primaryCategory = SOURCE_CATEGORY_MAP[primaryCategoryId];

      return {
        id: `${element.type}-${element.id}`,
        osmId: element.id,
        osmType: element.type,
        provinceId,
        name:
          tags.name ||
          tags.brand ||
          `${primaryCategory.label.slice(0, -1)} ${element.type.toUpperCase()} ${element.id}`,
        primaryCategoryId,
        categoryIds: matchedCategoryIds,
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        address: formatAddress(tags),
        dataProvider: "osm",
        providerLabel: "OpenStreetMap",
        referenceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
        tags,
      } satisfies SourceFeature;
    })
    .filter((source) => source !== null) as SourceFeature[];

  if (
    sources.length === 0 &&
    activeOverpassCooldownCount() >= OVERPASS_ENDPOINTS.length - 1
  ) {
    reportProgress(
      reporter,
      `${province.name}: risposta fonti vuota con quasi tutti gli endpoint OSM in cooldown, considero la copertura temporaneamente inaffidabile.`,
    );
    throw new OverpassRateLimitError(
      "Copertura fonti OSM temporaneamente inaffidabile: riprovo appena i provider escono dal cooldown.",
    );
  }

  reportProgress(
    reporter,
    `${province.name}: fonti emissive trovate ${sources.length}.`,
  );

  return sources;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function buildTerrainObstacleAnchors(terrains: TerrainFeature[]) {
  const anchors: Array<{
    lat: number;
    lng: number;
    terrainIds: string[];
    probeRadiusMeters: number;
  }> = [];
  const terrainById = new Map(terrains.map((terrain) => [terrain.id, terrain]));

  for (const terrain of terrains) {
    const terrainPoint = point([terrain.center.lng, terrain.center.lat]);
    let matchedAnchor:
      | {
          lat: number;
          lng: number;
          terrainIds: string[];
          probeRadiusMeters: number;
        }
      | undefined;
    let matchedDistance = Number.POSITIVE_INFINITY;

    for (const anchor of anchors) {
      const anchorPoint = point([anchor.lng, anchor.lat]);
      const anchorDistance = distance(terrainPoint, anchorPoint, {
        units: "meters",
      });

      if (
        anchorDistance <= TERRAIN_OBSTACLE_CLUSTER_RADIUS_METERS &&
        anchorDistance < matchedDistance
      ) {
        matchedAnchor = anchor;
        matchedDistance = anchorDistance;
      }
    }

    if (!matchedAnchor) {
      anchors.push({
        lat: terrain.center.lat,
        lng: terrain.center.lng,
        terrainIds: [terrain.id],
        probeRadiusMeters: terrainProbeRadius(terrain),
      });
      continue;
    }

    matchedAnchor.terrainIds.push(terrain.id);
    matchedAnchor.lat =
      (matchedAnchor.lat * (matchedAnchor.terrainIds.length - 1) +
        terrain.center.lat) /
      matchedAnchor.terrainIds.length;
    matchedAnchor.lng =
      (matchedAnchor.lng * (matchedAnchor.terrainIds.length - 1) +
        terrain.center.lng) /
      matchedAnchor.terrainIds.length;

    const nextAnchorPoint = point([matchedAnchor.lng, matchedAnchor.lat]);
    let nextProbeRadius = 0;

    for (const terrainId of matchedAnchor.terrainIds) {
      const member = terrainById.get(terrainId);

      if (!member) {
        continue;
      }

      const memberPoint = point([member.center.lng, member.center.lat]);
      nextProbeRadius = Math.max(
        nextProbeRadius,
        distance(memberPoint, nextAnchorPoint, { units: "meters" }) +
          terrainProbeRadius(member),
      );
    }

    matchedAnchor.probeRadiusMeters = Math.min(
      SEARCH_RADIUS_METERS * 2,
      Math.ceil(nextProbeRadius),
    );
  }

  return anchors.map((anchor, index) => ({
    id: `obstacle-anchor-${index + 1}`,
    lat: anchor.lat,
    lng: anchor.lng,
    probeRadiusMeters: Math.max(
      TERRAIN_OBSTACLE_MIN_RADIUS_METERS,
      anchor.probeRadiusMeters,
    ),
    terrainIds: anchor.terrainIds,
  })) satisfies TerrainObstacleAnchor[];
}

function splitTerrainObstacleAnchorChunk(anchors: TerrainObstacleAnchor[]) {
  if (anchors.length <= 1) {
    return [anchors, []] satisfies [TerrainObstacleAnchor[], TerrainObstacleAnchor[]];
  }

  const south = Math.min(...anchors.map((anchor) => anchor.lat));
  const north = Math.max(...anchors.map((anchor) => anchor.lat));
  const west = Math.min(...anchors.map((anchor) => anchor.lng));
  const east = Math.max(...anchors.map((anchor) => anchor.lng));
  const latSpan = north - south;
  const lngSpan = east - west;
  const sorted = [...anchors].sort((left, right) =>
    latSpan >= lngSpan ? left.lat - right.lat : left.lng - right.lng,
  );
  const splitIndex = Math.ceil(sorted.length / 2);

  return [
    sorted.slice(0, splitIndex),
    sorted.slice(splitIndex),
  ] satisfies [TerrainObstacleAnchor[], TerrainObstacleAnchor[]];
}

function buildAroundStatementsForTerrainAnchors(
  selectors: ReadonlyArray<{ key: string; value?: string }>,
  anchors: TerrainObstacleAnchor[],
) {
  return anchors
    .flatMap((anchor) =>
      selectors.map((selector) => {
        const filter = selector.value
          ? `["${selector.key}"="${selector.value}"]`
          : `["${selector.key}"]`;

        return `way${filter}(around:${anchor.probeRadiusMeters},${anchor.lat},${anchor.lng});`;
      }),
    )
    .join("\n");
}

function terrainProbeRadius(terrain: TerrainFeature) {
  const centerPoint = point([terrain.center.lng, terrain.center.lat]);
  const maxVertexDistance = terrain.coordinates.reduce((maxDistance, coordinate) => {
    const vertexPoint = point(coordinate);

    return Math.max(
      maxDistance,
      distance(centerPoint, vertexPoint, { units: "meters" }),
    );
  }, 0);

  return Math.min(
    SEARCH_RADIUS_METERS,
    Math.max(
      TERRAIN_OBSTACLE_MIN_RADIUS_METERS,
      Math.ceil(maxVertexDistance + TERRAIN_OBSTACLE_MARGIN_METERS),
    ),
  );
}

function preparePolygonObstacle(element: OverpassElement) {
  const ring = ringFromGeometry(element.geometry);

  if (!ring) {
    return null;
  }

  try {
    return {
      id: `${element.type}-${element.id}`,
      ring,
      bounds: boundsFromCoordinates(ring),
      feature: polygon([ring]),
      tags: element.tags ?? {},
    } satisfies PreparedPolygonObstacle;
  } catch {
    return null;
  }
}

function prepareLineObstacle(element: OverpassElement) {
  const coords = coordinatesFromGeometry(element.geometry);

  if (!coords || coords.length < 2) {
    return null;
  }

  try {
    return {
      id: `${element.type}-${element.id}`,
      coords,
      bounds: boundsFromCoordinates(coords),
      feature: lineString(coords),
      tags: element.tags ?? {},
    } satisfies PreparedLineObstacle;
  } catch {
    return null;
  }
}

type TerrainObstacleChunkResult = TerrainObstacleLookup & {
  warningTriggered: boolean;
};

function createEmptyTerrainObstacleChunkResult(
  warning: string | null = null,
): TerrainObstacleChunkResult {
  return {
    buildings: [],
    urbanAreas: [],
    roads: [],
    warning,
    warningTriggered: Boolean(warning),
  };
}

function mergeTerrainObstacleChunkResults(
  results: TerrainObstacleChunkResult[],
): TerrainObstacleChunkResult {
  const buildingMap = new Map<string, PreparedPolygonObstacle>();
  const urbanAreaMap = new Map<string, PreparedPolygonObstacle>();
  const roadMap = new Map<string, PreparedLineObstacle>();
  let warning: string | null = null;

  for (const result of results) {
    for (const building of result.buildings) {
      buildingMap.set(building.id, building);
    }

    for (const urbanArea of result.urbanAreas) {
      urbanAreaMap.set(urbanArea.id, urbanArea);
    }

    for (const road of result.roads) {
      roadMap.set(road.id, road);
    }

    warning = warning ?? result.warning;
  }

  return {
    buildings: Array.from(buildingMap.values()),
    urbanAreas: Array.from(urbanAreaMap.values()),
    roads: Array.from(roadMap.values()),
    warning,
    warningTriggered: results.some((result) => result.warningTriggered),
  };
}

async function fetchTerrainObstaclesForChunk(
  provinceName: string,
  blockLabel: string,
  anchorChunk: TerrainObstacleAnchor[],
  reporter?: ProgressReporter,
  remainingSplits = OBSTACLE_CHUNK_SPLIT_DEPTH,
): Promise<TerrainObstacleChunkResult> {
  const query = `
[out:json][timeout:45];
(
${buildAroundStatementsForTerrainAnchors([{ key: "building" }], anchorChunk)}
${buildAroundStatementsForTerrainAnchors(URBAN_AREA_SELECTORS, anchorChunk)}
${buildAroundStatementsForTerrainAnchors(ROAD_SELECTORS, anchorChunk)}
);
out geom;
`;

  // Soft timeout: se il filtro anti-urbano non risponde entro
  // OBSTACLE_FILTER_SOFT_TIMEOUT_MS restituiamo un warning e lasciamo
  // passare il batch senza filtrare. Meglio risultati imperfetti in pochi
  // secondi che risultati perfetti in 5 minuti.
  const softTimeoutPromise = new Promise<TerrainObstacleChunkResult>((resolve) => {
    setTimeout(() => {
      resolve(
        createEmptyTerrainObstacleChunkResult(
          `${provinceName}: filtro anti-urbano blocco ${blockLabel} saltato per timeout soft ${Math.round(OBSTACLE_FILTER_SOFT_TIMEOUT_MS / 1000)}s.`,
        ),
      );
    }, OBSTACLE_FILTER_SOFT_TIMEOUT_MS);
  });

  const fetchPromise = (async (): Promise<TerrainObstacleChunkResult> => {
    try {
      const data = await fetchOverpass(
        query,
        reporter,
        `${provinceName} filtri blocco ${blockLabel}`,
      );
      const buildingMap = new Map<string, PreparedPolygonObstacle>();
      const urbanAreaMap = new Map<string, PreparedPolygonObstacle>();
      const roadMap = new Map<string, PreparedLineObstacle>();

      for (const element of data.elements) {
        if (element.type !== "way") {
          continue;
        }

        const tags = element.tags ?? {};
        const normalizedLanduse = tags.landuse?.trim().toLowerCase();
        const normalizedHighway = tags.highway?.trim().toLowerCase();

        if (tags.building) {
          const prepared = preparePolygonObstacle(element);

          if (prepared) {
            buildingMap.set(prepared.id, prepared);
          }
        }

        if (normalizedLanduse && EXCLUDED_URBAN_LANDUSES.has(normalizedLanduse)) {
          const prepared = preparePolygonObstacle(element);

          if (prepared) {
            urbanAreaMap.set(prepared.id, prepared);
          }
        }

        if (normalizedHighway) {
          const prepared = prepareLineObstacle(element);

          if (prepared) {
            roadMap.set(prepared.id, prepared);
          }
        }
      }

      return {
        buildings: Array.from(buildingMap.values()),
        urbanAreas: Array.from(urbanAreaMap.values()),
        roads: Array.from(roadMap.values()),
        warning: null,
        warningTriggered: false,
      };
    } catch (error) {
      const recoverable =
        error instanceof OverpassRateLimitError || isRecoverableOverpassError(error);

      if (recoverable && remainingSplits > 0 && anchorChunk.length > 1) {
        reportProgress(
          reporter,
          `${provinceName}: blocco filtri ${blockLabel} troppo pesante per i provider live, lo divido in sottoblocchi.`,
        );

        const [leftChunk, rightChunk] = splitTerrainObstacleAnchorChunk(anchorChunk);
        const branchResults = await Promise.all(
          [leftChunk, rightChunk]
            .filter((chunk) => chunk.length > 0)
            .map((chunk, index) =>
              fetchTerrainObstaclesForChunk(
                provinceName,
                `${blockLabel}.${index === 0 ? "a" : "b"}`,
                chunk,
                reporter,
                remainingSplits - 1,
              ),
            ),
        );

        return mergeTerrainObstacleChunkResults(branchResults);
      }

      if (recoverable) {
        const warning = `${provinceName}: filtro anti-urbano completato parzialmente per rate limit Overpass al blocco ${blockLabel}.`;
        reportProgress(reporter, warning);
        return createEmptyTerrainObstacleChunkResult(warning);
      }

      throw error;
    }
  })();

  return Promise.race([fetchPromise, softTimeoutPromise]);
}

async function fetchTerrainObstaclesForProvince(
  provinceId: ProvinceId,
  terrains: TerrainFeature[],
  reporter?: ProgressReporter,
  signal?: AbortSignal,
): Promise<TerrainObstacleLookup> {
  if (terrains.length === 0) {
    return {
      buildings: [],
      urbanAreas: [],
      roads: [],
      warning: null,
    };
  }

  const obstacleAnchors = buildTerrainObstacleAnchors(terrains);
  const anchorChunks = chunkArray(obstacleAnchors, OBSTACLE_ANCHORS_PER_CHUNK);
  const province = PROVINCE_MAP[provinceId];
  const buildingMap = new Map<string, PreparedPolygonObstacle>();
  const urbanAreaMap = new Map<string, PreparedPolygonObstacle>();
  const roadMap = new Map<string, PreparedLineObstacle>();
  let warning: string | null = null;

  reportProgress(
    reporter,
    `${province.name}: verifica edifici, urbanizzato e strade su ${anchorChunks.length} blocchi di contesto (concurrency=${Math.min(OBSTACLE_CHUNK_CONCURRENCY, anchorChunks.length)}).`,
  );

  // Chunk indipendenti (aree diverse della provincia): li lanciamo in
  // parallelo ma con un cap basso (default 2) per non esaurire i 4
  // endpoint Overpass con richieste concorrenti, soprattutto se piu
  // province girano in parallelo a loro volta.
  //
  // Nota: la vecchia logica aveva un `break` al primo warningTriggered
  // per non lanciare altri blocchi quando un chunk scada in soft-timeout.
  // In parallelo tutti i chunk sono gia in volo all'inizio, quindi non
  // c'e un reale "fermare lavoro futuro": accettiamo tutti i risultati e
  // conserviamo il primo warning per il banner UI.
  const chunkTasks = anchorChunks.map(
    (anchorChunk, index) => async () => {
      const chunkTerrainCount = anchorChunk.reduce(
        (sum, anchor) => sum + anchor.terrainIds.length,
        0,
      );
      reportProgress(
        reporter,
        `${province.name}: blocco filtri ${index + 1}/${anchorChunks.length} avviato (${anchorChunk.length} ancore, ${chunkTerrainCount} terreni).`,
      );
      return fetchTerrainObstaclesForChunk(
        province.name,
        `${index + 1}/${anchorChunks.length}`,
        anchorChunk,
        reporter,
      );
    },
  );

  const chunkResults = await runWithConcurrency(
    chunkTasks,
    OBSTACLE_CHUNK_CONCURRENCY,
    signal,
  );

  for (const chunkResult of chunkResults) {
    for (const building of chunkResult.buildings) {
      buildingMap.set(building.id, building);
    }
    for (const urbanArea of chunkResult.urbanAreas) {
      urbanAreaMap.set(urbanArea.id, urbanArea);
    }
    for (const road of chunkResult.roads) {
      roadMap.set(road.id, road);
    }
    if (!warning && chunkResult.warning) {
      warning = chunkResult.warning;
    }
  }

  reportProgress(
    reporter,
    `${province.name}: contesto urbano raccolto ${buildingMap.size} edifici, ${urbanAreaMap.size} aree urbane e ${roadMap.size} strade.`,
  );

  return {
    buildings: Array.from(buildingMap.values()),
    urbanAreas: Array.from(urbanAreaMap.values()),
    roads: Array.from(roadMap.values()),
    warning,
  };
}

function polygonHasInteriorOverlap(
  terrainFeature: ReturnType<typeof polygon>,
  terrainRing: CoordinateRing,
  obstacle: PreparedPolygonObstacle,
) {
  return (
    obstacle.ring.some((coordinate) =>
      booleanPointInPolygon(point(coordinate), terrainFeature, { ignoreBoundary: true }),
    ) ||
    terrainRing.some((coordinate) =>
      booleanPointInPolygon(point(coordinate), obstacle.feature, { ignoreBoundary: true }),
    )
  );
}

function roadTraversesTerrain(
  terrainFeature: ReturnType<typeof polygon>,
  terrainBoundary: ReturnType<typeof lineString>,
  road: PreparedLineObstacle,
) {
  const roadIntersections = lineIntersect(road.feature, terrainBoundary).features.length;
  const roadHasInteriorVertex = road.coords.some((coordinate) =>
    booleanPointInPolygon(point(coordinate), terrainFeature, { ignoreBoundary: true }),
  );

  return roadHasInteriorVertex || roadIntersections >= 2;
}

function filterTerrainsByObstacles(
  terrains: TerrainFeature[],
  lookup: TerrainObstacleLookup,
  reporter?: ProgressReporter,
) {
  const stats: TerrainFilterStats = {
    rejectedByTags: 0,
    rejectedByBuildings: 0,
    rejectedByUrbanAreas: 0,
    rejectedByRoads: 0,
  };

  const filtered = terrains.filter((terrain) => {
    if (isTerrainHardExcluded(terrain.tags)) {
      stats.rejectedByTags += 1;
      return false;
    }

    try {
      const terrainRing = terrain.coordinates;
      const terrainBounds = boundsFromCoordinates(terrainRing);
      const terrainFeature = polygon([terrainRing]);
      const terrainBoundary = lineString(terrainRing);

      const overlapsBuilding = lookup.buildings
        .filter((building) => boundsOverlap(terrainBounds, building.bounds))
        .some((building) => polygonHasInteriorOverlap(terrainFeature, terrainRing, building));

      if (overlapsBuilding) {
        stats.rejectedByBuildings += 1;
        return false;
      }

      const overlapsUrbanArea = lookup.urbanAreas
        .filter((urbanArea) => boundsOverlap(terrainBounds, urbanArea.bounds))
        .some((urbanArea) => polygonHasInteriorOverlap(terrainFeature, terrainRing, urbanArea));

      if (overlapsUrbanArea) {
        stats.rejectedByUrbanAreas += 1;
        return false;
      }

      let traversingMinorRoads = 0;

      for (const road of lookup.roads) {
        if (!boundsOverlap(terrainBounds, road.bounds)) {
          continue;
        }

        if (!roadTraversesTerrain(terrainFeature, terrainBoundary, road)) {
          continue;
        }

        if (MAJOR_ROAD_VALUES.has(road.tags.highway?.trim().toLowerCase() ?? "")) {
          stats.rejectedByRoads += 1;
          return false;
        }

        traversingMinorRoads += 1;

        if (traversingMinorRoads >= 2) {
          stats.rejectedByRoads += 1;
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  });

  reportProgress(
    reporter,
    `Filtro qualità terreni: scartati ${stats.rejectedByTags} per tag incompatibili, ${stats.rejectedByBuildings} con edifici, ${stats.rejectedByUrbanAreas} in aree urbane e ${stats.rejectedByRoads} attraversati da strade.`,
  );

  return {
    terrains: filtered,
    stats,
  };
}

function mergeSources(sources: SourceFeature[]) {
  const byId = new Map<string, SourceFeature>();

  for (const source of sources) {
    const existing = byId.get(source.id);

    if (!existing) {
      byId.set(source.id, source);
      continue;
    }

    const mergedCategoryIds = new Set([
      ...existing.categoryIds,
      ...source.categoryIds,
    ]);

    byId.set(source.id, {
      ...existing,
      categoryIds: Array.from(mergedCategoryIds),
    });
  }

  return Array.from(byId.values());
}

function provinceName(provinceId: ProvinceId) {
  return PROVINCE_MAP[provinceId].name;
}

async function scanProvince(
  provinceId: ProvinceId,
  categoryIds: SourceCategoryId[],
  reporter?: ProgressReporter,
  signal?: AbortSignal,
) {
  const province = PROVINCE_MAP[provinceId];
  throwIfAborted(signal);
  reportProgress(reporter, `${province.name}: scansione provincia avviata.`);
  const sources = mergeSources(
    await fetchSourcesForProvince(provinceId, categoryIds, reporter),
  ).sort((left, right) =>
    left.name.localeCompare(right.name, "it"),
  );
  const terrainLookup =
    sources.length === 0
      ? {
          terrains: [] as TerrainFeature[],
          warning: null as string | null,
        }
      : await fetchCadastralTerrainsNearSources(provinceId, sources, reporter, signal);
  const sortedCandidates = terrainLookup.terrains.sort(
    (left, right) => left.distanceMeters - right.distanceMeters,
  );
  const terrainCandidates = sortedCandidates.slice(0, MAX_TERRAINS_PRE_FILTER);

  if (sortedCandidates.length > MAX_TERRAINS_PRE_FILTER) {
    reportProgress(
      reporter,
      `${province.name}: pre-filtro ridotto a ${MAX_TERRAINS_PRE_FILTER} particelle piu vicine su ${sortedCandidates.length} disponibili per velocizzare il filtro anti-urbano.`,
    );
  }

  const terrainCandidateBatches = chunkArray(
    terrainCandidates,
    TERRAIN_FILTER_BATCH_SIZE,
  );
  const filteredTerrains: TerrainFeature[] = [];
  const provinceWarnings: string[] = [];
  const provinceNotes: string[] = [];

  reportProgress(
    reporter,
    `${province.name}: particelle preliminari prima del filtro urbano ${terrainCandidates.length}.`,
  );

  for (const [batchIndex, terrainBatch] of terrainCandidateBatches.entries()) {
    reportProgress(
      reporter,
      `${province.name}: filtro urbano batch ${batchIndex + 1}/${terrainCandidateBatches.length} su ${terrainBatch.length} particelle.`,
    );

    throwIfAborted(signal);
    const obstacleLookup = await fetchTerrainObstaclesForProvince(
      provinceId,
      terrainBatch,
      reporter,
      signal,
    );
    const terrainFilter = filterTerrainsByObstacles(
      terrainBatch,
      obstacleLookup,
      reporter,
    );

    filteredTerrains.push(...terrainFilter.terrains);

    if (obstacleLookup.warning) {
      provinceWarnings.push(obstacleLookup.warning);
    }

    if (filteredTerrains.length >= MAX_TERRAINS) {
      provinceNotes.push(
        `${province.name}: filtro urbano arrestato dopo i primi ${filteredTerrains.length} terreni compatibili per mantenere il run reattivo.`,
      );
      reportProgress(
        reporter,
        `${province.name}: trovato un set sufficiente di terreni vicini, interrompo i batch residui per velocizzare la risposta.`,
      );
      break;
    }
  }

  const terrains = filteredTerrains
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  reportProgress(
    reporter,
    `${province.name}: particelle compatibili nel raggio trovate ${terrains.length}.`,
  );

  return {
    sources,
    terrains,
    warnings: [terrainLookup.warning, ...provinceWarnings].filter(
      (warning): warning is string => Boolean(warning),
    ),
    notes: provinceNotes,
  };
}

export async function runScan(
  provinceIds: ProvinceId[],
  categoryIds: SourceCategoryId[],
  options?: RunScanOptions,
): Promise<ScanResponse> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const reporter = options?.reportProgress;
  const partialReporter = options?.reportPartialResult;
  const provinces = provinceIds.filter((provinceId) => provinceId in PROVINCE_MAP);
  const categories = categoryIds.filter((categoryId) =>
    SOURCE_CATEGORIES.some((category) => category.id === categoryId),
  );

  if (provinces.length === 0) {
    throw new Error("Seleziona almeno una provincia.");
  }

  if (categories.length === 0) {
    throw new Error("Seleziona almeno una tipologia di fonte emissiva.");
  }

  const scanCacheKey = buildScanCacheKey(provinces, categories);
  const cachedScanResult = scanResultCache.get(scanCacheKey);

  if (cachedScanResult && cachedScanResult.expiresAt > Date.now()) {
    reportProgress(
      reporter,
      "Uso un risultato recente già disponibile per evitare nuova pressione sui provider geospaziali live.",
    );
    return cloneScanResponse(cachedScanResult.value);
  }

  const inflightScan = scanInflight.get(scanCacheKey);

  if (inflightScan) {
    reportProgress(
      reporter,
      "Riprendo una scansione identica gia in esecuzione senza riaprire una nuova pipeline.",
    );
    return cloneScanResponse(await inflightScan);
  }

  const scanPromise = (async () => {
    reportProgress(
      reporter,
      `Scansione avviata su ${provinces.length} province e ${categories.length} categorie (concurrency=${Math.min(PROVINCE_CONCURRENCY, provinces.length)}).`,
    );

    try {
      const provinceResults: Array<Awaited<ReturnType<typeof scanProvince>>> = [];
      const totalProvinces = provinces.length;
      let completedCount = 0;

      // Province indipendenti: bbox disgiunti, fuel MIMIT e WFS catastale
      // condividono cache+inflight a livello di modulo, quindi i lavori
      // duplicati si collassano naturalmente. Lanciamo PROVINCE_CONCURRENCY
      // province in parallelo e, man mano che una completa, emettiamo un
      // partial-result cumulativo.
      const provinceTasks = provinces.map((provinceId) => async () => {
        throwIfAborted(options?.signal);
        const result = await scanProvince(
          provinceId,
          categories,
          reporter,
          options?.signal,
        );
        provinceResults.push(result);
        completedCount += 1;

        // Emette lo snapshot finche' restano province in volo. Sull'ultima
        // completata saltiamo (il "result" finale ha gli stessi dati e
        // viene inviato dal caller).
        if (partialReporter && completedCount < totalProvinces) {
          const partialSources = provinceResults
            .flatMap((r) => r.sources)
            .sort((left, right) => left.name.localeCompare(right.name, "it"));
          const partialTerrains = provinceResults
            .flatMap((r) => r.terrains)
            .sort((left, right) => left.distanceMeters - right.distanceMeters);
          const partialWarnings = provinceResults.flatMap((r) => r.warnings);
          const partialNotes = provinceResults.flatMap((r) => r.notes);

          partialReporter({
            sources: partialSources,
            terrains: partialTerrains.slice(0, MAX_TERRAINS),
            meta: {
              queryAt: new Date().toISOString(),
              radiusMeters: SEARCH_RADIUS_METERS,
              selectedProvinceIds: provinces,
              selectedCategoryIds: categories,
              totalSources: partialSources.length,
              totalTerrains: partialTerrains.length,
              warnings: partialWarnings,
              notes: [
                ...partialNotes,
                `Risultato parziale: ${completedCount}/${totalProvinces} province processate.`,
              ],
            },
          });
        }

        return result;
      });

      await runWithConcurrency(provinceTasks, PROVINCE_CONCURRENCY, options?.signal);

      const sources = provinceResults
        .flatMap((result) => result.sources)
        .sort((left, right) => left.name.localeCompare(right.name, "it"));

      const terrains = provinceResults
        .flatMap((result) => result.terrains)
        .sort((left, right) => left.distanceMeters - right.distanceMeters);
      warnings.push(...provinceResults.flatMap((result) => result.warnings));
      notes.push(...provinceResults.flatMap((result) => result.notes));

      if (terrains.length > MAX_TERRAINS) {
        warnings.push(
          `Mostro i primi ${MAX_TERRAINS} terreni ordinati per prossimità. Raffina le province per un set più mirato.`,
        );
      }

      if (sources.length === 0) {
        warnings.push(
          `Nessuna fonte trovata nei provider attivi. Prova con ${provinceName("FI")}, ${provinceName("PI")} o ${provinceName("PT")}.`,
        );
      }

      if (sources.length > 0 && terrains.length === 0) {
        warnings.push(
          "Le fonti sono state trovate, ma non sono emerse particelle catastali compatibili entro 350 m nel set corrente.",
        );
      }

      if (
        overpassCache.size > 0 &&
        (categories.some((category) => category !== "fuel") || terrains.length > 0)
      ) {
        notes.push(
          "Le scansioni uguali vengono temporaneamente riutilizzate da cache per ridurre la pressione sui provider geospaziali live.",
        );
      }

      reportProgress(
        reporter,
        `Scansione completata: ${sources.length} fonti e ${Math.min(terrains.length, MAX_TERRAINS)} terreni restituiti.`,
      );

      const result = {
        sources,
        terrains: terrains.slice(0, MAX_TERRAINS),
        meta: {
          queryAt: new Date().toISOString(),
          radiusMeters: SEARCH_RADIUS_METERS,
          selectedProvinceIds: provinces,
          selectedCategoryIds: categories,
          totalSources: sources.length,
          totalTerrains: terrains.length,
          warnings,
          notes,
        },
      } satisfies ScanResponse;

      scanResultCache.set(scanCacheKey, {
        expiresAt: Date.now() + SCAN_RESULT_CACHE_TTL_MS,
        value: cloneScanResponse(result),
      });

      return result;
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";

      if (
        cachedScanResult?.value &&
        isRecoverableOverpassError(error)
      ) {
        reportProgress(
          reporter,
          "Le sorgenti pubbliche sono sature: restituisco l'ultimo risultato utile disponibile da cache.",
        );

        logError(
          "runScan ha ripiegato su cache per saturazione provider",
          {
            provinceIds: provinces,
            categoryIds: categories,
            fallback: "cached-result",
          },
          error,
        );

        const cachedResult = cloneScanResponse(cachedScanResult.value);
        cachedResult.meta.queryAt = new Date().toISOString();
        cachedResult.meta.warnings = [
          "Risultato restituito da cache precedente perché Overpass è temporaneamente saturo.",
          ...cachedResult.meta.warnings,
        ];
        cachedResult.meta.notes = cachedResult.meta.notes ?? [];

        return cachedResult;
      }

      // Non logghiamo gli abort come errori: sono legittimi (client
      // ha chiuso la connessione). Tutto il resto e visibilita reale.
      if (!isAbort) {
        logError(
          "runScan ha fallito in modo non recuperabile",
          {
            provinceIds: provinces,
            categoryIds: categories,
          },
          error,
        );
      }

      throw error;
    }
  })();

  scanInflight.set(scanCacheKey, scanPromise);

  try {
    return cloneScanResponse(await scanPromise);
  } finally {
    if (scanInflight.get(scanCacheKey) === scanPromise) {
      scanInflight.delete(scanCacheKey);
    }
  }
}
