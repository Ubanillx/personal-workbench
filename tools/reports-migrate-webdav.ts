import { promises as fsp } from "node:fs";
import path from "node:path";
import { appConfig } from "../app/lib/context.server";
import { db, rows, run } from "../app/lib/db.server";
import {
  candidateFileName,
  isRemoteStoredName,
  remoteDirectoryFor,
  toRemoteStoredName,
  uploadReportFile,
} from "../app/lib/report-storage.server";
import { reportStorageMessage } from "../app/lib/report-storage.server";
import { reportStorageClient } from "../app/lib/webdav.server";
import { reportUploadRootFor, resolveReportUploadConfig } from "../app/lib/webdav-settings.server";

/**
 * 存量周报正文搬迁：把本地 `data/uploads/reports/<reportId>/v<N>.<ext>` 按 **D-46** 的新命名
 * 推到 NAS，并回写 `report_files.stored_name`（见 docs/harness/REPORTS_WEBDAV.md §6.2）。
 *
 * 用法：
 *
 * ```bash
 * npm run reports:migrate-webdav -- --dry-run   # 只打印计划，不动任何东西
 * npm run reports:migrate-webdav                # 上传 + 回写（本地文件原样保留）
 * npm run reports:migrate-webdav -- --purge     # 收尾：删掉本地正文与空目录
 * ```
 *
 * 四条刻意的行为：
 * 1. **幂等**：`stored_name` 已经有 `webdav:` 前缀的记录直接跳过，可以反复跑；
 * 2. **认领**：目标路径已存在且**字节数一致**时视为「上次已传成功、只是没来得及回写」，
 *    直接回写数据库而不再传一份 `_2`（否则失败重跑会在 NAS 上堆出重复文件）；
 * 3. **不半途而废**：单条失败只记下来，跑完全部再汇总；有失败就以退出码 1 结束；
 * 4. **`--purge` 只删确认过的**：删之前再 `stat` 一次远端，确认文件真的在那边才删本地。
 */

type MigrationRow = {
  fileId: string;
  reportId: string;
  version: number;
  originalName: string;
  storedName: string;
  ext: string;
  sizeBytes: number;
  periodStart: string;
  periodEnd: string;
  /** 周报所属组织：决定写进哪个上传根目录（D-53） */
  orgId: string;
  orgName: string | null;
  username: string | null;
};

/** 清理本地正文时的候选：**本地文件名必须与原 stored_name 分开记**（回写后那一列已经是远端路径了） */
type PurgeCandidate = { reportId: string; legacyLocalName: string; remotePath: string };

type Failure = { fileId: string; reportId: string; reason: string };

const HELP = `周报正文迁移到 WebDAV（D-46，连接口径见 D-52）

用法：npm run reports:migrate-webdav [-- --dry-run] [-- --purge]

  --dry-run   只打印将要执行的动作，不写 NAS、不改数据库
  --purge     迁移完成后删除本地正文与空目录（默认保留）
  --help      显示这段说明
`;

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** 待迁移的记录：还需要归属人用户名、周期与**所属组织**来拼远端路径（D-53：目录按组织） */
function listRows(): MigrationRow[] {
  return rows<MigrationRow>(
    db(),
    `SELECT f.id AS fileId,f.report_id AS reportId,f.version,f.original_name AS originalName,
            f.stored_name AS storedName,f.ext AS ext,f.size_bytes AS sizeBytes,
            r.period_start AS periodStart,r.period_end AS periodEnd,r.org_id AS orgId,
            u.username AS username,o.name AS orgName
       FROM report_files f
       JOIN weekly_reports r ON r.id = f.report_id
       LEFT JOIN users u ON u.id = r.owner_id
       LEFT JOIN organizations o ON o.id = r.org_id
      ORDER BY f.report_id, f.version`,
  );
}

/**
 * 老式记录的本地文件名。
 *
 * 回写之后 `stored_name` 已经是远端路径，不能再拿它拼本地路径——所以：
 * - 还没回写的记录直接用读到的 `stored_name`（就是本地文件名）；
 * - 已经回写的记录按旧约定还原：`v<version><ext>`（迁移前的 `persistFile` 就是这么写的）。
 */
function legacyLocalNameOf(row: MigrationRow): string {
  return isRemoteStoredName(row.storedName) ? `v${row.version}${row.ext}` : row.storedName;
}

function localPathOf(uploadsDir: string, reportId: string, localName: string): string {
  return path.join(uploadsDir, reportId, localName);
}

