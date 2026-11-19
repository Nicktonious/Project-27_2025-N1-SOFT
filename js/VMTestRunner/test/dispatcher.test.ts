import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import type * as SpiralFixtureType from '#js/srvSpiralSection/test/fixtures/spiralSection.fixture.js';
import type { MachineConfig } from '#js/srvStatesController/ts/IMachineConfig.ts';

import { ScenarioRunner } from '../server/js/ScenarioRunner.js';
import { createApiServer } from '../server/js/apiServer.js';
import { parseScenario, type TestScenarioInput } from '../shared/scenario.schema.js';
import { HMI_PRESETS } from '../server/js/presets.js';

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

describe('HMI JSON-диспетчер сценариев (ScenarioSchema, FaultDispatcher, ScenarioRunner)', () => {
    const baseConfig = createSpiralMachineConfig({ id: '1', rows: 8, cols: 12, powerBus: 'BUS-1' });

    it('parseScenario выбрасывает ZodError на некорректные координаты и правила аварий', () => {
        assert.throws(
            () =>
                parseScenario({
                    section: { rows: 4, cols: 4 },
                    order: {
                        command: 'GetItem',
                        cells: [{ row: 9, column: 0, quantity: 1 }],
                    },
                    faults: [
                        {
                            id: '',
                            when: { type: 'afterMs', ms: -10 },
                            action: { type: 'injectChannel', channel: 'Door.Sensor', value: 0 },
                        },
                    ],
                }),
            ZodError
        );
    });

    it('выполняет пресет test1_1 (штатная выдача 4 ячеек) и возвращает ответы OK', async () => {
        const runner = new ScenarioRunner();
        const events: string[] = [];
        runner.on('timeline', (ev: { kind: string }) => events.push(ev.kind));

        const report = await runner.run(withConfig(HMI_PRESETS.test1_1, baseConfig));

        assert.equal(report.aborted, false);
        assert.equal(report.timedOut, false);
        assert.equal(report.responses.length, 4);
        assert.ok(report.responses.every((r) => r.Response.Result === 'OK'));
        assert.ok(events.includes('lifecycle'));
        assert.ok(events.includes('response'));
    });

    it('отклоняет транзакцию при открытой двери до старта (atStart Door.Sensor = 0)', async () => {
        const runner = new ScenarioRunner();
        const report = await runner.run(
            withConfig(
                {
                    name: 'Открытая дверь со старта',
                    section: { id: '1', rows: 8, cols: 12, powerBus: 'BUS-1' },
                    order: { command: 'GetItem', cells: [{ row: 1, column: 0, quantity: 1 }] },
                    faults: [
                        {
                            id: 'door-open-at-start',
                            mode: 'atStart',
                            action: { type: 'injectChannel', channel: 'Door.Sensor', value: 0 },
                        },
                    ],
                    timeoutMs: 5000,
                },
                baseConfig
            )
        );
        const states = report.states as { Sections: Array<{ ID: string }>; Global: { Name: string } };

        assert.equal(states.Global.Name, 'TestMachine');
        assert.equal(states.Sections[0].ID, '1');
        assert.equal(report.triggeredFaults[0].id, 'door-open-at-start');
        assert.ok(report.responses.some((r) => r.Response.Result === 'FAIL'));
    });

    it('выполняет пресет test4_1 (открытие двери при движении лифта)', async () => {
        const runner = new ScenarioRunner();
        const report = await runner.run(withConfig(HMI_PRESETS.test4_1, baseConfig));

        assert.equal(report.triggeredFaults.length, 1);
        assert.equal(report.triggeredFaults[0].id, 'open-door-during-lift');
        assert.equal(report.triggeredFaults[0].actionType, 'injectChannel');
        assert.ok(report.responses.some((r) => r.Response.Result === 'FAIL'));
    });

    it('обрабатывает silentAck матрицы (таймаут драйвера — без ложного OK)', async () => {
        const runner = new ScenarioRunner();
        const report = await runner.run(
            withConfig(
                {
                    name: 'Таймаут матрицы',
                    section: { id: '1', rows: 8, cols: 12, powerBus: 'BUS-1' },
                    order: { command: 'GetItem', cells: [{ row: 2, column: 2, quantity: 1 }] },
                    faults: [
                        {
                            id: 'silent-ack-at-start',
                            mode: 'atStart',
                            action: { type: 'patchEmulator', patch: { silentAck: true } },
                        },
                    ],
                    timeoutMs: 8000,
                },
                baseConfig
            )
        );

        assert.equal(report.responses.some((r) => r.Response.Result === 'OK'), false);
        assert.ok(report.timeline.some((e) => e.message.includes('"code":14')));
    });

    it('поддерживает триггер afterMs, patchStates и принудительное прерывание runner.abort()', async () => {
        const runner = new ScenarioRunner();
        const runPromise = runner.run(
            {
                name: 'Тест abort',
                section: { id: '1', rows: 8, cols: 12 },
                order: {
                    command: 'GetItem',
                    cells: [{ row: 3, column: 1, quantity: 1 }],
                },
                faults: [
                    {
                        id: 'bus-drop',
                        when: { type: 'afterMs', ms: 40 },
                        action: { type: 'patchStates', patch: { Sections: { 0: { Door: 'OPEN' } } } },
                    },
                ],
                timeoutMs: 5000,
            },
            { config: baseConfig }
        );

        setTimeout(() => {
            runner.abort();
        }, 220);

        const report = await runPromise;
        assert.equal(report.aborted, true);
        assert.ok(report.triggeredFaults.some((f) => f.id === 'bus-drop'));
        const states = report.states as { Sections: Array<{ Door: string }> };
        assert.equal(states.Sections[0].Door, 'OPEN');
    });

    it('Fastify API запускает прогон (POST /api/runs), отдаёт статус и прерывает (POST /api/runs/:id/abort)', async () => {
        const app = createApiServer();
        try {
            const startRes = await app.inject({
                method: 'POST',
                url: '/api/runs',
                payload: {
                    sectionType: 'SPIRAL',
                    scenario: withConfig(HMI_PRESETS.test1_1, baseConfig),
                },
            });
            assert.equal(startRes.statusCode, 202);
            const { runId, status } = startRes.json() as { runId: string; status: string };
            assert.ok(runId);
            assert.equal(status, 'RUNNING');

            const abortRes = await app.inject({
                method: 'POST',
                url: `/api/runs/${runId}/abort`,
            });
            assert.equal(abortRes.statusCode, 200);

            await new Promise((r) => setTimeout(r, 150));
            const statusRes = await app.inject({
                method: 'GET',
                url: `/api/runs/${runId}`,
            });
            assert.equal(statusRes.statusCode, 200);
            const finalBody = statusRes.json() as { status: string; report: { aborted: boolean } | null };
            assert.equal(finalBody.status, 'ABORTED');
            assert.equal(finalBody.report?.aborted, true);
        } finally {
            await app.close();
        }
    });
});
