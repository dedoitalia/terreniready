import type { BoundingBox, Coordinate, ProvinceId } from "@/types/scan";

export type ProvinceDefinition = {
  id: ProvinceId;
  name: string;
  center: Coordinate;
  bbox: BoundingBox;
};

export const PROVINCES: ProvinceDefinition[] = [
  {
    id: "AR",
    name: "Arezzo",
    center: { lat: 43.4633, lng: 11.8796 },
    bbox: { south: 43.23, west: 11.23, north: 43.86, east: 12.45 },
  },
  {
    id: "FI",
    name: "Firenze",
    center: { lat: 43.7696, lng: 11.2558 },
    bbox: { south: 43.54, west: 10.96, north: 44.14, east: 11.82 },
  },
  {
    id: "GR",
    name: "Grosseto",
    center: { lat: 42.7635, lng: 11.1124 },
    bbox: { south: 42.35, west: 10.42, north: 43.42, east: 11.93 },
  },
  {
    id: "LI",
    name: "Livorno",
    center: { lat: 43.5485, lng: 10.3106 },
    bbox: { south: 42.74, west: 9.78, north: 43.72, east: 10.78 },
  },
  {
    id: "LU",
    name: "Lucca",
    center: { lat: 43.8429, lng: 10.5027 },
    bbox: { south: 43.67, west: 9.92, north: 44.23, east: 10.92 },
  },
  {
    id: "MS",
    name: "Massa-Carrara",
    center: { lat: 44.0367, lng: 10.1417 },
    bbox: { south: 43.94, west: 9.74, north: 44.44, east: 10.33 },
  },
  {
    id: "PI",
    name: "Pisa",
    center: { lat: 43.7228, lng: 10.4017 },
    bbox: { south: 43.18, west: 10.14, north: 43.84, east: 10.93 },
  },
  {
    id: "PO",
    name: "Prato",
    center: { lat: 43.8777, lng: 11.1022 },
    bbox: { south: 43.74, west: 10.96, north: 44.1, east: 11.33 },
  },
  {
    id: "PT",
    name: "Pistoia",
    center: { lat: 43.9333, lng: 10.9167 },
    bbox: { south: 43.76, west: 10.68, north: 44.14, east: 11.16 },
  },
  {
    id: "SI",
    name: "Siena",
    center: { lat: 43.3188, lng: 11.3308 },
    bbox: { south: 42.85, west: 10.93, north: 43.66, east: 11.98 },
  },
];

export const PROVINCE_MAP = Object.fromEntries(
  PROVINCES.map((province) => [province.id, province]),
) as Record<ProvinceId, ProvinceDefinition>;
