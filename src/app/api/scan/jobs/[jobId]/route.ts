import { getScanJob } from "@/lib/scan-jobs";

export const runtime = "nodejs";

type Params = Promise<{
  jobId: string;
}>;

export async function GET(
  _request: Request,
  context: {
    params: Params;
  },
) {
  const { jobId } = await context.params;
  const job = getScanJob(jobId);

  if (!job) {
    return Response.json(
      {
        error:
          "Sessione di scansione non più disponibile. Aggiorna la pagina e usa la scansione live.",
      },
      { status: 410 },
    );
  }

  return Response.json(job);
}
