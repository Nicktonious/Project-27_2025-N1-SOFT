const { EventEmitter2 } = require('eventemitter2');
const { STORAGE_CONSTANTS, COMMON_CONSTANTS } = require('../constants.js');
const { peekValueInRange } = require('../utils/emuUtils.js');

/**
 * Эмулятор спирального хранилища (Storage), работающий напрямую через ProxyChannelStub.
 */
class SpiralSection {
    /**
     * @param {object} params
     * @param {import('../../../../tests/helpers/ProxyChannelStub.js').ProxyChannelStub} params.proxy
     * @param {import('../../../srvSpiralSection/js/srvSpiralSectionStorage.js').TypeSpiralSectionStorageChannels} params.channels
     * @param {{ rows: number, cols: number }} [params.size={ rows: 8, cols: 12 }]
     * @param {EventEmitter2} [params.events]
     * @param {Function} [params.log=console.log]
     */
    constructor({ proxy, channels, size = { rows: 8, cols: 12 }, events, log = console.log }) {
        this.proxy = proxy;
        this.channels = channels;
        this.size = size;
        this.events = events ?? new EventEmitter2();
        this.log = log;

        this.CURR = {
            idle: peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.IDLE),
            workOk: peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.WORK_OK),
            overload: peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.OVERLOAD),
            short: peekValueInRange(STORAGE_CONSTANTS.CURRENT_RANGE.SHORT),
        };

        this.pendingTimers = new Set();
        this.matrixListenerOff = null;
    }

    _delay(ms) {
        return new Promise((res) => {
            const t = setTimeout(() => {
                this.pendingTimers.delete(t);
                res();
            }, ms);
            this.pendingTimers.add(t);
        });
    }

    /**
     * Инициализация штатных начальных показаний датчиков спирального хранилища в покое (IDLE)
     * и подключение базового авто-ACK для канала управления матрицей `matrixCtrlChannel`.
     */
    seedDefaultHardware() {
        const tamperChannels = this.channels?.spiralTamperChannels ?? [];
        const rowsCount = tamperChannels.length || (this.size?.rows ?? 8);

        const initial = {};
        if (this.channels?.current) initial[this.channels.current] = this.CURR.idle;
        if (this.channels?.voltage) initial[this.channels.voltage] = STORAGE_CONSTANTS.SUPPLY_VOLTAGE;
        if (this.channels?.short) initial[this.channels.short] = 0;
        if (this.channels?.psuWork) initial[this.channels.psuWork] = 1;
        if (this.channels?.monSpirals) initial[this.channels.monSpirals] = null;

        for (let r = 0; r < rowsCount; r++) {
            const chName = tamperChannels[r];
            if (chName) {
                initial[chName] = STORAGE_CONSTANTS.TAMPER_ON;
            }
        }

        this.proxy.seed(initial);

        if (this.channels?.matrixCtrlChannel && !this.matrixListenerOff) {
            this.attachMatrixBehavior();
        }
    }

    /** Алиас `seedDefaultHardware()` для совместимости с утилитарными тестами */
    seedDefaultSensors() {
        this.seedDefaultHardware();
    }

    /**
     * Установка значения тока и прокачка буфера `_I_CurrBuffer` (size = 2).
     * @param {number} ampValue
     * @param {{ pushToBuffer?: boolean, samples?: number }} [opts]
     */
    setCurrent(ampValue, { pushToBuffer = true, samples = 2 } = {}) {
        if (pushToBuffer) {
            for (let i = 0; i < samples; i++) {
                this.proxy.inject(this.channels.current, ampValue, { emit: true });
            }
        } else {
            this.proxy.inject(this.channels.current, ampValue, { emit: false });
        }
    }

    /**
     * Подача импульса тока (например, пусковой бросок или кратковременная помеха) на время `durationMs`
     * с последующим возвратом к значению `resumeCurrent`.
     * @param {number} spikeCurrent
     * @param {number} durationMs
     * @param {number} [resumeCurrent]
     */
    async pulseCurrent(spikeCurrent, durationMs, resumeCurrent = this.CURR.workOk) {
        this.setCurrent(spikeCurrent, { pushToBuffer: true });
        await this._delay(durationMs);
        this.setCurrent(resumeCurrent, { pushToBuffer: true });
    }

    /**
     * Установка значения напряжения и прокачка буфера `_V_VoltBuffer` (size = 3).
     * @param {number} voltValue
     * @param {{ pushToBuffer?: boolean, samples?: number }} [opts]
     */
    setVoltage(voltValue, { pushToBuffer = true, samples = 3 } = {}) {
        if (pushToBuffer) {
            for (let i = 0; i < samples; i++) {
                this.proxy.inject(this.channels.voltage, voltValue, { emit: true });
            }
        } else {
            this.proxy.inject(this.channels.voltage, voltValue, { emit: false });
        }
    }

    /**
     * Установка сигнала тампера для указанного ряда (TAMPER_ON = 0, TAMPER_OFF = 1).
     * @param {number} row
     * @param {boolean} isOn
     * @param {{ emit?: boolean }} [opts]
     */
    setRowTamper(row, isOn, { emit = true } = {}) {
        const val = isOn ? STORAGE_CONSTANTS.TAMPER_ON : STORAGE_CONSTANTS.TAMPER_OFF;
        this.proxy.inject(this.channels.spiralTamperChannels[row], val, { emit });
    }

    /**
     * Генерирует одиночный оборот спирали (сход с концевика TAMPER_OFF -> возврат в TAMPER_ON)
     * для указанного ряда `row`.
     * @param {number} row
     * @param {number} [pulseOffMs=15]
     */
    async pulseRowTamper(row, pulseOffMs = 15) {
        this.setRowTamper(row, false, { emit: true });
        if (pulseOffMs > 0) {
            await this._delay(pulseOffMs);
        }
        this.setRowTamper(row, true, { emit: true });
    }

    /**
     * Настраивает реакцию драйвера матрицы `matrixCtrlChannel` на вызовы `MotorStep`:
     * - подтверждает команду через `${matrixCtrlChannel}-value` (если не включен `silentAck`)
     * - управляет током на шагах `On(step: 1)`, `On(step: 2)` и `Off(step: 1/2)`
     */
    attachMatrixBehavior({
        silentAck = false,
        driverError = null,
        step1Current = this.CURR.idle,
        step2Current = this.CURR.workOk,
        offStep1Current = this.CURR.idle,
        shortOnStep1 = false,
        onMotorFullStart = null,
    } = {}) {
        if (this.matrixListenerOff) {
            this.matrixListenerOff();
            this.matrixListenerOff = null;
        }

        this.matrixListenerOff = this.proxy.onSet(this.channels.matrixCtrlChannel, (payload) => {
            if (silentAck) {
                return;
            }

            queueMicrotask(() => {
                if (driverError) {
                    this.proxy.emitChannelValue(this.channels.matrixCtrlChannel, { error: driverError });
                    return;
                }

                this.proxy.emitChannelValue(this.channels.matrixCtrlChannel, { ok: true, cmd: payload });

                if (!payload || typeof payload !== 'object') return;
                const { target, cmd, args } = payload;
                const step = args?.[0]?.step;

                if (cmd === 'On' && step === 1) {
                    if (shortOnStep1) {
                        this.setCurrent(this.CURR.short);
                        this.setVoltage(COMMON_CONSTANTS.MIN_VOLTAGE - 2);
                    } else {
                        this.setCurrent(step1Current);
                    }
                } else if (cmd === 'On' && step === 2) {
                    this.setCurrent(step2Current);
                    if (typeof onMotorFullStart === 'function') {
                        onMotorFullStart(target);
                    }
                } else if (cmd === 'Off') {
                    if (step === 1) {
                        this.setCurrent(offStep1Current);
                    } else {
                        this.setCurrent(this.CURR.idle);
                    }
                }
            });
        });

        return this.matrixListenerOff;
    }

    /**
     * Автоматическая симуляция вращения спирали на `rotationsCount` оборотов
     * после полного двухшагового включения мотора (`cmd: 'On', step: 2`).
     */
    simulateRotations({
        cols = this.size?.cols ?? 12,
        rotationsCount = 1,
        firstPulseDelayMs = 300 + STORAGE_CONSTANTS.TAMPER_DEBOUNCE + 80,
        betweenPulsesMs = 40,
    } = {}) {
        return this.attachMatrixBehavior({
            onMotorFullStart: async (unitIndex) => {
                const row = Math.floor(unitIndex / cols);
                await this._delay(firstPulseDelayMs);
                for (let i = 0; i < rotationsCount; i++) {
                    await this.pulseRowTamper(row, 15);
                    if (i < rotationsCount - 1) {
                        await this._delay(betweenPulsesMs);
                    }
                }
            },
        });
    }

    getState() {
        return {
            current: this.proxy?.GetValue(this.channels?.current),
            voltage: this.proxy?.GetValue(this.channels?.voltage),
        };
    }

    cleanup() {
        if (this.matrixListenerOff) {
            this.matrixListenerOff();
            this.matrixListenerOff = null;
        }
        for (const t of this.pendingTimers) {
            clearTimeout(t);
        }
        this.pendingTimers.clear();
    }

    reset() {
        this.cleanup();
    }
}

module.exports = { SpiralSection };
