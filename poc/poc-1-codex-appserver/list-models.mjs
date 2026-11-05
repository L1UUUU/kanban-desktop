// 零成本探测：initialize + model/list，打印该账号可用模型（不发起任何 turn）。
import { CodexAppServerClient } from "./client.mjs";

const c = new CodexAppServerClient({ log: () => {} });
c.start();
const init = await c.initialize();
const models = await c.request("model/list", {});
console.log(JSON.stringify({ userAgent: init.userAgent, models }, null, 2));
c.stop();
setTimeout(() => process.exit(0), 500);
