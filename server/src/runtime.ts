const MINIMUM_NODE_VERSION = { major: 22, minor: 5 } as const;

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) throw new Error(`无法识别 Node.js 版本：${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MINIMUM_NODE_VERSION.major || (major === MINIMUM_NODE_VERSION.major && minor < MINIMUM_NODE_VERSION.minor)) {
    throw new Error(`Personal Workbench 需要 Node.js >=22.5.0；当前为 ${version}`);
  }
}

export function runtimeLabel(): string {
  return `Node.js ${process.versions.node} / node:sqlite`;
}
