import type { DatabaseSync } from "node:sqlite";

export type NoteRecord = { id: string; content: string; isPinned: boolean; createdAt: string; updatedAt: string };
export type CreateNoteInput = NoteRecord;
export type UpdateNoteInput = Partial<Omit<NoteRecord, "id">>;

export class NoteRepository {
  public constructor(private readonly database: DatabaseSync) {}
  public findAll(): NoteRecord[] {
    return (
      this.database.prepare("SELECT id, content, is_pinned, created_at, updated_at FROM notes ORDER BY created_at").all() as Array<
        Record<string, unknown>
      >
    ).map(toNoteRecord);
  }
  public create(input: CreateNoteInput): NoteRecord {
    this.database
      .prepare("INSERT INTO notes(id, content, is_pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.content, Number(input.isPinned), input.createdAt, input.updatedAt);
    return input;
  }
  public update(id: string, input: UpdateNoteInput): NoteRecord {
    const current = this.findAll().find((item) => item.id === id);
    if (!current) throw new Error("Note not found");
    const next = { ...current, ...input, updatedAt: input.updatedAt ?? new Date().toISOString() };
    this.database
      .prepare("UPDATE notes SET content = ?, is_pinned = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run(next.content, Number(next.isPinned), next.createdAt, next.updatedAt, id);
    return next;
  }
  public delete(id: string): void {
    this.database.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }
}

function toNoteRecord(row: Record<string, unknown>): NoteRecord {
  return {
    id: String(row.id),
    content: String(row.content),
    isPinned: Number(row.is_pinned) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
