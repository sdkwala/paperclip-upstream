import { describe, expect, it } from "vitest";
import {
  validatePluginConfigPolicy,
  runPluginConfigPolicy,
  validateTelegramPluginConfig,
} from "../services/plugin-config-policy.js";

describe("plugin-config-policy", () => {
  it("rejects empty allowlists when inbound is enabled", () => {
    const result = validatePluginConfigPolicy("paperclip-plugin-telegram", {
      enableInbound: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe(
      "enableCommands/enableInbound requires a non-empty allowedTelegramUserIds or allowedTelegramChatIds",
    );
  });

  it("accepts a non-empty allowlist", () => {
    const result = validatePluginConfigPolicy("paperclip-plugin-telegram", {
      enableInbound: true,
      allowedTelegramUserIds: ["123"],
    });
    expect(result.valid).toBe(true);
  });

  it("allows empty allowlists when commands and inbound are disabled", () => {
    const result = validatePluginConfigPolicy("paperclip-plugin-telegram", {
      enableInbound: false,
      enableCommands: false,
    });
    expect(result.valid).toBe(true);
  });

  it("passes through non-telegram plugins", () => {
    const result = runPluginConfigPolicy("other.plugin", {
      enableInbound: true,
    });
    expect(result.valid).toBe(true);
  });

  it("validates via the direct telegram helper", () => {
    expect(validateTelegramPluginConfig({ enableCommands: true }).valid).toBe(false);
  });

  it("rejects an empty allowlist for a truthy non-boolean enableCommands flag", () => {
    const result = validatePluginConfigPolicy("paperclip-plugin-telegram", {
      enableCommands: "true",
    });
    expect(result.valid).toBe(false);
  });
});
