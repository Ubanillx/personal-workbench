import os from "node:os";

export function getLanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if (family === "IPv4" && !entry.internal && !addresses.includes(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
}
