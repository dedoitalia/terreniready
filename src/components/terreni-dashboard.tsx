"use client";

import dynamic from "next/dynamic";
import JSZip from "jszip";
import { startTransition, useEffect, useState } from "react";

import { PROVINCES, PROVINCE_MAP } from "@/lib/province-data";
import { SOURCE_CATEGORIES, SOURCE_CATEGORY_MAP, landuseLabel } from "@/lib/source-types";
import type {
  ProvinceId,
  ScanResponse,
  SourceCategoryId,
  TerrainFeature,
} from "@/types/scan";

const TerrainMap = dynamic(() => import("@/components/terrain-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[62vh] items-center justify-center rounded-[28px] border border-white/60 bg-[#dce6db] text-sm text-[#2d4635] shadow-[0_30px_80px_rgba(28,39,31,0.16)] lg:h-[calc(100vh-12rem)]">
      Carico la mappa territoriale...
    </div>
  ),
});

function toggleItem<T extends string>(list: T[], value: T) {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

function formatMeters(value: number) {
  return `${Math.round(value).toLocaleString("it-IT")} m`;
}

function formatSqm(value: number | null) {
  if (!value) {
    return "n.d.";
  }

  return `${value.toLocaleString("it-IT")} m²`;
}

function downloadBlob(contents: BlobPart, mimeType: string, filename: string) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

function buildCsv(data: ScanResponse) {
  const rows = [
    [
      "provincia",
      "terreno",
      "uso_agricolo",
      "distanza_metri",
      "superficie_mq",
      "fonte",
      "tipo_fonte",
      "lat",
      "lng",
      "osm_url",
    ],
    ...data.terrains.map((terrain) => [
      PROVINCE_MAP[terrain.provinceId].name,
      terrain.name,
      landuseLabel(terrain.landuse),
      Math.round(terrain.distanceMeters).toString(),
      terrain.areaSqm ? terrain.areaSqm.toString() : "",
      terrain.closestSourceName,
      SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId].label,
      terrain.center.lat.toFixed(6),
      terrain.center.lng.toFixed(6),
      `https://www.openstreetmap.org/way/${terrain.osmId}`,
    ]),
  ];

  return rows
    .map((row) =>
      row
        .map((cell) => `"${cell.replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\n");
}

function terrainPlacemark(terrain: TerrainFeature) {
  const coordinates = terrain.coordinates
    .map(([lng, lat]) => `${lng},${lat},0`)
    .join(" ");

  return `
    <Placemark>
      <name>${terrain.name}</name>
      <description><![CDATA[
        Provincia: ${PROVINCE_MAP[terrain.provinceId].name}<br/>
        Uso: ${landuseLabel(terrain.landuse)}<br/>
        Distanza: ${Math.round(terrain.distanceMeters)} m<br/>
        Superficie: ${terrain.areaSqm ? terrain.areaSqm.toLocaleString("it-IT") : "n.d."} m²<br/>
        Fonte: ${terrain.closestSourceName}
      ]]></description>
      <Style>
        <LineStyle><color>ff2f5d22</color><width>2</width></LineStyle>
        <PolyStyle><color>6670c16d</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordinates}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
}

async function downloadKmz(data: ScanResponse) {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>TerreniReady Export</name>
    ${data.terrains.map(terrainPlacemark).join("\n")}
  </Document>
</kml>`;

  const zip = new JSZip();
  zip.file("doc.kml", kml);

  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "application/vnd.google-earth.kmz", "terreniready-export.kmz");
}

export default function TerreniDashboard() {
  const [selectedProvinceIds, setSelectedProvinceIds] = useState<ProvinceId[]>(["PT"]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<SourceCategoryId[]>([
    "fuel",
    "bodyshop",
    "repair",
  ]);
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [activeTerrainId, setActiveTerrainId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const activeTerrain = scanData?.terrains.find(
    (terrain) => terrain.id === activeTerrainId,
  );

  useEffect(() => {
    if (!loading) {
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [loading]);

  async function runScan() {
    if (selectedProvinceIds.length === 0) {
      setError("Seleziona almeno una provincia.");
      return;
    }

    if (selectedCategoryIds.length === 0) {
      setError("Seleziona almeno una tipologia di fonte emissiva.");
      return;
    }

    setLoading(true);
    setLoadingSeconds(0);
    setError(null);

    startTransition(() => {
      void (async () => {
        let timeoutId: number | undefined;

        try {
          const controller = new AbortController();
          timeoutId = window.setTimeout(() => controller.abort(), 90_000);
          const response = await fetch("/api/scan", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
              provinceIds: selectedProvinceIds,
              categoryIds: selectedCategoryIds,
            }),
          });
          window.clearTimeout(timeoutId);

          const payload = (await response.json()) as ScanResponse & { error?: string };

          if (!response.ok) {
            throw new Error(payload.error ?? "Errore durante la scansione.");
          }

          setScanData(payload);
          setActiveTerrainId(payload.terrains[0]?.id);
        } catch (scanError) {
          setScanData(null);
          setActiveTerrainId(undefined);
          setError(
            scanError instanceof DOMException && scanError.name === "AbortError"
              ? "La scansione sta impiegando troppo. Prova con una sola provincia o meno categorie."
              : scanError instanceof Error
              ? scanError.message
              : "Errore durante la scansione.",
          );
        } finally {
          if (timeoutId) {
            window.clearTimeout(timeoutId);
          }
          setLoadingSeconds(0);
          setLoading(false);
        }
      })();
    });
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f5f0d7_0%,#eef2ea_34%,#e4ebdf_100%)] text-[#142015]">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-8 px-5 py-6 lg:px-8 lg:py-8">
        <section className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="rounded-[32px] border border-white/70 bg-white/78 p-6 shadow-[0_25px_70px_rgba(26,34,26,0.1)] backdrop-blur">
            <div className="space-y-3">
              <span className="inline-flex rounded-full bg-[#1d3826] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#eef5df]">
                TerreniReady
              </span>
              <h1 className="max-w-sm text-4xl font-semibold tracking-[-0.04em] text-[#162118]">
                SaaS geospaziale per scovare terreni agricoli vicini a fonti emissive.
              </h1>
              <p className="text-sm leading-6 text-[#4a5d4a]">
                Questo MVP usa dati reali OpenStreetMap per le fonti e i poligoni agricoli,
                con overlay WMS ufficiale dell&apos;Agenzia delle Entrate per le particelle catastali.
              </p>
            </div>

            <div className="mt-8 space-y-6">
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[#445646]">
                    Province toscane
                  </h2>
                  <span className="text-xs text-[#6d7f6f]">
                    {selectedProvinceIds.length} selezionate
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {PROVINCES.map((province) => {
                    const checked = selectedProvinceIds.includes(province.id);

                    return (
                      <button
                        key={province.id}
                        type="button"
                        onClick={() =>
                          setSelectedProvinceIds((current) =>
                            toggleItem(current, province.id),
                          )
                        }
                        className={`rounded-2xl border px-3 py-3 text-left text-sm transition ${
                          checked
                            ? "border-[#1d3826] bg-[#1d3826] text-white"
                            : "border-[#d8dfd1] bg-[#f8faf5] text-[#243326] hover:border-[#91a384]"
                        }`}
                      >
                        <div className="font-semibold">{province.name}</div>
                        <div className="mt-1 text-xs opacity-80">{province.id}</div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[#445646]">
                    Fonti emissive
                  </h2>
                  <span className="text-xs text-[#6d7f6f]">
                    {selectedCategoryIds.length} tipi
                  </span>
                </div>
                <div className="space-y-2">
                  {SOURCE_CATEGORIES.map((category) => {
                    const checked = selectedCategoryIds.includes(category.id);

                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() =>
                          setSelectedCategoryIds((current) =>
                            toggleItem(current, category.id),
                          )
                        }
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          checked
                            ? "border-[#132017] bg-[#eef3e0]"
                            : "border-[#d8dfd1] bg-white hover:border-[#91a384]"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                          <div>
                            <div className="font-semibold text-[#1e2c21]">{category.label}</div>
                            <p className="text-xs leading-5 text-[#607260]">
                              {category.description}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={runScan}
                  disabled={loading}
                  className="rounded-2xl bg-[#15251a] px-4 py-4 text-sm font-semibold text-white transition hover:bg-[#223528] disabled:cursor-wait disabled:opacity-70"
                >
                  {loading ? "Scansione in corso..." : "Avvia scansione reale"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!scanData) {
                      return;
                    }

                    downloadBlob(
                      `\ufeff${buildCsv(scanData)}`,
                      "text/csv;charset=utf-8",
                      "terreniready-export.csv",
                    );
                  }}
                  disabled={!scanData || scanData.terrains.length === 0}
                  className="rounded-2xl border border-[#d7decf] bg-white px-4 py-4 text-sm font-semibold text-[#1e2d20] transition hover:border-[#91a384] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Export CSV
                </button>
              </div>

              {loading ? (
                <div className="rounded-[24px] border border-[#d8dfd1] bg-[#f8faf5] p-4 text-sm leading-6 text-[#415441]">
                  Scansione reale in corso da {loadingSeconds}s.
                  {selectedProvinceIds.length > 1 || selectedCategoryIds.length > 1
                    ? " Con piu province o categorie puo richiedere 20-60 secondi."
                    : " Sto interrogando OpenStreetMap e calcolando i poligoni agricoli nel buffer dei 350 metri."}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  if (!scanData || scanData.terrains.length === 0) {
                    return;
                  }

                  void downloadKmz(scanData);
                }}
                disabled={!scanData || scanData.terrains.length === 0}
                className="w-full rounded-2xl border border-[#d7decf] bg-[#f7f9f3] px-4 py-4 text-sm font-semibold text-[#1e2d20] transition hover:border-[#91a384] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Export KMZ
              </button>

              <div className="rounded-[24px] bg-[#f6f8f1] p-4 text-xs leading-6 text-[#516351]">
                Proprietari, nomi e codici fiscali non sono inclusi in questo MVP: servono
                accessi catastali dedicati o integrazioni convenzionate. Qui la pipeline è reale
                su dati pubblici, non simulata.
              </div>
            </div>
          </aside>

          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-[28px] border border-white/70 bg-white/75 p-5 shadow-[0_20px_55px_rgba(26,34,26,0.08)] backdrop-blur">
                <div className="text-xs uppercase tracking-[0.18em] text-[#6d7f6f]">
                  Fonti trovate
                </div>
                <div className="mt-3 text-4xl font-semibold tracking-[-0.04em]">
                  {scanData?.meta.totalSources ?? 0}
                </div>
              </div>
              <div className="rounded-[28px] border border-white/70 bg-white/75 p-5 shadow-[0_20px_55px_rgba(26,34,26,0.08)] backdrop-blur">
                <div className="text-xs uppercase tracking-[0.18em] text-[#6d7f6f]">
                  Terreni agricoli
                </div>
                <div className="mt-3 text-4xl font-semibold tracking-[-0.04em]">
                  {scanData?.meta.totalTerrains ?? 0}
                </div>
              </div>
              <div className="rounded-[28px] border border-white/70 bg-white/75 p-5 shadow-[0_20px_55px_rgba(26,34,26,0.08)] backdrop-blur">
                <div className="text-xs uppercase tracking-[0.18em] text-[#6d7f6f]">
                  Raggio operativo
                </div>
                <div className="mt-3 text-4xl font-semibold tracking-[-0.04em]">
                  {scanData?.meta.radiusMeters ?? 350}m
                </div>
              </div>
            </div>

            {error ? (
              <div className="rounded-[26px] border border-[#e6b6af] bg-[#fff2ef] px-5 py-4 text-sm text-[#7f3328]">
                {error}
              </div>
            ) : null}

            {scanData?.meta.warnings.map((warning) => (
              <div
                key={warning}
                className="rounded-[26px] border border-[#e3d6a7] bg-[#fff9df] px-5 py-4 text-sm text-[#705d1d]"
              >
                {warning}
              </div>
            ))}

            <TerrainMap
              selectedProvinceIds={selectedProvinceIds}
              sources={scanData?.sources ?? []}
              terrains={scanData?.terrains ?? []}
              activeTerrainId={activeTerrainId}
              onSelectTerrainId={setActiveTerrainId}
            />
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-[30px] border border-white/70 bg-white/82 p-5 shadow-[0_22px_65px_rgba(26,34,26,0.08)] backdrop-blur">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-[-0.04em] text-[#172318]">
                  Risultati ordinati per vicinanza
                </h2>
                <p className="mt-1 text-sm text-[#627462]">
                  Ogni riga è un poligono agricolo OSM collegato alla fonte emissiva più vicina.
                </p>
              </div>
              <div className="text-xs text-[#708270]">
                {scanData?.terrains.length ?? 0} righe visibili
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.16em] text-[#738573]">
                    <th className="px-4 pb-1">Terreno</th>
                    <th className="px-4 pb-1">Provincia</th>
                    <th className="px-4 pb-1">Uso</th>
                    <th className="px-4 pb-1">Distanza</th>
                    <th className="px-4 pb-1">Superficie</th>
                    <th className="px-4 pb-1">Fonte vicina</th>
                  </tr>
                </thead>
                <tbody>
                  {(scanData?.terrains ?? []).map((terrain) => {
                    const active = terrain.id === activeTerrainId;

                    return (
                      <tr
                        key={terrain.id}
                        onClick={() => setActiveTerrainId(terrain.id)}
                        className={`cursor-pointer rounded-2xl transition ${
                          active
                            ? "bg-[#1f321f] text-white"
                            : "bg-[#f7faf4] text-[#1c2a1e] hover:bg-[#eef4e9]"
                        }`}
                      >
                        <td className="rounded-l-2xl px-4 py-4 font-semibold">{terrain.name}</td>
                        <td className="px-4 py-4">{PROVINCE_MAP[terrain.provinceId].name}</td>
                        <td className="px-4 py-4">{landuseLabel(terrain.landuse)}</td>
                        <td className="px-4 py-4">{formatMeters(terrain.distanceMeters)}</td>
                        <td className="px-4 py-4">{formatSqm(terrain.areaSqm)}</td>
                        <td className="rounded-r-2xl px-4 py-4">
                          <div>{terrain.closestSourceName}</div>
                          <div className={`text-xs ${active ? "text-[#d6e3cf]" : "text-[#667866]"}`}>
                            {SOURCE_CATEGORY_MAP[terrain.closestSourceCategoryId].label}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="rounded-[30px] border border-white/70 bg-[#162218] p-5 text-white shadow-[0_22px_65px_rgba(26,34,26,0.16)]">
            <h2 className="text-2xl font-semibold tracking-[-0.04em]">Scheda terreno</h2>
            {activeTerrain ? (
              <div className="mt-5 space-y-4 text-sm leading-6 text-[#e4ecda]">
                <div>
                  <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                    Nome
                  </div>
                  <div className="mt-1 text-lg font-semibold text-white">{activeTerrain.name}</div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                      Provincia
                    </div>
                    <div>{PROVINCE_MAP[activeTerrain.provinceId].name}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                      Uso
                    </div>
                    <div>{landuseLabel(activeTerrain.landuse)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                      Distanza
                    </div>
                    <div>{formatMeters(activeTerrain.distanceMeters)}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                      Superficie
                    </div>
                    <div>{formatSqm(activeTerrain.areaSqm)}</div>
                  </div>
                </div>
                <div className="rounded-2xl bg-white/6 p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-[#97ad95]">
                    Fonte più vicina
                  </div>
                  <div className="mt-1 font-semibold text-white">{activeTerrain.closestSourceName}</div>
                  <div className="text-sm text-[#cfdec9]">
                    {SOURCE_CATEGORY_MAP[activeTerrain.closestSourceCategoryId].label}
                  </div>
                </div>
                <div className="rounded-2xl bg-white/6 p-4 text-xs leading-6 text-[#cfdec9]">
                  Centroide:
                  <br />
                  {activeTerrain.center.lat.toFixed(6)}, {activeTerrain.center.lng.toFixed(6)}
                  <br />
                  OSM:
                  <br />
                  <a
                    href={`https://www.openstreetmap.org/way/${activeTerrain.osmId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#f3e38e] underline underline-offset-4"
                  >
                    Apri poligono sorgente
                  </a>
                </div>
              </div>
            ) : (
              <p className="mt-5 text-sm leading-6 text-[#cfdec9]">
                Seleziona un terreno dalla tabella o dalla mappa per vedere il dettaglio.
              </p>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
