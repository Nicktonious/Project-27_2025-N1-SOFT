const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionLift } = require('../../../js/srvSpiralSectionLift');
const { LIFT_CONSTANTS, FAULTS } = require('../../../js/SpiralSectionConstants');
const { LIFT_STATE } = require('../../../js/srvSpiralSectionStates');
const { ClassFault: Fault } = require('../../../js/srvUtils');
const {
    createLiftChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { Lift } = require('../../../../VMEmulator');

// --- Инженерные константы конфигурации секции ---
const SECTION_ROWS = 6;
const SECTION_COLS = 8;
const BUS_NUMBER = 1;
const MAX_LEVEL = 6;
const BOTTOM_LEVEL_POS = 0;

describe('ClassSpiralSectionLift — управление состояниями и флагами (States & Statuses)', () => {
    let stub;
    let emuLift;
    let channels;
    let sectionState;
    let logs;
    let proxyLogger;
    let lift;
    let activeIntervals = [];

    const origSetInterval = global.setInterval;

    beforeEach(() => {
        activeIntervals = [];
        global.setInterval = (...args) => {
            const id = origSetInterval(...args);
            activeIntervals.push(id);
            return id;
        };

        channels = createLiftChannelsFixture();

        stub = new ProxyChannelStub();
        emuLift = new Lift({ proxy: stub, channels });
        emuLift.seedDefaultSensors();

        sectionState = createMockSectionState({ rows: SECTION_ROWS, cols: SECTION_COLS });

        logs = [];
        proxyLogger = {
            Log: (entry) => logs.push(entry),
        };

        lift = new ClassSpiralSectionLift({
            ProxyCh: stub,
            channels,
            advOpts: { busNumber: BUS_NUMBER, maxLevel: MAX_LEVEL },
            sectionState,
            ProxyLogger: proxyLogger,
        });

        stub.clearHistory();
        logs.length = 0;
    });

    afterEach(() => {
        global.setInterval = origSetInterval;
        for (const id of activeIntervals) {
            clearInterval(id);
        }
        activeIntervals = [];
        emuLift.cleanup();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Обновление статуса: UpdateStatus(fault)
    // =========================================================================
    describe('UpdateStatus(fault) — трансляция аварий в статусы цифрового двойника', () => {
        it('корректно маппит коды ошибок FAULTS в состояния sectionState.Lift и StateAdapter', () => {
            const cases = [
                { code: FAULTS.BOTTOM_TAMPER_FAIL, expected: LIFT_STATE.ERR_TAMPER },
                { code: FAULTS.IO_DRIVER_ERR,      expected: LIFT_STATE.BLOCKED },
                { code: FAULTS.IO_PORT_ERR,        expected: LIFT_STATE.BLOCKED },
                { code: FAULTS.LEVEL_SENSOR_FAIL,  expected: LIFT_STATE.ERR_LEVEL },
                { code: FAULTS.LIFT_NO_POWER,      expected: LIFT_STATE.NO_POWER },
                { code: FAULTS.LIFT_SHORT_CIRCUIT, expected: LIFT_STATE.SHORT_CIRCUIT },
                { code: FAULTS.LIFT_OVERLOAD,      expected: LIFT_STATE.OVERLOAD },
            ];

            for (const { code, expected } of cases) {
                lift.StateAdapter.SetLiftReady();
                lift.UpdateStatus(new Fault({ code }));
                assert.equal(
                    sectionState.Lift.Status,
                    expected,
                    `Код ошибки ${code} должен переводить sectionState.Lift.Status в ${expected}`
                );
            }
        });

        it('сбрасывает текущий уровень лифта (lift.Level = undefined) при ошибке датчика уровня FAULTS.LEVEL_SENSOR_FAIL', () => {
            // Сначала фиксируем уровень 0 через срабатывание нижнего концевика
            emuLift.setBottomTamper(false, { emit: true });
            emuLift.setBottomTamper(true, { emit: true });
            assert.equal(lift.Level, BOTTOM_LEVEL_POS);

            // Ошибка тампера не должна сбрасывать знание об уровне
            lift.UpdateStatus(new Fault({ code: FAULTS.BOTTOM_TAMPER_FAIL }));
            assert.equal(lift.Level, BOTTOM_LEVEL_POS);

            // Отказ датчика уровня обязан сбросить currentLevel в undefined
            lift.UpdateStatus(new Fault({ code: FAULTS.LEVEL_SENSOR_FAIL }));
            assert.equal(lift.Level, undefined);
            assert.equal(lift.StateAdapter.HasLiftLevelError, true);
            assert.equal(sectionState.Lift.Status, LIFT_STATE.ERR_LEVEL);
        });

        it('не изменяет состояние при неизвестном коде ошибки или FAULTS.NONE', () => {
            lift.StateAdapter.SetLiftReady();
            lift.UpdateStatus(new Fault({ code: FAULTS.NONE }));
            assert.equal(lift.StateAdapter.IsLiftOk, true);
            assert.equal(sectionState.Lift.Status, LIFT_STATE.OK);
        });
    });

    // =========================================================================
    // 2. Геттеры состояния: Available, Level, State, EVENTS
    // =========================================================================
    describe('Геттеры Available, Level и EVENTS', () => {
        it('HasLiftLevelError и IsLiftOk отражают состояние лифта', () => {
            assert.equal(lift.StateAdapter.IsLiftOk, true);

            lift.StateAdapter.SetLiftFault(FAULTS.LEVEL_SENSOR_FAIL);
            assert.equal(lift.StateAdapter.HasLiftLevelError, true);
            assert.equal(lift.StateAdapter.IsLiftOk, false);
            assert.equal(sectionState.Lift.Status, LIFT_STATE.ERR_LEVEL);
        });

        it('Available возвращает false только для критических статусов SHORT_CIRCUIT и OVERLOAD', () => {
            const availableCases = [
                FAULTS.BOTTOM_TAMPER_FAIL,
                FAULTS.LEVEL_SENSOR_FAIL,
                FAULTS.LIFT_NO_POWER,
            ];

            for (const code of availableCases) {
                lift.StateAdapter.SetLiftReady();
                lift.UpdateStatus(new Fault({ code }));
                assert.equal(lift.Available, true, `При ошибке ${code} лифт должен оставаться Available`);
                assert.equal(lift.StateAdapter.IsLiftAvailable, true);
            }

            lift.StateAdapter.SetLiftFault(FAULTS.LIFT_SHORT_CIRCUIT);
            assert.equal(lift.Available, false);
            assert.equal(lift.StateAdapter.IsLiftAvailable, false);
            assert.equal(sectionState.Lift.Status, LIFT_STATE.SHORT_CIRCUIT);

            lift.StateAdapter.SetLiftFault(FAULTS.LIFT_OVERLOAD);
            assert.equal(lift.Available, false);
            assert.equal(lift.StateAdapter.IsLiftAvailable, false);
            assert.equal(sectionState.Lift.Status, LIFT_STATE.OVERLOAD);
        });

        it('Level изначально равен undefined и устанавливается в 0 при срабатывании нижнего тампера', () => {
            assert.equal(lift.Level, undefined);

            emuLift.setBottomTamper(true, { emit: true });
            assert.equal(lift.Level, BOTTOM_LEVEL_POS);
        });

        it('EVENTS содержит полный набор констант событий лифта', () => {
            const events = lift.EVENTS;
            assert.equal(typeof events.ELEVATE_TO_BOTTOM_COMMAND, 'string');
            assert.equal(typeof events.ELEVATE_COMMAND, 'string');
            assert.equal(typeof events.BOTTOM_LEVEL_REACHED, 'string');
            assert.equal(typeof events.COLLECT_LEVEL_REACHED, 'string');
            assert.equal(typeof events.ELEVATE_TIMEOUT, 'string');
            assert.equal(typeof events.FAULT, 'string');
            assert.equal(typeof events.RECOVERED, 'string');
            assert.equal(typeof events.ABORT, 'string');
        });
    });

    // =========================================================================
    // 3. Логирование смены состояния автомата: OnStateChanged()
    // =========================================================================
    describe('OnStateChanged() — фиксация переходов автомата состояний', () => {
        it('OnStateChanged форматирует и передает диагностические записи в ProxyLogger', () => {
            logs.length = 0;

            lift.OnStateChanged({
                prevState: ClassSpiralSectionLift.STATE.IDLE,
                eventName: lift.EVENTS.ELEVATE_COMMAND,
                state: ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT,
            });

            assert.equal(logs.length, 1);
            assert.equal(
                logs[0].msg,
                '[LIFT] STATE: IDLE --[ELEVATE_COMMAND]--> ELEVATING_TO_COLLECT'
            );
        });
    });
});
