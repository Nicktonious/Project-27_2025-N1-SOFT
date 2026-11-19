import type { TestScenarioInput } from '@shared/scenario.schema.ts';

export interface ChannelEntry {
    path: string;
    channel: string;
}

interface ConfigSectionLike {
    ID?: string | number;
    Type?: string;
    Channels?: Record<string, unknown>;
}

function findTargetSection(
    machineConfig: Record<string, unknown> | undefined,
    sectionId?: string
): ConfigSectionLike | undefined {
    const sections = (machineConfig as { Sections?: ConfigSectionLike[] } | undefined)?.Sections;
    if (!Array.isArray(sections) || sections.length === 0) return undefined;
    if (sectionId) {
        const byId = sections.find((s) => String(s.ID) === String(sectionId));
        if (byId) return byId;
    }
    return sections.find((s) => s.Type === 'SPIRAL') ?? sections[0];
}

function collectChannelEntries(node: unknown, prefix: string, out: ChannelEntry[]): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((item, idx) => {
            if (typeof item === 'string' && item) {
                out.push({ path: `${prefix}.${idx}`, channel: item });
            } else {
                collectChannelEntries(item, `${prefix}.${idx}`, out);
            }
        });
        return;
    }
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        const nextPath = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'string' && val) {
            out.push({ path: nextPath, channel: val });
        } else {
            collectChannelEntries(val, nextPath, out);
        }
    }
}

export function extractSectionChannelEntries(
    machineConfig: Record<string, unknown> | undefined,
    sectionId?: string
): ChannelEntry[] {
    const sec = findTargetSection(machineConfig, sectionId);
    if (!sec?.Channels) return [];
    const entries: ChannelEntry[] = [];
    collectChannelEntries(sec.Channels, '', entries);
    return entries;
}

export function resolveChannelFromConfig(
    nameOrPath: string,
    machineConfig: Record<string, unknown> | undefined,
    sectionId?: string
): string {
    if (!nameOrPath.includes('.')) return nameOrPath;
    const sec = findTargetSection(machineConfig, sectionId);
    let curr: unknown = sec?.Channels;
    for (const part of nameOrPath.split('.')) {
        if (curr && typeof curr === 'object' && part in curr) {
            curr = (curr as Record<string, unknown>)[part];
        } else {
            return nameOrPath;
        }
    }
    return typeof curr === 'string' && curr ? curr : nameOrPath;
}

export function resolveScenarioChannels(
    scenario: TestScenarioInput,
    machineConfig: Record<string, unknown> | undefined
): TestScenarioInput {
    if (!machineConfig) return scenario;
    const sectionId = scenario.section?.id;

    const faults = scenario.faults?.map((rule) => {
        const nextWhen =
            rule.when?.type === 'onChannelSet'
                ? { ...rule.when, channel: resolveChannelFromConfig(rule.when.channel, machineConfig, sectionId) }
                : rule.when;
        const nextAction =
            rule.action.type === 'injectChannel'
                ? { ...rule.action, channel: resolveChannelFromConfig(rule.action.channel, machineConfig, sectionId) }
                : rule.action;
        return { ...rule, when: nextWhen, action: nextAction };
    });

    const channelsPatch = scenario.channelsPatch
        ? Object.fromEntries(
              Object.entries(scenario.channelsPatch).map(([k, v]) => [
                  resolveChannelFromConfig(k, machineConfig, sectionId),
                  v,
              ])
          )
        : undefined;

    return {
        ...scenario,
        machineConfig,
        ...(faults ? { faults } : {}),
        ...(channelsPatch ? { channelsPatch } : {}),
    };
}
