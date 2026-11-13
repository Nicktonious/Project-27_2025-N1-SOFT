'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { SpiralMonitoringAdapter } = require('../../js/srvSpiralMonitoringAdapter');
const { ProxyChannelStub } = require('../../../../tests/helpers/ProxyChannelStub');

describe('SpiralMonitoringAdapter (Primitive Channel Emitter Tests)', () => {
    let stub;
    let adapter;

    beforeEach(() => {
        stub = new ProxyChannelStub();
        stub.seed({
            'mon-lift': null,
            'mon-spirals': null,
            'mon-box': 0,
        });

        adapter = new SpiralMonitoringAdapter({
            ProxyCh: stub,
            channels: {
                monLift: 'mon-lift',
                monSpirals: 'mon-spirals',
                monBox: 'mon-box',
            },
        });
    });

    it('RecordLevelPassed записывает пройденное расстояние в канал monLift', () => {
        adapter.RecordLevelPassed(0.15);
        assert.deepEqual(stub.getSentValues('mon-lift'), [0.15]);

        adapter.RecordLevelPassed(0.30);
        assert.deepEqual(stub.getSentValues('mon-lift'), [0.15, 0.30]);
    });

    it('RecordCellDispense записывает объект { Cell, Rots } в канал monSpirals', () => {
        adapter.RecordCellDispense(5, 1);
        assert.deepEqual(stub.getSentValues('mon-spirals'), [
            { Cell: 5, Rots: 1 },
        ]);

        adapter.RecordCellDispense(8, 3);
        assert.deepEqual(stub.getSentValues('mon-spirals'), [
            { Cell: 5, Rots: 1 },
            { Cell: 8, Rots: 3 },
        ]);
    });

    it('RecordBox записывает значение в канал monBox', () => {
        adapter.RecordBox(1);
        assert.deepEqual(stub.getSentValues('mon-box'), [1]);

        adapter.RecordBoxDoor(1);
        assert.deepEqual(stub.getSentValues('mon-box'), [1, 1]);

        adapter.RecordBoxLock(1);
        assert.deepEqual(stub.getSentValues('mon-box'), [1, 1, 1]);
    });

    it('не выполняет запись, если соответствующий канал не задан', () => {
        const adapterNoCh = new SpiralMonitoringAdapter({
            ProxyCh: stub,
            channels: {},
        });

        stub.clearHistory();

        assert.doesNotThrow(() => {
            adapterNoCh.RecordLevelPassed(0.15);
            adapterNoCh.RecordCellDispense(1, 1);
            adapterNoCh.RecordBox(1);
        });

        assert.equal(stub.getSentValues('mon-lift').length, 0);
        assert.equal(stub.getSentValues('mon-spirals').length, 0);
        assert.equal(stub.getSentValues('mon-box').length, 0);
    });

    it('выбрасывает ошибку, если ProxyCh не передан', () => {
        assert.throws(() => {
            new SpiralMonitoringAdapter();
        }, /ProxyCh обязателен/);
    });
});

/*
// =========================================================================
// Старые тесты со States.Monitoring (закомментированы по требованию задачи)
// =========================================================================

describe('SpiralMonitoringAdapter (Legacy States.Monitoring Tests - Commented Out)', () => {
    // Legacy tests with StatesController.Machine.Monitoring were preserved in backup
});
*/
