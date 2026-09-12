#!/usr/bin/env bash
#
# jenkins-remote.sh —— Jenkins 构建机侧的发布动作（上传产物 + 触发目标机部署）。
#
# 由 Jenkinsfile 调用，也可以手工执行做演练：
#   bash deploy/jenkins-remote.sh deploy
#   bash deploy/jenkins-remote.sh rollback
#   bash deploy/jenkins-remote.sh status
#
# 它只做两件事：把构建产物传上去、用 sudo 调目标机的部署脚本。
# 真正的部署逻辑（原子切换 / 健康检查 / 自动回滚）全都写在 deploy/remote-deploy.sh 里，
# 这样「Jenkins 自动部署」和「运维手工部署」走的是同一条路径，不会出现两套行为。
#
# 需要的环境变量（Jenkinsfile 通过 withCredentials / withEnv 注入）：
#   SSH_USER          SSH 登录账号（凭据里的 username）
#   SSH_KEY_FILE      SSH 私钥文件路径（Jenkins 凭据写出的临时文件）
#   TARGET_HOST       目标服务器地址
#   TARGET_PORT       SSH 端口，默认 22
#   TARGET_ROOT       目标机部署根目录，默认 /opt/personal-workbench
#   TARGET_KEEP       保留多少个历史 release，默认 5
#   RELEASE_TARBALL   产物文件名，例如 personal-workbench-abc1234-42.tar.gz（deploy 必需）
#   RELEASE_SHA256    产物 sha256（deploy 必需）
#   GIT_SHA           git 短 sha（deploy 必需）
#   BUILD_NUMBER      Jenkins 构建号（deploy 必需）
#   APP_NAME          应用名，默认 personal-workbench
#   ARTIFACT_DIR      产物目录，默认 dist
#   DEPLOY_DIR        部署脚本目录，默认 deploy

set -euo pipefail

APP_NAME="${APP_NAME:-personal-workbench}"
TARGET_PORT="${TARGET_PORT:-22}"
TARGET_ROOT="${TARGET_ROOT:-/opt/personal-workbench}"
TARGET_KEEP="${TARGET_KEEP:-5}"
ARTIFACT_DIR="${ARTIFACT_DIR:-dist}"
DEPLOY_DIR="${DEPLOY_DIR:-deploy}"

log() { printf '\033[1;34m[ci]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ci]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[ci]\033[0m %s\n' "$*" >&2
  exit 1
}

need() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "缺少环境变量 $name"
}

usage() {
  cat <<'EOF'
用法：bash deploy/jenkins-remote.sh <deploy|rollback|status>

所有参数都通过环境变量传入，见本文件头部注释。
EOF
}

# ---------------------------------------------------------------- 连接准备

setup_connection() {
  need SSH_USER
  need SSH_KEY_FILE
  need TARGET_HOST
  [[ -f "$SSH_KEY_FILE" ]] || die "SSH 私钥文件不存在：$SSH_KEY_FILE"
  [[ "$TARGET_PORT" =~ ^[0-9]+$ ]] || die "TARGET_PORT 必须是数字：$TARGET_PORT"

  REMOTE="${SSH_USER}@${TARGET_HOST}"
  SSH_OPTS=(
    -i "$SSH_KEY_FILE"
    -o IdentitiesOnly=yes
    # BatchMode：禁止任何交互式提问。密钥有密码短语时这里会立刻失败，
    # 而不是让构建卡在密码提示上直到超时。
    -o BatchMode=yes
    # accept-new：首次连接自动记录主机公钥，之后公钥变了就拒绝连接（防中间人）。
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout=20
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=4
  )

  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if ! ssh-keygen -F "$TARGET_HOST" >/dev/null 2>&1; then
    warn "known_hosts 里没有 $TARGET_HOST，用 ssh-keyscan 记录主机公钥（TOFU）。"
    warn "要求更严的话，把目标机公钥做成 Jenkins 凭据，构建时写入 known_hosts 再关掉 accept-new。"
    ssh-keyscan -p "$TARGET_PORT" -H "$TARGET_HOST" >>"$HOME/.ssh/known_hosts" 2>/dev/null || true
  fi
}

