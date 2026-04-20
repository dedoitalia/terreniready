import { runScan } from "@/lib/overpass";
import type {
  ScanJobCreateResponse,
  ScanJobLogEntry,
  ScanJobSnapshot,
  ScanJobStatus,
  ScanRequest,
} from "@/types/scan";

type InternalScanJob = ScanJobSnapshot;

const JOB_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LOGS = 120;

const scanJobs = getGlobalStore<Map<string, InternalScanJob>>(
  "__terreniReadyScanJobs",
  () => new Map(),
);

function getGlobalStore<T>(key: string, init: () => T) {
  const globalScope = globalThis as Record<string, unknown>;
  const existing = globalScope[key];

  if (existing) {
    return existing as T;
  }

  const created = init();
  globalScope[key] = created;
  return created;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanupJobs() {
  const threshold = Date.now() - JOB_TTL_MS;

  for (const [jobId, job] of scanJobs.entries()) {
    if (Date.parse(job.updatedAt) < threshold) {
      scanJobs.delete(jobId);
    }
  }
}

function cloneJob(job: InternalScanJob): ScanJobSnapshot {
  return {
    ...job,
    request: {
      provinceIds: [...job.request.provinceIds],
      categoryIds: [...job.request.categoryIds],
    },
    logs: [...job.logs],
    result: job.result,
    error: job.error,
  };
}

function appendLog(jobId: string, message: string) {
  const job = scanJobs.get(jobId);

  if (!job) {
    return;
  }

  const entry: ScanJobLogEntry = {
    timestamp: nowIso(),
    message,
  };

  job.logs = [...job.logs, entry].slice(-MAX_LOGS);
  job.updatedAt = entry.timestamp;
}

function updateStatus(jobId: string, status: ScanJobStatus) {
  const job = scanJobs.get(jobId);

  if (!job) {
    return;
  }

  job.status = status;
  job.updatedAt = nowIso();
}

export function createScanJob(request: ScanRequest): ScanJobCreateResponse {
  cleanupJobs();

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const job: InternalScanJob = {
    id,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    request,
    logs: [
      {
        timestamp: createdAt,
        message: "Job creato, in attesa di esecuzione.",
      },
    ],
    result: null,
    error: null,
  };

  scanJobs.set(id, job);
  void processScanJob(id);

  return { jobId: id };
}

async function processScanJob(jobId: string) {
  const job = scanJobs.get(jobId);

  if (!job) {
    return;
  }

  updateStatus(jobId, "running");
  appendLog(jobId, "Scansione partita sul server.");

  try {
    const result = await runScan(job.request.provinceIds, job.request.categoryIds, {
      reportProgress: ({ message }) => appendLog(jobId, message),
    });
    const currentJob = scanJobs.get(jobId);

    if (!currentJob) {
      return;
    }

    currentJob.result = result;
    currentJob.error = null;
    currentJob.status = "completed";
    currentJob.updatedAt = nowIso();
    appendLog(jobId, "Risultati pronti.");
  } catch (error) {
    const currentJob = scanJobs.get(jobId);

    if (!currentJob) {
      return;
    }

    currentJob.result = null;
    currentJob.error =
      error instanceof Error ? error.message : "Errore durante la scansione.";
    currentJob.status = "failed";
    currentJob.updatedAt = nowIso();
    appendLog(jobId, `Errore: ${currentJob.error}`);
  }
}

export function getScanJob(jobId: string): ScanJobSnapshot | null {
  cleanupJobs();
  const job = scanJobs.get(jobId);
  return job ? cloneJob(job) : null;
}
