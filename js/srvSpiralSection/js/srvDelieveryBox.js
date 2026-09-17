const { ClassFSM: FSM } = require('./srvFSM');
const { ClassFault } = require('./srvUtils');
const { BOX_CONSTANTS, FAULTS } = require('./SpiralSectionConstants');
const { default: BaseSectionState } = require("../../srvSpiralSection/js/srvSpiralSectionStates");
const { default: SpiralSectionState } = require('./srvSpiralSectionStates');
const { DELIVERY_BOX_STATE } = require('../../srvStatesController/ts/ISpiralSectionStates');
const { EventEmitter2 } = require('eventemitter2');

const DOOR_DEBOUNCE_MS = BOX_CONSTANTS.DOOR_DEBOUNCE ?? 300;

class ClassDeliveryBox extends EventEmitter2 {

    static STATE = {
        CLOSED: 'CLOSED',
        UNLOCKING: 'UNLOCKING',
        OPENED: 'OPENED',
    };

    static EVENTS = {
        DELIVER: 'DELIVER',
        OPENED: 'DOOR_OPENED',
        CLOSED: 'DOOR_CLOSED',
        TIMEOUT: 'OPEN_TIMEOUT',
        FINISH: 'FINISH'
    };
    /** @type {SpiralSectionState} */
    #_SectionState = null;
    #_FSM;
    #_StateGraph = {
        [ClassDeliveryBox.STATE.CLOSED]: {

            [ClassDeliveryBox.EVENTS.DELIVER]: {
                state: ClassDeliveryBox.STATE.UNLOCKING,
                action: this._Unlock.bind(this)
            },

            [ClassDeliveryBox.EVENTS.OPENED]: {
                state: ClassDeliveryBox.STATE.OPENED,
                action: this.OnDoorOpened.bind(this)
            }
        },

        [ClassDeliveryBox.STATE.UNLOCKING]: {

            [ClassDeliveryBox.EVENTS.OPENED]: {
                state: ClassDeliveryBox.STATE.OPENED,
                action: this.OnDoorOpened.bind(this)
            },

            [ClassDeliveryBox.EVENTS.TIMEOUT]: {
                state: ClassDeliveryBox.STATE.CLOSED,
                action: this.AbortDelivery.bind(this)
            }
        },