ssh_run() {
  ssh -p "$TARGET_PORT" "${SSH_OPTS[@]}" "$REMOTE" "$@"
}

scp_put() {
  scp -P "$TARGET_PORT" "${SSH_OPTS[@]}" "$@"
}

require_installed_script() {
  if ! ssh_run "test -x '$TARGET_ROOT/bin/deploy.sh'"; then
    die "目标机 $TARGET_HOST 上还没有 $TARGET_ROOT/bin/deploy.sh。
这是**一次性**初始化，必须先做（之后每次部署都会自动同步脚本与模板）：
  1) scp -r deploy $SSH_USER@$TARGET_HOST:/tmp/pw-deploy
  2) ssh $SSH_USER@$TARGET_HOST 'sudo bash /tmp/pw-deploy/remote-deploy.sh init --templates-dir /tmp/pw-deploy'
  3) 确认 $TARGET_ROOT/shared/.env 里的配置（尤其是 PORT 与 WEBDAV_URL）
详见 deploy/README-DEPLOY.md 的「首次接入」。"
  fi
}

# ---------------------------------------------------------------- 子命令

cmd_deploy() {
  need RELEASE_TARBALL
  need RELEASE_SHA256
  need GIT_SHA
  need BUILD_NUMBER

  local tarball="$ARTIFACT_DIR/$RELEASE_TARBALL"
  [[ -f "$tarball" ]] || die "找不到构建产物：$tarball"
  [[ -f "$tarball.sha256" ]] || die "找不到校验文件：$tarball.sha256"
  [[ -f "$DEPLOY_DIR/remote-deploy.sh" ]] || die "找不到 $DEPLOY_DIR/remote-deploy.sh"

  setup_connection
  require_installed_script

  local remote_dir="$TARGET_ROOT/incoming/${APP_NAME}-${BUILD_NUMBER}-${GIT_SHA}"

  log "创建远端目录 $remote_dir"
  ssh_run "mkdir -p '$remote_dir/deploy'"

  log "上传构建产物（$(du -h "$tarball" | cut -f1)）"
  scp_put "$tarball" "$tarball.sha256" "$REMOTE:$remote_dir/"

  log "上传部署脚本与模板"
  scp_put \
    "$DEPLOY_DIR/remote-deploy.sh" \
    "$DEPLOY_DIR/${APP_NAME}.service.in" \
    "$DEPLOY_DIR/env.production.example" \
    "$DEPLOY_DIR/sudoers.${APP_NAME}.in" \
    "$REMOTE:$remote_dir/deploy/"

  local remote_cmd="sudo -n '$TARGET_ROOT/bin/deploy.sh' deploy"
  remote_cmd+=" --archive '$remote_dir/$RELEASE_TARBALL'"
  remote_cmd+=" --sha256 '$RELEASE_SHA256'"
  remote_cmd+=" --sha '$GIT_SHA'"
  remote_cmd+=" --keep '$TARGET_KEEP'"
  remote_cmd+=" --templates-dir '$remote_dir/deploy'"

  log "在 $TARGET_HOST 上执行部署"
  if ! ssh_run "$remote_cmd"; then
    warn "远端部署失败。日志在上面（部署脚本会在健康检查失败时自动回滚）。"
    warn "手工排查：ssh $REMOTE \"sudo $TARGET_ROOT/bin/deploy.sh status\""
    return 1
  fi
  log "发布完成：$RELEASE_TARBALL"
}

cmd_rollback() {
  setup_connection
  require_installed_script
  log "在 $TARGET_HOST 上回滚到上一个 release"
  ssh_run "sudo -n '$TARGET_ROOT/bin/deploy.sh' rollback"
  log "回滚完成"
}

cmd_status() {
  setup_connection
  require_installed_script
  ssh_run "sudo -n '$TARGET_ROOT/bin/deploy.sh' status"
}

# ---------------------------------------------------------------- 分发

main() {
  case "${1:-}" in
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  -h | --help | "") usage ;;
  *) usage && die "未知命令：$1" ;;
  esac
}

main "$@"
