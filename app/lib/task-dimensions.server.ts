import { randomUUID } from "node:crypto";
import { db, now, one, rows, run, type User } from "./db.server";
import { assertOrgAccess } from "./session.server";
import { createTask, type ServiceResult } from "./task-service.server";
import { canView, findTaskWithOrg, type TaskView } from "./tasks.server";

export type TaskDimension = { id: string; name: string };
export type PersonalTaskState = { dimensionIds: string[]; handled: boolean };
const done = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, data, status });
const fail = (code: string, message: string, status: number): ServiceResult<never> => ({ ok: false, code, message, status });
const missing = (): ServiceResult<never> => fail("NOT_FOUND", "未找到该资源", 404);

export function listTaskDimensions(user: User): TaskDimension[] {
  return rows<TaskDimension>(db(), "SELECT id,name FROM task_dimensions WHERE user_id=? ORDER BY created_at,id", user.id);
}

export function saveTaskDimension(user: User, id: string | null, body: Record<string, unknown>): ServiceResult<TaskDimension> {
  const database = db();
  const creating = id === null;
  if (id !== null && !one(database, "SELECT id FROM task_dimensions WHERE id=? AND user_id=?", id, user.id)) return missing();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 40) return fail("VALIDATION_ERROR", "维度名称需要 1 至 40 个字符", 400);
  if (one(database, "SELECT id FROM task_dimensions WHERE user_id=? AND name=? AND id<>?", user.id, name, id ?? "")) {
    return fail("VALIDATION_ERROR", "你已有同名维度", 400);
  }
  const stamp = now();
  if (id !== null) run(database, "UPDATE task_dimensions SET name=?,updated_at=? WHERE id=? AND user_id=?", name, stamp, id, user.id);
  else {
    id = randomUUID();
    run(database, "INSERT INTO task_dimensions(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)", id, user.id, name, stamp, stamp);
  }
  return done({ id, name }, creating ? 201 : 200);
}

export function deleteTaskDimension(user: User, id: string): ServiceResult<null> {
  const database = db();
  if (!one(database, "SELECT id FROM task_dimensions WHERE id=? AND user_id=?", id, user.id)) return missing();
  run(database, "DELETE FROM task_dimensions WHERE id=? AND user_id=?", id, user.id);
  return done(null);
}

function validateDimensions(user: User, value: unknown): ServiceResult<string[]> {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !id)) {
    return fail("VALIDATION_ERROR", "请选择有效的个人维度", 400);
  }
  const ids = [...new Set(value as string[])];
  const owned = new Set(listTaskDimensions(user).map((dimension) => dimension.id));
  if (ids.some((id) => !owned.has(id))) return missing();
  return done(ids);
}

function taskAccess(user: User, taskId: string): ServiceResult<null> {
  const found = findTaskWithOrg(db(), taskId);
  if (!found || assertOrgAccess(user, found.orgId)) return missing();
  if (!canView(found.task, user)) return fail("FORBIDDEN", "无权查看该任务", 403);
  return done(null);
}

/** SQLite 单条语句的占位符有上限，看板一次要查全量任务，按批取 */
const PERSONAL_STATE_CHUNK = 400;

/** Only enrich already-authorized tasks. The account+task key synchronizes every personal dimension. */
export function personalTaskStates(user: User, taskIds: string[]): Record<string, PersonalTaskState> {
  const result: Record<string, PersonalTaskState> = {};
  const ids = [...new Set(taskIds)];
  if (!ids.length) return result;
  const database = db();
  for (const id of ids) result[id] = { dimensionIds: [], handled: false };
  for (let start = 0; start < ids.length; start += PERSONAL_STATE_CHUNK) {
    const chunk = ids.slice(start, start + PERSONAL_STATE_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of rows<{ taskId: string; dimensionId: string }>(
      database,
      `SELECT task_id AS taskId,dimension_id AS dimensionId FROM task_dimension_links WHERE user_id=? AND task_id IN (${placeholders})`,
      user.id,
      ...chunk,
    )) {
      result[row.taskId]?.dimensionIds.push(row.dimensionId);
    }
    for (const row of rows<{ taskId: string; handled: number }>(
      database,
      `SELECT task_id AS taskId,handled FROM personal_task_handling WHERE user_id=? AND task_id IN (${placeholders})`,
      user.id,
      ...chunk,
    )) {
      const state = result[row.taskId];
      if (state) state.handled = row.handled === 1;
    }
  }
  return result;
}

/** 维度看板的一格：一个维度（或「未分类」）加上归属它的任务 */
export type DimensionBoardGroup = { id: string; name: string; tasks: TaskView[] };

