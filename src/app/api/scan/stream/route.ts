import type { NextRequest } from "next/server";

import { formatScanErrorMessage } from "@/lib/scan-error-message";
import { runScan } from "@/lib/overpass";
import type {
  ProvinceId,
  ScanJobLogEntry,
  ScanStreamEvent,
  SourceCategoryId,
} from "@/types/scan";

export const runtime = "nodejs";

function isoNow() {
  return new Date().toISOString();
}

function buildEvent(type: string, payload: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: NextRequest) {
  const provinceIds = request.nextUrl.searchParams.getAll(
    "provinceIds",
  ) as ProvinceId[];
  const categoryIds = request.nextUrl.searchParams.getAll(
    "categoryIds",
  ) as SourceCategoryId[];

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeatId: ReturnType<typeof setInterval> | null = null;

      const send = (event: ScanStreamEvent) => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(buildEvent(event.type, event)));
      };

      const appendLog = (message: string) => {
        const entry: ScanJobLogEntry = {
          timestamp: isoNow(),
          message,
        };

        send({
          type: "log",
          entry,
        });
      };

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;

        if (heartbeatId) {
          clearInterval(heartbeatId);
        }

        try {
          controller.close();
        } catch {
          // The client may have already closed the stream.
        }
      };

      heartbeatId = setInterval(() => {
        send({
          type: "heartbeat",
          timestamp: isoNow(),
        });
      }, 10_000);

      void (async () => {
        send({
          type: "status",
          status: "running",
          timestamp: isoNow(),
        });

        if (provinceIds.length === 0) {
          send({
            type: "scan-error",
            message: "Seleziona almeno una provincia.",
          });
          close();
          return;
        }

        if (categoryIds.length === 0) {
          send({
            type: "scan-error",
            message: "Seleziona almeno una tipologia di fonte emissiva.",
          });
          close();
          return;
        }

        try {
          appendLog("Connessione live con il motore di scansione stabilita.");

          const result = await runScan(provinceIds, categoryIds, {
            reportProgress: ({ message }) => appendLog(message),
          });

          send({
            type: "result",
            result,
          });
          send({
            type: "status",
            status: "completed",
            timestamp: isoNow(),
          });
        } catch (error) {
          send({
            type: "scan-error",
            message: formatScanErrorMessage(error),
          });
          send({
            type: "status",
            status: "failed",
            timestamp: isoNow(),
          });
        } finally {
          close();
        }
      })();
    },
    cancel() {
      // The client interrupted the connection; the stream cleanup is handled in `close`.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
