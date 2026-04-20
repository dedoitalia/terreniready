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
    description: "Stazioni di servizio e carburanti da OpenStreetMap.",
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
    description: "Aree o impianti industriali con traccia geospaziale pubblica.",
    color: "#244c74",
    selectors: [
      { key: "landuse", value: "industrial" },
      { key: "industrial" },
      { key: "man_made", value: "works" },
    ],
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
