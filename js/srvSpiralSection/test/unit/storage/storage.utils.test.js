const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionStorage } = require('../../../js/srvSpiralSectionStorage');
const { STORAGE_CONSTANTS, COMMON_CONSTANTS } = require('../../../js/SpiralSectionConstants');
const {
    createStorageChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { SpiralSection, peekValueInRange, getRangeAbove, getRangeBelow } = require('../../../../VMEmulator');

// --- Инженерные константы конфигурации матрицы и буферов ---
const ROWS = 4;
const COLS = 3;
const BUS_NUMBER = 1;
const CURR_BUFFER_SIZE = 2;
const VOLT_BUFFER_SIZE = 3;

// --- Физические константы сигналов датчиков (сопоставленные со SpiralSectionConstants.js) ---
const STORAGE_SUPPLY_VOLTAGE = STORAGE_CONSTANTS.SUPPLY_VOLTAGE; // 24V
const STORAGE_WORK_CURRENT = peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.WORK_OK);
const STORAGE_IDLE_CURRENT = peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.IDLE);
const STORAGE_OVERLOAD_CURRENT = peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.OVERLOAD);
const STORAGE_SHORT_THRESHOLD = STORAGE_CONSTANTS.CURRENT_RANGE.SHORT[0]; // 1.4A
const STORAGE_SHORT_CURRENT = getRangeAbove(STORAGE_CONSTANTS.CURRENT_RANGE.SHORT, 0.5);
const MIN_OPERATING_VOLTAGE = COMMON_CONSTANTS.MIN_VOLTAGE; // 16V

const SAFE_VOLTAGE_DELTA = 0.5;
const DEEP_VOLTAGE_DROP = 4;
const SHORT_DELTA = 0.05;

