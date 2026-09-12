#!/usr/bin/env bash
#
# remote-deploy.sh —— personal-workbench 目标服务器（Linux + systemd）部署脚本。
#
# 这是「目标机侧」的唯一入口：Jenkins 通过 SSH 以 sudo 调用它，运维人员也可以用同一条命令
# 手工部署、回滚、查状态。
#
#   sudo deploy.sh init                    # 一次性初始化：服务账号 / 目录 / .env / systemd / sudoers
#   sudo deploy.sh deploy --archive <tgz> --sha <sha> [--sha256 <hex>] [--keep 5] [--templates-dir <dir>]
#   sudo deploy.sh rollback [--to <release>]   # 回滚到上一个（或指定）release
#   sudo deploy.sh status                  # 当前版本 / 服务状态 / 健康检查
#   sudo deploy.sh logs [--lines 200]      # 服务日志
#   sudo deploy.sh prune [--keep 5]        # 清理旧 release 与历史上传包
#
# 四条设计约束（详见 deploy/README-DEPLOY.md）：
#   1. 每次部署落到 releases/<时间戳>-<sha>/，用 current 软链接原子切换；回滚 = 切回旧目录 + 重启；
#   2. 数据（SQLite / 上传文件）永远在 shared/ 下，不随 release 一起被替换或清理；
#   3. 切换后必须通过 /api/ping 健康检查，否则自动切回上一个 release 并让本次构建失败；
#   4. 部署前先停服再备份数据库，保证备份是一致快照（SQLite 在 WAL 下边跑边拷可能拷到半个事务）。
#
# 退出码：0 成功；1 失败（已尽力回滚）；2 用法错误。

set -euo pipefail

# ---------------------------------------------------------------- 常量

APP_NAME="personal-workbench"
SERVICE_NAME="personal-workbench"
DEFAULT_ROOT="/opt/personal-workbench"
DEFAULT_SERVICE_USER="workbench"
DEFAULT_DEPLOY_USER="deploy"
DEFAULT_KEEP=5
DEFAULT_BACKUP_KEEP=20
HEALTH_PATH="/api/ping"
HEALTH_TIMEOUT=60
SUDOERS_PATH="/etc/sudoers.d/personal-workbench"
INCOMING_KEEP_DAYS=7

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- 可被参数覆盖的全局量

ROOT="$DEFAULT_ROOT"
SERVICE_USER="$DEFAULT_SERVICE_USER"
DEPLOY_USER="$DEFAULT_DEPLOY_USER"
KEEP="$DEFAULT_KEEP"
ARCHIVE=""
RELEASE_SHA=""
ARCHIVE_SHA256=""
TEMPLATES_DIR=""
TARGET_RELEASE=""
LOG_LINES=200
NODE_BIN=""
COMMAND=""

# ---------------------------------------------------------------- 日志

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
personal-workbench 目标服务器部署脚本

用法：
  sudo deploy.sh init [--root DIR] [--service-user USER] [--deploy-user USER]
  sudo deploy.sh deploy --archive FILE [--sha SHA] [--sha256 HEX] [--keep N] [--templates-dir DIR]
  sudo deploy.sh rollback [--to RELEASE_NAME_OR_PATH]
  sudo deploy.sh status
  sudo deploy.sh logs [--lines N]
  sudo deploy.sh prune [--keep N]

通用参数：
  --root DIR          部署根目录，默认 /opt/personal-workbench
  --service-user U    跑服务的系统账号，默认 workbench
  --deploy-user U     允许免密 sudo 部署脚本的账号（Jenkins 的 SSH 账号），默认 deploy
  --node-bin PATH     指定 node 可执行文件（默认从 PATH 里找）
  --templates-dir D   模板目录（systemd 单元 / .env / sudoers），默认 <root>/share/deploy-templates
EOF
}

# ---------------------------------------------------------------- 基础工具

require_root() {
  [[ "${EUID}" -eq 0 ]] || die "需要 root 权限，请用 sudo 执行：sudo ${SCRIPT_DIR}/$(basename -- "${BASH_SOURCE[0]}") ${COMMAND:-<命令>}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "目标机缺少命令：$1（$2）"
}

