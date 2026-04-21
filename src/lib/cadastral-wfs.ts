import {
  area,
  booleanPointInPolygon,
  centerOfMass,
  distance,
  point,
  pointToPolygonDistance,
  polygon,
} from "@turf/turf";
import { XMLParser } from "fast-xml-parser";

import { PROVINCE_MAP } from "@/lib/province-data";
import type {
  ProvinceId,
  ScanProgressEvent,
  SourceFeature,
  TerrainFeature,
} from "@/types/scan";

const CADASTRAL_WFS_BASE_URL =
  "https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php";
const SEARCH_RADIUS_METERS = 350;
const BASE_TERRAIN_SOURCE_CLUSTER_RADIUS_METERS = 225;
const CADASTRAL_ANCHORS_PER_CHUNK = 10;
const CADASTRAL_BBOX_SPLIT_DEPTH = 3;
const CADASTRAL_WFS_PAGE_SIZE = 200;
// Max pagine WFS per bbox prima di innescare il split bbox ricorsivo e
// il warning "copertura parziale". A 10 pagine copriamo fino a 2000
// particelle per bbox, sufficiente per tutte le aree toscane escluse
// Firenze centro. Con 4 chunk paralleli il worst-case resta contenuto.
const CADASTRAL_WFS_MAX_PAGES = 10;
const CADASTRAL_WFS_CACHE_TTL_MS = 45 * 60 * 1000;
// Il WFS Agenzia Entrate e` un servizio diverso da Overpass: ha rate
// limit autonomi e non mostra 429 aggressivi come OSM. Mandare piu
// chunk in parallelo taglia la pagina cadastrale che di solito e` il
// bottleneck di una scansione (piu lento della parte OSM).
//
// Default 4 parallele; tunabile via env TERRENI_CADASTRAL_CONCURRENCY.
const CADASTRAL_CHUNK_CONCURRENCY = parsePositiveIntegerEnvCadastral(
  "TERRENI_CADASTRAL_CONCURRENCY",
  4,
);
const MIN_PARCEL_AREA_SQM = 250;
const TECHNICAL_PARCEL_MIN_SPAN_METERS = 12;
const TECHNICAL_PARCEL_ASPECT_RATIO = 8;
const TECHNICAL_PARCEL_MIN_FILL_RATIO = 0.16;
const TECHNICAL_PARCEL_MIN_COMPACTNESS = 0.06;

// Un solo parser XML riutilizzato su tutte le pagine WFS: istanziarlo per
// ogni pagina e` uno spreco perche la config e` invariata.
const CADASTRAL_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

type ProgressReporter = (event: ScanProgressEvent) => void;

type TerrainSearchAnchor = {
  id: string;
  lat: number;
  lng: number;
  probeRadiusMeters: number;
  sourceIds: string[];
};

type CadastralBoundingBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

type CadastralParcelFeature = {
  id: string;
  administrativeUnit: string;
  nationalReference: string;
  label: string;
  coordinates: Array<[number, number]>;
};

type CachedWfsValue = {
  expiresAt: number;
  value: {
    parcels: CadastralParcelFeature[];
    nextUrl: string | null;
  };
};

type TerrainResolution =
  | {
      terrain: TerrainFeature;
      rejectReason: null;
    }
  | {
      terrain: null;
      rejectReason:
        | "outside-buffer"
        | "contains-source"
        | "technical-shape"
        | "invalid-geometry";
    };

type ParcelShapeMetrics = {
  areaSqm: number;
  minSpanMeters: number;
  maxSpanMeters: number;
  aspectRatio: number;
  fillRatio: number;
  compactness: number;
  technical: boolean;
};

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

// parsePositiveIntegerEnv duplicato volutamente qui: tenere cadastral-wfs
// auto-contenuto evita import ciclico con overpass.ts.
function parsePositiveIntegerEnvCadastral(key: string, fallback: number) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// Launcher parallelo con limite di concorrenza. Preserva l'ordine dei
// risultati (results[i] corrisponde a tasks[i]). Ogni worker tira la
// prossima task disponibile appena finisce la precedente.
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
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

