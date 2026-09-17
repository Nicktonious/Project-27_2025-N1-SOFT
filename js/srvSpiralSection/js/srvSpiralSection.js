const { EventEmitter2 } = require("eventemitter2");
const { ClassSpiralSectionLift }  = require('./srvSpiralSectionLift');
const { ClassSpiralSectionStorage } = require('./srvSpiralSectionStorage');
const { ClassFSM: FSM } = require('./srvFSM');
const { ClassFault } = require('./srvUtils');
const { FAULTS, STORAGE_CONSTANSTS, BOX_CONSTANTS, COMMON_CONSTANTS } = require('./SpiralSectionConstants');
const { default: BaseSectionState } = require("../../srvStatesController/js/srvBaseSectionState");
const ClassDeliveryBox = require("./srvDelieveryBox");
const { AVAILABLE_STATE, SECTION_STATUS } = require("../../srvStatesController/ts/IBaseSectionStates");
const { default: SpiralSectionState } = require("./srvSpiralSectionStates");
const { SPIRAL_SAFE_MODE } = COMMON_CONSTANTS;

let sleep = require('timers/promises').setTimeout;

const DELAY_BEFORE_DISPENSE = 250;

class ClassSpiralSection extends EventEmitter2 {

    static STATE = {
        IDLE:            'IDLE',
        DISPENSING:      'DISPENSING',
        UNLOADING:       'UNLOADING',
    };

    _Context = { 
        order: null,
        currentTask: null,
        aborted: false,
        results: [],
    };

    #_ProxyCh;
    /** @type {import("./srvSpiralSection.d.ts").TypeSpiralSectionChannels} */
    #_Channels;
    /**@type {EventEmitter2} */
    #_Events = new EventEmitter2();
    /** @type {ClassSpiralSectionLift} */
    #_Lift = null;
    /** @type {ClassSpiralSectionStorage} */
    #_Storage = null;
    /** @type {ClassDeliveryBox} */
    #_Box = null;

