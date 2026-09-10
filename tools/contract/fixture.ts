import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabaseClient } from "../../server/src/db/client";

/** 固定时间戳：golden 必须与运行时刻无关 */
const STAMP = "2026-09-01T00:00:00.000Z";
const MIGRATIONS_DIR = path.resolve(process.cwd(), "server/src/db/migrations");

export const TOKENS = {
  owner: "owner-token",
  assistant: "assistant-a-token",
  assistantB: "assistant-b-token",
  viewer: "viewer-token",
} as const;

export type Fixture = {
  directory: string;
  databasePath: string;
  uploadsDir: string;
  /** 种子数据的固定 id，供用例引用 */
  ids: {
    taskTodo: string;
    taskDoing: string;
    taskReview: string;
    taskDone: string;
    taskArchived: string;
    taskPrivate: string;
    taskOverdue: string;
    taskOfB: string;
    todoOpen: string;
    noteOne: string;
    fileOne: string;
    reportSubmitted: string;
  };
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 建立确定性种子库：固定 id、固定时间戳、固定内容。
 * 只依赖 node:sqlite 与 server/src/db（均为框架无关代码），迁移前后都可用。
 */
export function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-contract-"));
  const databasePath = path.join(directory, "workbench.sqlite");
  const uploadsDir = path.join(directory, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const client = createDatabaseClient({ databasePath, readOnly: false, migrationsDirectory: MIGRATIONS_DIR });
  const db = client.getDatabase();

  for (const [id, name, role, token] of [
    ["owner", "主人", "owner", TOKENS.owner],
    ["assistant-a", "助理 A", "assistant", TOKENS.assistant],
    ["assistant-b", "助理 B", "assistant", TOKENS.assistantB],
    ["viewer-a", "查看者", "viewer", TOKENS.viewer],
  ] as const) {
    db.prepare("INSERT INTO users(id,name,role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, role, 1, STAMP, STAMP);
    db.prepare("INSERT INTO access_tokens(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,NULL,NULL)").run(
      `token-${id}`,
      id,
      sha256(token),
      STAMP,
    );
  }

  const ids = {
    taskTodo: "t-todo",
    taskDoing: "t-doing",
    taskReview: "t-review",
    taskDone: "t-done",
    taskArchived: "t-archived",
    taskPrivate: "t-private",
    taskOverdue: "t-overdue",
    taskOfB: "t-of-b",
    todoOpen: "todo-open",
    noteOne: "note-1",
    fileOne: "file-1",
    reportSubmitted: "report-submitted",
  };

  const insertTask = db.prepare(
    "INSERT INTO tasks(id,title,description,priority,status,progress,due_date,owner_id,created_by,source,is_private,created_at,updated_at,completed_at,archived_at,wecom_fingerprint,overdue_notified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
  );
  const taskRows: Array<[string, string, string, string, number, string | null, string | null, number, string | null]> = [
    [ids.taskTodo, "待办任务", "todo", "P1", 0, null, "assistant-a", 0, null],
    [ids.taskDoing, "进行中任务", "in_progress", "P0", 40, "2026-09-30", "assistant-a", 0, null],
    [ids.taskReview, "待验收任务", "pending_review", "P1", 100, "2026-09-30", "assistant-a", 0, null],
    [ids.taskDone, "已完成任务", "completed", "P2", 100, "2026-09-10", "assistant-a", 0, null],
    [ids.taskArchived, "已归档任务", "todo", "P1", 0, null, "owner", 0, "2026-09-02T00:00:00.000Z"],
    [ids.taskPrivate, "私密任务", "todo", "P2", 0, null, "owner", 1, null],
    [ids.taskOverdue, "逾期任务", "todo", "P0", 10, "2020-01-01", "assistant-a", 0, null],
    [ids.taskOfB, "助理B的任务", "todo", "P1", 0, null, "assistant-b", 0, null],
  ];
  for (const [id, title, status, priority, progress, due, ownerId, isPrivate, archivedAt] of taskRows) {
    insertTask.run(
      id,
      title,
      "",
      priority,
      status,
      progress,
      due,
      ownerId,
      "owner",
      "manual",
      isPrivate,
      STAMP,
      STAMP,
      status === "completed" ? STAMP : null,
      archivedAt,
      null,
    );
  }

  db.prepare(
    "INSERT INTO task_progress_logs(id,task_id,author_id,author_name,content,progress_snapshot,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("log-1", ids.taskDoing, "assistant-a", "助理 A", "已完成一半", 40, STAMP);
  db.prepare("INSERT INTO task_comments(id,task_id,author_id,author_name,author_role,content,created_at) VALUES(?,?,?,?,?,?,?)").run(
    "comment-1",
    ids.taskDoing,
    "owner",
    "主人",
    "owner",
    "请补充报价单",
    STAMP,
  );
  db.prepare("INSERT INTO task_events(id,task_id,actor_id,actor_name,event_type,content,created_at) VALUES(?,?,?,?,?,?,?)").run(
    "event-1",
    ids.taskDoing,
    "owner",
    "主人",
    "task_created",
    "创建任务",
    STAMP,
  );

  db.prepare("INSERT INTO todos(id,content,todo_date,is_completed,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(
    ids.todoOpen,
    "跟进报价",
    "2026-09-01",
    0,
    null,
    STAMP,
    STAMP,
  );
  db.prepare("INSERT INTO notes(id,content,is_pinned,created_at,updated_at) VALUES(?,?,?,?,?)").run(
    ids.noteOne,
    "会议要点",
    0,
    STAMP,
    STAMP,
  );
  db.prepare("INSERT INTO important_files(id,name,file_path,category,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(
    ids.fileOne,
    "报价单模板",
    "C:\\fixture\\quote-template.xlsx",
    "报价",
    null,
    STAMP,
    STAMP,
  );

  db.prepare(
    "INSERT INTO weekly_reports(id,owner_id,period_start,period_end,doc_type,note,status,current_version,uploaded_by,review_note,created_at,updated_at,submitted_at,reviewed_at,returned_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
  ).run(
    ids.reportSubmitted,
    "assistant-a",
    "2026-08-24",
    "2026-08-30",
    "weekly_report",
    "第八周",
    "submitted",
    1,
    "assistant-a",
    null,
    STAMP,
    STAMP,
    STAMP,
    null,
  );

  const reportDir = path.join(uploadsDir, ids.reportSubmitted);
  fs.mkdirSync(reportDir, { recursive: true });
  const fileName = "v1.docx";
  fs.writeFileSync(path.join(reportDir, fileName), "fake-docx-v1");
  db.prepare(
    "INSERT INTO report_files(id,report_id,version,original_name,stored_name,size_bytes,ext,mime_type,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run("rf-1", ids.reportSubmitted, 1, "第八周周报.docx", fileName, 12, ".docx", "application/msword", "assistant-a", STAMP);

  db.close();
  return { directory, databasePath, uploadsDir, ids };
}

export function removeFixture(fixture: Fixture): void {
  try {
    fs.rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (error) {
    // 临时目录残留无害（系统会自行清 Temp），不要因此让整个验收流程失败
    console.warn(`临时夹具目录未能删除（可忽略）：${error instanceof Error ? error.message : String(error)}`);
  }
}
