import type { DatabaseSync } from "node:sqlite";

export type FileRecord = { id: string; name: string; filePath: string; createdAt: string; updatedAt: string };
export type CreateFileInput = FileRecord;
export type UpdateFileInput = Partial<Omit<FileRecord, "id">>;

export class FileRepository {
  public constructor(private readonly database: DatabaseSync) {}
  public findAll(): FileRecord[] { return (this.database.prepare("SELECT id, name, file_path, created_at, updated_at FROM important_files ORDER BY created_at").all() as Array<Record<string, unknown>>).map(toFileRecord); }
  public create(input: CreateFileInput): FileRecord { this.database.prepare("INSERT INTO important_files(id, name, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.name, input.filePath, input.createdAt, input.updatedAt); return input; }
  public update(id: string, input: UpdateFileInput): FileRecord { const current = this.findAll().find((item) => item.id === id); if (!current) throw new Error("File bookmark not found"); const next = { ...current, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() }; this.database.prepare("UPDATE important_files SET name = ?, file_path = ?, created_at = ?, updated_at = ? WHERE id = ?").run(next.name, next.filePath, next.createdAt, next.updatedAt, id); return next; }
  public delete(id: string): void { this.database.prepare("DELETE FROM important_files WHERE id = ?").run(id); }
}

function toFileRecord(row: Record<string, unknown>): FileRecord { return { id: String(row.id), name: String(row.name), filePath: String(row.file_path), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
