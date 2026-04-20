import {
  area,
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
const CADASTRAL_EMPTY_BBOX_SPLIT_DEPTH = 2;
const CADASTRAL_WFS_PAGE_SIZE = 200;
const CADASTRAL_WFS_MAX_PAGES = 6;
const CADASTRAL_WFS_CACHE_TTL_MS = 45 * 60 * 1000;

type ProgressReporter = (event: ScanProgressEvent) => void;

type TerrainSearchAnchor = {
  id: string;
  lat: number;
  lng: number;
  probeRadiusMeters: number;
  sourceIds: string[];
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
  const sourceById = new Map(sources.map((source) => [source.id, source]));

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

  return anchors.map((anchor, index) => ({
    id: `cad-anchor-${index + 1}`,
    lat: anchor.lat,
    lng: anchor.lng,
    probeRadiusMeters: Math.min(
      SEARCH_RADIUS_METERS * 2,
      Math.ceil(SEARCH_RADIUS_METERS + anchor.maxDistanceMeters),
    ),
    sourceIds: anchor.sourceIds,
  })) satisfies TerrainSearchAnchor[];
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

  return { south, west, north, east };
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
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
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

async function fetchParcelsForAnchorChunk(
  provinceName: string,
  blockLabel: string,
  anchors: TerrainSearchAnchor[],
  remainingSplits: number,
  reporter?: ProgressReporter,
): Promise<AnchorChunkFetchResult> {
  const bbox = bboxForAnchorChunk(anchors);
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

  if (parcelMap.size === 0 && anchors.length > 1 && remainingSplits > 0) {
    const midpoint = Math.ceil(anchors.length / 2);
    const leftAnchors = anchors.slice(0, midpoint);
    const rightAnchors = anchors.slice(midpoint);

    reportProgress(
      reporter,
      `${provinceName}: blocco particelle ${blockLabel} vuoto su bbox aggregato, lo suddivido.`,
    );

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
      hitPageCap: hitPageCap || leftResult.hitPageCap || rightResult.hitPageCap,
    };
  }

  return {
    parcels: Array.from(parcelMap.values()),
    hitPageCap,
  };
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

function computeTerrainFromParcel(
  provinceId: ProvinceId,
  parcel: CadastralParcelFeature,
  sources: SourceFeature[],
): TerrainFeature | null {
  try {
    const poly = polygon([parcel.coordinates]);
    const centroid = centerOfMass(poly).geometry.coordinates;
    const lats = parcel.coordinates.map((coordinate) => coordinate[1]);
    const lngs = parcel.coordinates.map((coordinate) => coordinate[0]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    let closestSource: SourceFeature | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    let sourceCountInRange = 0;

    for (const source of sources) {
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

    const foglio = parcelFoglio(parcel.nationalReference);

    return {
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
      areaSqm: Math.round(area(poly)),
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
      },
    } satisfies TerrainFeature;
  } catch {
    return null;
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

  reportProgress(
    reporter,
    `${province.name}: fonti aggregate in ${anchors.length} ancore catastali.`,
  );
  reportProgress(
    reporter,
    `${province.name}: avvio ricerca particelle catastali nel raggio in ${anchorChunks.length} blocchi.`,
  );

  for (const [chunkIndex, anchorChunk] of anchorChunks.entries()) {
    const chunkSourceCount = anchorChunk.reduce(
      (sum, anchor) => sum + anchor.sourceIds.length,
      0,
    );
    reportProgress(
      reporter,
      `${province.name}: blocco particelle ${chunkIndex + 1}/${anchorChunks.length} su ${anchorChunk.length} ancore e ${chunkSourceCount} fonti.`,
    );

    const chunkResult = await fetchParcelsForAnchorChunk(
      province.name,
      `${chunkIndex + 1}/${anchorChunks.length}`,
      anchorChunk,
      CADASTRAL_EMPTY_BBOX_SPLIT_DEPTH,
      reporter,
    );

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
    .filter((terrain): terrain is TerrainFeature => terrain !== null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  reportProgress(
    reporter,
    `${province.name}: particelle catastali nel raggio trovate ${terrains.length}.`,
  );

  return {
    terrains,
    warning,
  };
}
