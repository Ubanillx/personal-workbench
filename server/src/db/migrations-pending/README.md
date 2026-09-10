# 待启用迁移（migrations-pending）

这里的 `.sql` **不会**被服务自动应用——`SqliteMigrationRunner` 只读 `server/src/db/migrations/`。

账号密码 + 多组织改造（`docs/harness/ACCOUNTS_AND_ORGS.md`）的迁移先放这里，原因是**顺序耦合**：
`009` 给 `tasks`/`todos`/`notes`/`important_files`/`weekly_reports` 加的是 `NOT NULL org_id`，
而旧代码插入这些表时不带 `org_id`。如果先把迁移放进 `migrations/`，从那一刻起应用就写不进数据，
`npm test` 也会一直红到 B/C 阶段代码落地为止。

## 使用方式

```bash
npm run db:rehearse              # 用 node:sqlite backup 取正式库快照，在副本上试跑 pending 迁移
npm run db:rehearse -- --source <路径>   # 换一个源库
```

`db:rehearse` 会把 `migrations/` 的全部迁移 + 这里的 pending 迁移合成一个临时目录交给真实的
`SqliteMigrationRunner` 执行（因此也顺带验证了 runner 的「FK OFF + 单事务」行为），然后逐表核对：
行数是否一致、`org-default` 是否建立、5 个账号是否映射正确、业务数据是否都挂上了组织、
`PRAGMA foreign_key_check` 是否干净、旧角色 CHECK 是否还被接受。

## 启用时机

B/C 阶段代码（注册/登录、组织上下文、所有查询带组织过滤、所有插入带 `org_id`）落地并通过契约回放后，
把这两个文件 `git mv` 到 `server/src/db/migrations/`，再按 `ACCOUNTS_AND_ORGS.md` §9 的流程迁移正式库。