const wfsCache = getGlobalStore<Map<string, CachedWfsValue>>(
  "__terreniReadyCadastralWfsCache",
  () => new Map(),
);
const wfsInflight = getGlobalStore<
  Map<string, Promise<{ parcels: CadastralParcelFeature[]; nextUrl: string | null }>>
>("__terreniReadyCadastralWfsInflight", () => new Map());

function reportProgress(reporter: ProgressReporter | undefined, message: string) {
  reporter?.({ message });
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function terrainClusterRadiusForSourceCount() {
  return BASE_TERRAIN_SOURCE_CLUSTER_RADIUS_METERS;
}

function buildTerrainSearchAnchors(sources: SourceFeature[]) {
  const clusterRadiusMeters = terrainClusterRadiusForSourceCount();
  const anchors: Array<{
    lat: number;
    lng: number;
    sourceIds: string[];
    maxDistanceMeters: number;
  }> = [];
  const spatialSources = [...sources].sort((left, right) => {
    const latDelta = left.latitude - right.latitude;

    if (Math.abs(latDelta) > 0.015) {
      return latDelta;
    }

    return left.longitude - right.longitude;
  });
  const sourceById = new Map(spatialSources.map((source) => [source.id, source]));

  for (const source of spatialSources) {
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
        anchorDistance <= clusterRadiusMeters &&
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
      const member = sourceById.get(sourceId);

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

  return anchors
    .map((anchor, index) => ({
      id: `cad-anchor-${index + 1}`,
      lat: anchor.lat,
      lng: anchor.lng,
      probeRadiusMeters: Math.min(
        SEARCH_RADIUS_METERS * 2,
        Math.ceil(SEARCH_RADIUS_METERS + anchor.maxDistanceMeters),
      ),
      sourceIds: anchor.sourceIds,
    }))
    .sort((left, right) => {
      const latDelta = left.lat - right.lat;

      if (Math.abs(latDelta) > 0.015) {
        return latDelta;
      }

      return left.lng - right.lng;
    }) satisfies TerrainSearchAnchor[];
}

function metersToLatDegrees(meters: number) {
  return meters / 111_320;
}

function metersToLngDegrees(meters: number, latitude: number) {
  return meters / (111_320 * Math.cos((latitude * Math.PI) / 180));
}

function buildWfsUrl(
  south: number,
  west: number,
  north: number,
  east: number,
) {
  const params = new URLSearchParams({
    language: "ita",
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    TYPENAMES: "CP:CadastralParcel",
    SRSNAME: "urn:ogc:def:crs:EPSG::6706",
    BBOX: `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`,
    COUNT: String(CADASTRAL_WFS_PAGE_SIZE),
  });

  return `${CADASTRAL_WFS_BASE_URL}?${params.toString()}`;
}

function bboxForAnchorChunk(anchors: TerrainSearchAnchor[]) {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;

  for (const anchor of anchors) {
    const latDelta = metersToLatDegrees(anchor.probeRadiusMeters);
    const lngDelta = metersToLngDegrees(anchor.probeRadiusMeters, anchor.lat);

    south = Math.min(south, anchor.lat - latDelta);
    west = Math.min(west, anchor.lng - lngDelta);
    north = Math.max(north, anchor.lat + latDelta);
    east = Math.max(east, anchor.lng + lngDelta);
  }

  return { south, west, north, east } satisfies CadastralBoundingBox;
}

function splitAnchorChunk(anchors: TerrainSearchAnchor[]) {
  if (anchors.length <= 1) {
    return [anchors, []] satisfies [TerrainSearchAnchor[], TerrainSearchAnchor[]];
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
  ] satisfies [TerrainSearchAnchor[], TerrainSearchAnchor[]];
}

function splitBoundingBox(bbox: CadastralBoundingBox) {
  const latSpan = bbox.north - bbox.south;
  const lngSpan = bbox.east - bbox.west;

  if (latSpan >= lngSpan) {
    const midLat = bbox.south + latSpan / 2;

    return [
      {
        south: bbox.south,
        west: bbox.west,
        north: midLat,
        east: bbox.east,
      },
      {
        south: midLat,
        west: bbox.west,
        north: bbox.north,
        east: bbox.east,
      },
    ] satisfies CadastralBoundingBox[];
  }

  const midLng = bbox.west + lngSpan / 2;

  return [
    {
      south: bbox.south,
      west: bbox.west,
      north: bbox.north,
      east: midLng,
    },
    {
      south: bbox.south,
      west: midLng,
      north: bbox.north,
      east: bbox.east,
    },
  ] satisfies CadastralBoundingBox[];
}

function parsePosList(raw: unknown) {
  const value =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "#text" in raw
        ? String((raw as { "#text": string })["#text"])
        : "";

  const numbers = value
    .trim()
    .split(/\s+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));

  const coordinates: Array<[number, number]> = [];

  for (let index = 0; index < numbers.length; index += 2) {
    const lat = numbers[index];
    const lng = numbers[index + 1];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    coordinates.push([lng, lat]);
  }

  if (coordinates.length < 4) {
    return null;
  }

  const [firstLng, firstLat] = coordinates[0];
  const [lastLng, lastLat] = coordinates[coordinates.length - 1];

  if (firstLng !== lastLng || firstLat !== lastLat) {
    coordinates.push([firstLng, firstLat]);
  }

  return coordinates;
}

function polygonCoordinatesFromParcel(parcel: Record<string, unknown>) {
  const geometry = parcel["CP:msGeometry"];

  if (!geometry || typeof geometry !== "object") {
    return null;
  }

  const polygonNode =
    "gml:Polygon" in geometry
      ? (geometry["gml:Polygon"] as Record<string, unknown>)
      : null;

  if (!polygonNode || !polygonNode["gml:exterior"]) {
    return null;
  }

  const exterior = polygonNode["gml:exterior"] as Record<string, unknown>;
  const ring = exterior["gml:LinearRing"] as Record<string, unknown>;

  if (!ring || !ring["gml:posList"]) {
    return null;
  }

  return parsePosList(ring["gml:posList"]);
}

function normalizeMembers(members: unknown) {
  if (!members) {
    return [];
  }

  return Array.isArray(members) ? members : [members];
}

function parseCadastralResponse(xml: string) {
  const parsed = CADASTRAL_XML_PARSER.parse(xml);
  const collection = parsed["wfs:FeatureCollection"] as
    | Record<string, unknown>
    | undefined;

  if (!collection) {
    return {
      parcels: [] as CadastralParcelFeature[],
      nextUrl: null as string | null,
    };
  }

  const parcels = normalizeMembers(collection["wfs:member"])
    .map((member) => {
      const parcel = (member as Record<string, unknown>)["CP:CadastralParcel"] as
        | Record<string, unknown>
        | undefined;

      if (!parcel) {
        return null;
      }

      const coordinates = polygonCoordinatesFromParcel(parcel);
      const label = String(parcel["CP:LABEL"] ?? "").trim();
      const administrativeUnit = String(parcel["CP:ADMINISTRATIVEUNIT"] ?? "").trim();
      const nationalReference = String(
        parcel["CP:NATIONALCADASTRALREFERENCE"] ?? "",
      ).trim();
      const localId = String(parcel["CP:INSPIREID_LOCALID"] ?? "").trim();

      if (
        !coordinates ||
        !label ||
        !administrativeUnit ||
        !nationalReference ||
        !localId
      ) {
        return null;
      }

      return {
        id: localId,
        administrativeUnit,
        nationalReference,
        label,
        coordinates,
      } satisfies CadastralParcelFeature;
    })
    .filter((parcel): parcel is CadastralParcelFeature => parcel !== null);

  return {
    parcels,
    nextUrl:
      typeof collection["@_next"] === "string" ? String(collection["@_next"]) : null,
  };
}

async function fetchWfsPage(url: string) {
  const cached = wfsCache.get(url);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const inflight = wfsInflight.get(url);

  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5",
        "User-Agent":
          "TerreniReady/0.1 (+https://terreniready.onrender.com; repo:https://github.com/dedoitalia/terreniready)",
      },
    });

    if (!response.ok) {
      throw new Error(`Cadastral WFS responded with ${response.status}`);
    }

    const xml = await response.text();
    const parsed = parseCadastralResponse(xml);

    wfsCache.set(url, {
      expiresAt: Date.now() + CADASTRAL_WFS_CACHE_TTL_MS,
      value: parsed,
    });

    return parsed;
  })();

  wfsInflight.set(url, requestPromise);

  try {
    return await requestPromise;
  } finally {
    wfsInflight.delete(url);
  }
}

