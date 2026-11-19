import type { TestScenarioInput } from '../../shared/scenario.schema.js';

const DEFAULT_SECTION = { id: '1', rows: 8, cols: 12, powerBus: 'BUS-1' };

export const HMI_PRESETS: Record<string, TestScenarioInput> = {
    test1_1: {
        name: 'Тест 1.1 — Штатная выдача (95, 53, 28, 5)',
        description: 'Попытка выдачи из ячеек 95 (стр. 8), 53 (стр. 5), 28 (стр. 3), 5 (стр. 1) по 1 шт. Все выдачи успешны.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 7, column: 10, quantity: 1 },
                { row: 4, column: 4, quantity: 1 },
                { row: 2, column: 3, quantity: 1 },
                { row: 0, column: 4, quantity: 1 },
            ],
        },
        timeoutMs: 20000,
    },

    test1_2: {
        name: 'Тест 1.2 — Штатная выдача с количеством (90, 52x3, 33, 11)',
        description: 'Попытка выдачи из ячеек 90 (1 шт.), 52 (3 шт.), 33 (1 шт.), 11 (1 шт.). Все выдачи успешны.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 7, column: 5, quantity: 1 },
                { row: 4, column: 3, quantity: 3 },
                { row: 2, column: 8, quantity: 1 },
                { row: 0, column: 10, quantity: 1 },
            ],
        },
        timeoutMs: 25000,
    },

    test2_1: {
        name: 'Тест 2.1 — Нет питания моторов в ячейках 7 и 12 (ACTUATOR_NO_POWER)',
        description: 'Ячейки 4 (x3), 7 (x3), 12 (x1). Ячейка 4 успешна, ячейки 7 и 12 проваливаются с ACTUATOR_NO_POWER.',
        section: DEFAULT_SECTION,
        emulator: { spiralNoPowerTargets: [6, 11] },
        order: {
            command: 'GetItem',
            cells: [
                { row: 0, column: 3, quantity: 3 },
                { row: 0, column: 6, quantity: 3 },
                { row: 0, column: 11, quantity: 1 },
            ],
        },
        timeoutMs: 25000,
    },

    test2_2: {
        name: 'Тест 2.2 — Отключение питания лифта после первой выдачи (LIFT_NO_POWER)',
        description: 'Ячейки 90 (стр. 8), 30 (стр. 3). После первой выдачи отключается питание лифта — все ячейки FAIL, LIFT_NO_POWER.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 7, column: 5, quantity: 1 },
                { row: 2, column: 5, quantity: 1 },
            ],
        },
        faults: [
            {
                id: 'lift-no-power-after-first',
                mode: 'runtime',
                when: { type: 'onChannelSet', channel: 'Lift.MotorCtrl', occurrence: 2 },
                delayMs: 30,
                action: { type: 'patchEmulator', patch: { liftNoPower: true } },
            },
        ],
        timeoutMs: 20000,
    },

    test3_1: {
        name: 'Тест 3.1 — КЗ на шине/лифте после первой выдачи (LIFT_SHORT_CIRCUIT)',
        description: 'Ячейки 90, 52, 31, 30. После первой выдачи замыкается питание секции — все ячейки FAIL, LIFT_SHORT_CIRCUIT.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 7, column: 5, quantity: 1 },
                { row: 4, column: 3, quantity: 1 },
                { row: 2, column: 6, quantity: 1 },
                { row: 2, column: 5, quantity: 1 },
            ],
        },
        faults: [
            {
                id: 'lift-short-circuit',
                mode: 'runtime',
                when: { type: 'onChannelSet', channel: 'Lift.MotorCtrl', occurrence: 2 },
                delayMs: 30,
                action: { type: 'injectChannel', channel: 'Power.Short', value: 1, samples: 1 },
            },
        ],
        timeoutMs: 20000,
    },

    test3_2: {
        name: 'Тест 3.2 — КЗ во время второй выдачи (ACTUATOR_SHORT_CIRCUIT)',
        description: 'Ячейки 52, 5, 8. Ячейка 52 успешна, во время второй выдачи вызывается КЗ (ACTUATOR_SHORT_CIRCUIT), затем ИП восстанавливается.',
        section: DEFAULT_SECTION,
        emulator: { spiralShortTargets: [4] },
        order: {
            command: 'GetItem',
            cells: [
                { row: 4, column: 3, quantity: 1 },
                { row: 0, column: 4, quantity: 1 },
                { row: 0, column: 7, quantity: 1 },
            ],
        },
        timeoutMs: 20000,
    },

    test4_1: {
        name: 'Тест 4.1 — Открытие двери при движении лифта',
        description: 'Ячейки 28, 18, 16. Открытие двери при движении лифта прерывает операцию — провал по всем ячейкам.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 2, column: 3, quantity: 1 },
                { row: 1, column: 5, quantity: 1 },
                { row: 1, column: 3, quantity: 1 },
            ],
        },
        faults: [
            {
                id: 'open-door-during-lift',
                mode: 'runtime',
                when: { type: 'onChannelSet', channel: 'Lift.MotorCtrl', match: 'UP', occurrence: 1 },
                delayMs: 80,
                action: { type: 'injectChannel', channel: 'Door.Sensor', value: 0, samples: 1 },
            },
        ],
        timeoutMs: 15000,
    },

    test4_2: {
        name: 'Тест 4.2 — Открытие двери при повороте спирали',
        description: 'Ячейки 28, 16, 18. Открытие двери при вращении спирали прерывает операцию — провал по всем ячейкам.',
        section: DEFAULT_SECTION,
        order: {
            command: 'GetItem',
            cells: [
                { row: 2, column: 3, quantity: 1 },
                { row: 1, column: 3, quantity: 1 },
                { row: 1, column: 5, quantity: 1 },
            ],
        },
        faults: [
            {
                id: 'open-door-during-spiral',
                mode: 'runtime',
                when: { type: 'onChannelSet', channel: 'Storage.MatrixCtrl', occurrence: 1 },
                delayMs: 80,
                action: { type: 'injectChannel', channel: 'Door.Sensor', value: 0, samples: 1 },
            },
        ],
        timeoutMs: 15000,
    },
};