/** 目标远端路径（不含撞名后缀）：与运行时同一套命名规则 */
function intendedRemotePath(root: string, row: MigrationRow): string {
  const directory = remoteDirectoryFor(root, {
    username: row.username ?? "unnamed",
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  });
  return `${directory}/${candidateFileName(row.originalName, row.version, 0)}`;
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(HELP);
    return;
  }
  const dryRun = hasFlag("--dry-run");
  const purge = hasFlag("--purge");
  const config = appConfig();
  const uploadsDir = config.uploadsDir;

  const resolved = resolveReportUploadConfig(null);
  if (!resolved.enabled) {
    console.error("× 周报上传还不能用：请管理员先到「设置 → WebDAV」保存一次连接（用户名 / 密码 / 浏览根目录）");
    console.error("  （地址来自 .env 的 WEBDAV_URL；各组织的上传目录默认用那份连接的浏览根目录）");
    process.exitCode = 2;
    return;
  }
  const client = reportStorageClient();
  if (!client) {
    console.error("× 无法创建 WebDAV 客户端：请检查 WEBDAV_URL 与共用连接配置");
    process.exitCode = 2;
    return;
  }

  const all = listRows();
  const pending = all.filter((row) => !isRemoteStoredName(row.storedName));
  console.log(`本地正文目录：${uploadsDir}`);
  console.log(`远端落点    ：${resolved.url}<各组织的上传根目录>/<用户名>/<起止日期>/<文件名>`);
  console.log(`共 ${all.length} 个版本，其中已有 ${all.length - pending.length} 个在 NAS 上，待迁移 ${pending.length} 个。`);
  if (dryRun) console.log("（--dry-run：只打印计划，不写 NAS、不改数据库）");

  const failures: Failure[] = [];
  const purgeCandidates: PurgeCandidate[] = [];
  let migrated = 0;
  let adopted = 0;
  let skipped = 0;

  for (const row of pending) {
    const legacyLocalName = legacyLocalNameOf(row);
    const localPath = localPathOf(uploadsDir, row.reportId, legacyLocalName);
    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(localPath);
    } catch {
      failures.push({ fileId: row.fileId, reportId: row.reportId, reason: `本地文件不存在：${localPath}` });
      continue;
    }
    const target = intendedRemotePath(reportUploadRootFor(row.orgId), row);

    if (dryRun) {
      console.log(`  [计划] v${row.version} ${row.originalName} → ${target}（${buffer.byteLength} 字节）`);
      continue;
    }

    try {
      // 认领：目标已在远端且大小一致 → 上次多半传成功只是没回写，直接回写数据库
      const existing = await client.stat(target);
      if (existing && existing.size !== null && existing.size === buffer.byteLength) {
        run(db(), "UPDATE report_files SET stored_name=? WHERE id=?", toRemoteStoredName(target), row.fileId);
        adopted += 1;
        purgeCandidates.push({ reportId: row.reportId, legacyLocalName, remotePath: target });
        console.log(`  [认领] v${row.version} ${row.originalName} → ${target}（远端已有且大小一致）`);
        continue;
      }
      const uploaded = await uploadReportFile({
        orgId: row.orgId,
        username: row.username ?? "unnamed",
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        originalName: row.originalName,
        version: row.version,
        buffer,
        contentType: null,
      });
      run(db(), "UPDATE report_files SET stored_name=? WHERE id=?", uploaded.storedName, row.fileId);
      if (uploaded.remotePath !== target) {
        console.log(`  [注意] v${row.version} ${row.originalName} → ${uploaded.remotePath}（目标名被占用，已改后缀）`);
      }
      migrated += 1;
      purgeCandidates.push({ reportId: row.reportId, legacyLocalName, remotePath: uploaded.remotePath });
      console.log(`  [完成] v${row.version} ${row.originalName} → ${uploaded.remotePath}`);
    } catch (error) {
      failures.push({ fileId: row.fileId, reportId: row.reportId, reason: reportStorageMessage(error) });
    }
  }

  // 已经在前缀里的记录也算「可以清本地」的候选（它们本来就在 NAS 上）；
  // 它们的本地文件名按旧约定还原，不能拿回写后的 stored_name 去拼。
  const alreadyRemote: PurgeCandidate[] = all
    .filter((row) => isRemoteStoredName(row.storedName))
    .map((row) => ({
      reportId: row.reportId,
      legacyLocalName: legacyLocalNameOf(row),
      remotePath: row.storedName.slice("webdav:".length),
    }));
  const purgeable = [...purgeCandidates, ...alreadyRemote];

  let purged = 0;
  if (purge && !dryRun) {
    console.log("\n--purge：删除本地正文（删前会再确认远端存在）");
    for (const candidate of purgeable) {
      const localPath = localPathOf(uploadsDir, candidate.reportId, candidate.legacyLocalName);
      try {
        const entry = await client.stat(candidate.remotePath);
        if (!entry) {
          skipped += 1;
          console.log(`  [保留] ${candidate.remotePath} 远端查不到，本地文件先留着`);
          continue;
        }
        await fsp.rm(localPath, { force: true });
        purged += 1;
      } catch (error) {
        failures.push({
          fileId: candidate.reportId,
          reportId: candidate.reportId,
          reason: `清理本地文件失败：${reportStorageMessage(error)}`,
        });
      }
    }
    // 清掉空出来的 <reportId> 目录（只删空目录，非空一律留着）
    const reportDirs = [...new Set(purgeable.map((candidate) => path.join(uploadsDir, candidate.reportId)))];
    for (const dir of reportDirs) {
      try {
        const left = await fsp.readdir(dir);
        if (left.length === 0) await fsp.rmdir(dir);
      } catch {
        // 目录不存在 / 非空 / 正在被占用：都不影响迁移结果
      }
    }
  }

  console.log("\n——— 汇总 ———");
  console.log(`新上传 ${migrated} 个，认领 ${adopted} 个，失败 ${failures.length} 个${purge ? `，已清理本地 ${purged} 个` : ""}。`);
  if (failures.length > 0) {
    console.log("\n失败明细（本地文件仍在，修好后可以重跑；本命令幂等）：");
    for (const failure of failures) console.log(`  × 周报 ${failure.reportId} / 文件 ${failure.fileId}：${failure.reason}`);
    process.exitCode = 1;
  }
  if (!dryRun && !purge && pending.length > 0 && failures.length === 0) {
    console.log("\n本地正文仍保留着（默认不删）。确认 NAS 上都在之后，可以再跑一次加 --purge 收尾。");
  }
}

void main().catch((error: unknown) => {
  console.error(`× 迁移中止：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
});