type AnchorChunkFetchResult = {
  parcels: CadastralParcelFeature[];
  hitPageCap: boolean;
};

async function fetchParcelsForBoundingBoxOnce(
  provinceName: string,
  blockLabel: string,
  bbox: CadastralBoundingBox,
  reporter?: ProgressReporter,
) {
  const parcelMap = new Map<string, CadastralParcelFeature>();
  let nextUrl: string | null = buildWfsUrl(
    bbox.south,
    bbox.west,
    bbox.north,
    bbox.east,
  );
  let pageCount = 0;
  let hitPageCap = false;

  while (nextUrl && pageCount < CADASTRAL_WFS_MAX_PAGES) {
    pageCount += 1;
    reportProgress(
      reporter,
      `${provinceName}: particelle catastali blocco ${blockLabel}, pagina ${pageCount}.`,
    );
    const page = await fetchWfsPage(nextUrl);

    for (const parcel of page.parcels) {
      parcelMap.set(parcel.id, parcel);
    }

    nextUrl = page.nextUrl;
  }

  if (nextUrl) {
    hitPageCap = true;
  }

  return {
    parcels: Array.from(parcelMap.values()),
    hitPageCap,
  } satisfies AnchorChunkFetchResult;
}

async function fetchParcelsForAnchorChunk(
  provinceName: string,
  blockLabel: string,
  anchors: TerrainSearchAnchor[],
  remainingSplits: number,
  reporter?: ProgressReporter,
): Promise<AnchorChunkFetchResult> {
  const bbox = bboxForAnchorChunk(anchors);
  const chunkResult = await fetchParcelsForBoundingBoxOnce(
    provinceName,
    blockLabel,
    bbox,
    reporter,
  );

  if (remainingSplits <= 0) {
    return chunkResult;
  }

  if (chunkResult.hitPageCap && anchors.length > 1) {
    reportProgress(
      reporter,
      `${provinceName}: blocco particelle ${blockLabel} supera la paginazione WFS, lo divido per gruppi di ancore.`,
    );

    const [leftAnchors, rightAnchors] = splitAnchorChunk(anchors);

    const [leftResult, rightResult] = await Promise.all([
      fetchParcelsForAnchorChunk(
        provinceName,
        `${blockLabel}.a`,
        leftAnchors,
        remainingSplits - 1,
        reporter,
      ),
      fetchParcelsForAnchorChunk(
        provinceName,
        `${blockLabel}.b`,
        rightAnchors,
        remainingSplits - 1,
        reporter,
      ),
    ]);

    return {
      parcels: [...leftResult.parcels, ...rightResult.parcels],
      hitPageCap:
        chunkResult.hitPageCap ||
        leftResult.hitPageCap ||
        rightResult.hitPageCap,
    };
  }

  if (chunkResult.parcels.length === 0 && anchors.length > 1) {
    reportProgress(
      reporter,
      `${provinceName}: blocco particelle ${blockLabel} vuoto su bbox aggregato, verifico le ancore singolarmente.`,
    );
    const anchorResults: AnchorChunkFetchResult[] = [];

    for (const [anchorIndex, anchor] of anchors.entries()) {
      anchorResults.push(
        await fetchParcelsForAnchorChunk(
          provinceName,
          `${blockLabel}.${anchorIndex + 1}`,
          [anchor],
          remainingSplits - 1,
          reporter,
        ),
      );
    }

    return {
      parcels: anchorResults.flatMap((result) => result.parcels),
      hitPageCap: anchorResults.some((result) => result.hitPageCap),
    };
  }

  if ((chunkResult.parcels.length === 0 || chunkResult.hitPageCap) && remainingSplits > 0) {
    return fetchParcelsForBoundingBox(
      provinceName,
      blockLabel,
      bbox,
      remainingSplits - 1,
      reporter,
      chunkResult,
    );
  }

  return chunkResult;
}

