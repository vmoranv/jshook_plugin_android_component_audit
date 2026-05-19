import {
  createExtension,
  errorResponse,
  jsonResponse,
} from '@jshookmcp/extension-sdk/plugin';
import type {
  PluginLifecycleContext,
  ToolArgs,
  ToolResponse,
} from '@jshookmcp/extension-sdk/plugin';

const PLUGIN_ID = 'io.github.vmoranv.android.component-audit';
const PLUGIN_VERSION = '0.0.1';
const TOOL_NAME = 'android_component_audit';

type JsonRecord = Record<string, unknown>;
type TagBlock = { attrs: Record<string, string>; innerXml: string };

function readTextContent(result: ToolResponse): string {
  const block = result.content.find(
    (item): item is { type: 'text'; text: string } =>
      item.type === 'text' && typeof item.text === 'string',
  );
  if (!block) {
    throw new Error('Tool did not return text content');
  }
  return block.text;
}

function parseToolPayload(result: ToolResponse): JsonRecord {
  const parsed = JSON.parse(readTextContent(result)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool did not return a JSON object');
  }
  return parsed as JsonRecord;
}

async function invokeJsonTool(
  ctx: PluginLifecycleContext,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRecord> {
  return parseToolPayload(await ctx.invokeTool(name, args));
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRegex = /([:\w.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRegex.exec(source)) !== null) {
    const [, key, value] = match;
    if (key) attributes[key] = value ?? '';
  }
  return attributes;
}

function collectTagBlocks(xml: string, tagName: string): TagBlock[] {
  const blocks: TagBlock[] = [];
  const pairRegex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, 'gi');
  const selfRegex = new RegExp(`<${tagName}\\b([^>]*)/>`, 'gi');

  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(xml)) !== null) {
    blocks.push({
      attrs: parseAttributes(match[1] ?? ''),
      innerXml: match[2] ?? '',
    });
  }
  while ((match = selfRegex.exec(xml)) !== null) {
    blocks.push({
      attrs: parseAttributes(match[1] ?? ''),
      innerXml: '',
    });
  }
  return blocks;
}

function parseBooleanLike(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function computeEffectiveExported(
  type: 'activity' | 'activity-alias' | 'service' | 'receiver' | 'provider',
  explicitExported: boolean | null,
  hasIntentFilter: boolean,
): boolean {
  if (explicitExported !== null) return explicitExported;
  if (type === 'provider') return false;
  return hasIntentFilter;
}

function normalizeComponentName(
  packageName: string | null,
  componentName: string | undefined,
): string | null {
  if (!componentName) return null;
  if (componentName.startsWith('.')) {
    return packageName ? `${packageName}${componentName}` : componentName;
  }
  if (componentName.includes('.')) return componentName;
  return packageName ? `${packageName}.${componentName}` : componentName;
}

async function handleComponentAudit(args: ToolArgs, ctx: PluginLifecycleContext) {
  const apkPath = typeof args.apkPath === 'string' ? args.apkPath.trim() : '';
  if (!apkPath) {
    return errorResponse(TOOL_NAME, new Error('apkPath is required'));
  }

  try {
    const payload = await invokeJsonTool(ctx, 'apk_manifest_dump', { apkPath });
    const manifestXml = payload.manifest;
    if (typeof manifestXml !== 'string' || !manifestXml.trimStart().startsWith('<')) {
      throw new Error('apk_manifest_dump did not return readable XML');
    }

    const manifestAttrs = parseAttributes(
      /<manifest\b([^>]*?)(?:\/?>)/i.exec(manifestXml)?.[1] ?? '',
    );
    const packageName = manifestAttrs['package'] ?? null;
    const types: Array<'activity' | 'activity-alias' | 'service' | 'receiver' | 'provider'> = [
      'activity',
      'activity-alias',
      'service',
      'receiver',
      'provider',
    ];

    const components = types.flatMap((type) =>
      collectTagBlocks(manifestXml, type).map((block) => {
        const explicitExported = parseBooleanLike(block.attrs['android:exported']);
        const hasIntentFilter = /<intent-filter\b/i.test(block.innerXml);
        const hasBrowsable = /android\.intent\.category\.BROWSABLE/i.test(block.innerXml);
        const hasMain = /android\.intent\.action\.MAIN/i.test(block.innerXml);
        const hasLauncher = /android\.intent\.category\.LAUNCHER/i.test(block.innerXml);
        return {
          type,
          name: normalizeComponentName(
            packageName,
            block.attrs['android:name'] ??
              (type === 'activity-alias' ? block.attrs['android:targetActivity'] : undefined),
          ),
          directName: block.attrs['android:name'] ?? null,
          exported: explicitExported,
          effectiveExported: computeEffectiveExported(type, explicitExported, hasIntentFilter),
          permission: block.attrs['android:permission'] ?? null,
          process: block.attrs['android:process'] ?? null,
          enabled: parseBooleanLike(block.attrs['android:enabled']),
          launchMode: block.attrs['android:launchMode'] ?? null,
          authorities: block.attrs['android:authorities'] ?? null,
          hasIntentFilter,
          hasBrowsable,
          launcher: hasMain && hasLauncher,
          deepLinkSurface: hasBrowsable || /<data\b/i.test(block.innerXml),
        };
      }),
    );

    const exportedComponents = components.filter((component) => component.effectiveExported);
    const launcherComponents = components
      .filter((component) => component.launcher)
      .map((component) => component.name)
      .filter((value): value is string => typeof value === 'string');
    const deepLinkComponents = components.filter((component) => component.deepLinkSurface);
    const exportedWithoutPermission = exportedComponents.filter((component) => !component.permission);

    return jsonResponse({
      success: true,
      apkPath,
      packageName,
      totalComponents: components.length,
      countsByType: {
        activity: components.filter((component) => component.type === 'activity').length,
        activityAlias: components.filter((component) => component.type === 'activity-alias').length,
        service: components.filter((component) => component.type === 'service').length,
        receiver: components.filter((component) => component.type === 'receiver').length,
        provider: components.filter((component) => component.type === 'provider').length,
      },
      exportedCount: exportedComponents.length,
      launcherComponents,
      deepLinkComponents: deepLinkComponents.map((component) => ({
        type: component.type,
        name: component.name,
        exported: component.effectiveExported,
      })),
      exportedWithoutPermission: exportedWithoutPermission.map((component) => ({
        type: component.type,
        name: component.name,
      })),
      components,
    });
  } catch (error) {
    return errorResponse(TOOL_NAME, error, { apkPath });
  }
}

export default createExtension(PLUGIN_ID, PLUGIN_VERSION)
  .name('Android Component Audit')
  .description('Audit Android manifest components, launcher entrypoints, exported surfaces, and deep link exposure.')
  .author('vmoranv')
  .sourceRepo('https://github.com/vmoranv/jshook_plugin_android_component_audit')
  .compatibleCore('>=0.1.0')
  .profile(['workflow', 'full'])
  .allowTool('apk_manifest_dump')
  .metric('android_component_audit_calls_total')
  .tool(
    TOOL_NAME,
    'Inspect Android components, highlight exported surfaces, and identify launcher and deep link entrypoints.',
    {
      apkPath: {
        type: 'string',
        description: 'Absolute or relative path to the target APK file.',
      },
    },
    handleComponentAudit,
  );
