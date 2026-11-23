import { readFile, statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function cpuTimes(text) {
  const fields = text.split("\n")[0].trim().split(/\s+/);
  if (fields[0] !== "cpu" || fields.length < 5 ||
      fields.slice(1, 9).some(value => !/^\d+$/.test(value))) {
    throw new Error("Invalid host CPU statistics");
  }

  const times = fields.slice(1, 9).map(Number);
  return {
    total: times.reduce((sum, value) => sum + value, 0),
    idle: times[3] + (times[4] ?? 0),
  };
}

function memoryUsage(text) {
  const values = Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)]
    .map(([, name, value]) => [name, Number(value) * 1024]));
  const total = values.MemTotal;
  const available = values.MemAvailable;
  if (!Number.isSafeInteger(total) || total <= 0 ||
      !Number.isSafeInteger(available) || available < 0 || available > total) {
    throw new Error("Invalid host memory statistics");
  }
  return { used: total - available, total };
}

export async function readHostMetrics({
  read = readFile,
  filesystem = statfs,
  wait = delay,
  procPath = "/host-proc",
  rootPath = "/host-root",
} = {}) {
  const [first, memory, disk] = await Promise.all([
    read(`${procPath}/stat`, "utf8"),
    read(`${procPath}/meminfo`, "utf8"),
    filesystem(rootPath),
  ]);
  await wait(1000);
  const second = await read(`${procPath}/stat`, "utf8");
  const before = cpuTimes(first);
  const after = cpuTimes(second);
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (!Number.isFinite(total) || total <= 0 || idle < 0 || idle > total) {
    throw new Error("Invalid host CPU sample");
  }
  const diskTotal = disk.blocks * disk.bsize;
  const diskUsed = (disk.blocks - disk.bfree) * disk.bsize;
  if (!Number.isFinite(diskTotal) || diskTotal <= 0 ||
      !Number.isFinite(diskUsed) || diskUsed < 0 || diskUsed > diskTotal) {
    throw new Error("Invalid host disk statistics");
  }

  return {
    checked_at: new Date().toISOString(),
    cpu: { percentage: (total - idle) / total * 100 },
    memory: memoryUsage(memory),
    disk: { used: diskUsed, total: diskTotal },
  };
}
