const { EventEmitter2 } = require("eventemitter2");
const { createTimer, ClassFault: Fault, isWithinTolerance, BufferedCsvWriter } = require("./srvUtils");
const { ClassFSM: FSM } = require("./srvFSM");
const { LIFT_CONSTANTS, FAULTS, STORAGE_CONSTANSTS, U_TRANSACTIONS, COMMON_CONSTANTS } = require("./SpiralSectionConstants");
const { /*LIFT_STATE,*/ default: SpiralSectionState } = require("./srvSpiralSectionStates");
const { LIFT_STATE } = require('../../srvStatesController/ts/ISpiralSectionStates')
const { default: StatesController } = require("../../srvStatesController/js/srvSectionStateController");
const ClassBuffer = require('../../../../HorizonServer/js/srvUtils/js/buffer');
let sleep = require('timers/promises').setTimeout;
const { LIFT_BOTTOM_TAMPER_ON, 
    LIFT_BOTTOM_TAMPER_DEBOUNCE,
    // DOUBLE_TRIGGER_WINDOW, 
    ELEVATE_NEXT_MAX_TIME, 
    ELECTR_CURR_STATE,
    CURRENT_RANGE,
    MONITOR_INTERVAL } = LIFT_CONSTANTS;

const BOTTOM_LEVEL = 0;
const SLEEP_BETWEEN_STEPS = 500;