        [ClassDeliveryBox.STATE.OPENED]: {

            [ClassDeliveryBox.EVENTS.CLOSED]: {
                state: ClassDeliveryBox.STATE.CLOSED,
                action: this.FinishDelivery.bind(this)
            }
        }
    };

    #_ProxyCh;
    /** @type {import('./srvSpiralSection').TypeDeliveryBoxChannels} */
    #_Channels = null;
    #_Context = {};
    #_DoorHandlers = new Map();
    keepOpened = null;
    _debounceTimer = null;

    /**
     * @param {object} param0
     * @param {TypeProxyCh} param0.ProxyCh
     * @param {import('./srvSpiralSection').TypeDeliveryBoxChannels} param0.channels 
     * @param {object} param0.advOpts
     * @param {BaseSectionState} param0.sectionState
     * @param {import('../../srvLogger/js/srvProxyLogger').ClassProxyLogger} param0.ProxyLogger
     */
    constructor({ ProxyCh, ProxyLogger, channels, advOpts, sectionState }) {
        super();
        this.#_ProxyCh = ProxyCh;
        this._ProxyLogger = ProxyLogger;
        this.#_SectionState = sectionState;
        this.#_Channels = channels;
        this.unlockTimeout = BOX_CONSTANTS.UNLOCKED_TIMEOUT_SEC ?? 100;
        this.#_FSM = new FSM({      // TODO clear on reset
            defaultState: ClassDeliveryBox.STATE.CLOSED,
            stateGraph: this.#_StateGraph,
            onStateChanged: (({ state, prevState }) => {
                this._ProxyLogger.Log({ level: 'D', msg: `[BOX] ${prevState} -> ${state}` });
                switch (state) {
                    case ClassDeliveryBox.STATE.OPENED:
                        this.#_SectionState.DeliveryBox = DELIVERY_BOX_STATE.OPENED;
                        break;
                    case ClassDeliveryBox.STATE.CLOSED:
                        this.#_SectionState.DeliveryBox = DELIVERY_BOX_STATE.CLOSED;
                        break;
                }
            }).bind(this)
        });
        this.InitEventHandlers();
    }

    get IsLockOpen() {
        if (!this.#_Channels?.lock)
            return false;
        return this.#_ProxyCh.GetValue(this.#_Channels.lock) == BOX_CONSTANTS.UNLOCK_ON;
    }

    get IsOpened() {
        const isDoorOpened = this.#_ProxyCh.GetValue(this.#_Channels.optic) != BOX_CONSTANTS.BOX_CLOSED;
        return isDoorOpened || this.IsLockOpen;
    }

    async Deliver() {
        return new Promise((res, rej) => {

            if (this.#_Context.currentTask)
                return rej(new Error('[BOX] Выполняется предыдущая операция'));

            if (this.#_FSM.State !== ClassDeliveryBox.STATE.CLOSED)
                return rej(new Error('[BOX] Invalid delivery box state'));

            this.#_Context.currentTask = { res, rej };

            this.#_FSM.Dispatch(ClassDeliveryBox.EVENTS.DELIVER);
        });
    }

    _Unlock() {
        if (this.keepOpened) {
            clearTimeout(this.keepOpened);
            this.keepOpened = null;
        }

        this.SetLockState(BOX_CONSTANTS.UNLOCK_ON);

        this.#_Context.openTimer = setTimeout(() => {

            this.#_FSM.Dispatch(ClassDeliveryBox.EVENTS.TIMEOUT);

        }, this.unlockTimeout*1000);
    }

    OnDoorOpened() {
        if (this.keepOpened) {
            clearTimeout(this.keepOpened);
            this.keepOpened = null;
        }

        if (this.#_Context.openTimer)
            clearTimeout(this.#_Context.openTimer);
        
        this.#_Context.openTimer = null;
    }

    FinishDelivery() {
        if (this.keepOpened) {
            clearTimeout(this.keepOpened);
            this.keepOpened = null;
        }

        this.SetLockState(BOX_CONSTANTS.UNLOCK_OFF);

        this.#_Context.currentTask?.res();
        this.#_Context.currentTask = null;
    }

    AbortDelivery() {
        this._ProxyLogger.Log({ level: 'I', msg: `[BOX] Таймаут выдачи` });
        if (this.keepOpened) {
            clearTimeout(this.keepOpened);
            this.keepOpened = null;
        }
        this.SetLockState(BOX_CONSTANTS.UNLOCK_OFF);

        this.#_Context.currentTask?.rej(new Error('Лючок не был открыт'));
        this.#_Context.currentTask = null;
    }

    SetLockState(value) {
        if (!this.#_Channels.lock)
            return;

        this.#_ProxyCh.SetValue(this.#_Channels.lock, value);
    }

    InitEventHandlers() {
        let cachedDoorValue = undefined;

        const handler = (({ Value }) => {
            if (Value === cachedDoorValue)
                return;

            if (this._debounceTimer) {
                clearTimeout(this._debounceTimer);
                this._debounceTimer = null;
            }

            this._debounceTimer = setTimeout(() => {
                this._debounceTimer = null;

                if (Value === cachedDoorValue)
                    return;

                cachedDoorValue = Value;

                switch (this.#_FSM.State) {
                    case ClassDeliveryBox.STATE.CLOSED:
                    case ClassDeliveryBox.STATE.UNLOCKING:
                        if (Value != BOX_CONSTANTS.BOX_CLOSED) {
                            this.emit(ClassDeliveryBox.EVENTS.OPENED);
                            this.#_FSM.Dispatch(ClassDeliveryBox.EVENTS.OPENED);
                        }
                        break;

                    case ClassDeliveryBox.STATE.OPENED:
                        if (Value == BOX_CONSTANTS.BOX_CLOSED) {
                            this.emit(ClassDeliveryBox.EVENTS.CLOSED);
                            this.#_FSM.Dispatch(ClassDeliveryBox.EVENTS.CLOSED);
                        }
                        break;
                }
            }, DOOR_DEBOUNCE_MS);
        }).bind(this);

        const eventName = `${this.#_Channels.optic}-value`;

        this.#_DoorHandlers.set(eventName, handler);
        this.#_ProxyCh.Events.on(eventName, handler);
    }

    Reset() {
        this.#_FSM.Reset();

        if (this.#_Context.openTimer)
            clearTimeout(this.#_Context.openTimer);

        if (this.keepOpened) {
            clearTimeout(this.keepOpened);
            this.keepOpened = null;
        }

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }

        this.#_Context.openTimer = null;
        this.#_Context.currentTask?.rej?.(new Error('Reset'));
        this.#_Context.currentTask = null;

        this.SetLockState(BOX_CONSTANTS.UNLOCK_OFF);
        this.#_SectionState.DeliveryBox = DELIVERY_BOX_STATE.CLOSED;

        // for (let [eventName, handler] of this.#_DoorHandlers)
        //     this.#_ProxyCh.Events.off(eventName, handler);

        // this.#_DoorHandlers.clear();
    }
}

module.exports = ClassDeliveryBox;