async function fetchParcelsForBoundingBox(
  provinceName: string,
  blockLabel: string,
  bbox: CadastralBoundingBox,
  remainingSplits: number,
  reporter?: ProgressReporter,
  initialResult?: AnchorChunkFetchResult,
): Promise<AnchorChunkFetchResult> {
  const chunkResult =
    initialResult ??
    (await fetchParcelsForBoundingBoxOnce(
      provinceName,
      blockLabel,
      bbox,
      reporter,
    ));

  if ((chunkResult.parcels.length === 0 || chunkResult.hitPageCap) && remainingSplits > 0) {
    const splitReason =
      chunkResult.parcels.length === 0
        ? "vuoto su bbox aggregato"
        : `tronco oltre ${CADASTRAL_WFS_MAX_PAGES} pagine`;

    reportProgress(
      reporter,
      `${provinceName}: blocco particelle ${blockLabel} ${splitReason}, lo suddivido.`,
    );

    const [leftBox, rightBox] = splitBoundingBox(bbox);

    const [leftResult, rightResult] = await Promise.all([
      fetchParcelsForBoundingBox(
        provinceName,
        `${blockLabel}.a`,
        leftBox,
        remainingSplits - 1,
        reporter,
      ),
      fetchParcelsForBoundingBox(
        provinceName,
        `${blockLabel}.b`,
        rightBox,
        remainingSplits - 1,
        reporter,
      ),
    ]);

    return {
      parcels: [...leftResult.parcels, ...rightResult.parcels],
      hitPageCap:
        chunkResult.hitPageCap || leftResult.hitPageCap || rightResult.hitPageCap,
    };
  }

  return chunkResult;
}

