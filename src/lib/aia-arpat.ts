import { PROVINCE_MAP } from "@/lib/province-data";
import type { ProvinceId, SourceFeature } from "@/types/scan";

// --------------------------------------------------------------------------
// Sorgenti AIA nazionali in Toscana (fonte: ARPAT dati.toscana.it)
//
// Il dataset ARPAT "Aziende con AIA di competenza nazionale presenti in
// Toscana" e` pubblicato solo in formato ODS sul sito ARPAT (non piu
// come CSV parsabile al volo). Dato che gli impianti AIA nazionali in
// Toscana sono un set piccolo, stabile e noto (~10 siti concentrati su
// 3 poli industriali: Piombino, Rosignano, Scarlino, Cavriglia), li
// portiamo come lista hardcoded con coordinate geocodate via Nominatim.
//
// Aggiornamento: confrontare con l'ultimo ODS pubblicato a
// https://www.arpat.toscana.it/datiemappe/aziende-con-aia-dati-delle-
// emissioni-in-aria-degli-impianti-di-competenza-nazionale-presenti-in-
// toscana/  (frequenza annuale, licenza CC-BY-4.0).
//
// Gli impianti AIA nazionali sono autorizzati dal Ministero dell'Ambiente:
// raffinerie, acciaierie, grandi centrali, chimica pesante. Sono i siti
// piu rilevanti per un'analisi di prossimita` emissiva.
// --------------------------------------------------------------------------

export type AiaPlantRecord = {
  id: string;
  name: string;
  operator: string;
  provinceId: ProvinceId;
  comune: string;
  latitude: number;
  longitude: number;
  sector: string;
};

const AIA_NATIONAL_PLANTS: AiaPlantRecord[] = [
  {
    id: "aia-piombino-bertocci",
    name: "Bertocci Montaggi (ex Edison)",
    operator: "Bertocci Montaggi S.r.l.",
    provinceId: "LI",
    comune: "Piombino",
    latitude: 42.936435,
    longitude: 10.545207,
    sector: "Stabilimento industriale — area portuale Piombino",
  },
  {
    id: "aia-piombino-enel",
    name: "Centrale ENEL Torre del Sale",
    operator: "ENEL Produzione",
    provinceId: "LI",
    comune: "Piombino",
    latitude: 42.957625,
    longitude: 10.602723,
    sector: "Centrale termoelettrica",
  },
  {
    id: "aia-piombino-lucchini",
    name: "Acciaierie Piombino (ex Lucchini / JSW Steel Italy)",
    operator: "JSW Steel Italy Piombino S.p.A.",
    provinceId: "LI",
    comune: "Piombino",
    latitude: 42.939020,
    longitude: 10.544861,
    sector: "Siderurgia integrata",
  },
  {
    id: "aia-piombino-snam",
    name: "Snam FSRU Piombino (Golar Tundra)",
    operator: "Snam S.p.A.",
    provinceId: "LI",
    comune: "Piombino",
    latitude: 42.928430,
    longitude: 10.545404,
    sector: "Rigassificatore offshore/porto",
  },
  {
    id: "aia-rosignano-solvay",
    name: "Solvay Chimica Italia Rosignano",
    operator: "Solvay Chimica Italia S.p.A.",
    provinceId: "LI",
    comune: "Rosignano Marittimo",
    latitude: 43.381224,
    longitude: 10.457315,
    sector: "Chimica — carbonato di sodio e derivati",
  },
  {
    id: "aia-rosignano-ineos",
    name: "INEOS Manufacturing Rosignano",
    operator: "INEOS Manufacturing Italia S.p.A.",
    provinceId: "LI",
    comune: "Rosignano Marittimo",
    latitude: 43.387707,
    longitude: 10.445593,
    sector: "Chimica — cloroalcali",
  },
  {
    id: "aia-rosignano-engie",
    name: "Roselectra (ENGIE Produzione)",
    operator: "ENGIE Produzione S.p.A.",
    provinceId: "LI",
    comune: "Rosignano Marittimo",
    latitude: 43.381547,
    longitude: 10.448474,
    sector: "Centrale termoelettrica a ciclo combinato",
  },
  {
    id: "aia-rosignano-cte-solvay",
    name: "CTE Solvay Energia (ex Rosen)",
    operator: "Solvay Energia Italia",
    provinceId: "LI",
    comune: "Rosignano Marittimo",
    latitude: 43.381936,
    longitude: 10.449435,
    sector: "Cogenerazione industriale",
  },
  {
    id: "aia-scarlino-solmine",
    name: "Nuova Solmine Scarlino",
    operator: "Nuova Solmine S.p.A.",
    provinceId: "GR",
    comune: "Scarlino",
    latitude: 42.924072,
    longitude: 10.795998,
    sector: "Chimica — acido solforico e derivati",
  },
  {
    id: "aia-cavriglia-enel",
    name: "Centrale ENEL Santa Barbara",
    operator: "ENEL Produzione",
    provinceId: "AR",
    comune: "Cavriglia",
    latitude: 43.552110,
    longitude: 11.450392,
    sector: "Centrale termoelettrica (ex carbone, riconversione)",
  },
];

const DATASET_REFERENCE_URL =
  "https://dati.toscana.it/dataset/aziende-con-aia-di-competenza-nazionale-presenti-in-toscana-dati-delle-emissioni-in-aria";

function toSourceFeature(plant: AiaPlantRecord): SourceFeature {
  return {
    id: plant.id,
    // osmId/osmType non esistono per AIA: riusiamo il formato ma con
    // id numerico stabile (hash parziale del codice testuale).
    osmId: Math.abs(
      plant.id
        .split("")
        .reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) | 0, 5381),
    ),
    osmType: "node",
    provinceId: plant.provinceId,
    name: plant.name,
    primaryCategoryId: "aia",
    categoryIds: ["aia"],
    latitude: plant.latitude,
    longitude: plant.longitude,
    address: `${plant.comune} (${plant.provinceId})`,
    dataProvider: "arpat",
    providerLabel: "ARPAT — AIA nazionali in Toscana",
    referenceUrl: DATASET_REFERENCE_URL,
    tags: {
      operator: plant.operator,
      sector: plant.sector,
      comune: plant.comune,
      provincia: plant.provinceId,
      aia_scope: "nazionale",
    },
  };
}

/**
 * Ritorna gli stabilimenti AIA nazionali presenti nella provincia
 * richiesta. Operazione locale (nessuna chiamata di rete): la lista
 * hardcoded e` la stessa su tutte le province e filtrata per provinceId.
 *
 * Il firmato e` compatibile con `fetchFuelSourcesFromMimit` per simmetria
 * con la pipeline di `fetchSourcesForProvince`.
 */
export async function fetchAiaSourcesFromArpat(
  provinceId: ProvinceId,
  reportProgress?: (message: string) => void,
): Promise<SourceFeature[]> {
  const province = PROVINCE_MAP[provinceId];
  const matches = AIA_NATIONAL_PLANTS.filter(
    (plant) => plant.provinceId === provinceId,
  );

  reportProgress?.(
    `${province.name}: AIA nazionali trovati ${matches.length} (dataset ARPAT ODS, ultima revisione 2024).`,
  );

  return matches.map(toSourceFeature);
}
