import type { SourceCategoryId } from "@/types/scan";

type TagSelector = {
  key: string;
  value?: string;
};

export type SourceCategoryDefinition = {
  id: SourceCategoryId;
  label: string;
  description: string;
  color: string;
  selectors: TagSelector[];
};

export const SOURCE_CATEGORIES: SourceCategoryDefinition[] = [
  {
    id: "fuel",
    label: "Distributori",
    description: "Stazioni di servizio dal dataset ufficiale MIMIT Osservaprezzi.",
    color: "#d14d41",
    selectors: [{ key: "amenity", value: "fuel" }],
  },
  {
    id: "bodyshop",
    label: "Carrozzerie",
    description: "Carrozzerie e carrozzieri censiti in OpenStreetMap.",
    color: "#f08c2e",
    selectors: [
      { key: "craft", value: "car_painter" },
      { key: "craft", value: "body_repair" },
    ],
  },
  {
    id: "repair",
    label: "Officine",
    description: "Officine meccaniche e servizi di autoriparazione.",
    color: "#e7b10a",
    selectors: [
      { key: "shop", value: "car_repair" },
      { key: "craft", value: "mechanic" },
    ],
  },
  {
    id: "industrial",
    label: "Industriale",
    description: "Aree o impianti industriali con traccia geospaziale pubblica (OpenStreetMap).",
    color: "#244c74",
    selectors: [
      { key: "landuse", value: "industrial" },
      { key: "industrial" },
      { key: "man_made", value: "works" },
      // ciminiere e forni industriali come tracce puntuali
      { key: "man_made", value: "chimney" },
      { key: "man_made", value: "kiln" },
      // cave e attivita` estrattive (polveri, emissioni)
      { key: "landuse", value: "quarry" },
    ],
  },
  {
    id: "energy",
    label: "Energia e rifiuti",
    description:
      "Centrali elettriche, discariche, depuratori, inceneritori, isole ecologiche — impianti pubblici ad alta potenziale emissione.",
    color: "#2f855a",
    selectors: [
      // centrali di qualsiasi tipo (power=plant copre termo, biomasse, solare, eolico)
      { key: "power", value: "plant" },
      { key: "power", value: "substation" },
      // rifiuti: discariche, trattamento, trasferimento
      { key: "landuse", value: "landfill" },
      { key: "amenity", value: "waste_transfer_station" },
      { key: "amenity", value: "recycling" },
      // impianti acque reflue
      { key: "man_made", value: "wastewater_plant" },
    ],
  },
  {
    id: "aia",
    label: "Impianti AIA",
    description:
      "Stabilimenti con Autorizzazione Integrata Ambientale di competenza nazionale (ARPAT Toscana): raffinerie, acciaierie, chimica pesante, grandi centrali.",
    color: "#8b5cf6",
    // Nessun selettore OSM: questa categoria non e` alimentata da
    // Overpass ma dal modulo src/lib/aia-arpat.ts (lista ARPAT).
    selectors: [],
  },
];

export const SOURCE_CATEGORY_MAP = Object.fromEntries(
  SOURCE_CATEGORIES.map((category) => [category.id, category]),
) as Record<SourceCategoryId, SourceCategoryDefinition>;

export const AGRICULTURAL_SELECTORS: TagSelector[] = [
  { key: "landuse", value: "farmland" },
  { key: "landuse", value: "orchard" },
  { key: "landuse", value: "vineyard" },
  { key: "landuse", value: "greenhouse_horticulture" },
];

export function landuseLabel(landuse: string) {
  switch (landuse) {
    case "cadastral_parcel":
      return "Particella";
    case "farmland":
      return "Seminativo";
    case "orchard":
      return "Frutteto";
    case "vineyard":
      return "Vigneto";
    case "greenhouse_horticulture":
      return "Serra";
    default:
      return landuse || "Agricolo";
  }
}
