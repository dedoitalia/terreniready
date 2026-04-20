import type { NextRequest } from "next/server";

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
    const message =
      error instanceof Error
        ? error.message
        : "Impossibile completare la scansione.";

    return Response.json({ error: message }, { status: 400 });
  }
}
