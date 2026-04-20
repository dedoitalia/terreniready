import { area, centerOfMass, point, pointToPolygonDistance, polygon } from "@turf/turf";

import { PROVINCE_MAP } from "@/lib/province-data";
import {
  AGRICULTURAL_SELECTORS,
  SOURCE_CATEGORIES,
  SOURCE_CATEGORY_MAP,
  landuseLabel,
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
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const SEARCH_RADIUS_METERS = 350;
const MAX_TERRAINS = 250;
const OVERPASS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ENDPOINT_COOLDOWN_MS = 90 * 1000;
const ENDPOINT_RETRY_DELAY_MS = 450;
const SOURCES_PER_AGRI_CHUNK = 18;
const OVERPASS_REQUEST_TIMEOUT_MS = 12 * 1000;

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

type CachedOverpassValue = {
  expiresAt: number;
  value: OverpassResponse;
};

type ProgressReporter = (event: ScanProgressEvent) => void;

type RunScanOptions = {
  reportProgress?: ProgressReporter;
};

class OverpassRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassRateLimitError";
  }
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

function reportProgress(reporter: ProgressReporter | undefined, message: string) {
  reporter?.({ message });
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

function buildSelectorStatements(
  selectors: Array<{ key: string; value?: string }>,
  bbox: BoundingBox,
  elementTypes: Array<"node" | "way">,
) {
  const area = bboxString(bbox);

  return selectors
    .flatMap((selector) =>
      elementTypes.map((elementType) => {
        if (selector.value) {
          return `${elementType}["${selector.key}"="${selector.value}"](${area});`;
        }

        return `${elementType}["${selector.key}"](${area});`;
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

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const cooldownUntil = endpointCooldowns.get(endpoint) ?? 0;

      if (cooldownUntil > Date.now()) {
        sawRateLimit = true;
        reportProgress(
          reporter,
          `${contextLabel ?? "Query"}: salto ${new URL(endpoint).hostname} per cooldown attivo.`,
        );
        continue;
      }

      try {
        reportProgress(
          reporter,
          `${contextLabel ?? "Query"}: interrogo ${new URL(endpoint).hostname}.`,
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
            `${contextLabel ?? "Query"}: ${new URL(endpoint).hostname} ha risposto 429, passo al prossimo endpoint.`,
          );
          await delay(ENDPOINT_RETRY_DELAY_MS);
          continue;
        }

        if (!response.ok) {
          lastError = new Error(`${endpoint} responded with ${response.status}`);
          reportProgress(
            reporter,
            `${contextLabel ?? "Query"}: ${new URL(endpoint).hostname} ha risposto ${response.status}, provo il prossimo endpoint.`,
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
          lastError = new Error(`${endpoint} timed out after ${OVERPASS_REQUEST_TIMEOUT_MS}ms`);
          reportProgress(
            reporter,
            `${contextLabel ?? "Query"}: ${new URL(endpoint).hostname} non ha risposto entro ${Math.round(OVERPASS_REQUEST_TIMEOUT_MS / 1000)}s, provo il prossimo endpoint.`,
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
          `${contextLabel ?? "Query"}: errore rete su ${new URL(endpoint).hostname}, provo il prossimo endpoint.`,
        );
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
  if (!geometry || geometry.length < 3) {
    return null;
  }

  const ring = geometry.map((vertex) => [vertex.lon, vertex.lat] as [number, number]);
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
) {
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
(
${buildSelectorStatements(selectors, province.bbox, ["node", "way"])}
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
        tags,
      } satisfies SourceFeature;
    })
    .filter((source): source is SourceFeature => source !== null);

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

function buildAroundStatements(
  selectors: Array<{ key: string; value?: string }>,
  sources: SourceFeature[],
) {
  return sources
    .flatMap((source) =>
      selectors.map((selector) => {
        const filter = selector.value
          ? `["${selector.key}"="${selector.value}"]`
          : `["${selector.key}"]`;

        return `way${filter}(around:${SEARCH_RADIUS_METERS},${source.latitude},${source.longitude});`;
      }),
    )
    .join("\n");
}

async function fetchAgriculturalWaysNearSources(
  provinceId: ProvinceId,
  provinceSources: SourceFeature[],
  reporter?: ProgressReporter,
) {
  if (provinceSources.length === 0) {
    return [] as OverpassElement[];
  }

  const sourceChunks = chunkArray(provinceSources, SOURCES_PER_AGRI_CHUNK);
  const allElements: OverpassElement[] = [];
  const province = PROVINCE_MAP[provinceId];

  reportProgress(
    reporter,
    `${province.name}: avvio ricerca poligoni agricoli vicini alle fonti in ${sourceChunks.length} blocchi.`,
  );

  for (const [index, sourceChunk] of sourceChunks.entries()) {
    reportProgress(
      reporter,
      `${province.name}: blocco terreni ${index + 1}/${sourceChunks.length} su ${sourceChunk.length} fonti.`,
    );
    const query = `
[out:json][timeout:45];
(
${buildAroundStatements(AGRICULTURAL_SELECTORS, sourceChunk)}
);
out geom;
`;

    const data = await fetchOverpass(
      query,
      reporter,
      `${province.name} terreni blocco ${index + 1}/${sourceChunks.length}`,
    );
    allElements.push(...data.elements);
  }

  const unique = new Map<string, OverpassElement>();

  for (const element of allElements) {
    unique.set(`${element.type}-${element.id}`, element);
  }

  const ways = Array.from(unique.values()).filter((element) => element.type === "way");

  reportProgress(
    reporter,
    `${province.name}: poligoni agricoli candidati ${ways.length}.`,
  );

  return ways;
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

function sourceCandidatePrefilter(
  source: SourceFeature,
  minLat: number,
  minLng: number,
  maxLat: number,
  maxLng: number,
) {
  const latBuffer = 0.006;
  const lngBuffer = 0.006;

  return (
    source.latitude >= minLat - latBuffer &&
    source.latitude <= maxLat + latBuffer &&
    source.longitude >= minLng - lngBuffer &&
    source.longitude <= maxLng + lngBuffer
  );
}

function computeTerrainCandidate(
  provinceId: ProvinceId,
  element: OverpassElement,
  provinceSources: SourceFeature[],
): TerrainFeature | null {
  const ring = ringFromGeometry(element.geometry);

  if (!ring) {
    return null;
  }

  try {
    const poly = polygon([ring]);
    const centroid = centerOfMass(poly).geometry.coordinates;
    const tags = element.tags ?? {};
    const landuse = tags.landuse ?? "agricultural";
    const lats = ring.map((coordinate) => coordinate[1]);
    const lngs = ring.map((coordinate) => coordinate[0]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    let closestSource: SourceFeature | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    let sourceCountInRange = 0;

    for (const source of provinceSources) {
      if (!sourceCandidatePrefilter(source, minLat, minLng, maxLat, maxLng)) {
        continue;
      }

      const sourcePoint = point([source.longitude, source.latitude]);
      const distanceMeters = pointToPolygonDistance(sourcePoint, poly, {
        units: "meters",
      });

      if (Number.isNaN(distanceMeters)) {
        continue;
      }

      if (distanceMeters <= SEARCH_RADIUS_METERS) {
        sourceCountInRange += 1;
      }

      if (distanceMeters < closestDistance) {
        closestDistance = distanceMeters;
        closestSource = source;
      }
    }

    if (!closestSource || closestDistance > SEARCH_RADIUS_METERS) {
      return null;
    }

    return {
      id: `${provinceId}-terrain-${element.id}`,
      osmId: element.id,
      osmType: "way",
      provinceId,
      name: tags.name || `${landuseLabel(landuse)} ${element.id}`,
      landuse,
      center: {
        lat: centroid[1],
        lng: centroid[0],
      },
      coordinates: ring,
      distanceMeters: closestDistance,
      areaSqm: Math.round(area(poly)),
      closestSourceId: closestSource.id,
      closestSourceName: closestSource.name,
      closestSourceCategoryId: closestSource.primaryCategoryId,
      sourceCountInRange,
      tags,
    } satisfies TerrainFeature;
  } catch {
    return null;
  }
}

async function scanProvince(
  provinceId: ProvinceId,
  categoryIds: SourceCategoryId[],
  reporter?: ProgressReporter,
) {
  const province = PROVINCE_MAP[provinceId];
  reportProgress(reporter, `${province.name}: scansione provincia avviata.`);
  const sources = mergeSources(
    await fetchSourcesForProvince(provinceId, categoryIds, reporter),
  ).sort((left, right) =>
    left.name.localeCompare(right.name, "it"),
  );
  const landWays =
    sources.length === 0
      ? []
      : await fetchAgriculturalWaysNearSources(provinceId, sources, reporter);

  reportProgress(
    reporter,
    `${province.name}: calcolo prossimità terreno-fonte su ${landWays.length} poligoni.`,
  );

  const terrains = landWays
    .map((element) => computeTerrainCandidate(provinceId, element, sources))
    .filter((terrain): terrain is TerrainFeature => terrain !== null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  reportProgress(
    reporter,
    `${province.name}: terreni agricoli nel raggio trovati ${terrains.length}.`,
  );

  return {
    sources,
    terrains,
  };
}

export async function runScan(
  provinceIds: ProvinceId[],
  categoryIds: SourceCategoryId[],
  options?: RunScanOptions,
): Promise<ScanResponse> {
  const warnings: string[] = [];
  const reporter = options?.reportProgress;
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

  reportProgress(
    reporter,
    `Scansione avviata su ${provinces.length} province e ${categories.length} categorie.`,
  );

  const provinceResults: Array<Awaited<ReturnType<typeof scanProvince>>> = [];

  for (const provinceId of provinces) {
    provinceResults.push(await scanProvince(provinceId, categories, reporter));
  }

  const sources = provinceResults
    .flatMap((result) => result.sources)
    .sort((left, right) => left.name.localeCompare(right.name, "it"));

  const terrains = provinceResults
    .flatMap((result) => result.terrains)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  if (terrains.length > MAX_TERRAINS) {
    warnings.push(
      `Mostro i primi ${MAX_TERRAINS} terreni ordinati per prossimità. Raffina le province per un set più mirato.`,
    );
  }

  if (sources.length === 0) {
    warnings.push(
      `Nessuna fonte OSM trovata nelle province selezionate. Prova con ${provinceName("FI")}, ${provinceName("PI")} o ${provinceName("PT")}.`,
    );
  }

  if (sources.length > 0 && terrains.length === 0) {
    warnings.push(
      "Le fonti sono state trovate, ma non sono emersi poligoni agricoli OSM entro 350 m nel set corrente.",
    );
  }

  if (overpassCache.size > 0) {
    warnings.push(
      "Le scansioni uguali vengono temporaneamente riutilizzate da cache per ridurre i rate limit di Overpass.",
    );
  }

  reportProgress(
    reporter,
    `Scansione completata: ${sources.length} fonti e ${Math.min(terrains.length, MAX_TERRAINS)} terreni restituiti.`,
  );

  return {
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
    },
  };
}
