const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionStorage } = require('../../../js/srvSpiralSectionStorage');
const { FAULTS } = require('../../../js/SpiralSectionConstants');
const { SPIRAL_CELL_STATE } = require('../../../js/srvSpiralSectionStates');
const {
    createStorageChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { SpiralSection } = require('../../../../VMEmulator');

// --- Инженерные константы конфигурации матрицы ---
const ROWS = 4;
const COLS = 3;
const BUS_NUMBER = 1;
const TEST_DISPENSED_COUNT = 2;

describe('ClassSpiralSectionStorage — управление состояниями и флагами ячеек (States & Statuses)', () => {
    let stub;
    let emuStorage;
    let channels;
    let sectionState;
    let logs;
    let proxyLogger;
    let storage;
    let activeIntervals = [];

    const origSetInterval = global.setInterval;

    beforeEach(async () => {
        activeIntervals = [];
        global.setInterval = (...args) => {
            const id = origSetInterval(...args);
            activeIntervals.push(id);
            return id;
        };

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
        global.setInterval = origSetInterval;
        for (const id of activeIntervals) {
            clearInterval(id);
        }
        activeIntervals = [];
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Обновление контекста и статусов ячеек: UpdateStorageContext
    // =========================================================================
    describe('UpdateStorageContext() — обновление флагов и счетчиков ячеек матрицы', () => {
        it('UpdateStorageContext() обновляет счетчики itemsDispensed и статусы ячеек с учетом области scope', () => {
            const targetCellIndex = 4;
            // Одиночное обновление ячейки 4 (row 1, col 1)
            storage.UpdateStorageContext(
                { index: targetCellIndex },
                { dispensed: TEST_DISPENSED_COUNT, scope: 'single', faultCode: FAULTS.ERR_TAMPER }
            );

            assert.equal(storage.StateAdapter.IsCellOk(targetCellIndex), false);
            assert.equal(storage.StateAdapter.IsCellOk(3), true);
            assert.equal(storage.StateAdapter.IsCellOk(5), true);
            assert.equal(sectionState.Cells[targetCellIndex].Status, SPIRAL_CELL_STATE.ERR_TAMPER);
            assert.equal(sectionState.Cells[3].Status, SPIRAL_CELL_STATE.OK);
            assert.equal(sectionState.Cells[5].Status, SPIRAL_CELL_STATE.OK);

            const unit4 = [...storage.UnitsByScope(targetCellIndex, 'single')][0];
            assert.equal(unit4.itemsDispensed, TEST_DISPENSED_COUNT);
        });

        it('UpdateStorageContext() с параметром except не перезаписывает защищенные статусы в ряду', () => {
            // В ряду 1 (индексы 3, 4, 5) ячейка 3 уже имеет статус ACTUATOR_SHORT_CIRCUIT
            storage.UpdateStorageContext(
                { index: 3 },
                { scope: 'single', faultCode: FAULTS.ACTUATOR_SHORT_CIRCUIT }
            );

            // Обновляем весь ряд 1 через базовую ячейку 4 с ошибкой драйвера
            storage.UpdateStorageContext(
                { index: 4 },
                {
                    scope: 'row',
                    faultCode: FAULTS.IO_DRIVER_ERR,
                }
            );

            assert.equal(sectionState.Cells[4].Status, SPIRAL_CELL_STATE.BLOCKED);
            assert.equal(sectionState.Cells[5].Status, SPIRAL_CELL_STATE.BLOCKED);
            // Защищенный статус КЗ не перезаписался на BLOCKED
            assert.equal(sectionState.Cells[3].Status, SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT);
        });

        it('ClearOverloadStatus() сбрасывает все ячейки со статусом OVERLOAD_I обратно в OK, не трогая другие ошибки', () => {
            storage.StateAdapter.SetCellOverload(1);
            storage.StateAdapter.SetCellOverload(5);
            storage.StateAdapter.SetCellFault(8, FAULTS.ERR_TAMPER);

            storage.ClearOverloadStatus();

            assert.equal(storage.StateAdapter.IsCellOk(1), true);
            assert.equal(storage.StateAdapter.IsCellOk(5), true);
            assert.equal(storage.StateAdapter.IsCellOk(8), false);
            assert.equal(sectionState.Cells[1].Status, SPIRAL_CELL_STATE.OK);
            assert.equal(sectionState.Cells[5].Status, SPIRAL_CELL_STATE.OK);
            assert.equal(sectionState.Cells[8].Status, SPIRAL_CELL_STATE.ERR_TAMPER);
        });
    });

    // =========================================================================
    // 2. Доступность ячеек и линий матричной коммутации: IsAvailable, IsCheckable
    // =========================================================================
    describe('IsAvailable() и IsCheckable() — валидация готовности ячеек к операциям', () => {
        it('IsAvailable() возвращает true только для статусов OK, ERR_TAMPER и ACTUATOR_NO_POWER', () => {
            const cell = { row: 1, column: 2 };
            const ind = storage.PosToInd(cell);

            storage.StateAdapter.SetCellReady(ind);
            assert.equal(storage.IsAvailable(cell), true);

            storage.StateAdapter.SetCellFault(ind, FAULTS.ERR_TAMPER);
            assert.equal(storage.IsAvailable(cell), true);

            storage.StateAdapter.SetCellFault(ind, FAULTS.ACTUATOR_NO_POWER);
            assert.equal(storage.IsAvailable(cell), true);

            storage.StateAdapter.SetCellFault(ind, FAULTS.IO_DRIVER_ERR);
            assert.equal(storage.IsAvailable(cell), false);

            storage.StateAdapter.SetCellOverload(ind);
            assert.equal(storage.IsAvailable(cell), false);
        });

        it('IsCheckable() проверяет допустимость статуса ячейки и блокирует весь ряд, если хотя бы у одной ячейки ряда статус ACTUATOR_SHORT_CIRCUIT', () => {
            const cellA = { row: 2, column: 0 };
            const cellB = { row: 2, column: 1 };
            const indA = storage.PosToInd(cellA);

            // Исходно все ячейки исправны
            assert.equal(storage.IsCheckable(cellA), true);
            assert.equal(storage.IsCheckable(cellB), true);

            // Навешиваем КЗ на ячейку cellA
            storage.StateAdapter.SetCellFault(indA, FAULTS.ACTUATOR_SHORT_CIRCUIT);

            // Теперь ни одна ячейка 2-го ряда не checkable
            assert.equal(storage.IsCheckable(cellA), false);
            assert.equal(storage.IsCheckable(cellB), false);

            // При этом ячейки на другом ряду (row 0) остаются доступными
            assert.equal(storage.IsCheckable({ row: 0, column: 0 }), true);
        });
    });

    // =========================================================================
    // 3. Обработка аварий и переходов автомата: UpdateStatus, OnStateChanged
    // =========================================================================
    describe('UpdateStatus() и OnStateChanged() — фиксация состояний хранилища', () => {
        it('UpdateStatus() безопасно игнорирует объекты ошибок, не являющиеся экземплярами внутреннего класса StorageFault', () => {
            storage.UpdateStatus(new Error('Generic error'));
            storage.UpdateStatus({ code: FAULTS.ERR_TAMPER, index: 0 });

            // Ни одна ячейка не должна изменить статус OK
            const allOk = [0, 1, 2, 3, 4, 5, 6, 7, 8].every((i) => storage.StateAdapter.IsCellOk(i));
            assert.equal(allOk, true);
        });

        it('OnStateChanged() форматирует и передает запись о смене состояния автомата в ProxyLogger', () => {
            logs.length = 0;

            storage.OnStateChanged({
                prevState: ClassSpiralSectionStorage.STATE.IDLE,
                eventName: storage.EVENTS.TEST_COMMAND,
                state: ClassSpiralSectionStorage.STATE.TESTING,
            });

            assert.equal(logs.length, 1);
            assert.equal(logs[0].msg, '[STORAGE] STATE: IDLE --[TEST_COMMAND]--> TESTING');
        });
    });
});
