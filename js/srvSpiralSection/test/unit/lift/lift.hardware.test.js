const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSectionLift } = require('../../../js/srvSpiralSectionLift');
const { LIFT_CONSTANTS, COMMON_CONSTANTS, FAULTS } = require('../../../js/SpiralSectionConstants');
const {
    createLiftChannelsFixture,
    createMockSectionState,
} = require('../../helpers/spiralSection.helper');
const { ProxyChannelStub } = require('../../../../../tests/helpers/ProxyChannelStub');
const { Lift } = require('../../../../VMEmulator');

// --- Параметры тестовой конфигурации аппаратной секции ---
const SECTION_ROWS = 6;
const SECTION_COLS = 8;
const BUS_NUMBER = 1;
const MAX_LEVEL = 6;
const MON_LIFT_LEVEL_METRIC = 0.15;
const INIT_STOP_SETTLE_MS = 70; // Ожидание стартового Stop() в Init() (где цикл ждет sleep(50))

describe('ClassSpiralSectionLift — управление актуаторами и установка лифта в позицию (Hardware & Positioning)', () => {
    let stub;
    /** @type {Lift} */
    let emu;
    let channels;
    let sectionState;
    let logs;
    /** @type {ClassSpiralSectionLift} */
    let lift;

    beforeEach(async () => {
        channels = createLiftChannelsFixture();

        stub = new ProxyChannelStub();
        emu = new Lift({ proxy: stub, channels });
        emu.seedDefaultHardware({ atBottom: true });

        sectionState = createMockSectionState({ rows: SECTION_ROWS, cols: SECTION_COLS });

        logs = [];
        lift = new ClassSpiralSectionLift({
            ProxyCh: stub,
            channels,
            advOpts: { busNumber: BUS_NUMBER, maxLevel: MAX_LEVEL },
            sectionState,
            ProxyLogger: { Log: (entry) => logs.push(entry) },
        });

        // Дожидаемся завершения стартового this.Stop() в конструкторе (Init -> Stop ждет 50мс)
        await new Promise((r) => setTimeout(r, INIT_STOP_SETTLE_MS));
        stub.clearHistory();
        logs.length = 0;
    });

    afterEach(() => {
        lift.Reset();
        emu.cleanup();
        stub.reset({ removeListeners: true });
    });

    // =========================================================================
    // 1. Прямые аппаратные команды: OffPSU, OnPSU, MotorStep, StopForce
    // =========================================================================
    describe('Низкоуровневые команды актуаторов: OffPSU(), OnPSU(), MotorStep(), StopForce()', () => {
        it('OffPSU() записывает 0 в канал psuWork, а OnPSU() записывает 1', () => {
            lift.OffPSU();
            assert.equal(stub.getLastSentValue(channels.psuWork), 0);

            lift.OnPSU();
            assert.equal(stub.getLastSentValue(channels.psuWork), 1);
            assert.deepEqual(stub.getSentValues(channels.psuWork), [0, 1]);
        });

        it('MotorStep() отправляет команду шагового управления в канал liftMotorCtrl', () => {
            lift.MotorStep('Forward', { step: 1 });
            assert.deepEqual(stub.getLastSentValue(channels.liftMotorCtrl), {
                cmd: 'Forward',
                args: [{ step: 1 }],
            });
        });

        it('StopForce() немедленно отправляет STOP в канал liftMotorCtrl без ожидания затухания тока', () => {
            lift.StopForce();
            assert.equal(stub.getLastSentValue(channels.liftMotorCtrl), 'STOP');
        });
    });

    // =========================================================================
    // 2. Включение привода: Elevate({ cmd }), ElevateUp(), ElevateDown()
    // =========================================================================
    describe('Включение мотора лифта: Elevate(), ElevateUp(), ElevateDown()', () => {
        it('ElevateUp() предварительно вызывает StopForce("STOP"), затем подает "UP" в liftMotorCtrl и дожидается рабочего тока', async () => {
            emu.attachMotorBehavior({ workCurrent: emu.CURR.workOk });

            await lift.ElevateUp();

            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP', 'UP']);
        });

        it('ElevateDown() предварительно вызывает StopForce("STOP"), затем подает "DOWN" в liftMotorCtrl и дожидается рабочего тока', async () => {
            emu.attachMotorBehavior({ workCurrent: emu.CURR.workOk });

            await lift.ElevateDown();

            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP', 'DOWN']);
        });

        it('выбрасывает FAULTS.LIFT_CTRL_UNDEFINED, если еще до подачи команды на мотор ток уже находится в рабочем диапазоне (>= WORK_OK[0])', async () => {
            // Залипший ключ: даже при STOP ток остается рабочим
            emu.attachMotorBehavior({ stopCurrent: emu.CURR.workOk });
            emu.setCurrent(emu.CURR.workOk);

            await assert.rejects(
                () => lift.ElevateUp(),
                (fault) => fault.code === FAULTS.LIFT_CTRL_UNDEFINED
            );

            // Команда 'UP' даже не должна была отправиться, только предварительный 'STOP'
            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP']);
        });

        it('выбрасывает FAULTS.LIFT_SHORT_CIRCUIT при обнаружении признаков КЗ после подачи команды движения', async () => {
            emu.attachMotorBehavior({
                workCurrent: emu.CURR.idle,
                shortOnStart: true,
            });

            await assert.rejects(
                () => lift.ElevateUp(),
                (fault) => fault.code === FAULTS.LIFT_SHORT_CIRCUIT
            );
        });

        it('выбрасывает FAULTS.LIFT_NO_POWER, если после подачи команды движения ток не вырос до WORK_OK за время SLEEP_BETWEEN_STEPS', async () => {
            // Мотор не реагирует: ток остается в IDLE
            emu.attachMotorBehavior({ workCurrent: emu.CURR.idle });

            await assert.rejects(
                () => lift.ElevateUp(),
                (fault) => fault.code === FAULTS.LIFT_NO_POWER
            );
        });
    });

    // =========================================================================
    // 3. Остановка привода с контролем тока: Stop()
    // =========================================================================
    describe('Остановка мотора с контролем спада тока: Stop()', () => {
        it('отправляет "STOP" в liftMotorCtrl и завершается успешно, когда ток падает ниже WORK_OK[0]', async () => {
            emu.setCurrent(emu.CURR.workOk);
            emu.attachMotorBehavior({ stopCurrent: emu.CURR.idle });

            await lift.Stop();

            assert.equal(stub.getLastSentValue(channels.liftMotorCtrl), 'STOP');
        });

        it('выбрасывает FAULTS.IO_PORT_ERR, если после команды "STOP" ток не упал до холостого хода за 500 мс', async () => {
            emu.setBottomTamper(true, { emit: false });
            // Ключ пробит: после команды STOP ток продолжает течь
            emu.attachMotorBehavior({ stopCurrent: emu.CURR.workOk });

            await assert.rejects(
                () => lift.Stop(),
                (fault) => fault.code === FAULTS.IO_PORT_ERR
            );
        });

        it('выбрасывает FAULTS.LIFT_SHORT_CIRCUIT при остановке вне нижней позиции, если фиксируется КЗ', async () => {
            emu.setBottomTamper(false, { emit: false });
            stub.onSet(channels.liftMotorCtrl, (cmd) => {
                if (cmd === 'STOP') {
                    emu.setCurrent(emu.CURR.short);
                }
            });

            await assert.rejects(
                () => lift.Stop(),
                (fault) => fault.code === FAULTS.LIFT_SHORT_CIRCUIT
            );
        });
    });

    // =========================================================================
    // 4. Установка лифта в нижнее положение: ElevateToBottom()
    // =========================================================================
    describe('Установка лифта в положение выдачи (0-й уровень): ElevateToBottom()', () => {
        it('мгновенно завершается и устанавливает Level = 0 без запуска мотора вниз, если лифт уже на нижнем концевике', async () => {
            emu.setBottomTamper(true, { emit: false });
            emu.attachMotorBehavior();

            await lift.ElevateToBottom();

            assert.equal(lift.Level, 0);
            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            // Команда 'DOWN' не подавалась, вызвался только Stop() при переходе в Idle()
            assert.equal(stub.getSentValues(channels.liftMotorCtrl).includes('DOWN'), false);
        });

        it('включает движение вниз ("DOWN"), ждет срабатывания liftBottomTamper и останавливает мотор на уровне 0', async () => {
            // Лифт находится выше нижнего концевика
            emu.setBottomTamper(false, { emit: false });
            emu.simulateTravel({
                stepsCount: 1,
                reachBottom: true,
                stepIntervalMs: 30,
            });

            await lift.ElevateToBottom();

            assert.equal(lift.Level, 0);
            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP', 'DOWN', 'STOP']);
        });

        it('отклоняет вызов ElevateToBottom(), если статус лифта SHORT_CIRCUIT или OVERLOAD (!Available)', async () => {
            lift.StateAdapter.SetLiftFault(FAULTS.LIFT_OVERLOAD);

            await assert.rejects(
                () => lift.ElevateToBottom(),
                /Статус лифта не позволяет начать новую операцию/
            );
        });

        it('отклоняет параллельный вызов операции, пока предыдущая команда перемещения еще выполняется', async () => {
            emu.setBottomTamper(false, { emit: false });
            emu.simulateTravel({
                stepsCount: 0,
                reachBottom: true,
                stepIntervalMs: 80,
            });

            const firstTask = lift.ElevateToBottom();
            await assert.rejects(
                () => lift.ElevateToBottom(),
                /Выполняется предыдущая операция/
            );

            await firstTask;
        });
    });

    // =========================================================================
    // 5. Установка лифта на целевой уровень полки: ElevateToLevel(requiredLevel)
    // =========================================================================
    describe('Установка лифта на заданный уровень полки: ElevateToLevel(requiredLevel)', () => {
        beforeEach(async () => {
            // Привязываем лифт к 0-му уровню перед тестами поездок по полкам
            emu.setBottomTamper(true, { emit: false });
            await lift.ElevateToBottom();
            stub.clearHistory();
        });

        it('поднимает лифт с 0-го на 3-й уровень ("UP"), отсчитывая 3 импульса датчика уровня liftLevelSensor, и останавливает привод', async () => {
            const levelPassedEvents = [];
            lift.on(ClassSpiralSectionLift.EVENTS.LEVEL_PASSED, (payload) => levelPassedEvents.push(payload));

            emu.simulateTravel({
                stepsCount: 3,
                stepIntervalMs: 25,
            });

            await lift.ElevateToLevel(3);

            assert.equal(lift.Level, 3);
            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP', 'UP', 'STOP']);
            // На каждом из 3 уровней эмитировалось событие LEVEL_PASSED (0.15)
            assert.equal(levelPassedEvents.length, 3);
            assert.deepEqual(
                levelPassedEvents.map(e => e.distance),
                Array(3).fill(MON_LIFT_LEVEL_METRIC)
            );
        });

        it('опускает лифт с 4-го на 2-й уровень ("DOWN"), уменьшая счетчик уровня на каждом импульсе датчика', async () => {
            // Сначала поднимаем лифт на 4-й уровень
            let off = emu.simulateTravel({
                stepsCount: 4,
                stepIntervalMs: 20,
            });
            await lift.ElevateToLevel(4);
            assert.equal(lift.Level, 4);
            off();
            stub.clearHistory();

            // Теперь спускаем с 4-го на 2-й уровень (2 импульса вниз)
            off = emu.simulateTravel({
                stepsCount: 2,
                stepIntervalMs: 20,
            });
            await lift.ElevateToLevel(2);
            off();

            assert.equal(lift.Level, 2);
            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            assert.deepEqual(stub.getSentValues(channels.liftMotorCtrl), ['STOP', 'DOWN', 'STOP']);
        });

        it('игнорирует однократный бросок тока выше порога КЗ во время движения (фильтрация помехи / пускового броска) и успешно достигает уровня', async () => {
            emu.simulateTravel({
                stepsCount: 3,
                stepIntervalMs: 80,
                startDelayMs: 60,
            });

            // Во время активного движения (через 250 мс, когда мотор уже запущен)
            // кратковременный бросок тока на 60 мс не должен вызывать аварию (short_count < 2)
            setTimeout(() => {
                emu.pulseCurrent(emu.CURR.short, 60, emu.CURR.workOk);
            }, 250);

            await lift.ElevateToLevel(3);

            assert.equal(lift.Level, 3);
            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            assert.equal(lift.StateAdapter.IsLiftOk, true);
        });

        it('прерывает перемещение с ошибкой FAULTS.LIFT_SHORT_CIRCUIT при устойчивом токе КЗ в течение 2 интервалов монитора', async () => {
            emu.attachMotorBehavior({
                onStartMove: async () => {
                    // Через 50 мс после старта ток уходит в устойчивое КЗ (более 2 тактов монитора по 200 мс)
                    await new Promise((r) => setTimeout(r, 50));
                    emu.setCurrent(emu.CURR.short);
                },
            });

            await assert.rejects(
                () => lift.ElevateToLevel(3),
                (fault) => fault.code === FAULTS.LIFT_SHORT_CIRCUIT
            );

            assert.equal(lift.StateAdapter.IsLiftOk, false);
            assert.equal(lift.StateAdapter.IsLiftAvailable, false);
            assert.equal(stub.getLastSentValue(channels.liftMotorCtrl), 'STOP');
        });

        it('прерывает подъем с ошибкой FAULTS.LEVEL_SENSOR_FAIL и останавливает мотор при срабатывании верхнего аварийного концевика liftTopTamper', async () => {
            emu.attachMotorBehavior({
                onStartMove: async () => {
                    await new Promise((r) => setTimeout(r, 30));
                    // Вместо нужного уровня лифт врезался в верхний аварийный концевик
                    emu.triggerTopTamper();
                },
            });

            await assert.rejects(
                () => lift.ElevateToLevel(5),
                (fault) => fault.code === FAULTS.LEVEL_SENSOR_FAIL
            );

            assert.equal(lift.StateAdapter.HasLiftLevelError, true);
            assert.equal(lift.Level, undefined);
            assert.equal(stub.getLastSentValue(channels.liftMotorCtrl), 'STOP');
        });

        it('Abort() во время подъема останавливает мотор и возвращает автомат лифта в состояние IDLE', async () => {
            emu.attachMotorBehavior({
                onStartMove: async () => {
                    await new Promise((r) => setTimeout(r, 30));
                    lift.Abort();
                },
            });

            await lift.ElevateToLevel(4);

            assert.equal(lift.State, ClassSpiralSectionLift.STATE.IDLE);
            assert.equal(stub.getLastSentValue(channels.liftMotorCtrl), 'STOP');
        });
    });
});
