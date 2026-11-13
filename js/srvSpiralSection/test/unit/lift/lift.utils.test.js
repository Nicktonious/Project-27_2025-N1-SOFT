const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionLift } = require('../../../js/srvSpiralSectionLift');
const { LIFT_CONSTANTS, COMMON_CONSTANTS } = require('../../../js/SpiralSectionConstants');
const {
    createLiftChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { Lift, peekValueInRange, getRangeAbove, getRangeBelow } = require('../../../../VMEmulator');

// --- Инженерные константы конфигурации секции и буферов ---
const SECTION_ROWS = 6;
const SECTION_COLS = 8;
const BUS_NUMBER = 1;
const MAX_LEVEL = 6;
const CURR_BUFFER_SIZE = 5;

// --- Физические константы сигналов датчиков (сопоставленные со SpiralSectionConstants.js) ---
const NOMINAL_WORK_VOLTAGE = LIFT_CONSTANTS.WORK_VOLTAGE; // 24V
const NOMINAL_WORK_CURRENT = peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.WORK_OK);
const IDLE_CURRENT = peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.IDLE);
const OVERLOAD_CURRENT = peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.OVERLOAD);
const SHORT_THRESHOLD_CURRENT = LIFT_CONSTANTS.CURRENT_RANGE.SHORT[0]; // 5A
const SHORT_EXCESS_CURRENT = getRangeAbove(LIFT_CONSTANTS.CURRENT_RANGE.SHORT, 5);
const MIN_OPERATING_VOLTAGE = COMMON_CONSTANTS.MIN_VOLTAGE; // 16V

const NEGATIVE_CURRENT_SAMPLE = -0.5;
const SAFE_VOLTAGE_DELTA = 0.1;
const DEEP_VOLTAGE_DROP = 5;

