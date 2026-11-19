const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ClassSpiralSection } = require('../../js/srvSpiralSection');
const { ClassSpiralSectionLift } = require('../../js/srvSpiralSectionLift');
const { ClassSpiralSectionStorage } = require('../../js/srvSpiralSectionStorage');
const ClassDeliveryBox = require('../../js/srvDelieveryBox');
const { SpiralMonitoringAdapter } = require('../../js/srvSpiralMonitoringAdapter');
const { ProxyChannelStub } = require('../../../../tests/helpers/ProxyChannelStub');
const {
    createSpiralMachineConfig,
    createInitialChannelsState,
    createMockSectionState,
} = require('../helpers/spiralSection.helper');

describe('ClassSpiralSection — Обработка событий моторесурса от Lift, Storage и DeliveryBox', () => {
    let stub;
    let section;
    let channels;
    let secChannels;
    let monitoringAdapter;

    beforeEach(() => {
        stub = new ProxyChannelStub();

        const config = createSpiralMachineConfig({ rows: 2, cols: 2 });
        secChannels = config.Sections[0].Channels;
        const ch = secChannels;

        channels = {
            door: ch.Door.Sensor,
            boxChannels: {
                lock: ch.DeliveryBox.Lock,
                optic: ch.DeliveryBox.Optic,
            },
            storageChannels: {
                matrixCtrlChannel: ch.Storage.MatrixCtrl,
                spiralTamperChannels: ch.Storage.Tamper,
                current: ch.Power.Current,
                voltage: ch.Power.Voltage,
                short: ch.Power.Short,
                psuWork: ch.Power.PsuWork,
            },
            liftChannels: {
                liftMotorCtrl: ch.Lift.MotorCtrl,
                liftMotorCtrl2: ch.Lift.MotorCtrl2,
                liftLevelSensor: ch.Lift.LevelSensor,
                liftBottomTamper: ch.Lift.BottomTamper,
                liftTopTamper: ch.Lift.TopTamper,
                current: ch.Power.Current,
                voltage: ch.Power.Voltage,
                short: ch.Power.Short,
                psuWork: ch.Power.PsuWork,
            },
        };

        stub.seed(createInitialChannelsState(config));

        monitoringAdapter = new SpiralMonitoringAdapter({
            ProxyCh: stub,
            channels: {
                monBox: ch.DeliveryBox.Monitoring,
                monLift: ch.Lift.Monitoring,
                monSpirals: ch.Storage.Monitoring,
            },
        });

        const sectionState = createMockSectionState({ rows: 2, cols: 2 });

        section = new ClassSpiralSection({
            ProxyCh: stub,
            channels,
            advOpts: {
                liftOpts: { busNumber: 1, maxLevel: 2 },
                storageOpts: { busNumber: 1, size: { rows: 2, cols: 2 }, globalState: null },
            },
            sectionState,
            monitoringAdapter,
            ProxyLogger: { Log: () => {} },
        });

        stub.clearHistory();
    });

    afterEach(() => {
        section.Reset();
        stub.reset({ removeListeners: true });
    });

    it('при возникновении события LEVEL_PASSED у Lift, вызывает monitoringAdapter.RecordLevelPassed и инкрементирует monLift', () => {
        const monLift = secChannels.Lift.Monitoring;
        assert.equal(stub.getSentValues(monLift).length, 0);

        // Лифт эмитит событие LEVEL_PASSED
        section.Lift.emit(ClassSpiralSectionLift.EVENTS.LEVEL_PASSED, { distance: 0.15, level: 1 });

        assert.deepEqual(stub.getSentValues(monLift), [0.15]);

        section.Lift.emit(ClassSpiralSectionLift.EVENTS.LEVEL_PASSED, { distance: 0.15, level: 2 });
        assert.deepEqual(stub.getSentValues(monLift), [0.15, 0.15]);
    });

    it('при возникновении события DISPENSE_DONE у Storage, вызывает monitoringAdapter.RecordCellDispense и инкрементирует monSpirals', () => {
        const monSpirals = secChannels.Storage.Monitoring;
        assert.equal(stub.getSentValues(monSpirals).length, 0);

        // Storage эмитит событие DISPENSE_DONE
        section.Storage.emit(ClassSpiralSectionStorage.EVENTS.DISPENSE_DONE, {
            cell: 3,
            rots: 2,
            coords: { row: 1, col: 1 },
        });

        assert.deepEqual(stub.getSentValues(monSpirals), [
            { Cell: 3, Rots: 2 },
        ]);
    });

    it('при возникновении события OPENED у DeliveryBox, вызывает monitoringAdapter.RecordBox и инкрементирует monBox', () => {
        const monBox = secChannels.DeliveryBox.Monitoring;
        assert.equal(stub.getSentValues(monBox).length, 0);

        // DeliveryBox эмитит событие OPENED
        section.Box.emit(ClassDeliveryBox.EVENTS.OPENED);

        assert.deepEqual(stub.getSentValues(monBox), [1]);
    });

    it('при отсутствии monitoringAdapter (monitoringAdapter = null/undefined), события обрабатываются без ошибок и без записи в каналы', () => {
        const sectionWithoutMon = new ClassSpiralSection({
            ProxyCh: stub,
            channels,
            advOpts: {
                liftOpts: { busNumber: 1, maxLevel: 2 },
                storageOpts: { busNumber: 1, size: { rows: 2, cols: 2 }, globalState: null },
            },
            ProxyLogger: { Log: () => {} },
        });

        try {
            stub.clearHistory();

            // Проверяем эмиссию событий — ошибок быть не должно
            assert.doesNotThrow(() => {
                sectionWithoutMon.Lift.emit(ClassSpiralSectionLift.EVENTS.LEVEL_PASSED, { distance: 0.15, level: 1 });
                sectionWithoutMon.Storage.emit(ClassSpiralSectionStorage.EVENTS.DISPENSE_DONE, { cell: 1, rots: 1 });
                sectionWithoutMon.Box.emit(ClassDeliveryBox.EVENTS.OPENED);
            });

            assert.equal(stub.getSentValues(secChannels.Lift.Monitoring).length, 0);
            assert.equal(stub.getSentValues(secChannels.Storage.Monitoring).length, 0);
            assert.equal(stub.getSentValues(secChannels.DeliveryBox.Monitoring).length, 0);
        } finally {
            sectionWithoutMon.Reset();
        }
    });
});