/**
 * 按个人维度把任务分到卡片：一个维度一张卡，任务可同时出现在多个维度里，
 * 没有任何维度的任务进「未分类」。`dimension` 是工具栏筛选器，选中某一项时只回那一格。
 */
export function buildDimensionBoard(
  user: User,
  tasks: TaskView[],
  states: Record<string, PersonalTaskState>,
  dimension: string,
): DimensionBoardGroup[] {
  const groups: DimensionBoardGroup[] = listTaskDimensions(user).map((item) => ({
    id: item.id,
    name: item.name,
    tasks: tasks.filter((task) => states[task.id]?.dimensionIds.includes(item.id)),
  }));
  groups.push({
    id: "unclassified",
    name: "未分类",
    tasks: tasks.filter((task) => !states[task.id]?.dimensionIds.length),
  });
  return !dimension || dimension === "all" ? groups : groups.filter((group) => group.id === dimension);
}

export function readPersonalTask(user: User, taskId: string): ServiceResult<PersonalTaskState> {
  const access = taskAccess(user, taskId);
  if (!access.ok) return access;
  return done(personalTaskStates(user, [taskId])[taskId]!);
}

function replaceLinks(user: User, taskId: string, ids: string[]): void {
  const database = db();
  run(database, "DELETE FROM task_dimension_links WHERE user_id=? AND task_id=?", user.id, taskId);
  for (const id of ids) run(database, "INSERT INTO task_dimension_links(user_id,task_id,dimension_id) VALUES(?,?,?)", user.id, taskId, id);
}

export function savePersonalTask(user: User, taskId: string, body: Record<string, unknown>): ServiceResult<PersonalTaskState> {  const access = taskAccess(user, taskId);
  if (!access.ok) return access;
  const dimensions = body.dimensionIds === undefined ? null : validateDimensions(user, body.dimensionIds);
  if (dimensions && !dimensions.ok) return dimensions;
  if (body.handled !== undefined && typeof body.handled !== "boolean") return fail("VALIDATION_ERROR", "本人已处理必须是布尔值", 400);
  if (!dimensions && body.handled === undefined) return fail("VALIDATION_ERROR", "请选择维度或设置本人已处理", 400);
  const database = db();
  database.exec("SAVEPOINT personal_task");
  try {
    if (dimensions?.ok) replaceLinks(user, taskId, dimensions.data);
    if (typeof body.handled === "boolean")
      run(
        database,
        "INSERT INTO personal_task_handling(user_id,task_id,handled,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,task_id) DO UPDATE SET handled=excluded.handled,updated_at=excluded.updated_at",
        user.id,
        taskId,
        Number(body.handled),
        now(),
      );
    database.exec("RELEASE personal_task");
  } catch (error) {
    database.exec("ROLLBACK TO personal_task; RELEASE personal_task");
    throw error;
  }
  return readPersonalTask(user, taskId);
}

/**
 * 看板拖拽：把任务移动到某个个人维度 = 清空其他维度，只保留目标维度。
 * 目标必须是本人创建的维度（「未分类」不是真实维度，拖进去会 404）；
 * 不改任务本身，也不影响其他人的维度。
 */
export function moveTaskDimension(user: User, taskId: string, dimensionId: string): ServiceResult<PersonalTaskState> {
  const access = taskAccess(user, taskId);
  if (!access.ok) return access;
  if (!one(db(), "SELECT id FROM task_dimensions WHERE id=? AND user_id=?", dimensionId, user.id)) return missing();
  const database = db();
  database.exec("SAVEPOINT move_dimension");
  try {
    replaceLinks(user, taskId, [dimensionId]);
    database.exec("RELEASE move_dimension");
  } catch (error) {
    database.exec("ROLLBACK TO move_dimension; RELEASE move_dimension");
    throw error;
  }
  return readPersonalTask(user, taskId);
}

/** Creation and optional personal links commit together; the base task API shape stays unchanged. */
export function createTaskWithDimensions(user: User, body: Record<string, unknown>): ServiceResult<unknown> {
  const dimensions = validateDimensions(user, body.dimensionIds === undefined ? [] : body.dimensionIds);
  if (!dimensions.ok) return dimensions;
  const database = db();
  database.exec("SAVEPOINT dimension_task_create");
  try {
    const result = createTask(user, body);
    if (!result.ok) {
      database.exec("ROLLBACK TO dimension_task_create; RELEASE dimension_task_create");
      return result;
    }
    replaceLinks(user, String(result.data.id), dimensions.data);
    database.exec("RELEASE dimension_task_create");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO dimension_task_create; RELEASE dimension_task_create");
    throw error;
  }
}
