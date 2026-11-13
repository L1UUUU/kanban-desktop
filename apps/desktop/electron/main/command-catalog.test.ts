// 用途：CommandCatalog 短 TTL 缓存测试（issue #89 / spec #82 E 块）—— 同 (cli, cwd) 重复调用在 TTL 内不重复扫描；过期重扫；不同 cli/cwd 独立缓存键；拉取失败不缓存（下次重读）
import { describe, expect, it } from "vitest";
import { AdapterError, FakeAdapter, type ListCommandsInput } from "@kanban/cli-host";
import { COMMAND_LIST_CACHE_TTL_MS, type CommandEntry } from "@kanban/ipc-schema";
import { CommandCatalog } from "./command-catalog";

/** 本地 fixture 命令条目（被测对象是 Catalog 缓存而非 FakeAdapter；ADR 0004 后 fake 通道恒空集，条目与通道内容解耦） */
const FIXTURE: CommandEntry[] = [{ name: "probe", description: "探针", argsHint: null, source: "user", cli: "claude", sourcePath: "C:\\prompts\\probe.md", userOnly: false }];

/** 计数型 FakeAdapter 子类：记录 listCommands 调用并回放 fixture（TTL 命中率断言依据） */
class CountingAdapter extends FakeAdapter {
  listCommandsCalls = 0;
  override async listCommands(_input: ListCommandsInput): Promise<CommandEntry[]> {
    this.listCommandsCalls += 1;
    return FIXTURE.map((c) => ({ ...c }));
  }
}

/** 可切换失败的 FakeAdapter 子类（失败保持冷的断言依据；成功回放 fixture） */
class FlakyAdapter extends FakeAdapter {
  failListCommands = true;
  listCommandsCalls = 0;
  override async listCommands(_input: ListCommandsInput): Promise<CommandEntry[]> {
    this.listCommandsCalls += 1;
    if (this.failListCommands) throw new AdapterError("E_SPAWN_NOT_FOUND", "注入失败");
    return FIXTURE.map((c) => ({ ...c }));
  }
}

describe("CommandCatalog（#89 命令目录 TTL 缓存）", () => {
  it("同 (cli, cwd) TTL 内重复调用不重复扫描；时钟越过 TTL 后重扫", async () => {
    const adapter = new CountingAdapter();
    let now = 1_000_000;
    const catalog = new CommandCatalog({ adapter, now: () => now });
    const first = await catalog.list("fake", "C:\\w");
    const second = await catalog.list("fake", "C:\\w");
    expect(adapter.listCommandsCalls).toBe(1); // TTL 内：缓存命中不重扫
    expect(second).toEqual(first);
    now += COMMAND_LIST_CACHE_TTL_MS; // 恰好到 TTL 边界：过期
    await catalog.list("fake", "C:\\w");
    expect(adapter.listCommandsCalls).toBe(2); // 过期后重扫
  });

  it("不同 cli 或 cwd 独立缓存键；返回值为缓存条目拷贝（调用方改写不污染缓存）", async () => {
    const adapter = new CountingAdapter();
    const catalog = new CommandCatalog({ adapter, now: () => 0 });
    await catalog.list("fake", "C:\\a");
    await catalog.list("claude", "C:\\a"); // 不同 cli
    await catalog.list("fake", "C:\\b"); // 不同 cwd
    expect(adapter.listCommandsCalls).toBe(3);
    const first = await catalog.list("fake", "C:\\a");
    first[0].description = "被改写";
    const again = await catalog.list("fake", "C:\\a");
    expect(again[0].description).not.toBe("被改写");
  });

  it("拉取失败不缓存（保持冷，下次调用重读）；成功后恢复缓存", async () => {
    const adapter = new FlakyAdapter();
    const catalog = new CommandCatalog({ adapter, now: () => 0 });
    await expect(catalog.list("opencode", "C:\\w")).rejects.toMatchObject({ code: "E_SPAWN_NOT_FOUND" });
    await expect(catalog.list("opencode", "C:\\w")).rejects.toMatchObject({ code: "E_SPAWN_NOT_FOUND" }); // 失败未缓存：再次真实调用
    expect(adapter.listCommandsCalls).toBe(2);
    adapter.failListCommands = false;
    const commands = await catalog.list("opencode", "C:\\w");
    expect(commands.length).toBeGreaterThan(0);
    expect(adapter.listCommandsCalls).toBe(3); // 成功后写入缓存
    await catalog.list("opencode", "C:\\w");
    expect(adapter.listCommandsCalls).toBe(3); // 此后 TTL 内命中
  });
});
