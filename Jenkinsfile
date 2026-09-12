#!/usr/bin/env groovy
/*
 * personal-workbench —— Jenkins CI/CD 流水线（构建在 Jenkins，部署在目标 Linux 服务器）
 *
 * 触发：GitHub webhook（push 事件）。仓库 webhook 指向 http://<jenkins>/github-webhook/，
 *       任务里勾选 "GitHub hook trigger for GITScm polling"（本文件的 triggers 已声明）。
 *
 * 流程：拉代码 → 装依赖 → 静态检查 → 构建 → 测试 → 打包 → scp 上传 → SSH 调用目标机部署脚本。
 *
 * 三条刻意的分工：
 *   1. 构建只发生在 Jenkins：目标机不需要联网、不需要 devDependencies、不需要编译器；
 *   2. 发布动作全在 deploy/ 里（shell），Jenkinsfile 只负责编排 —— 这样「手工部署」和
 *      「流水线部署」走同一条路径，不会出现两套行为；
 *   3. 目标机上真正的切换/健康检查/自动回滚由 deploy/remote-deploy.sh 负责，Jenkins 只读结果。
 *
 * 前置条件（见 deploy/README-DEPLOY.md）：
 *   - Jenkins 全局工具或 PATH 里有 Node.js >= 22.9.0（本流水线会校验版本并不达标就失败）；
 *   - 凭据：SSH 用户名+私钥，ID 见下方 DEPLOY_SSH_CREDENTIAL（默认 workbench-deploy-ssh）；
 *   - 目标机已由管理员执行过一次 `deploy.sh init`。
 */

