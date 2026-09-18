const { EventEmitter2 } = require("eventemitter2");
const { createTimer, isWithinTolerance, ClassFault } = require("./srvUtils");
const { ClassFSM: FSM } = require("./srvFSM");
const { STORAGE_CONSTANSTS, FAULTS, U_TRANSACTIONS, COMMON_CONSTANTS } = require("./SpiralSectionConstants");
const { default: SpiralSectionState, } = require("./srvSpiralSectionStates");
const { SPIRAL_CELL_STATE, CELL_ACTION } = require("../../srvStatesController/ts/ISpiralSectionStates");
const { default: StatesController } = require("../../srvStatesController/js/srvSectionStateController");
const STATUS_EXCEPT = [SPIRAL_CELL_STATE.ACTUATOR_NO_POWER, SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT, SPIRAL_CELL_STATE.ERR_TAMPER];
const ClassBuffer = require('../../../../HorizonServer/js/srvUtils/js/buffer');

const MOTOR_RES_MAX_TIME = 1000;
const TIME_BETWEEN_STEPS = 300;

let sleep = require('timers/promises').setTimeout;

const { ELECTR_CURR_STATE, TAMPER_ON, TAMPER_OFF, CURRENT_RANGE, FULL_ROTATION_TIMEOUT, MONITOR_INTERVAL, TAMPER_DEBOUNCE } = STORAGE_CONSTANSTS;
const STATE = {
    IDLE: 'IDLE',
    DISPENSING: 'COLLECTING ',
    FAULT: 'OUT_OF_SERVICE',
    TESTING: 'TESTING',
    RUNNING_MOTOR: 'RUNNING_MOTOR'
}

/**
 * @implements {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage}
 */
class ClassSpiralSectionStorage {

    /** @type {typeof import("./srvSpiralSectionStorage").ClassSpiralSectionStorage.STATE} */
    static STATE = STATE;

