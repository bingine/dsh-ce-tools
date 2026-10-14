import { spawn } from "node:child_process";
import { callTool, createHarness } from "../test/helpers/harness.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oracle = spawn("D:/Project/dsh-cheat-engine/CheatTestWindow.exe", [], { stdio: "ignore" });
const h = createHarness({ backend: "self" });
await sleep(2500);
await callTool(h, "ce_attach", { pid: oracle.pid });
// 干净起点：加一条已知记录
const a = await callTool(h, "ce_cheat_table", {
  action: "add",
  entries: [{ description: "DIAG-add", address: "CheatTestWindow.exe+9010", type: "dword" }]
});
console.log("add 返回值:", JSON.stringify(a.data));
console.log("add 摘要  :", a.summary);
console.log("add 行    :", JSON.stringify(a.lines));
const l = await callTool(h, "ce_cheat_table", { action: "list", limit: 50 });
console.log("list 摘要 :", l.summary);
for (const r of l.data.records) {
  console.log(`  顶层 id=${r.id} addr=${r.address === null ? "null" : "0x" + BigInt(r.address).toString(16)} desc=${r.description} children=${(r.children ?? []).length}`);
}
await h.dispose();
if (oracle.exitCode === null) oracle.kill();