# 读取 shared/.env 里的单个键（不 source 该文件：避免执行到文件里的任意内容）
env_value() {
  local key="$1" fallback="${2-}" file="$ROOT/shared/.env" line
  if [[ ! -f "$file" ]]; then
    printf '%s' "$fallback"
    return 0
  fi
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$fallback"
    return 0
  fi
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [[ ${#line} -ge 2 && "$line" == \"*\" ]]; then
    line="${line:1:${#line}-2}"
  elif [[ ${#line} -ge 2 && "$line" == \'*\' ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

resolve_node_bin() {
  if [[ -z "$NODE_BIN" ]]; then
    NODE_BIN="$(command -v node || true)"
  fi
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die \
    "目标机找不到 node。请安装 Node.js >= 22.9.0（建议用 nodesource/apt 做系统级安装，不要只装在某个用户的 nvm 里），或用 --node-bin 指定绝对路径。"

  local major minor
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  minor="$("$NODE_BIN" -p 'process.versions.node.split(".")[1]')"
  if ((major < 22)) || { ((major == 22)) && ((minor < 9)); }; then
    die "Node 版本过低：$("$NODE_BIN" --version)，本项目要求 >= 22.9.0（依赖 node:sqlite 与 --env-file-if-exists）。"
  fi
  log "使用 Node：$NODE_BIN（$("$NODE_BIN" --version)）"
}

# 渲染模板：@ROOT@ 之类的占位符替换 + 强制 LF（模板万一被 Windows 检出带成 CRLF，配置会静默失效）
render_template() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || die "模板不存在：$src"
  sed -e "s|@ROOT@|${ROOT}|g" \
    -e "s|@APP_NAME@|${APP_NAME}|g" \
    -e "s|@SERVICE_NAME@|${SERVICE_NAME}|g" \
    -e "s|@SERVICE_USER@|${SERVICE_USER}|g" \
    -e "s|@SERVICE_GROUP@|${SERVICE_GROUP:-$SERVICE_USER}|g" \
    -e "s|@DEPLOY_USER@|${DEPLOY_USER}|g" \
    -e "s|@NODE_BIN@|${NODE_BIN}|g" \
    "$src" | tr -d '\r' >"$dst"
}

# ---------------------------------------------------------------- 服务与 release 状态

service_active() { systemctl is-active --quiet "$SERVICE_NAME"; }
service_failed() { systemctl is-failed --quiet "$SERVICE_NAME"; }

current_release() {
  local link="$ROOT/current"
  [[ -L "$link" ]] || return 1
  readlink -f "$link"
}

list_releases_desc() {
  find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | awk '{ $1 = ""; sub(/^ /, ""); print }'
}

previous_release() {
  local exclude="${1:-}" dir
  local -a dirs=()
  mapfile -t dirs < <(list_releases_desc)
  for dir in ${dirs[@]+"${dirs[@]}"}; do
    [[ -n "$exclude" && "$dir" == "$exclude" ]] && continue
    printf '%s\n' "$dir"
    return 0
  done
  return 1
}

switch_release() {
  local target="$1"
  [[ -d "$target" ]] || die "release 目录不存在：$target"
  ln -sfn "$target" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current" # mv -T：原子替换软链接，避免切换瞬间出现「软链接不存在」
  log "current -> $target"
}

stop_service() {
  if service_active; then
    log "停止服务 $SERVICE_NAME"
    systemctl stop "$SERVICE_NAME"
  else
    log "服务未在运行，跳过停止"
  fi
}

start_service() {
  log "启动服务 $SERVICE_NAME"
  systemctl start "$SERVICE_NAME"
}

# 部署中途放弃时的收尾：服务此刻是停的，必须先把它拉起来再报错退出，
# 否则一次「备份失败」就会把线上服务留在停止状态。
abort_restarting() {
  warn "$1"
  start_service || true
  die "已中止本次部署（服务已尝试恢复运行）"
}

journal_tail() {
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager 2>/dev/null || true
}

backup_db() {
  local db stamp base dir
  db="$(env_value DATABASE_PATH "$ROOT/shared/data/workbench.sqlite")"
  if [[ ! -f "$db" ]]; then
    log "数据库还不存在（首次部署），跳过备份"
    return 0
  fi
  dir="$ROOT/shared/backups"
  stamp="$(date +%Y%m%d-%H%M%S)"
  base="$(basename -- "$db")"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$dir"
  cp -p "$db" "$dir/${base}.${stamp}.bak"
  [[ -f "${db}-wal" ]] && cp -p "${db}-wal" "$dir/${base}.${stamp}.bak-wal" || true
  [[ -f "${db}-shm" ]] && cp -p "${db}-shm" "$dir/${base}.${stamp}.bak-shm" || true
  log "已备份数据库到 $dir/${base}.${stamp}.bak"
  # 只保留最近 N 份（按文件名里的时间戳倒序）
  ls -1t "$dir"/*.bak 2>/dev/null | tail -n "+$((DEFAULT_BACKUP_KEEP + 1))" | xargs -r rm -f || true
}

# ---------------------------------------------------------------- 健康检查

# 目标机不一定装了 curl，退回用 node 自带的 fetch（node 是本项目的硬前提）
http_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 "$url"
    return
  fi
  "$NODE_BIN" -e '
    const url = process.argv[1];
    const timer = setTimeout(() => process.exit(1), 5000);
    fetch(url)
      .then(async (res) => {
        if (!res.ok) process.exit(1);
        process.stdout.write(await res.text());
      })
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
      .finally(() => clearTimeout(timer));
  ' "$url"
}

health_check() {
  local port url deadline body
  port="$(env_value PORT 17500)"
  url="http://127.0.0.1:${port}${HEALTH_PATH}"
  deadline=$(($(date +%s) + HEALTH_TIMEOUT))
  log "健康检查 $url（最多 ${HEALTH_TIMEOUT}s）"

  while (($(date +%s) < deadline)); do
    if service_failed; then
      warn "服务状态为 failed，不再等待"
      return 1
    fi
    # 判据要同时满足两条：/api/ping 的顶层 status=ok **并且** database.status=ready。
    # 只看顶层是不够的：数据库连上了但不可用时，它同样返回 200 + status=ok
    # （见 server/src/db/health.ts 的 unavailable / not_configured），
    # 那样会把「起来了但用不了」的服务判成健康。
    if body="$(http_get "$url" 2>/dev/null)" &&
      grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" &&
      grep -Eq '"database"[[:space:]]*:[[:space:]]*\{[^}]*"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$body"; then
      log "健康检查通过：$body"
      return 0
    fi
    sleep 1
  done

  warn "健康检查超时（${HEALTH_TIMEOUT}s 内 $url 未返回 status=ok 且 database.status=ready）"
  return 1
}

# ---------------------------------------------------------------- 模板同步

sync_templates() {
  [[ -d "$TEMPLATES_DIR" ]] || die "模板目录不存在：$TEMPLATES_DIR"
  install -d -m 0755 "$ROOT/share" "$ROOT/share/deploy-templates"

  # systemd 单元里有 ProtectHome=true（服务账号不该看得到 /home、/root）。
  # 部署根目录要是落在这些路径下，服务会读不到代码，直接在部署时就提示，别等到运行期再猜。
  case "$ROOT" in
  /home/* | /root/* | /run/user/*)
    die "部署根目录不能放在 $ROOT：systemd 单元启用了 ProtectHome=true，服务进程将读不到代码。请用 /opt 或 /srv 下的路径。"
    ;;
  esac

  local f
  for f in "$TEMPLATES_DIR"/*; do
    [[ -f "$f" ]] || continue
    install -m 0644 -o root -g root "$f" "$ROOT/share/deploy-templates/$(basename -- "$f")"
  done
  log "已同步部署模板到 $ROOT/share/deploy-templates"

  # 用新模板覆盖到目标机；内容有变化才动，避免无意义地 daemon-reload
  local tmp
  tmp="$(mktemp)"
  render_template "$ROOT/share/deploy-templates/${SERVICE_NAME}.service.in" "$tmp"
  if ! cmp -s "$tmp" "/etc/systemd/system/${SERVICE_NAME}.service"; then
    install -m 0644 -o root -g root "$tmp" "/etc/systemd/system/${SERVICE_NAME}.service.new"
    mv -f "/etc/systemd/system/${SERVICE_NAME}.service.new" "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    log "已更新 systemd 单元 /etc/systemd/system/${SERVICE_NAME}.service"
  fi
  rm -f "$tmp"

  # 自更新：正在运行的 bash 是边读边执行的，直接覆盖会读到半截脚本，
  # 所以先写临时文件再 mv（原子替换，当前进程继续用旧 inode）。
  local self="$ROOT/share/deploy-templates/remote-deploy.sh"
  if [[ -f "$self" ]] && ! cmp -s "$self" "$ROOT/bin/deploy.sh"; then
    install -m 0755 -o root -g root "$self" "$ROOT/bin/.deploy.sh.new"
    mv -f "$ROOT/bin/.deploy.sh.new" "$ROOT/bin/deploy.sh"
    log "已更新部署脚本 $ROOT/bin/deploy.sh（下次调用生效）"
  fi
}

# ---------------------------------------------------------------- 清理

prune_releases() {
  local keep="$1" cur dir
  cur="$(current_release || true)"
  local -a dirs=()
  mapfile -t dirs < <(list_releases_desc)
  local index=0
  for dir in ${dirs[@]+"${dirs[@]}"}; do
    index=$((index + 1))
    # 用 if 而不是 `((...)) && continue`：后者在条件为假时会让函数返回非 0，
    # 配合 set -e 会把「清理完成」当成失败，整次部署被误判为失败。
    if ((index <= keep)); then
      continue
    fi
    if [[ -n "$cur" && "$(readlink -f "$dir")" == "$cur" ]]; then
      continue
    fi
    log "清理旧 release：$(basename -- "$dir")"
    rm -rf "$dir"
  done
}

prune_incoming() {
  [[ -d "$ROOT/incoming" ]] || return 0
  find "$ROOT/incoming" -mindepth 1 -maxdepth 1 -type d -mtime "+${INCOMING_KEEP_DAYS}" -exec rm -rf {} + 2>/dev/null || true
}

# ---------------------------------------------------------------- 归档校验与解包

verify_archive() {
  local entries actual

  if [[ -n "$ARCHIVE_SHA256" ]]; then
    actual="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
    [[ "$actual" == "$ARCHIVE_SHA256" ]] || die "归档校验失败：期望 $ARCHIVE_SHA256，实际 $actual"
    log "归档 sha256 校验通过"
  fi

  if ! entries="$(tar -tzf "$ARCHIVE" 2>/dev/null)"; then
    die "不是合法的 tar.gz：$ARCHIVE"
  fi
  grep -qE '^\./build/server/index\.js$' <<<"$entries" || die "归档缺少 build/server/index.js，可能不是本项目产物"
  grep -qE '^\./package\.json$' <<<"$entries" || die "归档缺少 package.json"
  grep -qE '^\./node_modules/\.bin/tsx$' <<<"$entries" || die "归档缺少 node_modules/.bin/tsx（运维 CLI user:passwd/user:init 依赖它）"
  log "归档结构校验通过（$(wc -l <<<"$entries") 个条目）"
}

extract_release() {
  local release_dir="$1" staging_dir
  staging_dir="$ROOT/releases/.staging-$$"
  rm -rf "$staging_dir"
  install -d -m 0755 "$staging_dir"
  log "解包到 $staging_dir"
  tar -xzf "$ARCHIVE" -C "$staging_dir"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$staging_dir"
  chmod -R u=rwX,go=rX "$staging_dir"
  mv -T "$staging_dir" "$release_dir"
  ln -sfn "$ROOT/shared/.env" "$release_dir/.env" # 让 npm run user:passwd 之类在 release 目录里也能读到配置
  log "release 就位：$release_dir"
}

cleanup_incoming() {
  local dir
  dir="$(dirname -- "$ARCHIVE")"
  case "$ARCHIVE" in
  "$ROOT/incoming/"*)
    rm -f "$ARCHIVE" 2>/dev/null || true
    # 只删「按构建分出来的子目录」，不要误删 incoming 本身
    if [[ "$dir" != "$ROOT/incoming" && "$dir" == "$ROOT/incoming/"* ]]; then
      rm -rf "$dir" 2>/dev/null || true
    fi
    ;;
  esac
}

# ---------------------------------------------------------------- 子命令：init

cmd_init() {
  require_root
  require_cmd systemctl "目标机必须是 systemd"
  resolve_node_bin

  log "初始化 $ROOT（服务账号：$SERVICE_USER，免密部署账号：$DEPLOY_USER）"

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$ROOT" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    log "已创建系统账号 $SERVICE_USER"
  fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

  install -d -m 0755 "$ROOT" "$ROOT/releases" "$ROOT/bin" "$ROOT/incoming" "$ROOT/share" "$ROOT/share/deploy-templates"
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$ROOT/shared" "$ROOT/shared/data" "$ROOT/shared/backups"

  # 1) .env：只在缺失时生成，之后永不覆盖（生产配置是人工维护的状态）
  local env_file="$ROOT/shared/.env" tmp
  tmp="$(mktemp)"
  if [[ -f "$env_file" ]]; then
    log "已存在 $env_file，保持不动"
  else
    render_template "$TEMPLATES_DIR/env.production.example" "$tmp"
    install -m 0640 -o root -g "$SERVICE_GROUP" "$tmp" "$env_file"
    log "已生成 $env_file（首次部署前请确认 HOST / PORT / WEBDAV_URL）"
  fi
  rm -f "$tmp"

  # 2) 模板
  sync_templates

  # 3) systemd
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  log "systemd 单元已启用（$SERVICE_NAME.service）"

  # 4) sudoers：只授权这一个绝对路径，避免 NOPASSWD: ALL
  tmp="$(mktemp)"
  render_template "$ROOT/share/deploy-templates/sudoers.${APP_NAME}.in" "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then
    install -m 0440 -o root -g root "$tmp" "$SUDOERS_PATH"
    log "已写入 sudoers：$SUDOERS_PATH（允许 $DEPLOY_USER 免密执行 $ROOT/bin/deploy.sh）"
  else
    warn "sudoers 模板校验失败，已跳过安装；请手工检查 $tmp"
  fi
  rm -f "$tmp"

  cat <<EOF

初始化完成。接下来：
  1) 确认配置：sudo vi $env_file
  2) 首次部署完成后，生成管理员初始密码（只在终端打印一次）：
       cd $ROOT/current && sudo -u $SERVICE_USER $NODE_BIN --import tsx server/src/cli/init-passwords.ts --confirm
     或直接：sudo systemctl stop $SERVICE_NAME && cd $ROOT/current && sudo -u $SERVICE_USER npm run user:init -- --confirm
  3) 查状态：$ROOT/bin/deploy.sh status
EOF
}

# ---------------------------------------------------------------- 子命令：deploy

cmd_deploy() {
  require_root
  require_cmd systemctl "目标机必须是 systemd"
  [[ -n "$ARCHIVE" ]] || die "缺少 --archive <tar.gz>"
  [[ -f "$ARCHIVE" ]] || die "归档不存在：$ARCHIVE"
  [[ -f "$ROOT/shared/.env" ]] || die "$ROOT/shared/.env 不存在，请先执行 deploy.sh init"

  resolve_node_bin
  verify_archive
  sync_templates

  local stamp release_dir prev_release
  stamp="$(date +%Y%m%d-%H%M%S)"
  release_dir="$ROOT/releases/${stamp}-${RELEASE_SHA:-unknown}"

  prev_release="$(current_release || true)"

  # 解包放在停服之前：这是最耗时的一步，不该占停机时间
  extract_release "$release_dir"

  stop_service
  backup_db || abort_restarting "数据库备份失败，已取消本次部署（避免在没有快照的情况下切换版本）"
  switch_release "$release_dir" || abort_restarting "切换 current 软链接失败"
  # 刻意吞掉 start 的退出码：起不来时单元会进入 failed，
  # 由 health_check 统一判定并走回滚分支；若在这里被 set -e 打断，就不会回滚了。
  start_service || true

  if health_check; then
    prune_releases "$KEEP"
    prune_incoming
    cleanup_incoming
    log "部署完成：$(basename -- "$release_dir")"
    print_status
    return 0
  fi

  warn "本次部署未通过健康检查，最近日志："
  journal_tail | sed 's/^/    /' >&2

  if [[ -n "$prev_release" && -d "$prev_release" ]]; then
    warn "自动回滚到 $prev_release"
    switch_release "$prev_release"
    start_service || true
    if health_check; then
      warn "已回滚到 $(basename -- "$prev_release")；本次部署失败，请检查上面的日志。"
    else
      warn "回滚后健康检查仍未通过，请立即人工介入（journalctl -u $SERVICE_NAME -n 100）。"
      journal_tail | sed 's/^/    /' >&2
    fi
  else
    warn "没有可回滚的历史 release（这是首次部署），服务可能不可用。"
  fi
  exit 1
}

# ---------------------------------------------------------------- 子命令：rollback

cmd_rollback() {
  require_root
  require_cmd systemctl "目标机必须是 systemd"
  resolve_node_bin

  local cur target
  cur="$(current_release || true)"

  if [[ -n "$TARGET_RELEASE" ]]; then
    if [[ -d "$TARGET_RELEASE" ]]; then
      target="$(readlink -f "$TARGET_RELEASE")"
    elif [[ -d "$ROOT/releases/$TARGET_RELEASE" ]]; then
      target="$(readlink -f "$ROOT/releases/$TARGET_RELEASE")"
    else
      die "找不到 release：$TARGET_RELEASE"
    fi
  else
    target="$(previous_release "$cur")" || die "没有更早的 release 可以回滚"
  fi

  [[ "$target" != "$cur" ]] || die "目标 release 就是当前 release：$target"

  log "回滚：${cur:-（未部署）} -> $target"
  stop_service
  switch_release "$target" || abort_restarting "切换 current 软链接失败"
  start_service || true

  health_check || {
    warn "回滚后健康检查未通过，最近日志："
    journal_tail | sed 's/^/    /' >&2
    die "回滚失败"
  }
  log "回滚完成"
  print_status
}

# ---------------------------------------------------------------- 子命令：status / logs / prune

print_status() {
  local cur port
  cur="$(current_release || true)"
  port="$(env_value PORT 17500)"

  echo
  echo "应用：      $APP_NAME"
  echo "部署根目录：$ROOT"
  echo "当前 release：${cur:-（未部署）}"
  if [[ -n "$cur" && -f "$cur/RELEASE.txt" ]]; then
    sed 's/^/  /' "$cur/RELEASE.txt"
  fi
  echo "服务状态：  $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true) / $(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
  echo "监听地址：  $(env_value HOST 0.0.0.0):${port}"
  echo "数据库：    $(env_value DATABASE_PATH "$ROOT/shared/data/workbench.sqlite")"
  echo "健康检查：  $(http_get "http://127.0.0.1:${port}${HEALTH_PATH}" 2>/dev/null || echo '不可达')"
  echo "历史 release（新→旧）："
  local -a dirs=()
  mapfile -t dirs < <(list_releases_desc)
  if ((${#dirs[@]} == 0)); then
    echo "  （无）"
  else
    local dir
    for dir in ${dirs[@]+"${dirs[@]}"}; do
      printf '  %s%s\n' "$(basename -- "$dir")" "$([[ "$dir" == "$cur" ]] && echo '  <= current')"
    done
  fi
  echo "磁盘占用：  $(du -sh "$ROOT" 2>/dev/null | cut -f1)"
}

cmd_status() {
  require_root
  resolve_node_bin
  print_status
}

cmd_logs() {
  require_root
  journalctl -u "$SERVICE_NAME" -n "$LOG_LINES" --no-pager
}

cmd_prune() {
  require_root
  prune_releases "$KEEP"
  prune_incoming
  log "清理完成"
}

# ---------------------------------------------------------------- 参数解析与分发

parse_args() {
  while (($# > 0)); do
    case "$1" in
    --root) ROOT="${2:?--root 需要取值}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user 需要取值}"; shift 2 ;;
    --deploy-user) DEPLOY_USER="${2:?--deploy-user 需要取值}"; shift 2 ;;
    --node-bin) NODE_BIN="${2:?--node-bin 需要取值}"; shift 2 ;;
    --templates-dir) TEMPLATES_DIR="${2:?--templates-dir 需要取值}"; shift 2 ;;
    --keep) KEEP="${2:?--keep 需要取值}"; shift 2 ;;
    --lines) LOG_LINES="${2:?--lines 需要取值}"; shift 2 ;;
    --archive) ARCHIVE="${2:?--archive 需要取值}"; shift 2 ;;
    --sha) RELEASE_SHA="${2:?--sha 需要取值}"; shift 2 ;;
    --sha256) ARCHIVE_SHA256="${2:?--sha256 需要取值}"; shift 2 ;;
    --to) TARGET_RELEASE="${2:?--to 需要取值}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
  done
}

main() {
  COMMAND="${1:-}"
  if [[ -z "$COMMAND" ]]; then
    usage
    exit 2
  fi
  shift

  parse_args "$@"

  TEMPLATES_DIR="${TEMPLATES_DIR:-$ROOT/share/deploy-templates}"
  ROOT="${ROOT%/}"
  [[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep 必须是数字：$KEEP"

  SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"

  case "$COMMAND" in
  init) cmd_init ;;
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  prune) cmd_prune ;;
  *)
    usage
    die "未知命令：$COMMAND"
    ;;
  esac
}

main "$@"