class ClassSpiralSectionLift {
    static STATE = {
        IDLE:                 'IDLE',
        ELEVATING_TO_COLLECT: 'ELEVATING_TO_COLLECT',
        ELEVATING_TO_BOTTOM:  'ELEVATING_TO_BOTTOM',
        ELEVATING_TO_BASE:    'ELEVATING_TO_BASE',
        FAULT:                'FAULT',
    };
    /**@type {import("./srvSpiralSection").TypeProxyCh} */
    #_ProxyCh;
    /** @type {import("./srvSpiralSectionLift").TypeSpiralSectionLiftChannels} */
    #_Channels = null;
    /** @type {StatesController} */
    #_GlobalState = null;
    /** @type {SpiralSectionState} */
    #_SectionState = null;
    /** @type {import("./srvSpiralSectionLift").TypeSpiralSectionLiftContext} */
    #_Context = {
        currentLevel: undefined,
        requiredLevel: undefined,
        motorTransition: false,
        movingDir: 0
    };
    #_CurrentWatch = null;
    /**@type {EventEmitter2} */
    #_Events = new EventEmitter2(); 
    #_uTransactionsList = [];
    
    #_StatesGraph = {
        [ClassSpiralSectionLift.STATE.IDLE]: {
            [this.EVENTS.ELEVATE_TO_BOTTOM_COMMAND]: { state: ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM,  action: this._ElevateToBottom.bind(this) },
            [this.EVENTS.ELEVATE_COMMAND]:           { state: ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT, action: this._ElevateToLevel.bind(this) },
            [this.EVENTS.FAULT]:                     { state: ClassSpiralSectionLift.STATE.FAULT,                action: this.OnFault.bind(this)},             
        },
        [ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM] : {
            [this.EVENTS.BOTTOM_LEVEL_REACHED]: { state: ClassSpiralSectionLift.STATE.IDLE,                action: this.Idle.bind(this) },
            [this.EVENTS.ELEVATE_TIMEOUT]:      { state: ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM, action: this.OnElevateTimeout.bind(this) },
            [this.EVENTS.FAULT]:                { state: ClassSpiralSectionLift.STATE.FAULT,               action: this.OnFault.bind(this) },
            [this.EVENTS.ABORT]:                { state: ClassSpiralSectionLift.STATE.IDLE,                action: this.StopForce.bind(this) },
        }, 
        [ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT]: {
            [this.EVENTS.COLLECT_LEVEL_REACHED]: { state: ClassSpiralSectionLift.STATE.IDLE,                 action: this.Idle.bind(this) },
            [this.EVENTS.ELEVATE_TIMEOUT]:       { state: ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT, action: this.OnElevateTimeout.bind(this) },
            [this.EVENTS.FAULT]:                 { state: ClassSpiralSectionLift.STATE.FAULT,                action: this.OnFault.bind(this) },   
            [this.EVENTS.ABORT]:                 { state: ClassSpiralSectionLift.STATE.IDLE,                 action: this.Idle.bind(this) },
        },
        [ClassSpiralSectionLift.STATE.FAULT]: {
            [this.EVENTS.ELEVATE_TO_BOTTOM_COMMAND]: { state: ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM,  action: this._ElevateToBottom.bind(this) },
            [this.EVENTS.RECOVERED]:                 { state: ClassSpiralSectionLift.STATE.IDLE, action: () => {} }
        }
    };
    #_FSM = new FSM({ stateGraph: this.#_StatesGraph, defaultState: ClassSpiralSectionLift.STATE.IDLE, onStateChanged: this.OnStateChanged.bind(this) });
    #_ChHandlers = new Map();
    #_LevelHandler = null;
    #_LevelCachedValue = undefined;
    #_PSUWatch = null;
    /**
     * 
     * @param {object} param0
     * @param {import("./srvSpiralSection").TypeProxyCh} ProxyCh
     * @param {import("./srvSpiralSectionLift").TypeSpiralSectionLiftChannels} channels
     * @param {import("./srvSpiralSectionLift").TypeSpiralSectionLiftOpts} param0.advOpts 
     * @param {SpiralSectionState} param0.sectionState
     * @param {import("./srvSpiralSection.d.ts").TypeProxyLogger} param0.ProxyLogger
     */
    constructor({ ProxyCh, channels, advOpts, globalState, sectionState, ProxyLogger }) {
        this.#_ProxyCh = ProxyCh;
        this._ProxyLogger = ProxyLogger;
        this.#_Channels = channels;
        this.#_GlobalState = globalState;
        this.#_SectionState = sectionState;
        this._BusNumber = advOpts.busNumber;
        this._I_CurrBuffer = new ClassBuffer({ size: 5 });
        this._V_VoltBuffer = new ClassBuffer({ size: 4 });

        this.Init();
    }

    /**
     * @returns {import("./srvSpiralSectionLift").TypeSpiralSectionLiftEvents}
     */
    get EVENTS() {
        return ({
            IDLE:                   'IDLE',
            ELEVATE_TO_BASE_COMMAND:'ELEVATE_TO_BASE_COMMAND',
            ELEVATE_TO_BOTTOM_COMMAND: 'ELEVATE_TO_BOTTOM_COMMAND',
            BOTTOM_LEVEL_REACHED:   'BOTTOM_LEVEL_REACHED',
            BASE_LEVEL_REACHED:     'BASE_LEVEL_REACHED',
            COLLECT_LEVEL_REACHED:  'COLLECT_LEVEL_REACHED',
            ELEVATE_COMMAND:        'ELEVATE_COMMAND',
            ELEVATE_TIMEOUT:        'ELEVATE_TIMEOUT',
            FAULT:                  'FAULT',
            RECOVERED:              'RECOVERED',
            ABORT:                  'ABORT'
        });
    }

    get State() {
        return this.#_FSM.State;
    }

    get Status() {
        return this.#_SectionState.Lift;
    }

    get Level() {
        return this.#_Context.currentLevel;
    }

    get Available() {
        return this.Status != LIFT_STATE.SHORT_CIRCUIT && this.Status != LIFT_STATE.OVERLOAD;
    } 

    get Events() {
        // TODO return proxy
        return this.#_Events;
    }

    Init() {
        this.InitEventHandlers();
        this.Stop()
            .catch(e => this._ProxyLogger.Log({ level: 'E', msg: '[LIFT] Не удалось выполнить Reset мотора', obj: { error: e } }))
            // .then(() => {
            //     this.ElevateToBottom().catch(e => this._ProxyLogger.Log({ level: 'E', msg: '[LIFT] Не удалось установить лифт в нижнее положение', obj: { error: e } }));
            // });

    }

    InitEventHandlers() {
        this.SetBottomTamperHandler();
        this.SetLevelHandler();
        this.SetTopTamperHandler();
        this.SetCurrentHandler();
        this.SetVoltageHandler();
        this.StartPSUWatch();
    }

    SetBottomTamperHandler() {
        /** Bottom tamper handler */
        const eventName = `${this.#_Channels.liftBottomTamper}-value`;
        let tamperCachedValue = undefined;
        let debounce = null;

        const handler = (({ Value }) => {
            if (Value != tamperCachedValue && Value == LIFT_BOTTOM_TAMPER_ON && !debounce) {
                this.#_Context.timer?.clear();
                this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Обновлен сигнал на нижнем тампере: ${Value}` });
                debounce = setTimeout(() => {
                    debounce = null;
                }, LIFT_BOTTOM_TAMPER_DEBOUNCE);
                this.#_Context.currentLevel = BOTTOM_LEVEL;
                this.#_FSM.Dispatch(this.EVENTS.BOTTOM_LEVEL_REACHED);
            };
            tamperCachedValue = Value;
        }).bind(this);
        this.#_ChHandlers.set(eventName, handler);
        this.#_ProxyCh.Events.on(eventName, handler);
    }

    SetTopTamperHandler() {
        /** Bottom tamper handler */
        const eventName = `${this.#_Channels.liftTopTamper}-value`;
        let tamperCachedValue = undefined;
        let debounce = null;

        const handler = (({ Value }) => {
            if (Value != tamperCachedValue && Value == LIFT_BOTTOM_TAMPER_ON && !debounce) {
                this.#_Context.timer?.clear();
                this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Обновлен сигнал на верхнем тампере: ${Value}` });
                debounce = setTimeout(() => {
                    debounce = null;
                }, LIFT_BOTTOM_TAMPER_DEBOUNCE);

                this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LEVEL_SENSOR_FAIL }));
            };
            tamperCachedValue = Value;
        }).bind(this);
        this.#_ChHandlers.set(eventName, handler);
        this.#_ProxyCh.Events.on(eventName, handler);
    }

    SetLevelHandler() {
        /** New level handler */
        const levelValueEventName = `${this.#_Channels.liftLevelSensor}-value`;
        this.#_LevelHandler = this.HandleLevel.bind(this);

        this.#_ProxyCh.Events.on(levelValueEventName, this.#_LevelHandler);
    }

    SetCurrentHandler() {
        const I_currEventName = `${this.#_Channels.current}-value`;
        const I_currHandler = (({ Value }) => {
            this._I_CurrBuffer.push(Value);

        }).bind(this);

        this.#_ProxyCh.Events.on(I_currEventName, I_currHandler);
        this.#_ChHandlers.set(I_currEventName, I_currHandler);
    }

    SetVoltageHandler() {
        const V_EventName = `${this.#_Channels.voltage}-value`;
        const V_Handler = (({ Value }) => {
            // if (![ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT, 
            //     ClassSpiralSectionLift.STATE.ELEVATING_TO_BASE, 
            //     ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM].includes(this.#_FSM.State)) return;
            
            this._V_VoltBuffer.push(Value);

        }).bind(this);

        this.#_ProxyCh.Events.on(V_EventName, V_Handler);
        this.#_ChHandlers.set(V_EventName, V_Handler);
    }

    HandleLevel({ Value }) {
        if (Value == this.#_LevelCachedValue) return;
        this.#_LevelCachedValue = Value;
        if (Value == LIFT_BOTTOM_TAMPER_ON) {

            if (this.#_FSM.State == ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT || 
                this.#_FSM.State == ClassSpiralSectionLift.STATE.ELEVATING_TO_BASE ||
                this.#_FSM.State == ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM
            ) {
                if (this.#_Context.movingDir == 1)
                    this.#_Context.currentLevel++;
                else
                    this.#_Context.currentLevel--;

                this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Уровень лифта: ${this.#_Context.currentLevel}` });
                
                this.#_ProxyCh.SetValue(this.#_Channels.monLift, 0.15);
                
                if (this.#_Context.currentLevel == this.#_Context.requiredLevel) {  
                    this.#_Context.timer?.clear();

                    this.#_FSM.Dispatch(this.EVENTS.COLLECT_LEVEL_REACHED);
                } 
            }  
            this.nopower_count = 0;
            this.overload_count = 0;
            this.#_Context.timer?.reset();
        }
    }

    StartPSUWatch() {
        if (this.#_PSUWatch) clearInterval(this.#_PSUWatch);
        
        this.short_count = 0;
        this.nopower_count = 0;
        this.overload_count = 0;

        let prevStatus = this.#_SectionState.Lift;

        this.#_PSUWatch = setInterval(() => {
            if (this.State == ClassSpiralSectionLift.STATE.FAULT) {
                if (prevStatus != LIFT_STATE.OK && this.#_SectionState.Lift == LIFT_STATE.OK)
                    this.#_FSM.Dispatch(this.EVENTS.RECOVERED);
                prevStatus = this.#_SectionState.Lift;
            }
            if (![ClassSpiralSectionLift.STATE.ELEVATING_TO_COLLECT, 
                ClassSpiralSectionLift.STATE.ELEVATING_TO_BASE, 
                ClassSpiralSectionLift.STATE.ELEVATING_TO_BOTTOM].includes(this.#_FSM.State)) return;
            if (this.#_Context.motorTransition) return;

            let I_curr = this._I_CurrBuffer.Filter();
            let I_currState = this.#_ProxyCh.GetValue(this.#_Channels.short) == STORAGE_CONSTANSTS.SHORT_CH_VAL 
                            ? ELECTR_CURR_STATE.SHORT 
                            : this.CheckCurrentState(I_curr);

            let index = this.#_Context.currentOrder?.unitIndex;

            this._ProxyLogger.Log({ level: 'D', msg: JSON.stringify({ state: this.#_FSM.State, I_curr }) });

            switch (I_currState) {
                case ELECTR_CURR_STATE.SHORT:
                    // if (this.#_SectionState.Cells[index] != LIFT_STATE.SHORT_CIRCUIT) {
                    if (++this.short_count == 2) {
                        this.short_count = 0;
                        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Мониторинг выявил КЗ. Ток: ${I_curr?.toFixed?.(2)}` });
                        this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LIFT_SHORT_CIRCUIT, index }));
                    } else {
                        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Мониторинг выявил возможное КЗ. Ток: ${I_curr?.toFixed?.(2)}` });
                    }
                    break;

                case ELECTR_CURR_STATE.OVERLOAD:
                    ++this.overload_count;
                    if (this.overload_count == 2 && this.#_SectionState.Lift == LIFT_STATE.OK) {
                        this.#_SectionState.Lift = LIFT_STATE.OVERLOAD;
                        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Мониторинг выявил перегрузку. Ток: ${I_curr?.toFixed?.(2)}` });
                        this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LIFT_OVERLOAD, index }));
                    } else {
                        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Мониторинг выявил возможную перегрузку. Ток: ${I_curr?.toFixed?.(2)}` });
                    }
        
                    break;

                case ELECTR_CURR_STATE.IDLE:
                    if (this.#_SectionState.Cells[index] != LIFT_STATE.SHORT_CIRCUIT) {
                        if (++this.nopower_count == 3) {
                            this.nopower_count = 0;
                            this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Мониторинг выявил отсутствие питания. Ток: ${I_curr?.toFixed?.(2)}` });
                            this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.ACTUATOR_NO_POWER, index }));
                        }
                    }
                    break;

                case ELECTR_CURR_STATE.WORK_OK:
                    this.#_SectionState.Lift = LIFT_STATE.OK;
                    this.nopower_count = 0;
                    this.short_count = 0;
                    this.overload_count = 0;
                }

            // const V_voltage = this._V_VoltBuffer.Filter();
            // TODO: контроль заниженного напряжения
            /*if (V_voltage > STORAGE_CONSTANSTS.SUPPLY_VOLTAGE_UPPER_LIM) {
                this.#_SectionState.Cells[index] = LIFT_STATE.OVERLOAD_V;
            } else {
                if (this.#_SectionState.Cells[index] == CELL_STATE.OVERLOAD_V)
                    this.#_SectionState.Cells[index] = CELL_STATE.OK;
            }*/

        }, MONITOR_INTERVAL);
    }

    async ElevateToBottom() {
        return new Promise((res, rej) => {
            if (this.#_Context.currentTask)
                return rej('[LIFT] Выполняется предыдущая операция');
            
            if (!this.Available)
                return rej(`[LIFT] Статус лифта не позволяет начать новую операцию: ${this.Status}`)
            
            this.#_uTransactionsList = [];
            this.#_Context.currentTask = { res, rej };

            this.#_Context.fallbackTimer = createTimer(
                () => { 
                    this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] fallback timeout` });
                    this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.NONE }));
                },
                LIFT_CONSTANTS.ELEVATE_NEXT_MAX_TIME * 8);

            this.#_FSM.Dispatch(this.EVENTS.ELEVATE_TO_BOTTOM_COMMAND);
        });
    }

    async ElevateToLevel(requiredLevel) {
        return new Promise((res, rej) => {
            if (this.#_Context.currentTask)
                return rej('[LIFT] Выполняется предыдущая операция');
            
            if (!this.Available)
                return rej(`[LIFT] Статус лифта не позволяет начать новую операцию: ${this.Status}`)
            
            this.#_uTransactionsList = [];
            this.#_Context.currentTask = { res, rej };

            this.#_Context.fallbackTimer = createTimer(
                () => {
                    this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] fallback timeout` });
                    this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.NONE }));
                },
                LIFT_CONSTANTS.ELEVATE_NEXT_MAX_TIME * 8);

            this.#_FSM.Dispatch(this.EVENTS.ELEVATE_COMMAND, requiredLevel);
        });
    }

    async _ElevateToLevel(requiredLevel) {
        this.#_Context.requiredLevel = requiredLevel;
        const startLevel = this.#_Context.currentLevel; 

        if (startLevel == requiredLevel) return;

        const up = startLevel < requiredLevel;
        
        this.#_Context.timer?.clear?.();
        try {
            this.#_Context.timer = createTimer(this.OnTimeout.bind(this), ELEVATE_NEXT_MAX_TIME + SLEEP_BETWEEN_STEPS*2).set();
            up ? await this.ElevateUp() : await this.ElevateDown();
        } catch (fault) {
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault); 
        }           
    }

    OnTimeout() {
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Timeout 387` });
        this.#_FSM.Dispatch(this.EVENTS.ELEVATE_TIMEOUT);
    }

    async OnElevateTimeout() {
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Timeout` });
        let currState = this.CheckCurrentState();
    
        switch (currState) {
            case ELECTR_CURR_STATE.OVERLOAD:
                
                this.#_Context.timer?.clear();
                if ((this.#_Context.currentLevel == 1 || this.#_Context.currentLevel == undefined) && this.#_Context.requiredLevel == BOTTOM_LEVEL) {
                    this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Таймаут ожидания лифта. Вероятно поломка нижнего концевика. Ток: ${this.#_ProxyCh.GetValue(this.#_Channels.current)?.toFixed?.(2)}` });
                    this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.BOTTOM_TAMPER_FAIL, critical: false }));
                } else {
                    this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Таймаут ожидания лифта. Вероятно произошло механическое заклинивание. Ток: ${this.#_ProxyCh.GetValue(this.#_Channels.current)?.toFixed?.(2)}` });
                    this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LIFT_OVERLOAD, critical: true }));
                    this.#_SectionState.Lift = LIFT_STATE.OVERLOAD;
                }
                break;
            case ELECTR_CURR_STATE.IDLE:
                this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Таймаут ожидания лифта. Отсутствие питания. Ток: ${this.#_ProxyCh.GetValue(this.#_Channels.current)?.toFixed?.(2)} ` });
                this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LIFT_NO_POWER, critical: true }));
                this.#_SectionState.Lift = LIFT_STATE.NO_POWER;
                break;
            case ELECTR_CURR_STATE.WORK_OK:
                this.#_SectionState.Lift = LIFT_STATE.ERR_LEVEL;
                this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Таймаут ожидания лифта. Ошибка датчика уровня. Ток: ${this.#_ProxyCh.GetValue(this.#_Channels.current)?.toFixed?.(2)} ` });
                
                this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LEVEL_SENSOR_FAIL, critical: false }));
                break;
            case ELECTR_CURR_STATE.SHORT:
                this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Таймаут ожидания лифта. Короткое замыкание. Ток: ${this.#_ProxyCh.GetValue(this.#_Channels.current)?.toFixed?.(2)} ` });
                this.#_SectionState.Lift = LIFT_STATE.SHORT_CIRCUIT;
                this.#_FSM.Dispatch(this.EVENTS.FAULT, new Fault({ code: FAULTS.LIFT_SHORT_CIRCUIT, critical: true }));
                break;
            default:
                break;
        }
    }

    async _ElevateToBottom() {
        this.#_Context.requiredLevel = BOTTOM_LEVEL;
        if (this.#_ProxyCh.GetValue(this.#_Channels.liftBottomTamper) == LIFT_CONSTANTS.LIFT_BOTTOM_TAMPER_ON) {
            this.#_Context.currentLevel = BOTTOM_LEVEL;
            return this.#_FSM.Dispatch(this.EVENTS.BOTTOM_LEVEL_REACHED);
        }
        try {
            await this.ElevateDown();
            this.#_Context.timer?.clear();
            if (this.#_SectionState.Lift != LIFT_STATE.ERR_LEVEL)
                this.#_Context.timer = createTimer(this.OnTimeout.bind(this), ELEVATE_NEXT_MAX_TIME).set();

        } catch (fault) {
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault);
        }
    }
    /**
     * @returns {Promise<Fault | null>}
     */    
    async ElevateUp() {
        return this.Elevate({ cmd: 'Forward' });   
    }
    /**
     * @returns {Promise<Fault | null>}
     */
    async ElevateDown() {
        return this.Elevate({ cmd: 'Reverse' });
    }

    /**
     * 
     * @param {object} param0
     * @param {string} param0.cmd 
     * @returns 
     */
    async Elevate({ cmd }) {
        // if (!['Forward', 'Reverse'].includes(cmd))
        this.#_Context.motorTransition = true;

        let fwd = cmd == 'Forward';
        this.StopForce();
        
        await sleep(100);
        let current_0 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        if (current_0 >= CURRENT_RANGE.WORK_OK[0]) 
            throw new Fault({ code: FAULTS.LIFT_CTRL_UNDEFINED, critical: true });

        this.LogTransaction(fwd ? U_TRANSACTIONS.LIFT_FWD : U_TRANSACTIONS.LIFT_REV);
        
        // step = 2;
        this.#_ProxyCh.SetValue(this.#_Channels.liftMotorCtrl2, fwd ? 'UP' : 'DOWN');
        // this.MotorStep(cmd, { step: 2 });

        let current_2;
        let elapsed = 0;

        while (elapsed < SLEEP_BETWEEN_STEPS) {
            await sleep(50);
            elapsed += 50;

            current_2 = this.#_ProxyCh.GetValue(this.#_Channels.current);
            this._ProxyLogger.Log({ level: 'D', msg: `I = ${current_2}` });
            // ток обновился
            if (current_2 >= CURRENT_RANGE.WORK_OK[0]) {
                this._ProxyLogger.Log({ level: 'D', msg: `Ток обновился до ${current_2.toFixed(2)} спустя ~${elapsed} мс` })
                this.#_Context.movingDir = fwd ? 1 : -1;
                this.#_Context.motorTransition = false;
                return;
            }

            if (this.IsShorted()) {
                this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] КЗ при включении: I=${this.#_ProxyCh.GetValue(this.#_Channels.current)} Iavg=${this._I_CurrBuffer.Filter()} U=${this._V_VoltBuffer.Filter()}` })
                throw new Fault({ code: FAULTS.LIFT_SHORT_CIRCUIT, critical: true });
            }
        }
        // ток не обновился
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Ток не изменился после второго шага включения лифта ${current_0} -> ${current_2}` });
        throw new Fault({ code: FAULTS.LIFT_NO_POWER, critical: true });
    }

    LogTransaction(transName) {
        this.#_uTransactionsList.push(transName);  
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] ${transName}` });   
    }

    /**
     * 
     * @param {Fault} fault 
     */
    UpdateStatus(fault) {

        switch (fault.code) {
            case FAULTS.BOTTOM_TAMPER_FAIL:
                this.#_SectionState.Lift = LIFT_STATE.ERR_TAMPER;
                break;
            case FAULTS.IO_DRIVER_ERR:
                this.#_SectionState.Lift = LIFT_STATE.BLOCKED;
                break;
            case FAULTS.IO_PORT_ERR:
                this.#_SectionState.Lift = LIFT_STATE.BLOCKED;
                break;
            case FAULTS.LEVEL_SENSOR_FAIL:
                this.#_Context.currentLevel = undefined;
                this.#_SectionState.Lift = LIFT_STATE.ERR_LEVEL;
                break;
            case FAULTS.LIFT_NO_POWER:
                this.#_SectionState.Lift = LIFT_STATE.NO_POWER;
                break;
            case FAULTS.LIFT_SHORT_CIRCUIT:
                this.#_SectionState.Lift = LIFT_STATE.SHORT_CIRCUIT;
                break;
            case FAULTS.LIFT_OVERLOAD:
                this.#_SectionState.Lift = LIFT_STATE.OVERLOAD;
                break;

            default:
                break;
        }
    }

    /**
     * 
     * @param {string} cmd 
     * @param {number} step 
     * @returns {Promise}
     */
    MotorStep(cmd, { step }) {
        this.#_ProxyCh.SetValue(
            this.#_Channels.liftMotorCtrl, { cmd, args: [{ step }] })

        /*let step1Response = await this.#_ProxyCh.Events.waitFor(`${this.#_Channels.liftMotorCtrl}-value`, {
            timeout: LIFT_CONSTANTS.MOTOR_RES_MAX_TIME, 
        }).catch(() => {
            this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Motor error: no response from "${this.#_Channels.liftMotorCtrl} on step ${step}"` });
            throw new Fault({ code: FAULTS.IO_TIMEOUT, critical: true });
        });
        if (step1Response[0].Value.error) {
            // throw new Error(stepResponse[0].Value.error);
            throw new Fault({ code: FAULTS.IO_DRIVER_ERR, critical: true });
        }*/
    }

    /**
     * @returns {Promise}
     */
    async Stop() {
        let current_0 = this.#_ProxyCh.GetValue(this.#_Channels.current);
        let isIdle = current_0 < CURRENT_RANGE.WORK_OK[0]
        const fwd = this.#_Context.movingDir > 0;
        this.LogTransaction(fwd ? U_TRANSACTIONS.LIFT_STOP_AFTER_FWD : U_TRANSACTIONS.LIFT_STOP_AFTER_REV);
        let step = 1;
        this.#_ProxyCh.SetValue(this.#_Channels.liftMotorCtrl2, 'STOP');
        // this.MotorStep('Off', { step });
        let elapsed = 0;
        let current_1;
        while (elapsed < SLEEP_BETWEEN_STEPS) {
            await sleep(50);
            elapsed += 50;
        
            if (!this.InBottomPos() && this.IsShorted())
                throw new Fault({ code: FAULTS.LIFT_SHORT_CIRCUIT, critical: true });

            current_1 = this.#_ProxyCh.GetValue(this.#_Channels.current);

            if (current_1 < CURRENT_RANGE.WORK_OK[0]) {
                this.#_Context.movingDir = 0;
                return;
            }
        }
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] Ток не пропал (${current_0} -> ${current_1}) после Остановки лифта` });
        throw new Fault({ code: FAULTS.IO_PORT_ERR, critical: true });
    }

    StopForce() {
        this.LogTransaction(this.#_Context.movingDir > 0 ? U_TRANSACTIONS.LIFT_STOP_AFTER_FWD : U_TRANSACTIONS.LIFT_STOP_AFTER_REV);
        
        this.#_ProxyCh.SetValue(this.#_Channels.liftMotorCtrl2, 'STOP');
        // this.MotorStep('Off', { step: 2 });

        this.#_Context.movingDir = 0;
    }

    /**
     * 
     * @param {import('./srvUtils.js').ClassFault} fault 
     */
    async OnFault(fault) {
        this.#_Context.timer?.clear?.();
        this._ProxyLogger.Log({ level: 'I', msg: `Fault: ${fault.code}` });
        this.UpdateStatus(fault);
        try {
            if (fault.code == FAULTS.LIFT_SHORT_CIRCUIT && this.#_Channels.psuWork) {
                this.OffPSU();
                this.StopForce();
                await sleep(SLEEP_BETWEEN_STEPS/2);
                this.OnPSU();
                this._V_VoltBuffer.Clear();
                this._I_CurrBuffer.Clear();
                let recovered = false;
                let elapsed = 0;
                while (elapsed < 5000) {
                    await sleep(SLEEP_BETWEEN_STEPS);
                    elapsed += SLEEP_BETWEEN_STEPS;
                    this._ProxyLogger.Log({ level: 'I', msg: `[STORAGE] Попытка восстановления: Iavg=${this._I_CurrBuffer.Filter()} V=${this._V_VoltBuffer.Filter()}` });
                    if (!this.IsShorted()) {
                        this._ProxyLogger.Log({ level: 'I', msg: `[LIFT] Успешное восстановление после перезагрузки ИП.` });
                        recovered = true;
                        break;
                    } 
                }
                if (!recovered) {
                    this._ProxyLogger.Log({ level: 'I', msg: `[LIFT] Признаки КЗ после перезагрузки ИП.` });
                    throw new Fault({ code: LIFT_STATE.SHORT_CIRCUIT });
                }
            } else {
                this.StopForce();
            }
            this.#_FSM.Dispatch(this.EVENTS.RECOVERED);

        } catch (innerFault) {
            this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Критический сбой при попытке экстренной остановки. Выключение ИП.`, obj: innerFault });
            this.UpdateStatus(innerFault);
        } finally {
            this.#_Context.currentTask?.rej?.(fault);
            this.#_Context.currentTask = null;
            this.#_Context.fallbackTimer?.clear?.();
        }
    }

    OffPSU() {
        this._ProxyLogger.Log({ level: 'I', msg: '[LIFT] Выключение ИП' });
        this.#_ProxyCh.SetValue(this.#_Channels.psuWork, 0);
    }

    OnPSU() {
        this._ProxyLogger.Log({ level: 'I', msg: '[LIFT] Включение ИП' });
        this.#_ProxyCh.SetValue(this.#_Channels.psuWork, 1);
    }

    async Idle() {
        try {
            await this.Stop();
        } catch (fault) {
            this._ProxyLogger.Log({ level: 'E', msg: `[LIFT] Ошибка при переходе в состояние IDLE` });
            this.#_FSM.Dispatch(this.EVENTS.FAULT, fault);
            return; 
        } 
        this.#_Context.currentTask?.res?.();
        this.#_Context.currentTask = null;
        this.#_Context.timer?.clear?.();
        this.#_Context.fallbackTimer?.clear?.()
    }

    OnStateChanged({ eventName, state, prevState}) {
        this._ProxyLogger.Log({ level: 'D', msg: `[LIFT] STATE: ${prevState} --[${eventName}]--> ${state}` });
    }
    /**
     * 
     * @returns {string}
     */
    CheckCurrentState(currVal) {
        /**@type {number|undefined} */
        let currentAmp = currVal ?? this._I_CurrBuffer.Filter();
        if (typeof currentAmp != 'number')
            return;

        for (let [levelName, [lowLim, highLim]] of Object.entries(CURRENT_RANGE)) {
            if (currentAmp >= lowLim && currentAmp < highLim)
                return ELECTR_CURR_STATE[levelName];
        }
    }

    InBottomPos() {
        return this.#_ProxyCh.GetValue(this.#_Channels.liftBottomTamper) == LIFT_BOTTOM_TAMPER_ON;
    }

    /**
     * @method
     * @returns {boolean}
     */
    IsShorted() {
        const highI = this.#_ProxyCh.GetValue(this.#_Channels.current) > CURRENT_RANGE.SHORT[0];
        const lowV = this.#_ProxyCh.GetValue(this.#_Channels.voltage) <= COMMON_CONSTANTS.MIN_VOLTAGE;
        return  highI || lowV;
    }

    Abort() {
        this.#_FSM.Dispatch(this.EVENTS.ABORT);
    }

    Reset() {
        this.#_FSM.Reset();
        this.#_SectionState.Lift = LIFT_STATE.OK;
        this.#_Context.currentLevel = undefined;
        this.#_Context.requiredLevel = undefined;
        this.#_Context.motorTransition = false;
        this.#_Context.timer?.clear();
        this.#_Context.timer = null;
        this.#_Context.fallbackTimer?.clear();
        this.#_Context.fallbackTimer = null;
        this.#_Context.movingDir = 0;
        this.#_uTransactionsList = [];
        this.#_LevelCachedValue = undefined;

        this._I_CurrBuffer.Clear();
        this._V_VoltBuffer.Clear();

        /*for (let [eventName, handler] of this.#_ChHandlers) 
            if (eventName && handler) this.#_ProxyCh.Events.off(eventName, handler);
        this.#_ChHandlers.clear();*/

        // const levelValueEventName = `${this.#_Channels.liftLevelSensor}-value`;
        // this.#_ProxyCh.Events.off(levelValueEventName, this.#_LevelHandler);

        // if (this.#_CurrentWatch) clearInterval(this.#_CurrentWatch)
        // this.#_CurrentWatch = null;
        
        this.Stop().catch(() => {}); // Catch stop error during reset
        if (this.#_Context.currentTask?.rej) {
            this.#_Context.currentTask.rej(new Error('Reset'));
        }
        this.#_Context.currentTask = null;
    }

    async Test_1(fpath, level, times) {
        let writer = new BufferedCsvWriter(fpath);
        await this.ElevateToBottom();
        let state = 'b';
        let I_interv = setInterval(() => {
            let I = this.#_ProxyCh.GetValue(this.#_Channels.current);
            let t = new Date().getTime();
            writer.write([t, state, I]);
        }, 100);
        while (times--) {
            state = 'u';
            try {
                await this.ElevateToLevel(level);
            } catch {
                break
            }
            state = 'd';
            try {
                await this.ElevateToBottom();
            } catch {
                break
            }
        }
        writer.close();
    }
}



module.exports = { ClassSpiralSectionLift };