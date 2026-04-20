import {
  area,
  booleanPointInPolygon,
  centerOfMass,
  distance,
  lineIntersect,
  lineString,
  point,
  pointToPolygonDistance,
  polygon,
} from "@turf/turf";

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
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const SEARCH_RADIUS_METERS = 350;
const MAX_TERRAINS = 250;
const OVERPASS_CACHE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_ENDPOINT_COOLDOWN_MS = 90 * 1000;
const ENDPOINT_RETRY_DELAY_MS = 450;
const ANCHORS_PER_AGRI_CHUNK = 24;
const TERRAINS_PER_OBSTACLE_CHUNK = 20;
const OVERPASS_REQUEST_TIMEOUT_MS = 12 * 1000;
const OVERPASS_MAX_CYCLES = 2;
const OVERPASS_CYCLE_BACKOFF_MS = 3_500;
const SCAN_RESULT_CACHE_TTL_MS = 45 * 60 * 1000;
const TERRAIN_OBSTACLE_MARGIN_METERS = 25;
const TERRAIN_OBSTACLE_MIN_RADIUS_METERS = 45;
const TERRAIN_SOURCE_CLUSTER_RADIUS_METERS = 225;

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

type RunScanOptions = {
  reportProgress?: ProgressReporter;
};

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

type TerrainSearchAnchor = {
  id: string;
  lat: number;
  lng: number;
  probeRadiusMeters: number;
  sourceIds: string[];
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
const scanResultCache = getGlobalStore<Map<string, CachedScanResult>>(
  "__terreniReadyScanResultCache",
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

function endpointRole(index: number) {
  return index === 0 ? "primario" : `fallback ${index}`;
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
  anchors: TerrainSearchAnchor[],
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

function buildTerrainSearchAnchors(sources: SourceFeature[]) {
  const anchors: Array<{
    lat: number;
    lng: number;
    sourceIds: string[];
    maxDistanceMeters: number;
  }> = [];

  for (const source of sources) {
    const sourcePoint = point([source.longitude, source.latitude]);
    let matchedAnchor:
      | {
          lat: number;
          lng: number;
          sourceIds: string[];
          maxDistanceMeters: number;
        }
      | undefined;
    let matchedDistance = Number.POSITIVE_INFINITY;

    for (const anchor of anchors) {
      const anchorPoint = point([anchor.lng, anchor.lat]);
      const anchorDistance = distance(sourcePoint, anchorPoint, {
        units: "meters",
      });

      if (
        anchorDistance <= TERRAIN_SOURCE_CLUSTER_RADIUS_METERS &&
        anchorDistance < matchedDistance
      ) {
        matchedAnchor = anchor;
        matchedDistance = anchorDistance;
      }
    }

    if (!matchedAnchor) {
      anchors.push({
        lat: source.latitude,
        lng: source.longitude,
        sourceIds: [source.id],
        maxDistanceMeters: 0,
      });
      continue;
    }

    matchedAnchor.sourceIds.push(source.id);
    matchedAnchor.lat =
      (matchedAnchor.lat * (matchedAnchor.sourceIds.length - 1) + source.latitude) /
      matchedAnchor.sourceIds.length;
    matchedAnchor.lng =
      (matchedAnchor.lng * (matchedAnchor.sourceIds.length - 1) + source.longitude) /
      matchedAnchor.sourceIds.length;

    let nextMaxDistance = 0;
    const nextAnchorPoint = point([matchedAnchor.lng, matchedAnchor.lat]);

    for (const sourceId of matchedAnchor.sourceIds) {
      const member = sources.find((candidate) => candidate.id === sourceId);

      if (!member) {
        continue;
      }

      const memberPoint = point([member.longitude, member.latitude]);
      nextMaxDistance = Math.max(
        nextMaxDistance,
        distance(memberPoint, nextAnchorPoint, { units: "meters" }),
      );
    }

    matchedAnchor.maxDistanceMeters = nextMaxDistance;
  }

  return anchors.map((anchor, index) => ({
    id: `anchor-${index + 1}`,
    lat: anchor.lat,
    lng: anchor.lng,
    probeRadiusMeters: Math.min(
      SEARCH_RADIUS_METERS * 2,
      Math.ceil(SEARCH_RADIUS_METERS + anchor.maxDistanceMeters),
    ),
    sourceIds: anchor.sourceIds,
  })) satisfies TerrainSearchAnchor[];
}

function buildAroundStatementsForTerrains(
  selectors: ReadonlyArray<{ key: string; value?: string }>,
  terrains: TerrainFeature[],
) {
  return terrains
    .flatMap((terrain) =>
      selectors.map((selector) => {
        const filter = selector.value
          ? `["${selector.key}"="${selector.value}"]`
          : `["${selector.key}"]`;

        return `way${filter}(around:${terrainProbeRadius(terrain)},${terrain.center.lat},${terrain.center.lng});`;
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

async function fetchTerrainObstaclesForProvince(
  provinceId: ProvinceId,
  terrains: TerrainFeature[],
  reporter?: ProgressReporter,
): Promise<TerrainObstacleLookup> {
  if (terrains.length === 0) {
    return {
      buildings: [],
      urbanAreas: [],
      roads: [],
      warning: null,
    };
  }

  const terrainChunks = chunkArray(terrains, TERRAINS_PER_OBSTACLE_CHUNK);
  const province = PROVINCE_MAP[provinceId];
  const buildingMap = new Map<string, PreparedPolygonObstacle>();
  const urbanAreaMap = new Map<string, PreparedPolygonObstacle>();
  const roadMap = new Map<string, PreparedLineObstacle>();
  let warning: string | null = null;

  reportProgress(
    reporter,
    `${province.name}: verifica edifici, urbanizzato e strade su ${terrainChunks.length} blocchi di terreni.`,
  );

  for (const [index, terrainChunk] of terrainChunks.entries()) {
    reportProgress(
      reporter,
      `${province.name}: blocco filtri ${index + 1}/${terrainChunks.length} su ${terrainChunk.length} terreni.`,
    );
    const query = `
[out:json][timeout:45];
(
${buildAroundStatementsForTerrains([{ key: "building" }], terrainChunk)}
${buildAroundStatementsForTerrains(URBAN_AREA_SELECTORS, terrainChunk)}
${buildAroundStatementsForTerrains(ROAD_SELECTORS, terrainChunk)}
);
out geom;
`;

    try {
      const data = await fetchOverpass(
        query,
        reporter,
        `${province.name} filtri blocco ${index + 1}/${terrainChunks.length}`,
      );

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
    } catch (error) {
      if (error instanceof OverpassRateLimitError) {
        warning = `${province.name}: filtro anti-urbano completato parzialmente per rate limit Overpass al blocco ${index + 1}/${terrainChunks.length}.`;
        reportProgress(reporter, warning);
        break;
      }

      throw error;
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

async function fetchAgriculturalWaysNearSources(
  provinceId: ProvinceId,
  provinceSources: SourceFeature[],
  reporter?: ProgressReporter,
) {
  if (provinceSources.length === 0) {
    return {
      ways: [] as OverpassElement[],
      warning: null as string | null,
    };
  }

  const terrainAnchors = buildTerrainSearchAnchors(provinceSources);
  const anchorChunks = chunkArray(terrainAnchors, ANCHORS_PER_AGRI_CHUNK);
  const allElements: OverpassElement[] = [];
  const province = PROVINCE_MAP[provinceId];
  let warning: string | null = null;

  reportProgress(
    reporter,
    `${province.name}: fonti aggregate in ${terrainAnchors.length} ancore di ricerca.`,
  );

  reportProgress(
    reporter,
    `${province.name}: avvio ricerca poligoni agricoli vicini alle fonti in ${anchorChunks.length} blocchi.`,
  );

  for (const [index, anchorChunk] of anchorChunks.entries()) {
    const chunkSourceCount = anchorChunk.reduce(
      (sum, anchor) => sum + anchor.sourceIds.length,
      0,
    );
    reportProgress(
      reporter,
      `${province.name}: blocco terreni ${index + 1}/${anchorChunks.length} su ${anchorChunk.length} ancore e ${chunkSourceCount} fonti.`,
    );
    const query = `
[out:json][timeout:45];
(
${buildAroundStatements(AGRICULTURAL_SELECTORS, anchorChunk)}
);
out geom;
`;

    try {
      const data = await fetchOverpass(
        query,
        reporter,
        `${province.name} terreni blocco ${index + 1}/${anchorChunks.length}`,
      );
      allElements.push(...data.elements);
    } catch (error) {
      if (error instanceof OverpassRateLimitError) {
        warning = `${province.name}: scansione terreni completata parzialmente per rate limit Overpass al blocco ${index + 1}/${anchorChunks.length}.`;
        reportProgress(reporter, warning);
        break;
      }

      throw error;
    }
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

  return {
    ways,
    warning,
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

    if (isTerrainHardExcluded(tags)) {
      return null;
    }

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
  const terrainLookup =
    sources.length === 0
      ? {
          ways: [] as OverpassElement[],
          warning: null as string | null,
        }
      : await fetchAgriculturalWaysNearSources(provinceId, sources, reporter);

  reportProgress(
    reporter,
    `${province.name}: calcolo prossimità terreno-fonte su ${terrainLookup.ways.length} poligoni.`,
  );

  const terrainCandidates = terrainLookup.ways
    .map((element) => computeTerrainCandidate(provinceId, element, sources))
    .filter((terrain): terrain is TerrainFeature => terrain !== null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  reportProgress(
    reporter,
    `${province.name}: terreni preliminari prima del filtro urbano ${terrainCandidates.length}.`,
  );

  const obstacleLookup = await fetchTerrainObstaclesForProvince(
    provinceId,
    terrainCandidates,
    reporter,
  );
  const terrainFilter = filterTerrainsByObstacles(
    terrainCandidates,
    obstacleLookup,
    reporter,
  );
  const terrains = terrainFilter.terrains
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  reportProgress(
    reporter,
    `${province.name}: terreni agricoli nel raggio trovati ${terrains.length}.`,
  );

  return {
    sources,
    terrains,
    warnings: [terrainLookup.warning, obstacleLookup.warning].filter(
      (warning): warning is string => Boolean(warning),
    ),
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

  const scanCacheKey = buildScanCacheKey(provinces, categories);
  const cachedScanResult = scanResultCache.get(scanCacheKey);

  if (cachedScanResult && cachedScanResult.expiresAt > Date.now()) {
    reportProgress(
      reporter,
      "Uso un risultato recente già disponibile per evitare nuova pressione su Overpass.",
    );
    return cloneScanResponse(cachedScanResult.value);
  }

  reportProgress(
    reporter,
    `Scansione avviata su ${provinces.length} province e ${categories.length} categorie.`,
  );

  try {
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
    warnings.push(...provinceResults.flatMap((result) => result.warnings));

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
      },
    } satisfies ScanResponse;

    scanResultCache.set(scanCacheKey, {
      expiresAt: Date.now() + SCAN_RESULT_CACHE_TTL_MS,
      value: cloneScanResponse(result),
    });

    return result;
  } catch (error) {
    if (
      cachedScanResult?.value &&
      isRecoverableOverpassError(error)
    ) {
      reportProgress(
        reporter,
        "Le sorgenti pubbliche sono sature: restituisco l'ultimo risultato utile disponibile da cache.",
      );

      const cachedResult = cloneScanResponse(cachedScanResult.value);
      cachedResult.meta.queryAt = new Date().toISOString();
      cachedResult.meta.warnings = [
        "Risultato restituito da cache precedente perché Overpass è temporaneamente saturo.",
        ...cachedResult.meta.warnings,
      ];

      return cachedResult;
    }

    throw error;
  }
}
