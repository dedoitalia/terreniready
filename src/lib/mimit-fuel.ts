import { PROVINCE_MAP } from "@/lib/province-data";
import type { ProvinceId, SourceFeature } from "@/types/scan";

const MIMIT_FUEL_DATASET_URL =
  "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv";
const MIMIT_FUEL_DATASET_PAGE_URL =
  "https://www.mimit.gov.it/index.php/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti";
const MIMIT_FUEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type CachedMimitFuelDataset = {
  expiresAt: number;
  extractedAt: string | null;
  byProvince: Record<ProvinceId, SourceFeature[]>;
};

type MimitFuelStore = {
  cache: CachedMimitFuelDataset | null;
  inflight: Promise<CachedMimitFuelDataset> | null;
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

const mimitFuelStore = getGlobalStore<MimitFuelStore>(
  "__terreniReadyMimitFuelStore",
  () => ({
    cache: null,
    inflight: null,
  }),
);

function parseNumber(value: string | undefined) {
  if (!value) {
    return Number.NaN;
  }

  return Number(value.trim().replace(",", "."));
}

function isInsideProvinceBounds(
  provinceId: ProvinceId,
  latitude: number,
  longitude: number,
) {
  const bbox = PROVINCE_MAP[provinceId].bbox;
  const margin = 0.08;

  return (
    latitude >= bbox.south - margin &&
    latitude <= bbox.north + margin &&
    longitude >= bbox.west - margin &&
    longitude <= bbox.east + margin
  );
}

function parseDataset(text: string) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("Il dataset MIMIT dei carburanti è vuoto.");
  }

  let extractedAt: string | null = null;
  let headerLine = lines[0];
  let dataLines = lines.slice(1);

  if (headerLine.toLowerCase().startsWith("estrazione del")) {
    extractedAt = headerLine.replace(/^Estrazione del\s+/i, "").trim();
    headerLine = lines[1] ?? "";
    dataLines = lines.slice(2);
  }

  const delimiter = headerLine.includes("|")
    ? "|"
    : headerLine.includes(";")
      ? ";"
      : ",";
  const headers = headerLine.split(delimiter).map((header) => header.trim());
  const headerIndex = Object.fromEntries(
    headers.map((header, index) => [header.toLowerCase(), index]),
  ) as Record<string, number>;

  const provinceBuckets = Object.fromEntries(
    Object.keys(PROVINCE_MAP).map((provinceId) => [provinceId, new Map<string, SourceFeature>()]),
  ) as Record<ProvinceId, Map<string, SourceFeature>>;

  for (const line of dataLines) {
    const cells = line.split(delimiter).map((cell) => cell.trim());
    const provinceCode = cells[headerIndex.provincia]?.toUpperCase() as ProvinceId | undefined;

    if (!provinceCode || !(provinceCode in PROVINCE_MAP)) {
      continue;
    }

    const idImpianto = cells[headerIndex.idimpianto];
    const latitude = parseNumber(cells[headerIndex.latitudine]);
    const longitude = parseNumber(cells[headerIndex.longitudine]);

    if (
      !idImpianto ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !isInsideProvinceBounds(provinceCode, latitude, longitude)
    ) {
      continue;
    }

    const comune = cells[headerIndex.comune] ?? "";
    const indirizzo = cells[headerIndex.indirizzo] ?? "";
    const bandiera = cells[headerIndex.bandiera] ?? "";
    const tipoImpianto = cells[headerIndex["tipo impianto"]] ?? "";
    const gestore = cells[headerIndex.gestore] ?? "";
    const nomeImpianto = cells[headerIndex["nome impianto"]] ?? "";
    const name =
      nomeImpianto ||
      [bandiera, comune].filter(Boolean).join(" ") ||
      `Distributore ${idImpianto}`;

    provinceBuckets[provinceCode].set(`mimit-fuel-${idImpianto}`, {
      id: `mimit-fuel-${idImpianto}`,
      osmId: Number(idImpianto),
      osmType: "node",
      provinceId: provinceCode,
      name,
      primaryCategoryId: "fuel",
      categoryIds: ["fuel"],
      latitude,
      longitude,
      address: [indirizzo, comune].filter(Boolean).join(", ") || null,
      dataProvider: "mimit",
      providerLabel: "MIMIT Osservaprezzi carburanti",
      referenceUrl: MIMIT_FUEL_DATASET_PAGE_URL,
      tags: {
        idImpianto,
        gestore,
        bandiera,
        tipoImpianto,
        comune,
        provincia: provinceCode,
      },
    });
  }

  const byProvince = Object.fromEntries(
    Object.entries(provinceBuckets).map(([provinceId, bucket]) => [
      provinceId,
      Array.from(bucket.values()).sort((left, right) =>
        left.name.localeCompare(right.name, "it"),
      ),
    ]),
  ) as Record<ProvinceId, SourceFeature[]>;

  return {
    extractedAt,
    byProvince,
  };
}

async function loadFuelDataset() {
  const cached = mimitFuelStore.cache;

  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const inflight = mimitFuelStore.inflight;

  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
    const response = await fetch(MIMIT_FUEL_DATASET_URL, {
      cache: "no-store",
      headers: {
        Accept: "text/csv,text/plain;q=0.9,*/*;q=0.5",
        "User-Agent":
          "TerreniReady/0.1 (+https://terreniready.onrender.com; repo:https://github.com/dedoitalia/terreniready)",
      },
    });

    if (!response.ok) {
      throw new Error(`MIMIT responded with ${response.status}`);
    }

    const text = await response.text();
    const parsed = parseDataset(text);
    const nextValue = {
      expiresAt: Date.now() + MIMIT_FUEL_CACHE_TTL_MS,
      extractedAt: parsed.extractedAt,
      byProvince: parsed.byProvince,
    } satisfies CachedMimitFuelDataset;

    mimitFuelStore.cache = nextValue;

    return nextValue;
  })();

  mimitFuelStore.inflight = requestPromise;

  try {
    return await requestPromise;
  } finally {
    mimitFuelStore.inflight = null;
  }
}

export async function fetchFuelSourcesFromMimit(
  provinceId: ProvinceId,
  reportProgress?: (message: string) => void,
): Promise<SourceFeature[]> {
  reportProgress?.(
    `${PROVINCE_MAP[provinceId].name}: recupero distributori dal dataset ufficiale MIMIT.`,
  );

  const dataset = await loadFuelDataset();
  const sources = dataset.byProvince[provinceId] ?? [];

  reportProgress?.(
    `${PROVINCE_MAP[provinceId].name}: distributori MIMIT ${sources.length}${
      dataset.extractedAt ? ` (estrazione ${dataset.extractedAt}).` : "."
    }`,
  );

  return sources;
}
