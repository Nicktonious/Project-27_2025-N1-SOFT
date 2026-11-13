'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ClassVendingSectionFacade = require('../../js/srvVendingSectionFacade').default;
const {
    createSpiralMachineConfig,
    createInitialChannelsState,
    createMockStatesController,
} = require('../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../tests/helpers/ProxyChannelStub');
const { AVAILABLE_STATE, SECTION_STATUS } = require('../../../srvStatesController/ts/IBaseSectionStates');

const INIT_SETTLE_MS = 80;

describe('ClassVendingSectionFacade — Тестирование бизнес-логики и интеграции с StatesController.Config', () => {
    let stub;
    let config;
    let statesController;
    let sectionState;
    let busState;
    let facade;
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

        busState = {
            Voltage: 'OK',
            Current: 'OK',
            PSU: 'OK',
        };

        statesController = createMockStatesController({
            sectionId: '1',
            config,
            busState,
        });
        sectionState = statesController.Machine.States.Sections[0];

        logs = [];
        logger = {
            Log: (entry) => logs.push(entry),
        };

        facade = new ClassVendingSectionFacade({
            sectionId: '1',
            ProxyCh: stub,
            StatesController: statesController,
            ProxyLogger: logger,
        });

        section = facade.Section;

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
        facade.Reset();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Инициализация через StatesController.Config
    // =========================================================================
    describe('Инициализация через StatesController.Config', () => {
        it('корректно инициализирует фасад, связывает StatesController.Config, sectionState и busState', () => {
            assert.ok(facade);
            assert.ok(section);
            assert.equal(facade.ID, '1');
            assert.equal(facade.StateAdapter.IsSectionBlocked, false);
            assert.equal(facade.StateAdapter.IsSectionAvailable, true);
            assert.equal(facade.StateAdapter.IsBusOk(), true);
            assert.equal(sectionState.Status, SECTION_STATUS.IDLE);
            assert.equal(sectionState.IsAvailable, AVAILABLE_STATE.YES);
            assert.ok(facade.MonitoringAdapter, 'MonitoringAdapter должен быть инициализирован');
        });

        it('динамически реагирует на изменение состояния шины питания в StatesController', () => {
            assert.equal(facade.StateAdapter.IsBusOk(), true);
            assert.equal(facade.StateAdapter.IsSectionAvailable, true);

            // Симулируем аварию по напряжению на шине питания
            busState.Voltage = 'FAULT';

            assert.equal(facade.StateAdapter.IsBusOk(), false);
            assert.equal(facade.StateAdapter.IsSectionAvailable, false);

            // Восстановление нормального состояния
            busState.Voltage = 'OK';
            assert.equal(facade.StateAdapter.IsBusOk(), true);
            assert.equal(facade.StateAdapter.IsSectionAvailable, true);
        });

        it('выбрасывает ошибку, если секция с указанным sectionId не найдена в Config', () => {
            assert.throws(() => {
                new ClassVendingSectionFacade({
                    sectionId: '999',
                    ProxyCh: stub,
                    StatesController: statesController,
                    ProxyLogger: logger,
                });
            }, /Секция с ID "999" не найдена в конфигурации/);
        });
    });

    // =========================================================================
    // 2. Диспетчеризация команд (PerformTransaction)
    // =========================================================================
    describe('Диспетчеризация команд (PerformTransaction)', () => {
        it('SetLiftLevel выполняет команду лифта и возвращает ответ OK с метаданными', async () => {
            const responses = [];
            facade.Events.on('response', (msg) => responses.push(msg));

            const transaction = {
                Command: 'SetLiftLevel',
                ID: 'tx-lift-level-0',
                Level: 0,
            };

            await facade.PerformTransaction(transaction);

            assert.equal(responses.length, 1);
            const resp = responses[0].Response;
            assert.equal(resp.Result, 'OK');
            assert.equal(resp.ParentID, 'tx-lift-level-0');
            assert.equal(resp.Target, '1');
            assert.ok(typeof resp.ID === 'string' && resp.ID.length > 0);
            assert.ok(typeof resp.Timestamp === 'number');
        });

        it('RotateSpiral вызывает ManualRotateSpiral и возвращает успешный ответ с координатами ячейки', async () => {
            const responses = [];
            facade.Events.on('response', (msg) => responses.push(msg));

            let rotateArgs = null;
            section.ManualRotateSpiral = async (args) => {
                rotateArgs = args;
                return { success: true };
            };

            const transaction = {
                Command: 'RotateSpiral',
                ID: 'tx-rotate-1',
                Cells: [{ row: 1, column: 2, quantity: 1 }],
            };

            await facade.PerformTransaction(transaction);

            assert.equal(responses.length, 1);
            const resp = responses[0].Response;
            assert.equal(resp.Result, 'OK');
            assert.equal(resp.ParentID, 'tx-rotate-1');
            assert.deepEqual(resp.Cell, { row: 1, column: 2 });
            assert.deepEqual(rotateArgs, { row: 1, column: 2, quantity: 1 });
        });

        it('OpenDeliveryBox вызывает OpenBox и возвращает ответ OK', async () => {
            const responses = [];
            facade.Events.on('response', (msg) => responses.push(msg));

            let openCalled = false;
            section.OpenBox = async () => {
                openCalled = true;
                return true;
            };

            const transaction = {
                Command: 'OpenDeliveryBox',
                ID: 'tx-box-open',
            };

            await facade.PerformTransaction(transaction);

            assert.equal(responses.length, 1);
            assert.equal(responses[0].Response.Result, 'OK');
            assert.equal(responses[0].Response.ParentID, 'tx-box-open');
            assert.equal(openCalled, true);
        });

        it('формирует ответ с Result: FAIL при ошибке в обработчике команды', async () => {
            const responses = [];
            facade.Events.on('response', (msg) => responses.push(msg));

            const origElevate = section.ElevateLift.bind(section);
            section.ElevateLift = async () => {
                throw new Error('Сбой привода лифта');
            };

            const transaction = {
                Command: 'SetLiftLevel',
                ID: 'tx-fail-check',
                Level: 2,
            };

            await facade.PerformTransaction(transaction);

            assert.equal(responses.length, 1);
            const resp = responses[0].Response;
            assert.equal(resp.Result, 'FAIL');
            assert.equal(resp.ParentID, 'tx-fail-check');

            section.ElevateLift = origElevate;
        });

        it('Invoke делегирует служебные вызовы в Section.Invoke', () => {
            let invokeArgs = null;
            section.Invoke = (...args) => {
                invokeArgs = args;
                return 'invoke-result';
            };

            const result = facade.Invoke('Rotate', { row: 0, column: 0, duration: 200 });
            assert.equal(result, 'invoke-result');
            assert.deepEqual(invokeArgs, ['Rotate', { row: 0, column: 0, duration: 200 }]);
        });
    });

    // =========================================================================
    // 3. Контроль занятости, контекст и Reset
    // =========================================================================
    describe('Контроль занятости, контекст и Reset', () => {
        it('блокирует параллельный запуск транзакций с сообщением об ошибке занятости', async () => {
            let slowResolve;
            const slowPromise = new Promise((res) => {
                slowResolve = res;
            });

            const origElevate = section.ElevateLift.bind(section);
            section.ElevateLift = async () => {
                await slowPromise;
            };

            const tx1 = { Command: 'SetLiftLevel', ID: 'tx-slow-1', Level: 0 };
            const tx2 = { Command: 'SetLiftLevel', ID: 'tx-slow-2', Level: 0 };

            const p1 = facade.PerformTransaction(tx1);
            await facade.PerformTransaction(tx2);

            // TODO: переход на типизированные коды ошибок / кастомные исключения вместо строковых логов
            assert.equal(facade._Context.order?.ID, tx1.ID, 'Второй заказ не должен прерывать текущий активный заказ');
            assert.ok(logs.some((l) => l.level === 'E'), 'В логгере должна быть зафиксирована ошибка уровня E');

            slowResolve();
            await p1;

            section.ElevateLift = origElevate;
        });

        it('устанавливает TransactionID в логгере на время транзакции и очищает заказ по завершении', async () => {
            let txIdDuringWork = null;

            const origElevate = section.ElevateLift.bind(section);
            section.ElevateLift = async () => {
                txIdDuringWork = logger.TransactionID;
            };

            const transaction = {
                Command: 'SetLiftLevel',
                ID: 'tx-uuid-456',
                Level: 0,
            };

            await facade.PerformTransaction(transaction);

            assert.equal(txIdDuringWork, 'tx-uuid-456');
            assert.equal(facade._Context.order, null);

            section.ElevateLift = origElevate;
        });

        it('Reset() сбрасывает контекст заказа и восстанавливает доступность секции', () => {
            facade._Context.order = { ID: 'aborted-order', Cells: [] };
            facade.StateAdapter.SetSectionBlocked();

            facade.Reset();

            assert.equal(facade._Context.order, null);
            assert.equal(facade.StateAdapter.IsSectionBlocked, false);
            assert.equal(facade.StateAdapter.IsSectionAvailable, true);
            assert.equal(sectionState.Status, SECTION_STATUS.IDLE);
            assert.equal(sectionState.IsAvailable, AVAILABLE_STATE.YES);
        });
    });
});
