import type { NextRequest } from "next/server";

import { formatScanErrorMessage } from "@/lib/scan-error-message";
import { runScan } from "@/lib/overpass";
import type { ScanRequest } from "@/types/scan";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<ScanRequest>;
    const provinceIds = Array.isArray(body.provinceIds) ? body.provinceIds : [];
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];
    const response = await runScan(provinceIds, categoryIds);

    return Response.json(response);
  } catch (error) {
    return Response.json(
      { error: formatScanErrorMessage(error) },
      { status: 400 },
    );
  }
}
