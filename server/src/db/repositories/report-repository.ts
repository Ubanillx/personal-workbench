import type { DatabaseSync } from "node:sqlite";

export type ReportDocType = "weekly_report" | "summary" | "other";
export type ReportStatus = "submitted" | "approved" | "returned";

export type ReportRecord = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  periodStart: string;
  periodEnd: string;
  docType: ReportDocType;
  note: string;
  status: ReportStatus;
  currentVersion: number;
  uploadedBy: string;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  reviewedAt: string | null;
  returnedAt: string | null;
};

export type ReportFileRecord = {
  id: string;
  reportId: string;
  version: number;
  originalName: string;
  storedName: string;
  sizeBytes: number;
  ext: string;
  mimeType: string | null;
  uploadedBy: string;
  uploadedAt: string;
};

const SELECT_REPORT = `SELECT r.id, r.owner_id AS ownerId, u.name AS ownerName, r.period_start AS periodStart, r.period_end AS periodEnd, r.doc_type AS docType, r.note, r.status, r.current_version AS currentVersion, r.uploaded_by AS uploadedBy, r.review_note AS reviewNote, r.created_at AS createdAt, r.updated_at AS updatedAt, r.submitted_at AS submittedAt, r.reviewed_at AS reviewedAt, r.returned_at AS returnedAt FROM weekly_reports r LEFT JOIN users u ON u.id = r.owner_id`;

export class ReportRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public findById(id: string): ReportRecord | null {
    const row = this.database.prepare(`${SELECT_REPORT} WHERE r.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? toReportRecord(row) : null;
  }

  public findByOwner(ownerId: string): ReportRecord[] {
    return (
      this.database.prepare(`${SELECT_REPORT} WHERE r.owner_id = ? ORDER BY r.updated_at DESC`).all(ownerId) as Array<
        Record<string, unknown>
      >
    ).map(toReportRecord);
  }

  public findAll(): ReportRecord[] {
    return (this.database.prepare(`${SELECT_REPORT} ORDER BY r.updated_at DESC`).all() as Array<Record<string, unknown>>).map(
      toReportRecord,
    );
  }

  public create(input: ReportRecord): ReportRecord {
    this.database
      .prepare(
        "INSERT INTO weekly_reports(id, owner_id, period_start, period_end, doc_type, note, status, current_version, uploaded_by, review_note, created_at, updated_at, submitted_at, reviewed_at, returned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.ownerId,
        input.periodStart,
        input.periodEnd,
        input.docType,
        input.note,
        input.status,
        input.currentVersion,
        input.uploadedBy,
        input.reviewNote,
        input.createdAt,
        input.updatedAt,
        input.submittedAt,
        input.reviewedAt,
        input.returnedAt,
      );
    const result = this.findById(input.id);
    if (!result) throw new Error("Report insertion failed");
    return result;
  }

  public update(id: string, input: Partial<Omit<ReportRecord, "id" | "ownerName">>): ReportRecord {
    const current = this.findById(id);
    if (!current) throw new Error("Report not found");
    const next = { ...current, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() };
    this.database
      .prepare(
        "UPDATE weekly_reports SET owner_id = ?, period_start = ?, period_end = ?, doc_type = ?, note = ?, status = ?, current_version = ?, uploaded_by = ?, review_note = ?, created_at = ?, updated_at = ?, submitted_at = ?, reviewed_at = ?, returned_at = ? WHERE id = ?",
      )
      .run(
        next.ownerId,
        next.periodStart,
        next.periodEnd,
        next.docType,
        next.note,
        next.status,
        next.currentVersion,
        next.uploadedBy,
        next.reviewNote,
        next.createdAt,
        next.updatedAt,
        next.submittedAt,
        next.reviewedAt,
        next.returnedAt,
        id,
      );
    return next;
  }

  public listFiles(reportId: string): ReportFileRecord[] {
    return (
      this.database
        .prepare(
          "SELECT id, report_id AS reportId, version, original_name AS originalName, stored_name AS storedName, size_bytes AS sizeBytes, ext, mime_type AS mimeType, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM report_files WHERE report_id = ? ORDER BY version",
        )
        .all(reportId) as Array<Record<string, unknown>>
    ).map(toFileRecord);
  }

  public findFile(reportId: string, version: number): ReportFileRecord | null {
    const row = this.database
      .prepare(
        "SELECT id, report_id AS reportId, version, original_name AS originalName, stored_name AS storedName, size_bytes AS sizeBytes, ext, mime_type AS mimeType, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM report_files WHERE report_id = ? AND version = ?",
      )
      .get(reportId, version) as Record<string, unknown> | undefined;
    return row ? toFileRecord(row) : null;
  }

  public addFile(input: ReportFileRecord): void {
    this.database
      .prepare(
        "INSERT INTO report_files(id, report_id, version, original_name, stored_name, size_bytes, ext, mime_type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.reportId,
        input.version,
        input.originalName,
        input.storedName,
        input.sizeBytes,
        input.ext,
        input.mimeType,
        input.uploadedBy,
        input.uploadedAt,
      );
  }
}

function toReportRecord(row: Record<string, unknown>): ReportRecord {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    ownerName: row.ownerName == null ? null : String(row.ownerName),
    periodStart: String(row.periodStart),
    periodEnd: String(row.periodEnd),
    docType: String(row.docType) as ReportDocType,
    note: String(row.note ?? ""),
    status: String(row.status) as ReportStatus,
    currentVersion: Number(row.currentVersion),
    uploadedBy: String(row.uploadedBy),
    reviewNote: row.reviewNote == null ? null : String(row.reviewNote),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    submittedAt: String(row.submittedAt),
    reviewedAt: row.reviewedAt == null ? null : String(row.reviewedAt),
    returnedAt: row.returnedAt == null ? null : String(row.returnedAt),
  };
}

function toFileRecord(row: Record<string, unknown>): ReportFileRecord {
  return {
    id: String(row.id),
    reportId: String(row.reportId),
    version: Number(row.version),
    originalName: String(row.originalName),
    storedName: String(row.storedName),
    sizeBytes: Number(row.sizeBytes),
    ext: String(row.ext),
    mimeType: row.mimeType == null ? null : String(row.mimeType),
    uploadedBy: String(row.uploadedBy),
    uploadedAt: String(row.uploadedAt),
  };
}
