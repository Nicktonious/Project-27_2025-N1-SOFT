import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type * as SpiralFixtureType from '#js/srvSpiralSection/test/fixtures/spiralSection.fixture.js';
import type { MachineConfig } from '#js/srvStatesController/ts/IMachineConfig.ts';

import { HMI_PRESETS } from '../../js/presets.js';
import { ScenarioRunner } from '../../js/ScenarioRunner.js';
import type { TestScenarioInput } from '../../../shared/scenario.schema.js';

const { createSpiralMachineConfig } = require(
    '#js/srvSpiralSection/test/fixtures/spiralSection.fixture.js'
) as typeof SpiralFixtureType;

function resolvePathInChannels(channels: Record<string, unknown>, pathOrName: string): string {
    if (!pathOrName.includes('.')) return pathOrName;
    let curr: unknown = channels;
    for (const part of pathOrName.split('.')) {
        curr = curr && typeof curr === 'object' ? (curr as Record<string, unknown>)[part] : undefined;
    }
    return typeof curr === 'string' && curr ? curr : pathOrName;
}

function withConfig(preset: TestScenarioInput, config: MachineConfig): TestScenarioInput {
    const ch = config.Sections[0].Channels as unknown as Record<string, unknown>;
    return {
        ...preset,
        machineConfig: config as unknown as Record<string, unknown>,
        faults: preset.faults?.map((rule) => ({
            ...rule,
            when:
                rule.when?.type === 'onChannelSet'
                    ? { ...rule.when, channel: resolvePathInChannels(ch, rule.when.channel) }
                    : rule.when,
            action:
                rule.action.type === 'injectChannel'
                    ? { ...rule.action, channel: resolvePathInChannels(ch, rule.action.channel) }
                    : rule.action,
        })),
    };
}

interface PresetCase {
    key: string;
    expectedResults: Array<'OK' | 'FAIL'>;
}

const PRESET_CASES: PresetCase[] = [
    { key: 'test1_1', expectedResults: ['OK', 'OK', 'OK', 'OK'] },
    { key: 'test1_2', expectedResults: ['OK', 'OK', 'OK', 'OK'] },
    { key: 'test2_1', expectedResults: ['OK', 'FAIL', 'FAIL'] },
    { key: 'test2_2', expectedResults: ['FAIL', 'FAIL'] },
    { key: 'test3_1', expectedResults: ['FAIL', 'FAIL', 'FAIL', 'FAIL'] },
    { key: 'test3_2', expectedResults: ['OK', 'FAIL', 'FAIL'] },
    { key: 'test4_1', expectedResults: ['FAIL', 'FAIL', 'FAIL'] },
    { key: 'test4_2', expectedResults: ['FAIL', 'FAIL', 'FAIL'] },
];

describe('Пресеты демонстрации спиральной секции (_Тесты спиральной секции к демонстрации_02.md)', () => {
    const baseConfig = createSpiralMachineConfig({ id: '1', rows: 8, cols: 12, powerBus: 'BUS-1' });

    for (const tc of PRESET_CASES) {
        const preset = HMI_PRESETS[tc.key];

        it(`${tc.key}: ${preset.name}`, async () => {
            const runner = new ScenarioRunner();
            const report = await runner.run(withConfig(preset, baseConfig));

            assert.equal(report.aborted, false);
            assert.equal(report.timedOut, false);
            assert.deepEqual(
                report.responses.map((r) => r.Response.Result),
                tc.expectedResults
            );
        });
    }
});