describe('ClassSpiralSectionStorage — утилитарные и вспомогательные функции (без управления моторами)', () => {
    let stub;
    let emuStorage;
    let channels;
    let sectionState;
    let logs;
    let proxyLogger;
    let storage;

    beforeEach(async () => {
        channels = createStorageChannelsFixture({ rows: ROWS });

        stub = new ProxyChannelStub();
        emuStorage = new SpiralSection({ proxy: stub, channels, size: { rows: ROWS, cols: COLS } });
        emuStorage.seedDefaultSensors();

        sectionState = createMockSectionState({ rows: ROWS, cols: COLS });

        logs = [];
        proxyLogger = {
            Log: (entry) => logs.push(entry),
        };

        storage = new ClassSpiralSectionStorage({
            ProxyCh: stub,
            channels,
            advOpts: {
                busNumber: BUS_NUMBER,
                size: { rows: ROWS, cols: COLS },
                globalState: null,
            },
            sectionState,
            ProxyLogger: proxyLogger,
        });

        await new Promise((r) => setImmediate(r));
        stub.clearHistory();
        logs.length = 0;
    });

    afterEach(() => {
        storage.Reset();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Преобразование координат и уровней: IndexToPos, PosToInd, GetLevelByIndex, MaxLevel
    // =========================================================================
    describe('Координатная сетка матрицы: IndexToPos(), PosToInd(), GetLevelByIndex(), MaxLevel', () => {
        it('MaxLevel возвращает количество рядов (полок) хранилища', () => {
            assert.equal(storage.MaxLevel, ROWS);
        });

        it('IndexToPos() и PosToInd() взаимно обратимо преобразуют линейный индекс и координаты { row, col / column }', () => {
            // Матрица 4x3 (индексы 0..11)
            assert.deepEqual(storage.IndexToPos(0), { row: 0, col: 0 });
            assert.deepEqual(storage.IndexToPos(2), { row: 0, col: 2 });
            assert.deepEqual(storage.IndexToPos(3), { row: 1, col: 0 });
            assert.deepEqual(storage.IndexToPos(7), { row: 2, col: 1 });
            assert.deepEqual(storage.IndexToPos(11), { row: 3, col: 2 });

            // Проверка кастомной ширины _width в IndexToPos (индекс 5 при ширине 4 -> row 1, col 1)
            assert.deepEqual(storage.IndexToPos(5, 4), { row: 1, col: 1 });

            // PosToInd поддерживает как поле col, так и поле column
            assert.equal(storage.PosToInd({ row: 0, col: 0 }), 0);
            assert.equal(storage.PosToInd({ row: 2, col: 1 }), 7);
            assert.equal(storage.PosToInd({ row: 2, column: 1 }), 7);
            assert.equal(storage.PosToInd({ row: 3, column: 2 }), 11);
        });

        it('GetLevelByIndex() вычисляет физический уровень полки снизу вверх (rows - row)', () => {
            // При ROWS = 4:
            // row 0 (верхняя полка, индексы 0..2) -> уровень 4 (ROWS)
            assert.equal(storage.GetLevelByIndex(0), ROWS);
            assert.equal(storage.GetLevelByIndex(2), ROWS);
            // row 1 (индексы 3..5) -> уровень 3 (ROWS - 1)
            assert.equal(storage.GetLevelByIndex(4), ROWS - 1);
            // row 3 (нижняя полка, индексы 9..11) -> уровень 1
            assert.equal(storage.GetLevelByIndex(9), 1);
            assert.equal(storage.GetLevelByIndex(11), 1);
        });
    });

    // =========================================================================
    // 2. Итераторы матрицы: RowIterator, RowIndexIterator, ColIterator, UnitsByScope
    // =========================================================================
    describe('Итераторы ячеек: RowIterator(), RowIndexIterator(), ColIterator(), UnitsByScope()', () => {
        it('RowIterator() и RowIndexIterator() возвращают все ячейки указанного ряда и выбрасывают RangeError при выходе за границы', () => {
            const row1Units = [...storage.RowIterator(1)];
            assert.equal(row1Units.length, COLS);
            assert.deepEqual(
                row1Units.map((u) => u.index),
                [3, 4, 5]
            );
            assert.deepEqual(
                row1Units.map((u) => u.coords),
                [
                    { row: 1, col: 0 },
                    { row: 1, col: 1 },
                    { row: 1, col: 2 },
                ]
            );

            const row2Units = [...storage.RowIndexIterator(2)];
            assert.deepEqual(
                row2Units.map((u) => u.index),
                [6, 7, 8]
            );

            assert.throws(() => [...storage.RowIterator(-1)], RangeError);
            assert.throws(() => [...storage.RowIterator(ROWS)], RangeError);
            assert.throws(() => [...storage.RowIndexIterator(-1)], RangeError);
            assert.throws(() => [...storage.RowIndexIterator(ROWS)], RangeError);
        });

        it('ColIterator() возвращает все ячейки указанного столбца сверху вниз и выбрасывают RangeError при выходе за границы', () => {
            const col1Units = [...storage.ColIterator(1)];
            assert.equal(col1Units.length, ROWS);
            assert.deepEqual(
                col1Units.map((u) => u.index),
                [1, 4, 7, 10]
            );

            assert.throws(() => [...storage.ColIterator(-1)], RangeError);
            assert.throws(() => [...storage.ColIterator(COLS)], RangeError);
        });

        it('UnitsByScope() выбирает ячейку (single), ряд (row), колонку (col) или всю матрицу (all)', () => {
            const baseCellIndex = 4; // row 1, col 1
            const single = [...storage.UnitsByScope(baseCellIndex, 'single')].map((u) => u.index);
            assert.deepEqual(single, [baseCellIndex]);

            const rowScope = [...storage.UnitsByScope(baseCellIndex, 'row')].map((u) => u.index);
            assert.deepEqual(rowScope, [3, 4, 5]);

            const colScope = [...storage.UnitsByScope(baseCellIndex, 'col')].map((u) => u.index);
            assert.deepEqual(colScope, [1, 4, 7, 10]);

            const allScope = [...storage.UnitsByScope(baseCellIndex, 'all')].map((u) => u.index);
            assert.equal(allScope.length, ROWS * COLS);

            assert.throws(() => [...storage.UnitsByScope(baseCellIndex, 'invalid_scope')], /Invalid scope/);
        });
    });

    // =========================================================================
    // 3. Контроль тока и КЗ: CheckCurrentState(), IsShorted()
    // =========================================================================
    describe('CheckCurrentState() и IsShorted() — аналитическая классификация токов', () => {
        const { CURRENT_RANGE, ELECTR_CURR_STATE } = STORAGE_CONSTANTS;

        it('CheckCurrentState() классифицирует ток по диапазонам STORAGE_CONSTANTS.CURRENT_RANGE', () => {
            // IDLE: [0, 0.15)
            assert.equal(storage.CheckCurrentState(CURRENT_RANGE.IDLE[0]), ELECTR_CURR_STATE.IDLE);
            assert.equal(storage.CheckCurrentState(STORAGE_IDLE_CURRENT), ELECTR_CURR_STATE.IDLE);

            // WORK_OK: [0.15, 0.25)
            assert.equal(storage.CheckCurrentState(CURRENT_RANGE.WORK_OK[0]), ELECTR_CURR_STATE.WORK_OK);
            assert.equal(storage.CheckCurrentState(STORAGE_WORK_CURRENT), ELECTR_CURR_STATE.WORK_OK);

            // Зазор между WORK_OK (0.25) и OVERLOAD (0.30) возвращает undefined
            const gapCurrent = (CURRENT_RANGE.WORK_OK[1] + CURRENT_RANGE.OVERLOAD[0]) / 2;
            assert.equal(storage.CheckCurrentState(gapCurrent), undefined);

            // OVERLOAD: [0.3, 1.4)
            assert.equal(storage.CheckCurrentState(CURRENT_RANGE.OVERLOAD[0]), ELECTR_CURR_STATE.OVERLOAD);
            assert.equal(storage.CheckCurrentState(STORAGE_OVERLOAD_CURRENT), ELECTR_CURR_STATE.OVERLOAD);

            // SHORT: [1.4, Infinity)
            assert.equal(storage.CheckCurrentState(STORAGE_SHORT_THRESHOLD), ELECTR_CURR_STATE.SHORT);
            assert.equal(storage.CheckCurrentState(STORAGE_SHORT_CURRENT), ELECTR_CURR_STATE.SHORT);
        });

        it('CheckCurrentState() использует фильтрованное значение из _I_CurrBuffer, если аргумент не передан', () => {
            emuStorage.setCurrent(STORAGE_WORK_CURRENT, { pushToBuffer: true, samples: CURR_BUFFER_SIZE });
            assert.equal(storage.CheckCurrentState(), ELECTR_CURR_STATE.WORK_OK);

            storage._I_CurrBuffer.Clear();
            assert.equal(storage.CheckCurrentState(), undefined);
        });

        it('IsShorted() возвращает true при превышении тока КЗ (> 1.4A) или падении напряжения (<= MIN_VOLTAGE)', () => {
            // Нормальный рабочий режим
            emuStorage.setCurrent(STORAGE_WORK_CURRENT, { pushToBuffer: false });
            emuStorage.setVoltage(STORAGE_SUPPLY_VOLTAGE, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), false);

            // Ток на границе (1.4A) -> еще false, выше 1.4A -> true
            emuStorage.setCurrent(STORAGE_SHORT_THRESHOLD, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), false);

            emuStorage.setCurrent(STORAGE_SHORT_THRESHOLD + SHORT_DELTA, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), true);

            // Возвращаем ток в норму, но роняем напряжение до MIN_VOLTAGE (16V)
            emuStorage.setCurrent(STORAGE_IDLE_CURRENT, { pushToBuffer: false });
            emuStorage.setVoltage(MIN_OPERATING_VOLTAGE + SAFE_VOLTAGE_DELTA, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), false);

            emuStorage.setVoltage(MIN_OPERATING_VOLTAGE, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), true);

            emuStorage.setVoltage(MIN_OPERATING_VOLTAGE - DEEP_VOLTAGE_DROP, { pushToBuffer: false });
            assert.equal(storage.IsShorted(), true);
        });
    });

    // =========================================================================
    // 4. Пассивные обработчики, буферы, логгеры и валидация аргументов
    // =========================================================================
    describe('Пассивные обработчики, логгеры и валидация входных аргументов', () => {
        it('SetCurrentHandler и SetVoltageHandler накапливают значения в буферах _I_CurrBuffer и _V_VoltBuffer', () => {
            storage._I_CurrBuffer.Clear();
            storage._V_VoltBuffer.Clear();

            emuStorage.setCurrent(STORAGE_WORK_CURRENT, {
                pushToBuffer: true,
                samples: CURR_BUFFER_SIZE,
            });
            emuStorage.setVoltage(STORAGE_SUPPLY_VOLTAGE, {
                pushToBuffer: true,
                samples: VOLT_BUFFER_SIZE,
            });

            assert.equal(storage._I_CurrBuffer.Filter(), STORAGE_WORK_CURRENT);
            assert.equal(storage._V_VoltBuffer.Filter(), STORAGE_SUPPLY_VOLTAGE);
        });

        it('SetTamperHandlers игнорирует сигналы тамперов спиралей, когда опрос выключен (#_Polling === false)', () => {
            let dispensedEventFired = false;
            storage.Events.on('dispense', () => {
                dispensedEventFired = true;
            });

            // В состоянии IDLE (#_Polling === false) переключение тампера не должно вызывать OnDispensedSingle
            emuStorage.setRowTamper(0, false, { emit: true });
            emuStorage.setRowTamper(0, true, { emit: true });

            assert.equal(dispensedEventFired, false);
            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
        });

        it('Dispense() и RunMotor() синхронно отклоняют промис при невалидных координатах, quantity < 1 или duration <= 0 без запуска FSM', async () => {
            // Невалидный quantity (0 < 1)
            await assert.rejects(
                () => storage.Dispense({ row: 0, column: 0, quantity: 0 }),
                /\[Storage\] Невалидные параметры/
            );
            // Индекс за пределами матрицы (row 99)
            await assert.rejects(
                () => storage.Dispense({ row: 99, column: 0, quantity: 1 }),
                /\[Storage\] Невалидные параметры/
            );

            // Невалидный duration в RunMotor (0 мс)
            await assert.rejects(
                () => storage.RunMotor({ row: 0, column: 0, duration: 0 }),
                /\[Storage\] Невалидные параметры/
            );
            await assert.rejects(
                () => storage.RunMotor({ row: 99, column: 0, duration: 500 }),
                /\[Storage\] Невалидные параметры/
            );

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
        });
    });
});
