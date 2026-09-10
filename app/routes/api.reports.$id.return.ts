import { db, now } from "../lib/db.server";
import { fail, ok } from "../lib/http.server";
import { notifyReport, reportRepository, requireOwnerForReports, toView } from "../lib/reports.server";

/** POST /api/reports/:id/return —— 仅主人，仅"已提交"状态，必须填写原因 */
export async function action({ request, params }: { request: Request; params: { id?: string } }): Promise<Response> {
  const auth = requireOwnerForReports(request);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const repo = reportRepository();
  const report = repo.findById(String(params.id));
  if (!report) return fail("NOT_FOUND", "周报不存在", 404);
  if (report.status !== "submitted") return fail("INVALID_STATE", "只有已提交的周报才能退回", 400);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const note = String(body.note ?? "").trim();
  if (!note) return fail("VALIDATION_ERROR", "退回时请填写原因", 400);

  const stamp = now();
  repo.update(report.id, { status: "returned", reviewNote: note.slice(0, 2000), returnedAt: stamp });
  notifyReport(
    db(),
    report.ownerId,
    user.id,
    report.id,
    "report_returned",
    "周报已退回",
    `你的周报（${report.periodStart}~${report.periodEnd}）已退回：${note.slice(0, 2000)}`,
  );
  const updated = repo.findById(report.id);
  if (!updated) throw new Error("Report not found");
  return ok(toView(updated, repo));
}
