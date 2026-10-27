import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

test("/resume-peek shares /peek's handler and description", () => {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const pi: Pick<ExtensionAPI, "registerFlag" | "on" | "registerCommand"> = {
    registerFlag() {},
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  register(pi as ExtensionAPI);

  assert.ok(commands.has("peek"));
  assert.ok(commands.has("resume-peek"));
  assert.equal(commands.get("resume-peek")?.handler, commands.get("peek")?.handler);
  assert.equal(commands.get("resume-peek")?.description, commands.get("peek")?.description);
});
