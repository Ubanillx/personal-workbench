import { db, now } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { notifyReport, reportRepository, requireOwnerForReports, toView } from "../lib/reports.server";

/** POST /api/reports/:id/approve —— 仅主人，仅"已提交"状态 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwnerForReports(request);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const repo = reportRepository();
  const report = repo.findById(String(params.id));
  if (!report) return fail("NOT_FOUND", "周报不存在", 404);
  if (report.status !== "submitted") return fail("INVALID_STATE", "只有已提交的周报才能通过", 400);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const note = String(body.note ?? "")
    .trim()
    .slice(0, 2000);
  const stamp = now();
  repo.update(report.id, { status: "approved", reviewNote: note || null, reviewedAt: stamp });
  notifyReport(
    db(),
    report.ownerId,
    user.id,
    report.id,
    "report_approved",
    "周报已通过",
    `你的周报（${report.periodStart}~${report.periodEnd}）已通过`,
  );
  const updated = repo.findById(report.id);
  if (!updated) throw new Error("Report not found");
  return ok(toView(updated, repo));
}
