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
    return Response.json({ error: "Job non trovato." }, { status: 404 });
  }

  return Response.json(job);
}
