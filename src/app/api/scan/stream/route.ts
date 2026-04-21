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
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Le route handler Next 16 hanno runtime dinamico su richiesta: questa
// e' puro SSE, non deve mai essere sottoposta a static generation, cache
// fetch dedup ne CDN caching lungo. Le tre export sopra neutralizzano
// tutti e tre i meccanismi in un colpo solo.

function isoNow() {
  return new Date().toISOString();
}

// Stream SSE: piu veloce costruire una stringa sola invece di concatenare
// piu backtick. La versione precedente generava un template literal di ~80B
// per ogni evento log; il throughput su scan multi-provincia tocca facilmente
// 400-500 eventi.
function buildEvent(type: string, payload: unknown) {
  return (
    "event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n"
  );
}

export async function GET(request: NextRequest) {
  const provinceIds = request.nextUrl.searchParams.getAll(
    "provinceIds",
  ) as ProvinceId[];
  const categoryIds = request.nextUrl.searchParams.getAll(
    "categoryIds",
  ) as SourceCategoryId[];
  // L'encoder e' hot-path: un'unica istanza per connessione evita la
  // continua allocazione di TextEncoder ad ogni evento.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let heartbeatId: ReturnType<typeof setInterval> | null = null;

      const send = (event: ScanStreamEvent) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(buildEvent(event.type, event)));
        } catch {
          closed = true;

          if (heartbeatId) {
            clearInterval(heartbeatId);
          }
        }
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

      // Il client chiude il tab -> la ReadableStream riceve "cancel"; lo
      // AbortController permette a runScan (o a qualunque fetch upstream
      // che lo usi) di accorgersene e abbandonare il lavoro residuo.
      const abortController = new AbortController();

      const onUpstreamAbort = () => {
        abortController.abort();
        close();
      };

      request.signal.addEventListener("abort", onUpstreamAbort, { once: true });

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
            // Ogni provincia che termina invia un partial-result al
            // client: su scan multi-provincia l'utente vede i terreni
            // della prima provincia apparire in mappa prima che la
            // pipeline finisca.
            reportPartialResult: (partial) => {
              send({ type: "partial-result", result: partial });
            },
            // Quando il client chiude l'EventSource (bottone "Annulla"
            // o reload tab), request.signal trigga abortController; il
            // signal passa a runScan che lo propaga a runWithConcurrency
            // e a scanProvince: nessuna nuova provincia/chunk parte,
            // riducendo il lavoro residuo da minuti a secondi.
            signal: abortController.signal,
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
          request.signal.removeEventListener("abort", onUpstreamAbort);
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