function parcelFoglio(reference: string) {
  const match = reference.match(/^[A-Z0-9]+_(\d{4})/i);
  return match?.[1] ?? "n.d.";
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

function polygonPerimeterMeters(coords: Array<[number, number]>) {
  let perimeter = 0;

  for (let index = 0; index < coords.length - 1; index += 1) {
    perimeter += distance(point(coords[index]), point(coords[index + 1]), {
      units: "meters",
    });
  }

  return perimeter;
}

function parcelShapeMetrics(
  coords: Array<[number, number]>,
  areaSqm: number,
  minLat: number,
  minLng: number,
  maxLat: number,
  maxLng: number,
) {
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;
  const bboxWidthMeters = distance(point([minLng, midLat]), point([maxLng, midLat]), {
    units: "meters",
  });
  const bboxHeightMeters = distance(point([midLng, minLat]), point([midLng, maxLat]), {
    units: "meters",
  });
  const minSpanMeters = Math.max(0.5, Math.min(bboxWidthMeters, bboxHeightMeters));
  const maxSpanMeters = Math.max(bboxWidthMeters, bboxHeightMeters);
  const aspectRatio = maxSpanMeters / minSpanMeters;
  const bboxAreaSqm = Math.max(1, bboxWidthMeters * bboxHeightMeters);
  const fillRatio = areaSqm / bboxAreaSqm;
  const perimeterMeters = Math.max(1, polygonPerimeterMeters(coords));
  const compactness = (4 * Math.PI * areaSqm) / (perimeterMeters * perimeterMeters);
  const technical =
    areaSqm < MIN_PARCEL_AREA_SQM ||
    (minSpanMeters < TECHNICAL_PARCEL_MIN_SPAN_METERS &&
      aspectRatio >= TECHNICAL_PARCEL_ASPECT_RATIO) ||
    (fillRatio < TECHNICAL_PARCEL_MIN_FILL_RATIO &&
      compactness < TECHNICAL_PARCEL_MIN_COMPACTNESS) ||
    (minSpanMeters < 8 && maxSpanMeters > 60) ||
    (compactness < 0.03 && aspectRatio > 5.5);

  return {
    areaSqm,
    minSpanMeters,
    maxSpanMeters,
    aspectRatio,
    fillRatio,
    compactness,
    technical,
  } satisfies ParcelShapeMetrics;
}

function computeTerrainFromParcel(
  provinceId: ProvinceId,
  parcel: CadastralParcelFeature,
  sources: SourceFeature[],
): TerrainResolution {
  try {
    const poly = polygon([parcel.coordinates]);
    const centroid = centerOfMass(poly).geometry.coordinates;
    const areaSqm = Math.round(area(poly));
    const lats = parcel.coordinates.map((coordinate) => coordinate[1]);
    const lngs = parcel.coordinates.map((coordinate) => coordinate[0]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const shapeMetrics = parcelShapeMetrics(
      parcel.coordinates,
      areaSqm,
      minLat,
      minLng,
      maxLat,
      maxLng,
    );

    if (shapeMetrics.technical) {
      return {
        terrain: null,
        rejectReason: "technical-shape",
      };
    }

    let closestSource: SourceFeature | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    let sourceCountInRange = 0;
    let sourceInsideParcel = false;

    for (const source of sources) {
      if (!sourceCandidatePrefilter(source, minLat, minLng, maxLat, maxLng)) {
        continue;
      }

      const sourcePoint = point([source.longitude, source.latitude]);

      if (booleanPointInPolygon(sourcePoint, poly)) {
        sourceInsideParcel = true;
        continue;
      }

      const distanceMeters = pointToPolygonDistance(sourcePoint, poly, {
        units: "meters",
      });

      if (Number.isNaN(distanceMeters)) {
        continue;
      }

      const normalizedDistance = Math.max(0, distanceMeters);

      if (normalizedDistance <= SEARCH_RADIUS_METERS) {
        sourceCountInRange += 1;
      }

      if (normalizedDistance < closestDistance) {
        closestDistance = normalizedDistance;
        closestSource = source;
      }
    }

    if (sourceInsideParcel) {
      return {
        terrain: null,
        rejectReason: "contains-source",
      };
    }

    if (!closestSource || closestDistance > SEARCH_RADIUS_METERS) {
      return {
        terrain: null,
        rejectReason: "outside-buffer",
      };
    }

    const foglio = parcelFoglio(parcel.nationalReference);

    return {
      terrain: {
        id: `${provinceId}-parcel-${parcel.id}`,
        osmId: null,
        osmType: "way",
        provinceId,
        name: `Particella ${foglio}/${parcel.label}`,
        landuse: "cadastral_parcel",
        center: {
          lat: centroid[1],
          lng: centroid[0],
        },
        coordinates: parcel.coordinates,
        distanceMeters: closestDistance,
        areaSqm,
        closestSourceId: closestSource.id,
        closestSourceName: closestSource.name,
        closestSourceCategoryId: closestSource.primaryCategoryId,
        sourceCountInRange,
        dataProvider: "cadastre",
        providerLabel: "Agenzia delle Entrate WFS",
        referenceUrl: null,
        tags: {
          administrativeUnit: parcel.administrativeUnit,
          nationalCadastralReference: parcel.nationalReference,
          label: parcel.label,
          foglio,
          minSpanMeters: Math.round(shapeMetrics.minSpanMeters).toString(),
          maxSpanMeters: Math.round(shapeMetrics.maxSpanMeters).toString(),
          aspectRatio: shapeMetrics.aspectRatio.toFixed(2),
          fillRatio: shapeMetrics.fillRatio.toFixed(2),
          compactness: shapeMetrics.compactness.toFixed(3),
        },
      },
      rejectReason: null,
    };
  } catch {
    return {
      terrain: null,
      rejectReason: "invalid-geometry",
    };
  }
}

export async function fetchCadastralTerrainsNearSources(
  provinceId: ProvinceId,
  sources: SourceFeature[],
  reporter?: ProgressReporter,
) {
  if (sources.length === 0) {
    return {
      terrains: [] as TerrainFeature[],
      warning: null as string | null,
    };
  }

  const province = PROVINCE_MAP[provinceId];
  const anchors = buildTerrainSearchAnchors(sources);
  const anchorChunks = chunkArray(anchors, CADASTRAL_ANCHORS_PER_CHUNK);
  const parcelMap = new Map<string, CadastralParcelFeature>();
  let hitPageCap = false;
  let rejectedTechnicalShape = 0;
  let rejectedContainingSource = 0;

  reportProgress(
    reporter,
    `${province.name}: fonti aggregate in ${anchors.length} ancore catastali.`,
  );
  reportProgress(
    reporter,
    `${province.name}: avvio ricerca particelle catastali nel raggio in ${anchorChunks.length} blocchi (concurrency=${Math.min(CADASTRAL_CHUNK_CONCURRENCY, anchorChunks.length)}).`,
  );

  // I chunk sono indipendenti (bbox disgiunti): li lanciamo in parallelo
  // limitando la concurrency al valore configurato. Questo taglia il
  // wall-clock della fase catastale di circa chunks/concurrency.
  const chunkTasks = anchorChunks.map(
    (anchorChunk, chunkIndex) => async () => {
      const chunkSourceCount = anchorChunk.reduce(
        (sum, anchor) => sum + anchor.sourceIds.length,
        0,
      );
      reportProgress(
        reporter,
        `${province.name}: blocco particelle ${chunkIndex + 1}/${anchorChunks.length} avviato (${anchorChunk.length} ancore, ${chunkSourceCount} fonti).`,
      );

      return fetchParcelsForAnchorChunk(
        province.name,
        `${chunkIndex + 1}/${anchorChunks.length}`,
        anchorChunk,
        CADASTRAL_BBOX_SPLIT_DEPTH,
        reporter,
      );
    },
  );

  const chunkResults = await runWithConcurrency(
    chunkTasks,
    CADASTRAL_CHUNK_CONCURRENCY,
  );

  for (const chunkResult of chunkResults) {
    for (const parcel of chunkResult.parcels) {
      parcelMap.set(parcel.id, parcel);
    }
    hitPageCap = hitPageCap || chunkResult.hitPageCap;
  }

  const warning = hitPageCap
    ? `${province.name}: copertura particelle catastali parziale su uno o più blocchi per paginazione WFS oltre ${CADASTRAL_WFS_MAX_PAGES} pagine.`
    : null;

  if (warning) {
    reportProgress(reporter, warning);
  }

  reportProgress(
    reporter,
    `${province.name}: particelle catastali candidate ${parcelMap.size}.`,
  );

  const terrains = Array.from(parcelMap.values())
    .map((parcel) => computeTerrainFromParcel(provinceId, parcel, sources))
    .flatMap((result) => {
      if (result.terrain) {
        return [result.terrain];
      }

      if (result.rejectReason === "technical-shape") {
        rejectedTechnicalShape += 1;
      }

      if (result.rejectReason === "contains-source") {
        rejectedContainingSource += 1;
      }

      return [];
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  if (rejectedTechnicalShape > 0 || rejectedContainingSource > 0) {
    reportProgress(
      reporter,
      `${province.name}: filtro preliminare particelle ha scartato ${rejectedTechnicalShape} geometrie troppo strette/tecniche e ${rejectedContainingSource} particelle che contenevano direttamente la fonte emissiva.`,
    );
  }

  reportProgress(
    reporter,
    `${province.name}: particelle catastali nel raggio trovate ${terrains.length}.`,
  );

  return {
    terrains,
    warning,
  };
}
