const { EventEmitter2 } = require('eventemitter2');
const { LIFT_CONSTANTS, COMMON_CONSTANTS } = require('../js/constants.js');
const { peekValueInRange } = require('../js/utils/emuUtils.js');

/**
 * Эмулятор подсистемы лифта (Lift), работающий напрямую через ProxyChannelStub.
 */
class Lift {
    /**
     * @param {object} params
     * @param {import('../../../tests/helpers/ProxyChannelStub.js').ProxyChannelStub} params.proxy
     * @param {import('../../srvSpiralSection/js/srvSpiralSectionLift.js').TypeSpiralSectionLiftChannels} params.channels
     * @param {EventEmitter2} [params.events]
     * @param {Function} [params.log=console.log]
     */
    constructor({ proxy, channels, events, log = console.log }) {
        this.proxy = proxy;
        this.channels = channels;
        this.events = events ?? new EventEmitter2();
        this.log = log;

        this.CURR = {
            idle: peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.IDLE),
            workOk: peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.WORK_OK),
            overload: peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.OVERLOAD),
            short: peekValueInRange(LIFT_CONSTANTS.CURRENT_RANGE.SHORT),
        };

        this.pendingTimers = new Set();
        this.motorListenerOff = null;
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
     * Начальная инициализация каналов лифта (по умолчанию на 0-м уровне, мотор выключен, ток IDLE, 24V).
     * @param {{ atBottom?: boolean }} [opts]
     */
    seedDefaultHardware({ atBottom = true } = {}) {
        const initial = {};
        if (this.channels?.liftMotorCtrl) {
            initial[this.channels.liftMotorCtrl] = 'STOP';
        }
        if (this.channels?.liftBottomTamper) {
            initial[this.channels.liftBottomTamper] = atBottom
                ? LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_ON
                : LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_OFF;
        }
        if (this.channels?.liftTopTamper) {
            initial[this.channels.liftTopTamper] = LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_OFF;
        }
        if (this.channels?.liftLevelSensor) {
            initial[this.channels.liftLevelSensor] = LIFT_CONSTANTS.LIFT_LEVEL_OFF;
        }
        if (this.channels?.current) {
            initial[this.channels.current] = this.CURR.idle;
        }
        if (this.channels?.voltage) {
            initial[this.channels.voltage] = LIFT_CONSTANTS.WORK_VOLTAGE;
        }
        if (this.channels?.short) {
            initial[this.channels.short] = 0;
        }
        if (this.channels?.psuWork) {
            initial[this.channels.psuWork] = 1;
        }
        this.proxy.seed(initial);
    }

    /** Алиас `seedDefaultHardware()` для совместимости с утилитарными тестами */
    seedDefaultSensors(opts) {
        this.seedDefaultHardware(opts);
    }

    /**
     * Установка точечного значения датчика тока и прокачка буфера `_I_CurrBuffer` (size = 5).
     * @param {number} ampValue
     * @param {{ pushToBuffer?: boolean, samples?: number }} [opts]
     */
    setCurrent(ampValue, { pushToBuffer = true, samples = 5 } = {}) {
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
     * Установка напряжения ИП и прокачка буфера `_V_VoltBuffer` (size = 4).
     * @param {number} voltValue
     * @param {{ pushToBuffer?: boolean, samples?: number }} [opts]
     */
    setVoltage(voltValue, { pushToBuffer = true, samples = 4 } = {}) {
        if (pushToBuffer) {
            for (let i = 0; i < samples; i++) {
                this.proxy.inject(this.channels.voltage, voltValue, { emit: true });
            }
        } else {
            this.proxy.inject(this.channels.voltage, voltValue, { emit: false });
        }
    }

    /**
     * Переключение нижнего концевика лифта.
     * @param {boolean} isOn
     * @param {{ emit?: boolean }} [opts]
     */
    setBottomTamper(isOn, { emit = true } = {}) {
        const val = isOn
            ? LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_ON
            : LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_OFF;
        this.proxy.inject(this.channels.liftBottomTamper, val, { emit });
    }

    /**
     * Генерация сигнала датчика уровня полки.
     * @param {boolean} isOn
     * @param {{ emit?: boolean }} [opts]
     */
    setLevelSensor(isOn, { emit = true } = {}) {
        const val = isOn
            ? LIFT_CONSTANTS.LIFT_LEVEL_ON
            : LIFT_CONSTANTS.LIFT_LEVEL_OFF;
        this.proxy.inject(this.channels.liftLevelSensor, val, { emit });
    }

    /**
     * Срабатывание верхнего аварийного концевика.
     */
    triggerTopTamper() {
        this.proxy.inject(this.channels.liftTopTamper, LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_ON, { emit: true });
    }

    /**
     * Одиночный импульс датчика уровня полки (0 -> 1 -> 0).
     * @param {number} [pulseWidthMs=15]
     */
    async pulseLevelSensor(pulseWidthMs = 15) {
        this.setLevelSensor(false, { emit: true });
        this.setLevelSensor(true, { emit: true });
        if (pulseWidthMs > 0) {
            await this._delay(pulseWidthMs);
        }
        this.setLevelSensor(false, { emit: true });
    }

    /**
     * Авто-реакция привода лифта на команды `liftMotorCtrl`:
     * - при `'UP'` / `'DOWN'` подает ток `workCurrent` (или сценарий КЗ)
     * - при `'STOP'` опускает ток до `stopCurrent`
     */
    attachMotorBehavior({
        workCurrent = this.CURR.workOk,
        stopCurrent = this.CURR.idle,
        shortOnStart = false,
        onStartMove = null,
    } = {}) {
        if (this.motorListenerOff) {
            this.motorListenerOff();
            this.motorListenerOff = null;
        }

        this.motorListenerOff = this.proxy.onSet(this.channels.liftMotorCtrl, (cmd) => {
            if (cmd === 'UP' || cmd === 'DOWN') {
                if (cmd === 'UP') {
                    this.setBottomTamper(false, { emit: true });
                }
                if (shortOnStart) {
                    this.setCurrent(this.CURR.idle);
                    this.setVoltage(COMMON_CONSTANTS.MIN_VOLTAGE - 2);
                    return;
                }
                this.setCurrent(workCurrent);
                if (typeof onStartMove === 'function') {
                    onStartMove(cmd);
                }
            } else if (cmd === 'STOP') {
                this.setCurrent(stopCurrent);
            }
        });

        return this.motorListenerOff;
    }

    /**
     * Автоматическая симуляция прохождения `stepsCount` уровней с интервалом `stepIntervalMs`,
     * либо замыкания нижнего концевика при движении вниз к 0-му уровню.
     */
    simulateTravel({ stepsCount = 0, reachBottom = false, startDelayMs = 70, stepIntervalMs = 25 } = {}) {
        return this.attachMotorBehavior({
            onStartMove: async (cmd) => {
                await this._delay(startDelayMs);
                for (let i = 0; i < stepsCount; i++) {
                    if (this.proxy.GetValue(this.channels.liftMotorCtrl) === 'STOP') return;
                    await this.pulseLevelSensor(10);
                    await this._delay(stepIntervalMs);
                }
                if (reachBottom && cmd === 'DOWN') {
                    if (this.proxy.GetValue(this.channels.liftMotorCtrl) === 'STOP') return;
                    this.setBottomTamper(true, { emit: true });
                }
            },
        });
    }

    getState() {
        return {
            current: this.proxy?.GetValue(this.channels?.current),
            voltage: this.proxy?.GetValue(this.channels?.voltage),
            liftBottomTamper: this.proxy?.GetValue(this.channels?.liftBottomTamper),
            liftLevelSensor: this.proxy?.GetValue(this.channels?.liftLevelSensor),
        };
    }

    cleanup() {
        if (this.motorListenerOff) {
            this.motorListenerOff();
            this.motorListenerOff = null;
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

module.exports = { Lift };