pipeline {
  // 构建机需要：Node >= 22.9、git、ssh/scp、tar、curl（可选）。用标签可以钉住固定机器。
  agent any

  options {
    // 不要在这里写 timestamps()：它由 Timestamper 插件提供，插件没装会让整个 Jenkinsfile
    // 编译失败（Invalid option type "timestamps"），连一个 stage 都跑不到。
    // 想给日志加时间戳，二选一：
    //   a) Jenkins 装好 Timestamper 插件后，再把 timestamps() 加回本块；
    //   b) 不改流水线：Manage Jenkins → System → Timestamper，勾选全局默认加时间戳。
    // 不并发：两次部署同时切 current 软链接会互相踩踏。排队而不是打断正在跑的部署。
    disableConcurrentBuilds()
    timeout(time: 45, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10'))
  }

  parameters {
    choice(
      name: 'ACTION',
      choices: ['deploy', 'build-only', 'rollback'],
      description: 'deploy = 构建并发布；build-only = 只构建产物；rollback = 只在目标机回滚到上一个 release'
    )
    string(name: 'DEPLOY_HOST', defaultValue: '', description: '目标服务器地址（IP 或域名）。留空 = 用仓库默认目标机 192.168.3.251；只想出包请把 ACTION 选成 build-only')
    string(name: 'DEPLOY_PORT', defaultValue: '22', description: '目标机 SSH 端口')
    string(name: 'DEPLOY_ROOT', defaultValue: '/opt/personal-workbench', description: '目标机部署根目录')
    string(name: 'KEEP_RELEASES', defaultValue: '5', description: '目标机保留多少个历史 release（回滚靠它们）')
    booleanParam(name: 'RUN_TESTS', defaultValue: false, description: '是否跑完整测试（数据层 / 契约 / 鉴权 / SSR 冒烟）。只对 build-only 生效：ACTION=deploy 一律跳过测试')
    string(name: 'PUBLIC_HEALTH_URL', defaultValue: '', description: '可选：部署后再从构建机探一次该健康检查地址')
  }

  triggers {
    // GitHub 插件提供；仓库侧 webhook 事件选 push。若构建机没装 GitHub 插件，
    // 删掉这一行，改为在任务配置里手动勾选 "GitHub hook trigger for GITScm polling"。
    githubPush()
  }

  environment {
    APP_NAME = 'personal-workbench'
    // 凭据 ID：SSH Username with private key。私钥不要设密码短语（BatchMode 下无法交互输入）。
    DEPLOY_SSH_CREDENTIAL = 'workbench-deploy-ssh'
    NPM_CONFIG_AUDIT = 'false'
    NPM_CONFIG_FUND = 'false'
    CI = 'true'
  }

  stages {
    stage('准备') {
      steps {
        checkout scm
        sh '''#!/usr/bin/env bash
          # 显式声明 bash：Jenkins 的 sh 默认用 /bin/sh，Ubuntu 20.04/22.04 上那是 dash，
          # 不支持 set -o pipefail，会在第一行就报 "Illegal option -o pipefail"。
          set -euo pipefail
          echo "构建机：$(hostname)"
          echo "Node：  $(node --version)"
          echo "npm：   $(npm --version)"

          # package.json 里所有脚本都用 PATH 里的 node 启动（跨平台，不再是 Windows 专用的
          # %npm_node_execpath%），所以这里确认「PATH 的 node」与「npm 用的 node」不会跑出
          # 两个版本：版本不同会让构建静默跑在非预期的 Node 上，症状是莫名其妙的行为差异。
          path_node="$(command -v node || true)"
          npm_node="$(npm run --silent env 2>/dev/null | sed -n '/^npm_node_execpath=/{s///;p;q;}')" || true
          if [ -z "$path_node" ]; then
            echo "ERROR: PATH 里没有 node；本项目所有 npm 脚本都靠 node 启动。" >&2
            exit 1
          fi
          if [ -n "$npm_node" ] && [ "$(readlink -f "$path_node")" != "$(readlink -f "$npm_node")" ]; then
            path_ver="$(node --version)"
            npm_ver="$("$npm_node" --version 2>/dev/null || echo 取不到版本)"
            if [ "$path_ver" != "$npm_ver" ]; then
              echo "ERROR: PATH 里的 node（$path_node，$path_ver）与 npm 用的 node（$npm_node，$npm_ver）版本不一致。" >&2
              echo "       请修正 PATH 顺序，或让 node 与 npm 来自同一套安装后重跑。" >&2
              exit 1
            fi
            echo "提示：PATH 的 node 与 npm 的 node 是两套安装，但版本相同（$path_ver），继续。"
          fi
          echo "node 路径：$path_node（与 npm 一致）"

          major=$(node -p 'process.versions.node.split(".")[0]')
          minor=$(node -p 'process.versions.node.split(".")[1]')
          if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 9 ]; }; then
            echo "ERROR: 构建机 Node 版本过低（$(node --version)），本项目要求 >= 22.9.0" >&2
            exit 1
          fi
          echo "提交：  $(git rev-parse HEAD)"
          echo "说明：  $(git log -1 --pretty=%s)"
        '''
        script {
          env.GIT_SHA = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
          env.GIT_SUBJECT = sh(script: 'git log -1 --pretty=%s', returnStdout: true).trim()
          // 多分支任务里是分支名；普通任务没有 BRANCH_NAME，按 main 处理（部署门禁用得到）
          env.BUILD_BRANCH = env.BRANCH_NAME ?: 'main'
          // 部署目标：参数留空就回落到仓库里的默认目标机。这样「push 到 main → webhook →
          // 构建 → 发布」这条主路径不用每次手填参数；只想出包不发布就把 ACTION 选 build-only。
          env.DEPLOY_TARGET_HOST = params.DEPLOY_HOST?.trim() ?: '192.168.3.251'
          env.DEPLOY_TARGET_ROOT = params.DEPLOY_ROOT?.trim() ?: '/opt/personal-workbench'
          env.DEPLOY_TARGET_PORT = params.DEPLOY_PORT?.trim() ?: '22'
          env.DEPLOY_HEALTH_URL = params.PUBLIC_HEALTH_URL?.trim() ?: "http://${env.DEPLOY_TARGET_HOST}/api/ping"
          echo "本次构建：branch=${env.BUILD_BRANCH} sha=${env.GIT_SHA} action=${params.ACTION}"
          echo "部署目标：${env.DEPLOY_TARGET_HOST}（${env.DEPLOY_TARGET_ROOT}，端口 ${env.DEPLOY_TARGET_PORT}）"
        }
      }
    }

    stage('安装依赖') {
      when { expression { params.ACTION != 'rollback' } }
      steps {
        // 用 package-lock.json 精确还原；--prefer-offline 只在本地缓存里找得到时省流量
        sh 'npm ci --no-audit --no-fund --prefer-offline'
      }
    }

    stage('静态检查') {
      when { expression { params.ACTION != 'rollback' } }
      steps {
        sh 'npm run lint'
        sh 'npm run format:check'
        sh 'npm run typecheck'
        // antd 官方检查，README 定的门禁：必须 No issues found
        sh './node_modules/.bin/antd lint app'
      }
    }

    stage('构建') {
      when { expression { params.ACTION != 'rollback' } }
      steps {
        // 只构建一次，后面测试与打包都用这份 build/
        sh 'npm run build'
      }
    }

    stage('测试') {
      // 部署不跑测试（明确口径）：发布路径只关心「起不起得来」，完整测试交给
      // ACTION=build-only 或本地 `npm test`。想连测试一起发布，就把 ACTION 条件去掉。
      when { expression { params.ACTION != 'rollback' && params.ACTION != 'deploy' && params.RUN_TESTS } }
      // 四组测试互相独立：各自在 os.tmpdir() 下建临时库与临时上传目录，
      // 服务端口用 findFreePort() 现取，因此可以并行，不会互相抢端口或污染数据。
      parallel {
        stage('数据层 / WebDAV') {
          steps {
            sh 'npm run test:db'
            sh 'npm run test:webdav'
          }
        }
        stage('HTTP 契约') {
          steps { sh 'npm run test:api' }
        }
        stage('鉴权端到端') {
          steps { sh 'npm run test:auth' }
        }
        stage('SSR 冒烟') {
          steps { sh 'npm run test:ui' }
        }
      }
    }

    stage('打包') {
      when { expression { params.ACTION != 'rollback' } }
      steps {
        sh '''#!/usr/bin/env bash
          set -euo pipefail
          rm -rf .release dist
          mkdir -p .release dist

          # 运行期只要 build/ + 生产依赖；server/ 与 shared/ 是给运维 CLI 用的
          # （user:init / user:passwd / user:list / db:backup 通过 tsx 直接跑 TS 源码）。
          cp package.json package-lock.json tsconfig.json .release/
          cp -r build .release/build
          cp -r server .release/server
          cp -r shared .release/shared

          echo "安装生产依赖（目标机因此不需要联网装包）"
          ( cd .release && npm ci --omit=dev --no-audit --no-fund --prefer-offline )

          if [ ! -f .release/build/server/index.js ]; then
            echo "ERROR: 产物缺少 build/server/index.js" >&2
            exit 1
          fi
          if [ ! -x .release/node_modules/.bin/tsx ]; then
            echo "ERROR: 生产依赖里没有 tsx。运维 CLI 依赖它，tsx 必须放在 package.json 的 dependencies 中。" >&2
            exit 1
          fi

          {
            echo "release:  $GIT_SHA"
            echo "branch:   $BUILD_BRANCH"
            echo "build:    #$BUILD_NUMBER"
            echo "built_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            echo "built_by: $BUILD_URL"
            echo "subject:  $GIT_SUBJECT"
          } > .release/RELEASE.txt

          tar -czf "dist/${APP_NAME}-${GIT_SHA}-${BUILD_NUMBER}.tar.gz" -C .release .
          (
            cd dist
            # 名字必须与 jenkins-remote.sh 的预期一致：它找的是 "$tarball.sha256"，
            # 也就是 <...>.tar.gz.sha256（少了中间的 .tar.gz 会在部署阶段找不到校验文件）
            sha256sum "${APP_NAME}-${GIT_SHA}-${BUILD_NUMBER}.tar.gz" \
              > "${APP_NAME}-${GIT_SHA}-${BUILD_NUMBER}.tar.gz.sha256"
          )
          ls -lh dist
        '''
        script {
          env.RELEASE_TARBALL = "${env.APP_NAME}-${env.GIT_SHA}-${env.BUILD_NUMBER}.tar.gz"
          env.RELEASE_SHA256 = sh(
            script: "cut -d' ' -f1 dist/${env.RELEASE_TARBALL}.sha256",
            returnStdout: true
          ).trim()
          echo "产物：dist/${env.RELEASE_TARBALL}（sha256=${env.RELEASE_SHA256}）"
        }
        archiveArtifacts artifacts: 'dist/*.tar.gz,dist/*.sha256', fingerprint: true
      }
    }

    stage('部署到目标服务器') {
      when {
        expression {
          params.ACTION == 'deploy' &&
            env.BUILD_BRANCH == 'main' &&
            env.DEPLOY_TARGET_HOST
        }
      }
      steps {
        withCredentials([
          sshUserPrivateKey(
            credentialsId: env.DEPLOY_SSH_CREDENTIAL,
            keyFileVariable: 'SSH_KEY_FILE',
            usernameVariable: 'SSH_USER'
          )
        ]) {
          withEnv([
            "TARGET_HOST=${env.DEPLOY_TARGET_HOST}",
            "TARGET_PORT=${env.DEPLOY_TARGET_PORT}",
            "TARGET_ROOT=${env.DEPLOY_TARGET_ROOT}",
            "TARGET_KEEP=${params.KEEP_RELEASES.trim()}"
          ]) {
            sh 'bash deploy/jenkins-remote.sh deploy'
          }
        }
      }
    }

    stage('回滚目标服务器') {
      when {
        expression { params.ACTION == 'rollback' && env.DEPLOY_TARGET_HOST }
      }
      steps {
        withCredentials([
          sshUserPrivateKey(
            credentialsId: env.DEPLOY_SSH_CREDENTIAL,
            keyFileVariable: 'SSH_KEY_FILE',
            usernameVariable: 'SSH_USER'
          )
        ]) {
          withEnv([
            "TARGET_HOST=${env.DEPLOY_TARGET_HOST}",
            "TARGET_PORT=${env.DEPLOY_TARGET_PORT}",
            "TARGET_ROOT=${env.DEPLOY_TARGET_ROOT}"
          ]) {
            sh 'bash deploy/jenkins-remote.sh rollback'
          }
        }
      }
    }

    stage('部署后验证') {
      when {
        expression { params.ACTION == 'deploy' && env.DEPLOY_HEALTH_URL }
      }
      steps {
        withEnv(["HEALTH_URL=${env.DEPLOY_HEALTH_URL}"]) {
          sh '''#!/usr/bin/env bash
            set -euo pipefail
            if ! command -v curl >/dev/null 2>&1; then
              echo "构建机没有 curl，跳过部署后验证（目标机自身的健康检查已经在部署阶段通过）"
              exit 0
            fi
            body="$(curl -fsS --max-time 10 "$HEALTH_URL")"
            echo "$body"
            printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'
            echo "部署后验证通过：$HEALTH_URL"
          '''
        }
      }
    }
  }

  post {
    success {
      script {
        if (params.ACTION == 'deploy' && env.DEPLOY_TARGET_HOST && env.BUILD_BRANCH == 'main') {
          echo "[OK] ${env.RELEASE_TARBALL} 已发布到 ${env.DEPLOY_TARGET_HOST}（${env.DEPLOY_TARGET_ROOT}）"
        } else {
          echo "[OK] 构建完成（未发布）：${env.RELEASE_TARBALL ?: '无产物（回滚模式）'}"
        }
      }
    }
    failure {
      echo """[FAIL] 构建或部署失败。
  - 构建/测试失败：看上方阶段日志。
  - 部署失败：deploy/remote-deploy.sh 已在健康检查不通过时自动回滚，回滚结论也在上方日志里。
  - 目标机现场：
      ssh <user>@<host> 'sudo ${params.DEPLOY_ROOT}/bin/deploy.sh status'
      ssh <user>@<host> 'sudo journalctl -u personal-workbench -n 100 --no-pager'"""
    }
    aborted {
      echo '[ABORT] 构建被中止。'
    }
  }
}
