'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSection } = require('../../js/srvSpiralSection');
const { SpiralSectionState } = require('../../js/srvSpiralSectionStates');
const { BOX_CONSTANTS, STORAGE_CONSTANSTS } = require('../../js/SpiralSectionConstants');
const { ProxyChannelStub } = require('../../../../tests/helpers/ProxyChannelStub');
const {
    createSpiralMachineConfig,
    createInitialChannelsState,
} = require('../helpers/spiralSection.helper');

const INIT_SETTLE_MS = 80;

describe('ClassSpiralSection — Комплексное взаимодействие подсистем (Lift, Storage, Box) и алгоритмы безопасности', () => {
    let stub;
    let config;
    let sectionState;
    let section;
    let logs;
    let logger;
    let activeIntervals = [];

    const origSetInterval = global.setInterval;

    beforeEach(async () => {
        activeIntervals = [];
        global.setInterval = (...args) => {
            const id = origSetInterval(...args);
            activeIntervals.push(id);
            return id;
        };

        stub = new ProxyChannelStub();
        config = createSpiralMachineConfig({ id: '1', rows: 4, cols: 4, powerBus: 'BUS-1' });

        stub.seed(createInitialChannelsState(config));

        sectionState = new SpiralSectionState({
            Name: 'Machine-1-spiral',
            Type: 'SPIRAL',
            Rows: 4,
            Cols: 4,
            IOList: [],
        });
        sectionState.ID = '1';

        logs = [];
        logger = {
            Log: (entry) => logs.push(entry),
        };

        const secConf = config.Sections[0];
        const ch = secConf.Channels;
        const powerCh = ch.Power;

        const channels = {
            door: ch.Door.Sensor,
            boxChannels: {
                lock: ch.DeliveryBox.Lock,
                optic: ch.DeliveryBox.Optic,
            },
            storageChannels: {
                matrixCtrlChannel: ch.Storage.MatrixCtrl,
                spiralTamperChannels: ch.Storage.Tamper,
                current: powerCh.Current,
                voltage: powerCh.Voltage,
                short: powerCh.Short,
                psuWork: powerCh.PsuWork,
            },
            liftChannels: {
                liftMotorCtrl: ch.Lift.MotorCtrl,
                liftMotorCtrl2: ch.Lift.MotorCtrl2,
                liftLevelSensor: ch.Lift.LevelSensor,
                liftBottomTamper: ch.Lift.BottomTamper,
                liftTopTamper: ch.Lift.TopTamper,
                current: powerCh.Current,
                voltage: powerCh.Voltage,
                short: powerCh.Short,
                psuWork: powerCh.PsuWork,
            },
        };

        const advOpts = {
            storageOpts: {
                busNumber: secConf.PowerBus,
                size: { rows: secConf.Rows, cols: secConf.Cols },
                globalState: null,
            },
            liftOpts: {
                busNumber: secConf.PowerBus,
                maxLevel: secConf.Rows,
            },
        };

        section = new ClassSpiralSection({
            ProxyCh: stub,
            channels,
            advOpts,
            sectionState,
            ProxyLogger: logger,
        });

        // Ожидание завершения начального Stop() лифта
        await new Promise((r) => setTimeout(r, INIT_SETTLE_MS));
        stub.clearHistory();
        logs.length = 0;
    });

    afterEach(() => {
        global.setInterval = origSetInterval;
        for (const id of activeIntervals) {
            clearInterval(id);
        }
        activeIntervals = [];
        section.Reset();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Алгоритмы безопасности (Door и DeliveryBox)
    // =========================================================================
    describe('Безопасность: реакция на сервисные датчики двери и люка', () => {
        it('открытие сервисной двери во время операции вызывает Abort() у Lift и Storage', () => {
            let liftAborted = false;
            let storageAborted = false;

            section.Lift.Abort = () => { liftAborted = true; };
            section.Storage.Abort = () => { storageAborted = true; };

            // Симулируем активную задачу
            section._Context.currentTask = { res: () => {}, rej: () => {} };

            // Размыкание концевика сервисной двери (0 = дверь открыта)
            stub.inject('door-channel', 0);

            assert.equal(section.IsDoorClosed(), false);
            assert.equal(section.StateAdapter.IsDoorClosed, false);
            assert.equal(section._Context.aborted, true);
            assert.equal(liftAborted, true, 'Lift.Abort() должен быть вызван');
            assert.equal(storageAborted, true, 'Storage.Abort() должен быть вызван');
        });

        it('открытие створки люка выдачи (DOOR_OPENED) вызывает Abort() у секции', () => {
            let abortCalled = false;
            const origAbort = section.Abort.bind(section);
            section.Abort = () => {
                abortCalled = true;
                origAbort();
            };

            section._Context.currentTask = { res: () => {}, rej: () => {} };

            // Эмитим открытие отсека выдачи
            section.Box.emit(section.Box.constructor.EVENTS.OPENED);

            assert.equal(abortCalled, true);
            assert.equal(section._Context.aborted, true);
        });

        it('отклоняет запуск транзакции при открытой двери секции', async () => {
            stub.inject('door-channel', 0); // дверь открыта

            const orders = [{ row: 1, column: 1, quantity: 1 }];
            const results = [];
            section.on('result', (r) => results.push(r));

            await section.Execute(orders);

            // TODO: переход на типизированные коды ошибок / кастомные исключения вместо строковых логов
            assert.equal(results.length, 1);
            assert.equal(results[0].ok, false);
        });
    });

    // =========================================================================
    // 2. Алгоритм комплексной выдачи и обработка ошибок ячеек
    // =========================================================================
    describe('Комплексная транзакция выдачи: взаимодействие Lift + Storage + Box', () => {
        it('пропускает ячейку и не вызывает Dispense, если ее статус аварийный (!IsCheckable)', async () => {
            // Помечаем ячейку (row: 1, col: 0) как перегруженную/аварийную (OVERLOAD_I)
            const unitIndex = section.Storage.PosToInd({ row: 1, col: 0 });
            section.StateAdapter.SetCellOverload(unitIndex);

            let dispenseCalled = false;
            section.Storage.Dispense = async () => {
                dispenseCalled = true;
            };

            // Мокаем перемещение лифта и тестирование
            section.Lift.ElevateToBottom = async () => {};
            section.Lift.ElevateToLevel = async () => {};
            section.Storage.TestSpiral = async () => {};

            const orders = [{ row: 1, column: 0, quantity: 1 }];
            const results = [];
            section.on('result', (r) => results.push(r));

            await section.Execute(orders);

            assert.equal(dispenseCalled, false, 'Dispense не должен вызываться для аварийной ячейки');
            assert.equal(results.length, 1);
            assert.equal(results[0].ok, false);
        });

        it('не открывает люк выдачи (Box.Deliver), если ни один товар не был собран из Storage', async () => {
            let deliverCalled = false;
            section.Box.Deliver = async () => {
                deliverCalled = true;
            };

            section.Lift.ElevateToBottom = async () => {};
            section.Lift.ElevateToLevel = async () => {};
            section.Storage.TestSpiral = async () => {};

            // Симулируем неудачную выдачу (ошибка мотора при Dispense)
            section.Storage.Dispense = async () => {
                throw new Error('Механический заклинивание спирали');
            };

            const orders = [{ row: 0, column: 1, quantity: 1 }];
            const results = [];
            section.on('result', (r) => results.push(r));

            await section.Execute(orders);

            assert.equal(deliverCalled, false, 'Box.Deliver не должен вызываться при отсутствии собранных товаров');
            assert.equal(results.length, 1);
            assert.equal(results[0].ok, false);
        });

        it('при успешном сборе товара опускает лифт на 0-й уровень и открывает люк выдачи (Deliver)', async () => {
            let deliverCalled = false;
            section.Box.Deliver = async () => {
                deliverCalled = true;
            };

            let currentLevel = 2;
            Object.defineProperty(section.Lift, 'Level', {
                get: () => currentLevel,
                configurable: true,
            });

            let liftElevatedToZero = false;
            section.Lift.ElevateToBottom = async () => {
                liftElevatedToZero = true;
                currentLevel = 0;
            };
            section.Lift.ElevateToLevel = async (lvl) => {
                currentLevel = lvl;
            };
            section.Storage.TestSpiral = async () => {};

            // Симулируем успешную выдачу товара через эмит события 'dispense'
            section.Storage.Dispense = async (order) => {
                section.Storage.emit('dispense', { row: order.row, column: order.column, quantity: 1 });
            };

            const orders = [{ row: 1, column: 1, quantity: 1 }];
            const results = [];
            section.on('result', (r) => results.push(r));

            await section.Execute(orders);

            assert.equal(liftElevatedToZero, true, 'Лифт должен опуститься на уровень 0 перед выдачей');
            assert.equal(deliverCalled, true, 'Люк выдачи Box.Deliver() должен быть открыт');
            assert.equal(results.length, 1);
            assert.equal(results[0].ok, true);
        });
    });
});
