export type SourceCategoryId =
  | "fuel"
  | "bodyshop"
  | "repair"
  | "industrial";

export type ProvinceId =
  | "AR"
  | "FI"
  | "GR"
  | "LI"
  | "LU"
  | "MS"
  | "PI"
  | "PO"
  | "PT"
  | "SI";

export type Coordinate = {
  lat: number;
  lng: number;
};

export type BoundingBox = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type SourceFeature = {
  id: string;
  osmId: number;
  osmType: "node" | "way";
  provinceId: ProvinceId;
  name: string;
  primaryCategoryId: SourceCategoryId;
  categoryIds: SourceCategoryId[];
  latitude: number;
  longitude: number;
  address: string | null;
  tags: Record<string, string>;
};

export type TerrainFeature = {
  id: string;
  osmId: number;
  osmType: "way";
  provinceId: ProvinceId;
  name: string;
  landuse: string;
  center: Coordinate;
  coordinates: Array<[number, number]>;
  distanceMeters: number;
  areaSqm: number | null;
  closestSourceId: string;
  closestSourceName: string;
  closestSourceCategoryId: SourceCategoryId;
  sourceCountInRange: number;
  tags: Record<string, string>;
};

export type ScanRequest = {
  provinceIds: ProvinceId[];
  categoryIds: SourceCategoryId[];
};

export type ScanProgressEvent = {
  message: string;
};

export type ScanResponse = {
  sources: SourceFeature[];
  terrains: TerrainFeature[];
  meta: {
    queryAt: string;
    radiusMeters: number;
    selectedProvinceIds: ProvinceId[];
    selectedCategoryIds: SourceCategoryId[];
    totalSources: number;
    totalTerrains: number;
    warnings: string[];
  };
};

export type ScanJobStatus = "queued" | "running" | "completed" | "failed";

export type ScanJobLogEntry = {
  timestamp: string;
  message: string;
};

export type ScanJobSnapshot = {
  id: string;
  status: ScanJobStatus;
  createdAt: string;
  updatedAt: string;
  request: ScanRequest;
  logs: ScanJobLogEntry[];
  result: ScanResponse | null;
  error: string | null;
};

export type ScanJobCreateResponse = {
  jobId: string;
};