    /**@type {import("./srvSpiralSection").TypeProxyCh} */
    #_ProxyCh;
    /** @type {import("./srvSpiralSectionStorage").TypeSpiralSectionStorageChannels} */
    #_Channels = null;
    /** @type {StatesController} */
    #_GlobalState = null;
    /** @type {SpiralSectionState} */
    #_SectionState = null;
    /** @type {import("./srvSpiralSectionStorage").TypeSpiralSectionContext} */
    #_Context = {};
    /**@type {EventEmitter2} */
    #_Events = new EventEmitter2();
    #_uTransactionsList = [];
    #_StatesGraph = {
        [STATE.IDLE]: {
            [this.EVENTS.DISPENSE_COMMAND]: { state: STATE.DISPENSING, action: this._Dispense.bind(this) },
            [this.EVENTS.FAULT]:            { state: STATE.FAULT,   action: this.OnFault.bind(this) },
            [this.EVENTS.TEST_COMMAND]:     { state: STATE.TESTING, action: this._TestSpiral.bind(this) },
            [this.EVENTS.RUN_MOTOR_COMMAND]:{ state: STATE.RUNNING_MOTOR, action: this._RunMotor.bind(this) }
        },
        [STATE.DISPENSING]: {
            [this.EVENTS.DISPENSED_SINGLE]: { state: STATE.DISPENSING, action: this.OnDispensedSingle.bind(this) },
            [this.EVENTS.ROTATE_TIMEOUT]:   { state: STATE.DISPENSING, action: this.OnTimeout.bind(this) },
            [this.EVENTS.COMPLETED]:        { state: STATE.IDLE,       action: this.Idle.bind(this) },
            [this.EVENTS.FAULT]:            { state: STATE.FAULT,      action: this.OnFault.bind(this) },
        },
        [STATE.FAULT]: {
            [this.EVENTS.RECOVERED]: { state: STATE.IDLE, action: ()=>{}/*this.Idle.bind(this)*/ }
        },
        [STATE.TESTING]: {
            [this.EVENTS.TEST_DONE]: { state: STATE.IDLE,  action: this.Idle.bind(this) },
            [this.EVENTS.FAULT]:     { state: STATE.FAULT, action: this.OnFault.bind(this) }
        },
        [STATE.RUNNING_MOTOR]: {
            [this.EVENTS.RUN_MOTOR_DONE]: { state: STATE.IDLE,  action: this.Idle.bind(this) },
            [this.EVENTS.FAULT]:          { state: STATE.FAULT, action: this.OnFault.bind(this) }
        }
    };
    #_FSM = new FSM({ stateGraph: this.#_StatesGraph, onStateChanged: this.OnStateChanged.bind(this), defaultState: ClassSpiralSectionStorage.STATE.IDLE });
    #_Polling = false;
    #_PSUWatch = null;
    #_TamperPosWatch = null;
    #_ChHandlers = new Map();
    /**
     * @param {object} param0
     * @param {import("./srvSpiralSection").TypeProxyCh} param0.ProxyCh
     * @param {import("./srvSpiralSectionStorage").TypeSpiralSectionStorageChannels} param0.channels 
     * @param {import("./srvSpiralSectionStorage").TypeSpiralSectionStorageOpts} param0.advOpts
     * @param {SpiralSectionState} param0.sectionState
     * @param {import("./srvSpiralSection").TypeProxyLogger} param0.ProxyLogger
     */
    constructor({ ProxyCh, channels, advOpts, sectionState, ProxyLogger }) {
        this.#_ProxyCh = ProxyCh;
        /** @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_ProxyLogger']} */
        this._ProxyLogger = ProxyLogger;
        this.#_Channels = channels;
        this.#_GlobalState = advOpts.globalState;
        this.#_SectionState = sectionState;
        /** @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_BusNumber']} */
        this._BusNumber = advOpts.busNumber;
        let { rows, cols } = advOpts.size;
        this.#_Context = {
            rows,
            cols,
            currentOrder: null,
            units: Array(rows * cols).fill().map((_, i) => ({
                index: i,
                coords: this.IndexToPos(i, cols),
                tamperInd: Math.floor(i / cols),
                itemsLoaded: 999,
                itemsLeft: 999,
                capacity: 999,
                itemsDispensed: 0,
                status: SPIRAL_CELL_STATE.OK
            }))
        };
        /** @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_I_CurrBuffer']} */
        this._I_CurrBuffer = new ClassBuffer({ size: 2 });
        /** @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_V_VoltBuffer']} */
        this._V_VoltBuffer = new ClassBuffer({ size: 3 });
        this.Init();
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['EVENTS']}
     */
    get EVENTS() {
        return ({
            DISPENSE_COMMAND: 'DISPENSE_COMMAND',
            DISPENSED_SINGLE: 'DISPENSED_SINGLE',
            COMPLETED: 'DISPENSED',
            ROTATE_TIMEOUT: 'ROTATE_TIMEOUT',
            FAULT: 'ERROR',
            RECOVERED: 'RECOVERED',
            TEST_COMMAND: 'TEST_COMMAND',
            TEST_DONE: 'TEST_DONE',
            RUN_MOTOR_COMMAND: 'RUN_MOTOR_COMMAND',
            RUN_MOTOR_DONE: 'RUN_MOTOR_DONE',
        });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Events']}
     */
    get Events() {
        // TODO: add proxy
        return this.#_Events;
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['MaxLevel']}
     */
    get MaxLevel() { return this.#_Context?.rows; }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['State']}
     */
    get State() { return this.#_FSM.State; }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['IsAvailable']}
     */
    IsAvailable({ row, column }) {
        const ind = this.PosToInd({ row, col: column });
        return [SPIRAL_CELL_STATE.OK, SPIRAL_CELL_STATE.ERR_TAMPER, SPIRAL_CELL_STATE.ACTUATOR_NO_POWER].includes(this.#_SectionState.Cells[ind].Status);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['IsCheckable']}
     */
    IsCheckable({ row, column, col }) {
        column = column ?? col;
        for (let u of this.RowIterator(row)) {
            if (u.status == SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT)
                return false;
        }
        const ind = this.PosToInd({ row, col: column });
        return [SPIRAL_CELL_STATE.OK, SPIRAL_CELL_STATE.ERR_TAMPER_BAD_POS, SPIRAL_CELL_STATE.ACTUATOR_NO_POWER].includes(this.#_SectionState.Cells[ind].Status);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['RowIterator']}
     */
    *RowIterator(rowIndex) {
        const { rows, cols, units } = this.#_Context;

        if (rowIndex < 0 || rowIndex >= rows)
            throw new RangeError('rowIndex out of bounds');

        const start = rowIndex * cols;
        const end = start + cols;

        for (let i = start; i < end; i++) {
            yield units[i];
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['RowIndexIterator']}
     */
    *RowIndexIterator(rowIndex) {
        const { rows, cols, units } = this.#_Context;

        if (rowIndex < 0 || rowIndex >= rows)
            throw new RangeError('rowIndex out of bounds');

        const start = rowIndex * cols;
        const end = start + cols;

        for (let i = start; i < end; i++) {
            yield units[i];
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['ColIterator']}
     */
    *ColIterator(colIndex) {
        const { rows, cols, units } = this.#_Context;

        if (colIndex < 0 || colIndex >= cols)
            throw new RangeError('colIndex out of bounds');

        for (let row = 0; row < rows; row++) {
            yield units[row * cols + colIndex];
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Init']}
     */
    Init() {
        this.InitEventHandlers();
        this.StartPSUWatch();

        this.MotorOffAll().catch((fault) => {
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE] Ошибка при выключении мотора на старте`, 
                obj: fault 
            });
        });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['InitEventHandlers']}
     */
    InitEventHandlers() {
        this.SetTamperHandlers();
        this.SetCurrentHandler();
        this.SetVoltageHandler();
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['SetTamperHandlers']}
     */
    SetTamperHandlers() {
        /** Tamper trigger handler */
        let cachedValues = Array.from({ length: this.#_Channels.spiralTamperChannels.length }).fill(undefined);
        for (let i = 0; i < this.#_Channels.spiralTamperChannels.length; i++) {

            const handler = (({ Value }) => {
                if (this.#_Polling && Value != cachedValues[i] && Value == TAMPER_ON) {
                    this._ProxyLogger.Log({ level: 'D', msg: `[Storage] сигнал с тампера спирали`, obj: { tamperInd: i } });
                    this.#_FSM.Dispatch(this.EVENTS.DISPENSED_SINGLE, { tamperInd: i });
                }
                cachedValues[i] = Value;
            }).bind(this);
            let eventName = `${this.#_Channels.spiralTamperChannels[i]}-value`;
            this.#_ChHandlers.set(eventName, handler);
            this.#_ProxyCh.Events.on(eventName, handler);
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['SetCurrentHandler']}
     */
    SetCurrentHandler() {
        const I_currEventName = `${this.#_Channels.current}-value`;
        const I_currHandler = (({ Value }) => {
            // if (this.State == ClassSpiralSectionStorage.STATE.DISPENSING)
            this._I_CurrBuffer.push(Value);
        }).bind(this);

        this.#_ProxyCh.Events.on(I_currEventName, I_currHandler);
        this.#_ChHandlers.set(I_currEventName, I_currHandler);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['SetVoltageHandler']}
     */
    SetVoltageHandler() {
        const V_voltEventName = `${this.#_Channels.voltage}-value`;
        const V_voltHandler = (({ Value }) => this._V_VoltBuffer.push(Value)).bind(this);

        this.#_ProxyCh.Events.on(V_voltEventName, V_voltHandler);
        this.#_ChHandlers.set(V_voltEventName, V_voltHandler);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['StartPSUWatch']}
     */
    StartPSUWatch() {
        if (this.#_PSUWatch) clearInterval(this.#_PSUWatch);

        this.nopower_count = 0;

        this.#_PSUWatch = setInterval(() => {
            if (this.State != ClassSpiralSectionStorage.STATE.DISPENSING) {
                this.nopower_count = 0;
                this.ClearOverloadStatus();
                return;
            };
            let I_curr = this._I_CurrBuffer.Filter();
            let I_currState = this.#_ProxyCh.GetValue(this.#_Channels.short) == STORAGE_CONSTANSTS.SHORT_CH_VAL 
                            ? ELECTR_CURR_STATE.SHORT 
                            : this.CheckCurrentState(I_curr);

            let index = this.#_Context.currentOrder?.unitIndex;
            if (typeof index != 'number') return;
            // console.log(JSON.stringify({ state: this.#_FSM.State, I_curr, I_im: this.#_ProxyCh.GetValue(this.#_Channels.current), I_currState}));
            switch (I_currState) {
                case ELECTR_CURR_STATE.SHORT:
                    if (this.#_SectionState.Cells[index].Status != SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT) {
                        this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Мониторинг зафиксировал КЗ. Ток: ${I_curr}` });
                            this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.ACTUATOR_SHORT_CIRCUIT, index }));
                    } else {
                        // Повторно записываем статус, чтобы обновить время последнего изменения но не запускаем реакцию
                        this.#_SectionState.Cells[index].Status = SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT;
                    }
                    break;

                case ELECTR_CURR_STATE.OVERLOAD:
                    if (this.#_SectionState.Cells[index] == SPIRAL_CELL_STATE.OK)
                        this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.OVERLOAD_I })
                    break;

                case ELECTR_CURR_STATE.IDLE:
                    if (this.#_SectionState.Cells[index] != SPIRAL_CELL_STATE.ACTUATOR_NO_POWER) 
                        if (++this.nopower_count == 6) {
                            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Мониторинг зафиксировал отсутствие питания. Ток: ${I_curr}` });
                            this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.ACTUATOR_NO_POWER, index }));
                        } else {
                            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Мониторинг зафиксировал возможное отсутствие питания. Ток: ${I_curr}` });
                        }
                        this.ClearOverloadStatus();

                    break;

                case ELECTR_CURR_STATE.WORK_OK:
                    this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.OK });
                    this.nopower_count = 0;
                    this.ClearOverloadStatus();
                
                default:
                    this.nopower_count = 0;
            }

            const V_voltage = this._V_VoltBuffer.Filter();
            
            // TODO: контроль заниженного напряжения

        }, MONITOR_INTERVAL);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['ClearOverloadStatus']}
     */
    ClearOverloadStatus() {
        for (let u of this.#_Context.units) {
            if (u.status == SPIRAL_CELL_STATE.OVERLOAD_I) 
                this.UpdateStorageContext({ index: u.index }, { scope: 'single', status: SPIRAL_CELL_STATE.OK });
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OnStateChanged']}
     */
    OnStateChanged({ eventName, state, prevState}) {
        this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] STATE: ${prevState} --[${eventName}]--> ${state}` });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OnDispensedSingle']}
     */
    async OnDispensedSingle({ tamperInd }) {
        this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Выдана 1 ед. тмц` });
        const indexInUse = this.#_Context.currentOrder.unitIndex;
        const unitInUse = this.#_Context.units[indexInUse];

        // сработал тампер который не должен был работать -> вероятно пробой
        /*if (unitInUse.tamperInd != tamperInd) {
            // await this.MotorOff(indexInUse);
            debugger
        }*/
        const { row, col: column } = unitInUse.coords;
        this.#_Events.emit('dispense', { row, column, quantity: 1 });
        this.#_FSM.Dispatch(this.EVENTS.DISPENSE_RESULT, unitInUse.coords);
        this.UpdateStorageContext({ index: indexInUse }, { dispensed: 1, scope: 'single' });
        const { itemsDispensed, itemsRequested, aborted } = this.#_Context.currentOrder;
        // if (itemsDispensed > itemsRequested) TODO: log error
        if (itemsDispensed >= itemsRequested || aborted) {
            this.#_Context.dispenseTimer?.clear();
            this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Сброс таймера (361)` });
            this.#_Polling = false;
            this.#_ProxyCh.SetValue(this.#_Channels.monSpirals, { Cell: this.PosToInd(unitInUse.coords), Rots: itemsDispensed });
            this.#_FSM.Dispatch(this.EVENTS.COMPLETED, { index: indexInUse, itemsDispensed, itemsRequested });
        } else {
            this.#_Context.dispenseTimer?.reset();
            this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Ресет таймера (366)` });
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OnTimeout']}
     */
    async OnTimeout({ index }) {
        this._ProxyLogger.Log({ level: 'D', msg: `[Storage] Таймаут выдачи. Index: ${index}` });

        this.#_Polling = false;
        this.#_Context.dispenseTimer?.clear();
        this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Сброс таймера (380)` });
        this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.ERR_TAMPER, index, critical: false }));
    }

    // OnCompleted(/*{ index, itemsDispensed, error }*/) {
    //     // TODO log
    //     this.Idle();
    // }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OnFault']}
     */
    async OnFault(fault) {
        this.#_Context.dispenseTimer?.clear?.();
        this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Fault: ${fault}`, obj: fault });
        this.UpdateStatus(fault);
        const { unitIndex } = this.#_Context?.currentOrder ?? {};
        try {
            if (fault.code == FAULTS.ACTUATOR_SHORT_CIRCUIT && this.#_Channels.psuWork) {
                this.OffPSU();
                await sleep(100);
                
                if (typeof unitIndex == 'number')
                    await this.MotorOff(unitIndex);
                else
                    await this.MotorOffAll();
                this._I_CurrBuffer.Clear();
                this._V_VoltBuffer.Clear();
                await sleep(100);
                this.OnPSU();
                let recovered = false;
                let elapsed = 0;
                while (elapsed < 20000) {
                    await sleep(1000);
                    this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Попытка восстановления: Iavg=${this._I_CurrBuffer.Filter()} V=${this._V_VoltBuffer.Filter()}` });
                    elapsed += 1000;
                    if (!this.IsShorted()) {
                        this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Успешное восстановление после перезагрузки ИП.` });
                        recovered = true;
                        break;
                    } 
                }
                if (!recovered) {
                    this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Признаки КЗ после перезагрузки ИП. Требуется ручное исправление.` });
                    throw new StorageFault({ code: FAULTS.ACTUATOR_SHORT_CIRCUIT });
                }
                await sleep(1000);
            } else {
                if (typeof unitIndex == 'number') {
                    const { row, col: column } = this.#_Context.units[unitIndex].coords;
                    this.#_Events.emit('fail', { row, column }, fault);
                    this.MotorOff(unitIndex);
                }
            }
            this.#_FSM.Dispatch(this.EVENTS.RECOVERED);

        } catch (innerFault) {
            console.log(innerFault);
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE] Ошибка при попытке выполнении OnFault()`,
                obj: { fault, innerFault } 
            });
            // this.OffPSU();
            this.UpdateStatus(innerFault);
        } finally {
            this.#_Context.fallbackTimer?.clear?.();
            this.#_Context.dispenseTimer?.clear?.();
            this.#_Context.currentTask?.rej?.(fault);
            this.#_Context.currentTask = null;
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OffPSU']}
     */
    OffPSU() {
        this._ProxyLogger.Log({ level: 'I', msg: '[STORAGE] Выключение ИП' });
        this.#_ProxyCh.SetValue(this.#_Channels.psuWork, 0);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['OnPSU']}
     */
    OnPSU() {
        this._ProxyLogger.Log({ level: 'I', msg: '[STORAGE] Включение ИП' });
        this.#_ProxyCh.SetValue(this.#_Channels.psuWork, 1);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Idle']}
     */
    async Idle(/*{ index }*/) {
        this.#_Context.fallbackTimer?.clear();
        this.#_Context.dispenseTimer?.clear();

        const index = this.#_Context.currentOrder?.unitIndex;
        try {
            if (typeof index == 'number') {
                await this.MotorOff(index, { force: true });
            } else {
                this._ProxyLogger.Log({ level: 'W', msg: `[STORAGE] Не удалось определить индекс мотора над которым выполнялись операции перед переходом в IDLE` });
            }
            if (this.#_Context.currentTask) {
                this.#_Context.currentOrder = null;
                this.#_Context.dispenseTimer = null;
                this.#_Context.currentTask?.res?.();
                this.#_Context.currentTask = null;
            }

        } catch (fault) {
            this.EmergencyOff();
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['EmergencyOff']}
     */
    EmergencyOff() {

    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Dispense']}
     */
    async Dispense(order, manual=false) {
        return new Promise((res, rej) => {
            const index = this.PosToInd({ row: order.row, col: order.column });
            if (index > this.#_Context.units.length || typeof order.quantity != 'number' || order.quantity < 1)
                return rej(new Error('[Storage] Невалидные параметры'));

            /*let state = this.CheckCurrent();
            if (state != ELECTR_CURR_STATE.IDLE)
                return rej(new Error(''));*/

            if (this.#_Context.currentTask) {
                return rej(new Error('[Storage] Выполняется предыдущая операция'));
            }
            this.#_Context.currentTask = { res, rej };
            this.#_Context.currentOrder = {
                unitIndex: index,
                itemsRequested: order.quantity,
                itemsDispensed: 0,
                manual
            };
            const MAX_TIME = order.quantity * STORAGE_CONSTANSTS.FULL_ROTATION_TIMEOUT * 2;
            this.#_Context.fallbackTimer = createTimer(
                () => this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.NONE })),
                MAX_TIME).set();

            this.#_FSM.Dispatch(this.EVENTS.DISPENSE_COMMAND, order, manual);
        });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['TestSpiral']}
     */
    async TestSpiral(order) {
        return new Promise((res, rej) => {
            if (this.#_Context.currentTask) {
                return rej(new Error('[Storage] Выполняется предыдущая операция'));
            }
            const index = this.PosToInd(order);
            this.#_Context.currentOrder = {
                unitIndex: index,
                itemsRequested: 0,
                itemsDispensed: 0,
            };
            this.#_Context.currentTask = { res, rej };
            this.#_FSM.Dispatch(this.EVENTS.TEST_COMMAND, order);
        });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['RunMotor']}
     */
    async RunMotor({ row, column, duration }) {
        return new Promise((res, rej) => {
            const index = this.PosToInd({ row, col: column });
            if (index >= this.#_Context.units.length || typeof duration != 'number' || duration <= 0)
                return rej(new Error('[Storage] Невалидные параметры'));

            if (this.#_Context.currentTask) {
                return rej(new Error('[Storage] Выполняется предыдущая операция'));
            }

            this.#_Context.currentTask = { res, rej };
            this.#_Context.currentOrder = { unitIndex: index, manual: true };
            this.#_FSM.Dispatch(this.EVENTS.RUN_MOTOR_COMMAND, { row, column, duration });
        });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_Dispense']}
     */
    async _Dispense(order, manual=false) {
        const index = this.PosToInd({ row: order.row, col: order.column });

        const onTimeout = (() => this.#_FSM.Dispatch(this.EVENTS.ROTATE_TIMEOUT, { index })).bind(this);
        this.#_Context.dispenseTimer = createTimer(onTimeout, FULL_ROTATION_TIMEOUT-TIME_BETWEEN_STEPS).set();

        try {
            await this.MotorOnPhased(index);
            this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Включен мотор` });
            this.#_SectionState.Cells[index].Action = CELL_ACTION.ACTION;
            this._PollingTimeout = setTimeout(() => {
                this.#_Polling = true;
            }, manual ? 0 : TAMPER_DEBOUNCE);
        } catch (fault) {
            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Ошибка при включении мотора: ${JSON.stringify(fault)}`, obj: fault });
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault);
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_RunMotor']}
     */
    async _RunMotor({ row, column, duration }) {
        const index = this.PosToInd({ row, col: column });
    
        const onTimeout = (() => this.#_FSM.Dispatch(this.EVENTS.RUN_MOTOR_DONE)).bind(this);

        try {
            await this.MotorOnPhased(index);
            this.#_Context.dispenseTimer = createTimer(onTimeout, Math.max(duration-2*TIME_BETWEEN_STEPS, 0)).set();

            this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] Включен мотор на ${duration}мс` });
        } catch (fault) {
            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Ошибка при включении мотора по времени: ${JSON.stringify(fault)}`, obj: fault });
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault);
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['CheckCurrentState']}
     */
    CheckCurrentState(currVal) {
        /**@type {number} */
        let currentAmp = currVal ?? this._I_CurrBuffer.Filter();
        if (typeof currentAmp != 'number')
            return;

        for (let [levelName, [lowLim, highLim]] of Object.entries(CURRENT_RANGE)) {
            if (currentAmp >= lowLim && currentAmp < highLim) {
                return ELECTR_CURR_STATE[levelName];
            }
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['UnitsByScope']}
     */
    *UnitsByScope(index, scope) {
        const { row, col } = this.#_Context.units[index].coords;

        switch (scope) {
            case 'single':
                yield this.#_Context.units[index];
                break;

            case 'row':
                yield* this.RowIterator(row);
                break;

            case 'col':
                yield* this.ColIterator(col);
                break;

            case 'all':
                yield* this.#_Context.units;
                break;

            default:
                throw new Error('Invalid scope');
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['UpdateStorageContext']}
     */
    UpdateStorageContext({ index }, { dispensed = 0, scope='single', status, except = [] }) {
        if (this.#_Context.currentOrder)
            this.#_Context.currentOrder.itemsDispensed += dispensed;

        for (const unit of this.UnitsByScope(index, scope)) {
            unit.itemsDispensed += dispensed;

            if (status) {
                if (!except.includes(this.#_SectionState.Cells[index].Status)) {
                    unit.status = status;
                    this.#_SectionState.Cells[unit.index].Status = status;
                    this.#_Context.units[unit.index].status = status;
                }
            }
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['GetStorageInfo']}
     */
    GetStorageInfo({ index }) {
        return { ...this.#_SectionState.Cells[index].Status };
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['SetOutOfService']}
     */
    SetOutOfService() {
        // TODO
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['LogTransaction']}
     */
    LogTransaction(transName) {
        this.#_uTransactionsList.push(transName);  
        this._ProxyLogger.Log({ level: 'D', msg: `[STORAGE] ${transName}` });   
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['MotorOnPhased']}
     */
    async MotorOnPhased(index) {
        const { row } = this.IndexToPos(index);
        let step = 1;
        let current_0 = this.#_ProxyCh.GetValue(this.#_Channels.current); 

        this.LogTransaction(U_TRANSACTIONS.ACTUATOR_CONNECT_GND);

        await this.MotorStep('On', { index, step });

        await sleep(TIME_BETWEEN_STEPS);

        const tamperValue = this.#_ProxyCh.GetValue(this.#_Channels.spiralTamperChannels[row]);
        const shorted = this.IsShorted();
        const current_1 = this.#_ProxyCh.GetValue(this.#_Channels.current);

        if (shorted) {
            throw new StorageFault({ code: FAULTS.ACTUATOR_SHORT_CIRCUIT, index });
        }
        if (!isWithinTolerance(current_0, current_1, 0.1)) {
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE] Пробой ключа. Ток резко изменился (${current_0?.toFixed?.(2)} -> ${current_1?.toFixed?.(2)}) после Первого шага включения мотора ${index}.`,
                obj: { index } 
            });
            throw new StorageFault({ code: FAULTS.IO_PORT_ERR, index });
        }
        if (!this.#_Context.currentOrder.manual && tamperValue !== TAMPER_ON) {
            this._ProxyLogger.Log({ level: 'W', msg: `[STORAGE] Ряд ${row} блокируется из за сигнала ${tamperValue} на тампере (строка ${row})` });
            throw new StorageFault({ code: FAULTS.TAMPER_BAD_POS, index });
        }

        step = 2;
        this.LogTransaction(U_TRANSACTIONS.ACTUATOR_CONNECT_V_PLUS);

        await this.MotorStep('On', { index, step });

        await sleep(TIME_BETWEEN_STEPS);
        
        let current_2 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        if (isWithinTolerance(current_0, current_2, 0.1)) {
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE] Отсутствует питание после Второго шага включения мотора ${index}. Ток не изменился (${current_0?.toFixed?.(2)} -> ${current_2?.toFixed?.(2)})`,
                obj: { index } 
            });
            throw new StorageFault({ code: FAULTS.ACTUATOR_NO_POWER, index, critical: false });
        }
    } 

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['MotorStep']}
     */
    async MotorStep(cmd, param1) {
        const { index, step } = param1 ?? {};
        let all = typeof index != 'number' || typeof step != 'number';
        this.#_ProxyCh.SetValue(
            this.#_Channels.matrixCtrlChannel, {
            target: index,
            cmd,
            args: [{ step }]
        });
        
        let stepResponse = await this.#_ProxyCh.Events.waitFor(`${this.#_Channels.matrixCtrlChannel}-value`, {
            timeout: all ? MOTOR_RES_MAX_TIME * 2 : MOTOR_RES_MAX_TIME,
        }).catch(() => {
            // throw new Error(`Motor [${index}] error: no response from switch "${this.#_Channels.matrixCtrlChannel}"`);
            throw new StorageFault({ code: FAULTS.IO_TIMEOUT, index });
        });

        if (stepResponse?.[0]?.Value?.error) {
            throw new StorageFault({ code: FAULTS.IO_DRIVER_ERR, index });
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['_TestSpiral']}
     */
    async _TestSpiral({ row, column}) {
        const index = this.PosToInd({ row, col: column });
        let current_0 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        try {
            await this.MotorStep('On', { index, step: 1 });
        } catch (fault) {
            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] Ошибка при проверке позиции спирали: ${fault}`, obj: { index } });
            return this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault(fault));
        }
        await sleep(TIME_BETWEEN_STEPS);

        const tamperValue = this.#_ProxyCh.GetValue(this.#_Channels.spiralTamperChannels[row]);
        const current_1 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        const shorted = this.IsShorted();

        if (shorted) {
            return this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.ACTUATOR_SHORT_CIRCUIT, index }));
        }
        if (!isWithinTolerance(current_0, current_1, 0.05)) {
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE]  Пробой ключа. Ток резко изменился (${current_0?.toFixed?.(2)} -> ${current_1?.toFixed?.(2)}) после Первого шага включения мотора ${index}`, 
                obj: { index } 
            });
            return this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.IO_PORT_ERR, index }));
        }
        if (tamperValue !== TAMPER_ON) {
            this._ProxyLogger.Log({ 
                level: 'W', 
                msg: `[STORAGE] Ряд ${row} блокируется из за сигнала ${tamperValue} на тампере (строка ${row})`, 
                obj: { index } 
            });
            return this.#_FSM.Dispatch(this.EVENTS.FAULT, new StorageFault({ code: FAULTS.TAMPER_BAD_POS, index }));
        }
        try {
            await this.MotorOff(index);
            this.#_FSM.Dispatch(this.EVENTS.TEST_DONE);
        } catch (fault) {
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault);
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['MotorOff']}
     */
    async MotorOff(index) {
        let current_0 = this.#_ProxyCh.GetValue(this.#_Channels.current); 
        let isIdle = current_0 < CURRENT_RANGE.WORK_OK[0];

        this.LogTransaction(U_TRANSACTIONS.ACTUATOR_DISCONNECT_GND);
        await this.MotorStep('Off', { index, step: 1 });

        await sleep(TIME_BETWEEN_STEPS);

        let current_1 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        if (!isIdle && isWithinTolerance(current_0, current_1, 0.1)) {
            this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] index ${index} error: Source switch broken (${current_0?.toFixed?.(2)} -> ${current_1?.toFixed?.(2)})` });
            throw new StorageFault({ code: FAULTS.ACTUATOR_SHORT_CIRCUIT, index });
        }

        this.LogTransaction(U_TRANSACTIONS.ACTUATOR_DISCONNECT_V_PLUS);
        await this.MotorStep('Off', { index, step: 2 });
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['MotorOffAll']}
     */
    async MotorOffAll() {
        return this.MotorStep('Off', { index: undefined, step: undefined });
        // await sleep(TIME_BETWEEN_STEPS);
        // TODO: check current
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['IsShorted']}
     */
    IsShorted() {
        return  /*this._I_CurrBuffer.Filter()*/ this.#_ProxyCh.GetValue(this.#_Channels.current) > CURRENT_RANGE.SHORT[0] ||
                /*this._V_VoltBuffer.Filter()*/ this.#_ProxyCh.GetValue(this.#_Channels.voltage) <= COMMON_CONSTANTS.MIN_VOLTAGE;
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['IndexToPos']}
     */
    IndexToPos(index, _width) {
        let width = _width ?? this.#_Context.cols;
        return { row: Math.floor(index / width), col: index % width };
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['PosToInd']}
     */
    PosToInd({ row, col, column }) {
        return (row * this.#_Context.cols) + (col ?? column);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['GetLevelByIndex']}
     */
    GetLevelByIndex(index) {
        return this.#_Context.rows - Math.floor(index / this.#_Context.cols);
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['UpdateStatus']}
     */
    UpdateStatus(fault) {
        if (!(fault instanceof StorageFault)) return;
        const { index } = fault;
        if (typeof index != 'number') return;

        switch (fault.code) {
            case FAULTS.ERR_TAMPER:
                this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.ERR_TAMPER });
                break;

            case FAULTS.TAMPER_BAD_POS:
                this.UpdateStorageContext({ index }, { scope: 'row', status: SPIRAL_CELL_STATE.TAMPER_BAD_POS, except: STATUS_EXCEPT });
                break;

            case FAULTS.ACTUATOR_NO_POWER:
                this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.ACTUATOR_NO_POWER });
                break;

            case FAULTS.IO_DRIVER_ERR:
                this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.BLOCKED });
                break;

            case FAULTS.ACTUATOR_SHORT_CIRCUIT:
                this.UpdateStorageContext({ index }, { scope: 'row', status: SPIRAL_CELL_STATE.BLOCKED, except: STATUS_EXCEPT });
                this.UpdateStorageContext({ index }, { scope: 'single', status: SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT });
                break;

            case FAULTS.IO_PORT_ERR:
            case FAULTS.IO_TIMEOUT:
                this.UpdateStorageContext({ index }, { scope: 'all', status: SPIRAL_CELL_STATE.BLOCKED, except: STATUS_EXCEPT });
                break;
        }
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Abort']}
     */
    Abort() {
        if (this.#_Context.currentOrder)
            this.#_Context.currentOrder.aborted = true;
    }

    /**
     * @type {import("./srvSpiralSectionStorage").ClassSpiralSectionStorage['Reset']}
     */
    Reset() {
        this.#_FSM.Reset();
        this.#_Context.currentOrder = null;
        this.#_Context.fallbackTimer?.clear();
        this.#_Context.dispenseTimer?.clear();

        // if (this.#_TamperPosWatch) clearInterval(this.#_TamperPosWatch);
        // this.#_TamperPosWatch = null;

        // if (this.#_PSUWatch) clearInterval(this.#_PSUWatch);
        // this.#_PSUWatch = null;
        if (this._PollingTimeout) clearTimeout(this._PollingTimeout);
        this._PollingTimeout = null;
        this.#_Polling = false;

        /*for (let [eventName, handler] of this.#_ChHandlers) 
            if (eventName && handler) this.#_ProxyCh.Events.off(eventName, handler);
        this.#_ChHandlers.clear();*/

        this.#_Context.units = this.#_Context.units.map(u => ({
            ...u,
            itemsDispensed: 0,
            status: SPIRAL_CELL_STATE.OK,
        }));
        if (this.#_Context.currentTask?.rej) {
            this.#_Context.currentTask.rej(new Error('Reset'));
        }
        this.#_Context.currentTask = null;

        this._I_CurrBuffer.Clear();
        this._V_VoltBuffer.Clear();

        this.#_uTransactionsList = [];
        try {
            this.MotorOffAll().catch(e=>{});
        } catch (fault) {
            this._ProxyLogger.Log({ 
                level: 'E', 
                msg: `[STORAGE] Ошибка при выключении всех моторов при Reset()`,
                obj: { index, fault}
            });
        };
    }
}

class StorageFault extends ClassFault {
    constructor({ code, critical, index }) {
        super({ code, critical });
        this.index = index;
        this.critical = critical ?? true;
    }
}

module.exports = { ClassSpiralSectionStorage };