describe('ClassSpiralSectionLift — утилитарные и вспомогательные функции (без управления моторами)', () => {
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
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. CheckCurrentState(currVal)
    // =========================================================================
    describe('CheckCurrentState() — классификация уровней тока', () => {
        const { CURRENT_RANGE, ELECTR_CURR_STATE } = LIFT_CONSTANTS;

        it('классифицирует переданный аргумент currVal по диапазонам [low, high) из LIFT_CONSTANTS.CURRENT_RANGE', () => {
            const [idleLow] = CURRENT_RANGE.IDLE;       // [0, 0.08)
            const [workLow] = CURRENT_RANGE.WORK_OK;    // [0.08, 2)
            const [ovlLow] = CURRENT_RANGE.OVERLOAD;     // [2, 5)
            const [shortLow] = CURRENT_RANGE.SHORT;      // [5, Infinity)

            // Диапазон IDLE
            assert.equal(lift.CheckCurrentState(idleLow), ELECTR_CURR_STATE.IDLE);
            assert.equal(lift.CheckCurrentState(IDLE_CURRENT), ELECTR_CURR_STATE.IDLE);

            // Верхняя граница IDLE является нижней границей WORK_OK
            assert.equal(lift.CheckCurrentState(workLow), ELECTR_CURR_STATE.WORK_OK);
            assert.equal(lift.CheckCurrentState(NOMINAL_WORK_CURRENT), ELECTR_CURR_STATE.WORK_OK);

            // Верхняя граница WORK_OK является нижней границей OVERLOAD ('STUCK')
            assert.equal(lift.CheckCurrentState(ovlLow), ELECTR_CURR_STATE.OVERLOAD);
            assert.equal(lift.CheckCurrentState(OVERLOAD_CURRENT), ELECTR_CURR_STATE.OVERLOAD);

            // Верхняя граница OVERLOAD является нижней границей SHORT
            assert.equal(lift.CheckCurrentState(shortLow), ELECTR_CURR_STATE.SHORT);
            assert.equal(lift.CheckCurrentState(SHORT_EXCESS_CURRENT), ELECTR_CURR_STATE.SHORT);
        });

        it('берет усредненное значение из буфера _I_CurrBuffer.Filter(), если аргумент currVal не передан', () => {
            emuLift.setCurrent(NOMINAL_WORK_CURRENT, { pushToBuffer: true, samples: CURR_BUFFER_SIZE });
            assert.equal(lift.CheckCurrentState(), ELECTR_CURR_STATE.WORK_OK);

            emuLift.setCurrent(OVERLOAD_CURRENT, { pushToBuffer: true, samples: CURR_BUFFER_SIZE });
            assert.equal(lift.CheckCurrentState(), ELECTR_CURR_STATE.OVERLOAD);
        });

        it('возвращает undefined, если буфер тока пуст и аргумент currVal не передан или отрицателен', () => {
            lift._I_CurrBuffer.Clear();

            assert.equal(lift.CheckCurrentState(), undefined);
            assert.equal(lift.CheckCurrentState(NEGATIVE_CURRENT_SAMPLE), undefined);
        });
    });

    // =========================================================================
    // 2. InBottomPos()
    // =========================================================================
    describe('InBottomPos() — проверка дискретного концевика нижнего положения', () => {
        it('возвращает true, когда на канале liftBottomTamper значение LIFT_BOTTOM_TAMPER_ON', () => {
            emuLift.setBottomTamper(true, { emit: false });
            assert.equal(lift.InBottomPos(), true);
        });

        it('возвращает false, когда на канале liftBottomTamper значение LIFT_BOTTOM_TAMPER_OFF или undefined', () => {
            emuLift.setBottomTamper(false, { emit: false });
            assert.equal(lift.InBottomPos(), false);

            stub.inject(channels.liftBottomTamper, undefined, { emit: false });
            assert.equal(lift.InBottomPos(), false);
        });
    });

    // =========================================================================
    // 3. IsShorted()
    // =========================================================================
    describe('IsShorted() — аналитическое определение КЗ по порогу тока или просадке напряжения', () => {
        it('возвращает false при штатном токе и нормальном напряжении (> MIN_VOLTAGE)', () => {
            emuLift.setCurrent(getRangeBelow(LIFT_CONSTANTS.CURRENT_RANGE.SHORT, 0.5), { pushToBuffer: false });
            emuLift.setVoltage(NOMINAL_WORK_VOLTAGE, { pushToBuffer: false });

            assert.equal(lift.IsShorted(), false);
        });

        it('возвращает true при превышении порога тока КЗ (current > CURRENT_RANGE.SHORT[0]), даже если напряжение в норме', () => {
            emuLift.setVoltage(NOMINAL_WORK_VOLTAGE, { pushToBuffer: false });

            // На самой границе (== 5A) еще false
            emuLift.setCurrent(SHORT_THRESHOLD_CURRENT, { pushToBuffer: false });
            assert.equal(lift.IsShorted(), false);

            // Строго больше порога (> 5A) -> true
            emuLift.setCurrent(getRangeAbove(LIFT_CONSTANTS.CURRENT_RANGE.SHORT, 0.05), { pushToBuffer: false });
            assert.equal(lift.IsShorted(), true);
        });

        it('возвращает true при просадке напряжения (voltage <= COMMON_CONSTANTS.MIN_VOLTAGE), даже если ток в норме', () => {
            emuLift.setCurrent(NOMINAL_WORK_CURRENT, { pushToBuffer: false });

            // Чуть выше порога -> false
            emuLift.setVoltage(MIN_OPERATING_VOLTAGE + SAFE_VOLTAGE_DELTA, { pushToBuffer: false });
            assert.equal(lift.IsShorted(), false);

            // Равно порогу (<= 16V) -> true
            emuLift.setVoltage(MIN_OPERATING_VOLTAGE, { pushToBuffer: false });
            assert.equal(lift.IsShorted(), true);

            // Ниже порога -> true
            emuLift.setVoltage(MIN_OPERATING_VOLTAGE - DEEP_VOLTAGE_DROP, { pushToBuffer: false });
            assert.equal(lift.IsShorted(), true);
        });
    });

    // =========================================================================
    // 4. Пассивные обработчики датчиков тока, напряжения и регистрация транзакций
    // =========================================================================
    describe('SetCurrentHandler(), SetVoltageHandler(), LogTransaction()', () => {
        it('SetCurrentHandler записывает входящие события канала тока в циклический буфер _I_CurrBuffer', () => {
            lift._I_CurrBuffer.Clear();
            stub.inject(channels.current, NOMINAL_WORK_CURRENT, { emit: true });
            stub.inject(channels.current, NOMINAL_WORK_CURRENT, { emit: true });

            assert.equal(lift._I_CurrBuffer.Filter(), NOMINAL_WORK_CURRENT);
        });

        it('SetVoltageHandler записывает входящие события канала напряжения в буфер _V_VoltBuffer', () => {
            lift._V_VoltBuffer.Clear();
            stub.inject(channels.voltage, NOMINAL_WORK_VOLTAGE, { emit: true });
            stub.inject(channels.voltage, NOMINAL_WORK_VOLTAGE, { emit: true });

            assert.equal(lift._V_VoltBuffer.Filter(), NOMINAL_WORK_VOLTAGE);
        });
    });

    // =========================================================================
    // 5. HandleLevel({ Value }) в режиме покоя (без включения мотора)
    // =========================================================================
    describe('HandleLevel() — фильтрация дублей и сброс счетчиков в состоянии IDLE', () => {
        it('сбрасывает счетчики nopower_count и overload_count при фронте импульса датчика уровня, но не меняет Level в состоянии IDLE', () => {
            lift.nopower_count = 2;
            lift.overload_count = 1;

            // В состоянии IDLE приход фронта LIFT_BOTTOM_TAMPER_ON сбрасывает счетчики, но не меняет currentLevel
            emuLift.setLevelSensor(true, { emit: true });

            assert.equal(lift.nopower_count, 0);
            assert.equal(lift.overload_count, 0);
            assert.equal(lift.Level, undefined);
        });

        it('игнорирует повторные одинаковые значения датчика уровня (#_LevelCachedValue)', () => {
            emuLift.setLevelSensor(true, { emit: true });

            lift.nopower_count = 2;
            // Повторная отправка того же самого значения (1) должна быть отфильтрована кэшем
            emuLift.setLevelSensor(true, { emit: true });
            assert.equal(lift.nopower_count, 2);

            // После спада (0) и нового фронта (1) обработчик снова срабатывает
            emuLift.setLevelSensor(false, { emit: true });
            emuLift.setLevelSensor(true, { emit: true });
            assert.equal(lift.nopower_count, 0);
        });
    });
});
