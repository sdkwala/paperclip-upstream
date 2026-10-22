export interface PluginConfigPolicyError {
  field: string;
  message: string;
}

export interface PluginConfigPolicyResult {
  valid: boolean;
  errors?: PluginConfigPolicyError[];
}

export type PluginConfigPolicy = (pluginKey: string, configJson: Record<string, unknown>) => PluginConfigPolicyResult;

const TELEGRAM_PLUGIN_KEY = "paperclip-plugin-telegram";
const TELEGRAM_ALLOWLIST_ERROR =
  "enableCommands/enableInbound requires a non-empty allowedTelegramUserIds or allowedTelegramChatIds";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isTelegramPlugin(pluginKey: string): boolean {
  return pluginKey === TELEGRAM_PLUGIN_KEY;
}

function booleanConfig(value: unknown): boolean {
  return Boolean(value);
}

export function validateTelegramPluginConfig(
  configJson: Record<string, unknown> | null | undefined,
): PluginConfigPolicyResult {
  const config = configJson && typeof configJson === "object" && !Array.isArray(configJson) ? configJson : {};
  const enableCommands = booleanConfig(config.enableCommands);
  const enableInbound = booleanConfig(config.enableInbound);

  if (!enableCommands && !enableInbound) {
    return { valid: true, errors: [] };
  }

  const allowedUserIds = asArray(config.allowedTelegramUserIds);
  const allowedChatIds = asArray(config.allowedTelegramChatIds);
  if (allowedUserIds.length > 0 || allowedChatIds.length > 0) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: [
      {
        field: "/allowedTelegramUserIds",
        message: TELEGRAM_ALLOWLIST_ERROR,
      },
    ],
  };
}

export function validatePluginConfigPolicy(
  pluginKeyOrConfig: string | Record<string, unknown> | null | undefined,
  configJson?: Record<string, unknown> | null,
): PluginConfigPolicyResult {
  let pluginKey = TELEGRAM_PLUGIN_KEY;
  let config = configJson;

  if (typeof pluginKeyOrConfig === "string") {
    pluginKey = pluginKeyOrConfig;
  } else if (pluginKeyOrConfig && typeof pluginKeyOrConfig === "object" && !Array.isArray(pluginKeyOrConfig)) {
    config = pluginKeyOrConfig as Record<string, unknown>;
  }

  if (!isTelegramPlugin(pluginKey)) {
    return { valid: true, errors: [] };
  }

  return validateTelegramPluginConfig(config ?? {});
}

const pluginConfigPolicies = new Map<string, PluginConfigPolicy>([
  [TELEGRAM_PLUGIN_KEY, (_pluginKey, configJson) => validateTelegramPluginConfig(configJson)],
]);

export function registerPluginConfigPolicy(pluginKey: string, policy: PluginConfigPolicy): void {
  pluginConfigPolicies.set(pluginKey, policy);
}

export function getPluginConfigPolicy(pluginKey: string): PluginConfigPolicy | undefined {
  return pluginConfigPolicies.get(pluginKey);
}

export function runPluginConfigPolicy(
  pluginKey: string,
  configJson: Record<string, unknown> | null | undefined,
): PluginConfigPolicyResult {
  const policy = pluginConfigPolicies.get(pluginKey);
  if (!policy) {
    return { valid: true, errors: [] };
  }
  return policy(pluginKey, configJson ?? {});
}

export function hasPluginConfigPolicy(pluginKey: string): boolean {
  return pluginConfigPolicies.has(pluginKey);
}

export function listPluginConfigPolicies(): string[] {
  return [...pluginConfigPolicies.keys()];
}

export { TELEGRAM_PLUGIN_KEY };