    #_StatesGraph = {
        [ClassSpiralSection.STATE.IDLE]: {
            [this.EVENTS.DISPENSE_START]: { state: ClassSpiralSection.STATE.DISPENSING, action: this._Execute.bind(this) },
        },
        [ClassSpiralSection.STATE.DISPENSING]: {
            [this.EVENTS.OPERATION_FINISHED]:  { state: ClassSpiralSection.STATE.IDLE, action: this.Idle.bind(this) }
            // [this.EVENTS.DISPENSE_DONE]:  { state: ClassSpiralSection.STATE.UNLOADING, action: this.OpenBox.bind(this) },
        },
        [ClassSpiralSection.STATE.UNLOADING]: { 
            [this.EVENTS.UNLOADING_DONE]: { state: ClassSpiralSection.STATE.IDLE, action: this.Idle.bind(this) }
        }
    };
    /** @type {SpiralSectionState} */
    #_SectionState = null;

    #_FSM = new FSM({ stateGraph: this.#_StatesGraph, defaultState: ClassSpiralSection.STATE.IDLE });
    /**
     * 
     * @param {object} param0
     * @param {import("./srvSpiralSection.d.ts").TypeProxyCh} param0.ProxyCh
     * @param {import("./srvSpiralSection.d.ts").TypeSpiralSectionChannels} param0.channels
     * @param {import("./srvSpiralSection.d.ts").TypeSpiralSectionOpts} param0.advOpts
     * @param {SpiralSectionState} param0.sectionState
     * @param {import("./srvSpiralSection.d.ts").TypeProxyLogger} param0.ProxyLogger
     */
    constructor({ ProxyCh, channels, advOpts, sectionState, ProxyLogger={ Log: (o)=>console.log(o) } }) {
        super();
        this.#_ProxyCh = ProxyCh;
        this.#_Channels = channels;
        this._ProxyLogger = ProxyLogger;
        this.#_Lift = new ClassSpiralSectionLift({ ProxyCh, ProxyLogger, channels: channels.liftChannels, advOpts: advOpts.liftOpts, sectionState });
        this.#_Storage = new ClassSpiralSectionStorage({ ProxyCh, ProxyLogger, channels: channels.storageChannels, advOpts: advOpts.storageOpts, sectionState });
        this.#_Box = new ClassDeliveryBox({ ProxyCh, ProxyLogger, channels: channels.boxChannels, advOpts: {}, sectionState });
        this.#_Channels.door = channels.door;
        this.#_Channels.monSpirals = channels.monSpirals;
        this.#_Channels.monLift = channels.monLift;
        this.#_Channels.monBox = channels.monBox;
        this.#_SectionState = sectionState;
        this.Init();
    }

    get InWork() { return this._Context.currentTask; }

    /**
     * @returns {import("./srvSpiralSection.d.ts").TypeSpiralSectionEvents}
     */
    get EVENTS() {
        return {
            DISPENSE_START: 'OPERATION_START',
            OPERATION_FINISHED: 'DISPENSE_DONE',
            UNLOADING_DONE: 'UNLOADING_DONE',
            DISPENSE_START_MOCK: 'DISPENSE_START_MOCK',
            ABORT: 'ABORT'
        }
    }

    get Events() {
        // TODO: return proxy
        return this.#_Events;
    }

    set Logger(logger) {
        this._ProxyLogger = logger;
    }

    Init() {
        this._DispenseHandler = this.HandleDispense.bind(this);
        this.#_Storage.Events.on('dispense', this._DispenseHandler);
        this._FailHandler = ((cell, fault) => this.HandleFail(cell, fault, 'Не удалось выполнить выдачу ТМЦ')).bind(this);
        this.#_Storage.Events.on('fail', this._FailHandler);
        
        this.WatchDoor();
        this.WatchBox();

        this.#_SectionState.IsAvailable = AVAILABLE_STATE.YES;
    }

    WatchDoor() {
        let cachedDoorValue = undefined;

        this.#_ProxyCh.Events.on(`${this.#_Channels.door}-value`, (({ Value }) => {

            if (Value === cachedDoorValue)
                return;

            cachedDoorValue = Value;
            this.#_SectionState.Door = Value == BOX_CONSTANTS.BOX_CLOSED ? 'CLOSED' : 'OPENED';

            if (Value != BOX_CONSTANTS.BOX_CLOSED) {
                this.Abort();
            }
        }).bind(this));
    }

    WatchBox() {
        this.#_Box.on(ClassDeliveryBox.EVENTS.OPENED, (() => {
            this.#_ProxyCh.SetValue(this.#_Channels.monBox, 1);
            this.Abort();
        }).bind(this));
    }

    Abort() {
        if (SPIRAL_SAFE_MODE) {
            if (!this._Context.currentTask) return;
            this._ProxyLogger.Log({ level: 'I', msg: `Прерывание операции.` })
            this._Context.aborted = true;
            this.#_Lift.Abort();
            this.#_Storage.Abort()
        }
    }

    /**
     * 
     * @param {[import("./srvSpiralSection.d.ts").TypeOrder]} _orders 
     * @returns {Promise}
     */
    async Execute(_orders) {
        return new Promise((res, rej) => {
            if (this._Context.currentTask) 
                return rej(new Error('Выполняется предыдущая операция'));

            if (this.#_FSM.State != ClassSpiralSection.STATE.IDLE) 
                return rej(new Error('Секция не в состоянии покоя'));

            this._Context.currentTask = { res, rej };
            this.#_SectionState.Status = SECTION_STATUS.DISPENSE;
            this.#_SectionState.IsAvailable = AVAILABLE_STATE.NO;
            this.#_FSM.Dispatch(this.EVENTS.DISPENSE_START, _orders);
        });
    }

    /**
     * 
     * @param {[import("./srvSpiralSection.d.ts").TypeOrder]} _orders 
     * @returns {Promise}
     */
    async _Execute(_orders) {
        try {
            this.#_SectionState.Status = SECTION_STATUS.DISPENSE;
            if (SPIRAL_SAFE_MODE && (!this.IsDoorClosed() || this.#_Box.IsOpened))
                return this.HandleErr(undefined, 'Открыта дверь или люк. Отказ в начале транзакции');
            
            let orders = [..._orders];
            orders.sort((a, b) => -a.row + b.row);   //сортировка по убыванию уровня

            try {
                if (!this._Context.aborted)
                    await this.#_Lift.ElevateToBottom();
            } catch (e) {
                this.#_SectionState.Status = SECTION_STATUS.BLOCKED;
                this.HandleErr(e, 'Ошибка при установке лифта в положение выдачи');
            }
            for (let level of new Set(orders.map(o => this.#_Storage.MaxLevel - o.row))) {
                let testSpiral = orders.find(o => this.#_Storage.MaxLevel - o.row == level && this.#_Storage.IsCheckable(o));
                if (!testSpiral) continue;
                try {
                    await sleep(100);
                    await this.#_Storage.TestSpiral(testSpiral);
                } catch (e) {
                    this.HandleErr(e, 'Ошибка теста спирали');
                    this._ProxyLogger.Log({ level: 'E', msg: `[STORAGE] провал теста спирали: ${e.code}` });
                    continue;
                }
                
                let ordersOnLevel = orders.filter(o => this.#_Storage.MaxLevel - o.row == level && this.#_Storage.IsCheckable(o));

                if (ordersOnLevel.length == 0) continue;
                
                await sleep(100);
                this._ProxyLogger.Log({ level: 'DEBUG', msg: `[STORAGE] Команда поднять лифт на уровень ${level}` });
                try {
                    if (!this._Context.aborted)
                        await this.#_Lift.ElevateToLevel(level);
                } catch (e) {
                    this.HandleErr(e, `Ошибка при установке лифта на уровень ${level}`);
                    break;
                }

                for (let order of ordersOnLevel) {
                    if (this._Context.aborted) {
                        this._Context.results = [];
                        break;
                    }
                        
                    await sleep(DELAY_BEFORE_DISPENSE);
                    if (this.#_Storage.IsCheckable(order)) {
                        this._ProxyLogger.Log({ level: 'I', msg: `Начало выполения заказа: ${JSON.stringify(order)}` });
                        try {
                            await this.#_Storage.Dispense(order);
                            this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Выполнена выдача ${JSON.stringify(order)}` });
                        } catch (e) {
                            if (e instanceof Error)
                                this.HandleErr(e, 'Не удалось выполнить выдачу ТМЦ');
                        }
                    } else {
                        this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Заказ ${JSON.stringify(order)} не будет выполнен в связи со статусом соответствующей ячейки` });
                    }
                }
            }
            
            try {
                await sleep(100);
                this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Для выдачи лифт спускается на 0-й уровень` });
                if (!this._Context.aborted)
                    await this.#_Lift.ElevateToBottom();

            } catch (e) {
                this.#_SectionState.Status = SECTION_STATUS.BLOCKED;
                this.HandleErr(e, 'Ошибка при установке лифта в положение выдачи');
            }

            if (this._Context.results.length > 0 && this.#_Lift.Level == 0) try {
                for (let order of orders) 
                    this.emit('result', { ok: true, cell: { row: order.row, column: order.column } });

                this.#_SectionState.Status = SECTION_STATUS.DELIVERY;
                await this.#_Box.Deliver();
                this._ProxyLogger.Log({ level: 'I', msg: 'Успешно выполнена выдача' });

            } catch (e) {
                this.#_SectionState.Status = SECTION_STATUS.BLOCKED;
                this.HandleErr(e, 'Не удалось выполнить выдачу ТМЦ');
            }
            
        } catch (e) {
            this.HandleErr(e, 'Ошибка выполнения транзакции');
        } finally {
            for (let order of _orders) {
                let orderResults = this._Context.results.filter(r => r.cell?.row == order.row && r.cell?.column == order.column).length;
                if (orderResults == 0) {
                    this.emit('result', { ok: false, cell: { row: order.row, column: order.column } });
                }
            }
            this._Context.results = [];
            return this.#_FSM.Dispatch(this.EVENTS.OPERATION_FINISHED);
        }
    }

    IsDoorClosed() {
        return this.#_ProxyCh.GetValue(this.#_Channels.door) == BOX_CONSTANTS.DOOR_CLOSED;
    }
        
    Idle() {
        // this.#_Context.timer?.clear();
        try {
            this._Context.currentTask?.res?.();
            this._Context.currentTask = null;
            this._Context.aborted = false;

        } catch (fault) {
            // this.EmergencyOff();
        } finally {
            if (this.#_SectionState.Status != SECTION_STATUS.BLOCKED) {
                this.#_SectionState.Status = SECTION_STATUS.IDLE;
                this.#_SectionState.IsAvailable = AVAILABLE_STATE.YES;
            }
        }
    }

    Reset() {
        this.#_FSM.Reset();
        this.#_Lift.Reset();
        this.#_Storage.Reset();
        this.#_Box.Reset();

        this._Context.results = [];

        if (this._Context.currentTask?.rej) {
            this._Context.currentTask.rej(new Error('Reset'));
        }
        this._Context.currentTask = null;
        this._Context.order = null;
        if (this.openedTimer) clearTimeout(this.openedTimer);
        this.openedTimer = null;

        // this.#_Storage.Events.off('dispense', this._DispenseHandler);
        // this.#_Storage.Events.off('fail', this._FailHandler);

        this.#_SectionState.Status = SECTION_STATUS.IDLE;
        this.#_SectionState.IsAvailable = AVAILABLE_STATE.YES;
    }

    HandleDispense(cell) {
        this._Context.results.push({ ok: true, cell });
    }

    /**
     * 
     * @param {object} cell 
     * @param {number} cell.row 
     * @param {number} cell.column 
     * @param {} fault 
     * @param {*} message 
     */
    HandleFail(cell, fault, message='') {
        this._ProxyLogger.Log({ level: 'E', msg: `[FAIL] ${message}: ${JSON.stringify(fault)}` });
        this._Context.results.push({ ok: false, cell });
    }

    HandleErr(e, msg) {
        this._ProxyLogger.Log({ level: 'E', msg: `${msg}: ${JSON.stringify(e)}` });
        // this._Context.results.push({ error: e, message: msg ?? '' });
        // this.emit('result', { error: e, message: msg ?? '' });
    }

    Invoke(methodName, ...args) {
        if (this._Context.currentTask) return;
        if (methodName == 'Rotate') {
            const { row, column, quantity, duration } = args[0];
            return quantity
                ? this.#_Storage.Dispense({ row, column, quantity }, true) 
                : this.#_Storage.RunMotor({ row, column, duration });
        }
    }

    Deliver() {
        return this.#_Box.Deliver();
    }

    ManualRotateSpiral(args) {
        if (this._Context.currentTask) return;
        const { row, column, quantity, duration } = args ?? {};
        return quantity
                ? this.#_Storage.Dispense({ row, column, quantity }, true)
                : this.#_Storage.RunMotor({ row, column, duration }); 
    }    
    
    Test_1(fpath, level, times) {
        return this.#_Lift.Test_1(fpath, level, times);
    }
}

module.exports = { ClassSpiralSection };