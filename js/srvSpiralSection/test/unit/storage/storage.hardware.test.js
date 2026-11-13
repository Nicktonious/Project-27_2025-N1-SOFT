const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionStorage } = require('../../../js/srvSpiralSectionStorage');
const { STORAGE_CONSTANSTS, COMMON_CONSTANTS, FAULTS } = require('../../../js/SpiralSectionConstants');
const { SPIRAL_CELL_STATE } = require('../../../js/srvSpiralSectionStates');
const { CELL_ACTION } = require('../../../../srvStatesController/ts/ISpiralSectionStates');
const {
    createStorageChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { SpiralSection } = require('../../../../VMEmulator');

// --- Параметры аппаратного протокола коммутации матрицы ---
const TIME_BETWEEN_STEPS_MS = 300;
const MOTOR_STEP_GND = 1;
const MOTOR_STEP_VPLUS = 2;

// --- Константы тестовой конфигурации матрицы и таймингов ---
const ROWS = 4;
const COLS = 3;
const BUS_NUMBER = 1;

const BG_MOTOR_OFF_SETTLE_MS = TIME_BETWEEN_STEPS_MS + 20; // 320 мс — ожидание завершения MotorOff в afterEach
const MANUAL_FIRST_PULSE_DELAY_MS = TIME_BETWEEN_STEPS_MS + 40; // 340 мс — сразу после выхода из MotorOnPhased
const POST_DEBOUNCE_WAIT_MS = STORAGE_CONSTANSTS.TAMPER_DEBOUNCE + 20; // 520 мс — гарантированно после TAMPER_DEBOUNCE (500 мс)

const BETWEEN_PULSES_MS = 40;
const ABORT_BETWEEN_PULSES_MS = 60;
const TAMPER_PULSE_WIDTH_MS = 10;

describe('ClassSpiralSectionStorage — управление актуаторами матрицы, проверка стартового положения и выдача оборотами (Hardware)', () => {
    let stub;
    let emu;
    let channels;
    let sectionState;
    let logs;
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
        emu = new SpiralSection({ proxy: stub, channels, size: { rows: ROWS, cols: COLS } });
        emu.seedDefaultHardware();
        emu.attachMatrixBehavior();

        sectionState = createMockSectionState({ rows: ROWS, cols: COLS });

        logs = [];
        storage = new ClassSpiralSectionStorage({
            ProxyCh: stub,
            channels,
            advOpts: {
                busNumber: BUS_NUMBER,
                size: { rows: ROWS, cols: COLS },
                globalState: null,
            },
            sectionState,
            ProxyLogger: { Log: (entry) => logs.push(entry) },
        });

        // Дожидаемся завершения стартового MotorOffAll() в конструкторе Init()
        await new Promise((r) => setImmediate(r));
        stub.clearHistory();
        logs.length = 0;
    });

    afterEach(async () => {
        // Дожидаемся завершения фонового MotorOff(unitIndex) из OnFault()
        await new Promise((r) => setTimeout(r, BG_MOTOR_OFF_SETTLE_MS));
        storage.Reset();
        await new Promise((r) => setImmediate(r));
        global.setInterval = origSetInterval;
        for (const id of activeIntervals) {
            clearInterval(id);
        }
        activeIntervals = [];
        emu.cleanup();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Базовые аппаратные команды: OffPSU, OnPSU, MotorStep, MotorOffAll
    // =========================================================================
    describe('Низкоуровневые команды актуаторов: OffPSU(), OnPSU(), MotorStep(), MotorOffAll()', () => {
        it('OffPSU() записывает 0 в канал psuWork, а OnPSU() записывает 1', () => {
            storage.OffPSU();
            assert.equal(stub.getLastSentValue(channels.psuWork), 0);

            storage.OnPSU();
            assert.equal(stub.getLastSentValue(channels.psuWork), 1);
            assert.deepEqual(stub.getSentValues(channels.psuWork), [0, 1]);
        });

        it('MotorStep() отправляет команду в matrixCtrlChannel и разрешается при получении подтверждения от драйвера', async () => {
            const testCellIndex = 5;
            await storage.MotorStep('On', { index: testCellIndex, step: MOTOR_STEP_GND });

            assert.deepEqual(stub.getLastSentValue(channels.matrixCtrlChannel), {
                target: testCellIndex,
                cmd: 'On',
                args: [{ step: MOTOR_STEP_GND }],
            });
        });

        it('MotorOffAll() отправляет команду отключения всех линий матрицы { target: undefined, cmd: "Off", args: [{ step: undefined }] }', async () => {
            await storage.MotorOffAll();

            assert.deepEqual(stub.getLastSentValue(channels.matrixCtrlChannel), {
                target: undefined,
                cmd: 'Off',
                args: [{ step: undefined }],
            });
        });

        it('MotorStep() выбрасывает StorageFault с кодом FAULTS.IO_DRIVER_ERR, если драйвер вернул поле error', async () => {
            const testCellIndex = 2;
            emu.attachMatrixBehavior({ driverError: 'Modbus CRC error' });

            await assert.rejects(
                () => storage.MotorStep('On', { index: testCellIndex, step: MOTOR_STEP_GND }),
                (fault) => fault.code === FAULTS.IO_DRIVER_ERR && fault.index === testCellIndex
            );
        });

        it('MotorStep() выбрасывает StorageFault с кодом FAULTS.IO_TIMEOUT, если драйвер не ответил за MOTOR_RES_MAX_TIME (1000 мс)', async () => {
            const testCellIndex = 3;
            emu.attachMatrixBehavior({ silentAck: true });

            await assert.rejects(
                () => storage.MotorStep('On', { index: testCellIndex, step: MOTOR_STEP_GND }),
                (fault) => fault.code === FAULTS.IO_TIMEOUT && fault.index === testCellIndex
            );
        });
    });

    // =========================================================================
    // 2. Поэтапное включение и выключение мотора: MotorOnPhased(index) и MotorOff(index)
    // =========================================================================
    describe('Двухшаговая коммутация мотора ячейки: MotorOnPhased(index) и MotorOff(index)', () => {
        it('MotorOnPhased() в ручном режиме выполняет Step 1 (GND), проверяет отсутствие пробоя и КЗ, затем выполняет Step 2 (V+) и проверяет появление рабочего тока', async () => {
            emu.attachMatrixBehavior({
                step1Current: emu.CURR.idle,
                step2Current: emu.CURR.workOk,
            });

            await storage.RunMotor({
                row: 1,
                column: 2,
                duration: 50,
            });

            const sent = stub.getSentValues(channels.matrixCtrlChannel);
            const targetInd = storage.PosToInd({ row: 1, col: 2 }); // index = 5
            assert.deepEqual(sent, [
                { target: targetInd, cmd: 'On', args: [{ step: MOTOR_STEP_GND }] },
                { target: targetInd, cmd: 'On', args: [{ step: MOTOR_STEP_VPLUS }] },
                { target: targetInd, cmd: 'Off', args: [{ step: MOTOR_STEP_GND }] },
                { target: targetInd, cmd: 'Off', args: [{ step: MOTOR_STEP_VPLUS }] },
            ]);
        });

        it('MotorOnPhased() успешно включается при кратковременном пусковом броске тока на Step 2 (V+), спадающем до рабочего значения к концу фазирования', async () => {
            // При подаче Step 2 (V+) моделируем пусковой бросок (1.6A - КЗ), который через 80 мс спадает до нормального рабочего тока (0.20A)
            stub.onSet(channels.matrixCtrlChannel, (payload) => {
                if (payload.cmd === 'On' && payload.args?.[0]?.step === MOTOR_STEP_VPLUS) {
                    emu.pulseCurrent(emu.CURR.short, 80, emu.CURR.workOk);
                }
            });

            await storage.RunMotor({
                row: 1,
                column: 2,
                duration: 50,
            });

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            assert.equal(storage.StateAdapter.IsCellOk(5), true);
        });

        it('MotorOff() выполняет двухшаговое отключение (step 1 GND -> контроль падения тока -> step 2 V+)', async () => {
            const testCellIndex = 4;
            emu.setCurrent(emu.CURR.workOk);
            emu.attachMatrixBehavior({ offStep1Current: emu.CURR.idle });

            await storage.MotorOff(testCellIndex);

            assert.deepEqual(stub.getSentValues(channels.matrixCtrlChannel), [
                { target: testCellIndex, cmd: 'Off', args: [{ step: MOTOR_STEP_GND }] },
                { target: testCellIndex, cmd: 'Off', args: [{ step: MOTOR_STEP_VPLUS }] },
            ]);
        });

        it('MotorOff() выбрасывает FAULTS.ACTUATOR_SHORT_CIRCUIT (пробой ключа), если после отключения GND (step 1) рабочий ток не упал', async () => {
            const testCellIndex = 4;
            emu.setCurrent(emu.CURR.workOk);
            // После step 1 ток остается равным рабочему (ключ пробит)
            emu.attachMatrixBehavior({ offStep1Current: emu.CURR.workOk });

            await assert.rejects(
                () => storage.MotorOff(testCellIndex),
                (fault) => fault.code === FAULTS.ACTUATOR_SHORT_CIRCUIT && fault.index === testCellIndex
            );

            // Шаг 2 не должен был выполниться после выброса исключения
            assert.deepEqual(stub.getSentValues(channels.matrixCtrlChannel), [
                { target: testCellIndex, cmd: 'Off', args: [{ step: MOTOR_STEP_GND }] },
            ]);
        });
    });

    // =========================================================================
    // 3. Проверка корректного стартового положения спирали: TestSpiral({ row, column })
    // =========================================================================
    describe('Проверка исправности цепи и начального положения спирали: TestSpiral({ row, column })', () => {
        it('успешно завершает TestSpiral(), когда на Step 1 нет КЗ, ток не изменился, а тампер ряда находится в положении TAMPER_ON', async () => {
            const order = { row: 2, column: 1 };
            const targetInd = storage.PosToInd(order);

            emu.setRowTamper(order.row, true);
            emu.attachMatrixBehavior({ step1Current: emu.CURR.idle });

            await storage.TestSpiral(order);

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            assert.equal(storage.StateAdapter.IsCellOk(targetInd), true);

            const sent = stub.getSentValues(channels.matrixCtrlChannel);
            assert.deepEqual(sent[0], {
                target: targetInd,
                cmd: 'On',
                args: [{ step: MOTOR_STEP_GND }],
            });
            // Никакого включения V+ (cmd: 'On', step: 2) во время TestSpiral происходить не должно!
            assert.equal(
                sent.some((cmd) => cmd.cmd === 'On' && cmd.args?.[0]?.step === MOTOR_STEP_VPLUS),
                false
            );
        });

        it('выбрасывает FAULTS.TAMPER_BAD_POS и прерывает проверку ряда, если перед началом работы тампер ряда разомкнут (TAMPER_OFF)', async () => {
            const order = { row: 1, column: 0 };
            const expectedInd = storage.PosToInd(order);
            emu.setRowTamper(order.row, false); // Некорректное начальное положение спирали в ряду 1

            const failEvents = [];
            storage.Events.on('fail', (cell, fault) => failEvents.push({ cell, fault }));

            await assert.rejects(
                () => storage.TestSpiral(order),
                (fault) => fault.code === FAULTS.TAMPER_BAD_POS && fault.index === expectedInd
            );

            assert.equal(failEvents.length, 1);
            assert.deepEqual(failEvents[0].cell, order);
            assert.equal(failEvents[0].fault.code, FAULTS.TAMPER_BAD_POS);
        });

        it('блокирует всю матрицу с ошибкой FAULTS.IO_PORT_ERR при обнаружении пробоя ключа (скачок тока на Step 1)', async () => {
            const order = { row: 0, column: 1 };
            const expectedInd = storage.PosToInd(order);
            // На первом шаге (только GND) ток уже скакнул до рабочего из-за пробоя верхнего ключа
            emu.attachMatrixBehavior({ step1Current: emu.CURR.workOk });

            await assert.rejects(
                () => storage.TestSpiral(order),
                (fault) => fault.code === FAULTS.IO_PORT_ERR && fault.index === expectedInd
            );

            // При IO_PORT_ERR все ячейки секции переводятся в BLOCKED (scope: 'all')
            const allBlocked = Array.from({ length: ROWS * COLS }, (_, i) => sectionState.Cells[i].Status === SPIRAL_CELL_STATE.BLOCKED).every(Boolean);
            assert.equal(allBlocked, true);
            const allUnavailable = Array.from({ length: ROWS * COLS }, (_, i) => !storage.StateAdapter.IsCellAvailable(i)).every(Boolean);
            assert.equal(allUnavailable, true);
        });
    });

    // =========================================================================
    // 4. Выдача товара вращением спирали указанное кол-во раз: Dispense(order, manual)
    // =========================================================================
    describe('Вращение спирали на заданное количество оборотов: Dispense({ row, column, quantity })', () => {
        it('выполняет выдачу 1 ед. ТМЦ: фазно включает мотор, ждет импульс тампера после TAMPER_DEBOUNCE, эмитит событие "dispense" и выключает мотор', async () => {
            const order = { row: 2, column: 1, quantity: 1 };
            const targetInd = storage.PosToInd(order); // index = 7

            const dispensedEvents = [];
            let dispenseDoneEvent = null;
            storage.Events.on('dispense', (payload) => dispensedEvents.push(payload));
            storage.on(ClassSpiralSectionStorage.EVENTS.DISPENSE_DONE, (payload) => dispenseDoneEvent = payload);

            emu.simulateRotations({
                cols: COLS,
                rotationsCount: 1,
            });

            await storage.Dispense(order);

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            assert.deepEqual(dispensedEvents, [order]);
            assert.deepEqual(dispenseDoneEvent, {
                cell: targetInd,
                rots: 1,
                coords: { row: order.row, col: order.column }
            });
            assert.equal(sectionState.Cells[targetInd].Action, CELL_ACTION.ACTION);
        });

        it('выполняет выдачу нескольких единиц ТМЦ подряд (quantity = 3), отсчитывая ровно 3 срабатывания тампера перед выключением мотора', async () => {
            const order = { row: 0, column: 2, quantity: 3 };
            const targetInd = storage.PosToInd(order); // index = 2

            const dispensedEvents = [];
            let dispenseDoneEvent = null;
            storage.Events.on('dispense', (payload) => dispensedEvents.push(payload));
            storage.on(ClassSpiralSectionStorage.EVENTS.DISPENSE_DONE, (payload) => dispenseDoneEvent = payload);

            emu.simulateRotations({
                cols: COLS,
                rotationsCount: 3,
                betweenPulsesMs: BETWEEN_PULSES_MS,
            });

            await storage.Dispense(order);

            assert.equal(dispensedEvents.length, 3);
            assert.deepEqual(dispenseDoneEvent, {
                cell: targetInd,
                rots: 3,
                coords: { row: order.row, col: order.column }
            });

            const unit = [...storage.UnitsByScope(targetInd, 'single')][0];
            assert.equal(unit.itemsDispensed, 3);
            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
        });

        it('в ручном режиме (manual = true) принимает сигнал тампера без задержки TAMPER_DEBOUNCE и не блокирует старт при разомкнутом тампере', async () => {
            const order = { row: 3, column: 0, quantity: 1 };
            // Даже если изначально тампер был в TAMPER_OFF, в manual-режиме MotorOnPhased не бросает TAMPER_BAD_POS
            emu.setRowTamper(order.row, false);

            let dispenseDoneEvent = null;
            storage.on(ClassSpiralSectionStorage.EVENTS.DISPENSE_DONE, (payload) => dispenseDoneEvent = payload);

            emu.simulateRotations({
                cols: COLS,
                rotationsCount: 1,
                firstPulseDelayMs: MANUAL_FIRST_PULSE_DELAY_MS,
            });

            await storage.Dispense(order, true);

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            assert.deepEqual(dispenseDoneEvent, {
                cell: storage.PosToInd(order),
                rots: 1,
                coords: { row: order.row, col: order.column }
            });
        });

        it('игнорирует ложный дребезг тампера в автоматическом режиме, если импульс пришел раньше TAMPER_DEBOUNCE (500 мс)', async () => {
            const order = { row: 1, column: 1, quantity: 1 };
            const dispensedEvents = [];
            storage.Events.on('dispense', (e) => dispensedEvents.push(e));

            emu.attachMatrixBehavior({
                onMotorFullStart: async () => {
                    // 1-й импульс сразу после выхода из MotorOnPhased, но раньше TAMPER_DEBOUNCE (500 мс)
                    await new Promise((r) => setTimeout(r, MANUAL_FIRST_PULSE_DELAY_MS));
                    await emu.pulseRowTamper(order.row, TAMPER_PULSE_WIDTH_MS);
                    assert.equal(dispensedEvents.length, 0);

                    // 2-й импульс после истечения TAMPER_DEBOUNCE — засчитывается как выдача
                    await new Promise((r) => setTimeout(r, POST_DEBOUNCE_WAIT_MS));
                    await emu.pulseRowTamper(order.row, TAMPER_PULSE_WIDTH_MS);
                },
            });

            await storage.Dispense(order, false);

            assert.equal(dispensedEvents.length, 1);
        });

        it('диагностирует FAULTS.ACTUATOR_NO_POWER на Step 2 включения мотора, переводит ячейку в ACTUATOR_NO_POWER и эмитит событие "fail"', async () => {
            const order = { row: 2, column: 2, quantity: 1 };
            const targetInd = storage.PosToInd(order);

            const failEvents = [];
            storage.Events.on('fail', (cell, fault) => failEvents.push({ cell, fault }));

            // После подачи V+ (Step 2) ток остается равным току покоя IDLE
            emu.attachMatrixBehavior({
                step1Current: emu.CURR.idle,
                step2Current: emu.CURR.idle,
            });

            await assert.rejects(
                () => storage.Dispense(order),
                (fault) => fault.code === FAULTS.ACTUATOR_NO_POWER && fault.index === targetInd
            );

            assert.equal(storage.StateAdapter.HasCellNoPower(targetInd), true);
            assert.equal(sectionState.Cells[targetInd].Status, SPIRAL_CELL_STATE.ACTUATOR_NO_POWER);
            assert.equal(failEvents.length, 1);
            assert.deepEqual(failEvents[0].cell, { row: order.row, column: order.column });
            assert.equal(failEvents[0].fault.code, FAULTS.ACTUATOR_NO_POWER);
            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
        });

        it('прерывает многократную выдачу после текущего оборота при вызове Abort()', async () => {
            const order = { row: 0, column: 0, quantity: 3 };
            const dispensedEvents = [];

            storage.Events.on('dispense', (e) => {
                dispensedEvents.push(e);
                // После выдачи 1-го товара из 3 вызываем Abort()
                storage.Abort();
            });

            emu.simulateRotations({
                cols: COLS,
                rotationsCount: 3,
                betweenPulsesMs: ABORT_BETWEEN_PULSES_MS,
            });

            await storage.Dispense(order);

            // Выдача должна завершиться сразу после 1-го оборота, не дожидаясь остальных двух
            assert.equal(dispensedEvents.length, 1);
            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
        });
    });

    // =========================================================================
    // 5. Вращение мотора по времени и сброс состояния: RunMotor() и Reset()
    // =========================================================================
    describe('Вращение мотора по времени RunMotor() и полный сброс Reset()', () => {
        it('RunMotor({ row, column, duration }) включает мотор на заданное время и автоматически выключает его по таймеру', async () => {
            await storage.RunMotor({
                row: 1,
                column: 0,
                duration: 650,
            });

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            const sent = stub.getSentValues(channels.matrixCtrlChannel);
            const targetInd = storage.PosToInd({ row: 1, col: 0 });
            assert.deepEqual(sent, [
                { target: targetInd, cmd: 'On', args: [{ step: MOTOR_STEP_GND }] },
                { target: targetInd, cmd: 'On', args: [{ step: MOTOR_STEP_VPLUS }] },
                { target: targetInd, cmd: 'Off', args: [{ step: MOTOR_STEP_GND }] },
                { target: targetInd, cmd: 'Off', args: [{ step: MOTOR_STEP_VPLUS }] },
            ]);
        });

        it('Reset() во время активной операции отклоняет промис с ошибкой Reset, сбрасывает счетчики ячеек и отправляет MotorOffAll()', async () => {
            // Мотор включится, но импульсов тампера не будет
            emu.attachMatrixBehavior();

            const pendingDispense = storage.Dispense({
                row: 0,
                column: 1,
                quantity: 1,
            });
            await new Promise((r) => setTimeout(r, 100));

            storage.Reset();

            await assert.rejects(
                () => pendingDispense,
                (err) => err instanceof Error && err.message === 'Reset'
            );

            assert.equal(storage.State, ClassSpiralSectionStorage.STATE.IDLE);
            assert.deepEqual(stub.getLastSentValue(channels.matrixCtrlChannel), {
                target: undefined,
                cmd: 'Off',
                args: [{ step: undefined }],
            });
        });
    });
});
