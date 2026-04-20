import type { NextRequest } from "next/server";

import { createScanJob } from "@/lib/scan-jobs";
import type { ScanRequest } from "@/types/scan";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<ScanRequest>;
    const provinceIds = Array.isArray(body.provinceIds) ? body.provinceIds : [];
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];

    if (provinceIds.length === 0) {
      return Response.json(
        { error: "Seleziona almeno una provincia." },
        { status: 400 },
      );
    }

    if (categoryIds.length === 0) {
      return Response.json(
        { error: "Seleziona almeno una tipologia di fonte emissiva." },
        { status: 400 },
      );
    }

    return Response.json(
      createScanJob({
        provinceIds,
        categoryIds,
      }),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Impossibile avviare la scansione.",
      },
      { status: 400 },
    );
  }
}
