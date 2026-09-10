import { db, one } from "./db.server";

/** 成员管理相关查询（供路由模块复用；不能写在路由文件里，见 RR8 路由导出约束） */
export function memberExists(id: string): boolean {
  return Boolean(one(db(), "SELECT id FROM users WHERE id=? AND id<>?", id, "owner"));
}
