const { EventEmitter2 } = require("eventemitter2");
const { ClassFault } = require('./srvUtils');
const { FAULT_DESC_RU, FAULTS } = require('./SpiralSectionConstants');
const { default: BaseSectionState } = require("../../srvStatesController/js/srvBaseSectionState");
const { ClassSpiralSection } = require("./srvSpiralSection");
const { SECTION_TYPE } = require("../../srvStatesController/ts/IMachineConfig");

let sleep = require('timers/promises').setTimeout;

class ClassVendingSectionFacade {

    _Context = { 
        order: null,
    };

    /**@type {EventEmitter2} */
    #_Events = new EventEmitter2();
    /** @type {import('../../srvProxySection/js/Messages').TypeTarget} */
    _Target = null;
    /** @type {BaseSectionState} */
    #_SectionState = null;
    /** @type {ClassSpiralSection} */
    #_Section = null;
    /** @type {ClassLoggerDecorator} */
    #_Logger = null;

    /**
     * @param {object} [param0={}]
     * @param {import("./srvSpiralSection").TypeProxyCh} [param0.ProxyCh]
     * @param {import("./srvSpiralSection").TypeSpiralSectionOpts} [param0.advOpts]
     * @param {import('../../srvProxySection/js/Messages').TypeTarget} [param0.target]
     * @param {BaseSectionState} [param0.sectionState]
     * @param {import("../../srvStatesController/js/srvSectionStateController")} [param0.globalState]
     * @param {ClassLoggerDecorator} [param0.ProxyLogger]
     * @param {import("../../srvStatesController/ts/IMachineConfig").MachineConfig} [param0.machineConfig]
     */
    constructor({ ProxyCh, advOpts, target, sectionState, globalState, ProxyLogger, machineConfig } = {}) {
        this._Target = target;
        this.#_Logger = ProxyLogger;
        this.#_SectionState = sectionState;

        const spiralConf = machineConfig.Sections.find(s => s.Type === SECTION_TYPE.SPIRAL);
        const psuConf = machineConfig.Power.PSU.find(p => p.Bus === spiralConf.PowerBus);

        const channels = {
            door: spiralConf.Channels.Door.Sensor,
            monBox: spiralConf.Channels.DeliveryBox.Monitoring,
            boxChannels: {
                lock: spiralConf.Channels.DeliveryBox.Lock,
                optic: spiralConf.Channels.DeliveryBox.Optic
            },
            storageChannels: {
                matrixCtrlChannel: spiralConf.Channels.Storage.MatrixCtrl,
                spiralTamperChannels: spiralConf.Channels.Storage.Tamper,
                current: psuConf.Channels.CurrentOut,
                voltage: psuConf.Channels.VoltageOut,
                short: psuConf.Channels?.Short,
                psuWork: psuConf.Channels?.Work,
                monSpirals: spiralConf.Channels.Storage.Monitoring
            },
            liftChannels: {
                liftMotorCtrl: spiralConf.Channels.Lift.MotorCtrl,
                liftLevelSensor: spiralConf.Channels.Lift.LevelSensor,
                liftBottomTamper: spiralConf.Channels.Lift.BottomTamper,
                liftTopTamper: spiralConf.Channels.Lift.TopTamper,
                current: psuConf.Channels.CurrentOut,
                voltage: psuConf.Channels.VoltageOut,
                short: psuConf.Channels?.Short,
                psuWork: psuConf.Channels?.Work,
                monLift: spiralConf.Channels.Lift.Monitoring
            }
        };

        const defaultAdvOpts = {
            storageOpts: {
                busNumber: spiralConf.PowerBus,
                size: { rows: spiralConf.Rows, cols: spiralConf.Cols },
                globalState
            },
            liftOpts: {
                maxLevel: spiralConf.Rows,
                busNumber: spiralConf.PowerBus
            }
        };

        this._Target = target ?? { id: spiralConf.ID, name: spiralConf.Name };
        this.#_Section = new ClassSpiralSection({
            ProxyCh,
            channels,
            advOpts: advOpts ?? defaultAdvOpts,
            sectionState,
            ProxyLogger
        });

        this.#_Section.on('result', this.OnSectionResult.bind(this));
    }

    get Target() { return this._Target; }

    get Events() {
        // TODO: return proxy
        return this.#_Events;
    }

    get Section() { return this.#_Section; }

    /**
     * @param {import('../../srvProxySection/js/Messages').Order} transaction 
     * @param {object} param0 
     */
    async PerformTransaction(transaction, param0) {
        const { mock } = param0 ?? {}; 
        const { Command, ID, Cells } = transaction;
        if (this._Context.order) 
            return this.HandleErr(new Error('Выполняется предыдущая операция'));
        this.#_Logger.TransactionID = ID;
        this._Context.order = { ID, Cells };
        return (mock ? this._ExecuteMock(Cells) : this.#_Section.Execute(Cells)).finally(() => {
            this._Context.order = null;
        });
    }

    Invoke(...args) {
        return this.#_Section.Invoke(...args);
    }

     /**
     * Унифицированный обработчик результатов от секции
     * @param {object} param0
     * @param {object|null} param0.cell
     * @param {Error|ClassFault|null} param0.error
     */
    OnSectionResult({ ok, cell }) {
        const { ID } = this._Context?.order ?? {};
        if (ID) {
            this.SendResponse({
                Response: {
                    ID: crypto.randomUUID(),
                    ParentID: ID,			        // идентификатор транзакции, на которую отвечаем
                    Timestamp: new Date().getTime(),
                    Target: this._Target,
                    Cell: cell,
                    Result:  ok ? 'OK' : 'FAIL',           
                    Message: ok ? 'Операция выполнена успешно' : 'Ошибка при выдаче ТМЦ'
                }  
            });
        };
    }

    SendResponse(msg) {
        this.#_Events.emit('response', msg);
    }

    Reset() {
        this._Context.order = null;
        this.#_Section.Reset();
    }

    /**
     * @description
     * Выполняет имитацию выдачи:
     * @param {[import('../../srvProxySection/js/Messages').Cell]} _cells 
     */
    async _ExecuteMock(_cells) {
        try {
            /** @type {[import("./srvSpiralSection").TypeOrder]} */
            const orders = [..._cells];
            for (const order of orders) {
                for (let i = 0; i < order.quantity; i++) {
                    console.log(`[MOCK] Dispense row=${order.row}, column=${order.column}, item=${i + 1}/${order.quantity}`);
                    // имитация успешной выдачи
                    this.OnResult({...order, quantity: 1 }, '');

                    await sleep(1000);
                }
            }

        } catch (e) {
            this.HandleErr(e, 'Ошибка выполнении MOCK транзакции');
        }
    }
}

class ClassLoggerDecorator {
    #_TransactionID
    constructor(logger) {
        this._logger = logger;
    }
    set TransactionID(value) {
        this.#_TransactionID = value;
    }
    /**
     * @param {object} opts
     * @param {string} opts.level
     * @param {string} opts.msg
     * @param {object} opts.obj 
     */
    Log(opts) {
        return this._logger.Log({ 
            ...opts, 
            obj: this.#_TransactionID ? { ...opts.obj, transactionID: this.#_TransactionID } : opts.obj
        });
    }
}

exports.default = ClassVendingSectionFacade;