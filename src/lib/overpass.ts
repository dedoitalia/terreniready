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
  ScanResponse,
  SourceCategoryId,
  SourceFeature,
  TerrainFeature,
} from "@/types/scan";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const SEARCH_RADIUS_METERS = 350;
const MAX_TERRAINS = 250;

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

async function fetchOverpass(query: string): Promise<OverpassResponse> {
  let lastError: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
        },
        body: query,
      });

      if (!response.ok) {
        throw new Error(`${endpoint} responded with ${response.status}`);
      }

      const json = (await response.json()) as OverpassResponse;

      if (!Array.isArray(json.elements)) {
        throw new Error(`${endpoint} returned an invalid payload`);
      }

      return json;
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error("Unknown Overpass error");
    }
  }

  throw lastError ?? new Error("No Overpass endpoint available");
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

async function fetchSourcesForCategory(
  provinceId: ProvinceId,
  categoryId: SourceCategoryId,
) {
  const province = PROVINCE_MAP[provinceId];
  const category = SOURCE_CATEGORY_MAP[categoryId];
  const query = `
[out:json][timeout:40];
(
${buildSelectorStatements(category.selectors, province.bbox, ["node", "way"])}
);
out center;
`;

  const data = await fetchOverpass(query);

  return data.elements
    .map((element) => {
      const coordinates = sourceCoordinates(element);
      const tags = element.tags ?? {};

      if (!coordinates) {
        return null;
      }

      return {
        id: `${element.type}-${element.id}`,
        osmId: element.id,
        osmType: element.type,
        provinceId,
        name:
          tags.name ||
          tags.brand ||
          `${category.label.slice(0, -1)} ${element.type.toUpperCase()} ${element.id}`,
        primaryCategoryId: categoryId,
        categoryIds: [categoryId],
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        address: formatAddress(tags),
        tags,
      } satisfies SourceFeature;
    })
    .filter((source): source is SourceFeature => source !== null);
}

async function fetchAgriculturalWays(provinceId: ProvinceId) {
  const province = PROVINCE_MAP[provinceId];
  const query = `
[out:json][timeout:60];
(
${buildSelectorStatements(AGRICULTURAL_SELECTORS, province.bbox, ["way"])}
);
out geom;
`;

  const data = await fetchOverpass(query);

  return data.elements;
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
) {
  const sourceResponses = await Promise.all(
    categoryIds.map((categoryId) => fetchSourcesForCategory(provinceId, categoryId)),
  );

  const sources = mergeSources(sourceResponses.flat()).sort((left, right) =>
    left.name.localeCompare(right.name, "it"),
  );
  const landWays = await fetchAgriculturalWays(provinceId);

  const terrains = landWays
    .map((element) => computeTerrainCandidate(provinceId, element, sources))
    .filter((terrain): terrain is TerrainFeature => terrain !== null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  return {
    sources,
    terrains,
  };
}

export async function runScan(
  provinceIds: ProvinceId[],
  categoryIds: SourceCategoryId[],
): Promise<ScanResponse> {
  const warnings: string[] = [];
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

  const provinceResults = await Promise.all(
    provinces.map((provinceId) => scanProvince(provinceId, categories)),
  );

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
