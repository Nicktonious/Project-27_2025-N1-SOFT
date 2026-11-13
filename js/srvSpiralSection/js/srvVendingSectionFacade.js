const { EventEmitter2 } = require("eventemitter2");
const { ClassSpiralSection } = require("./srvSpiralSection");
const { SpiralStateAdapter } = require("./srvSpiralStateAdapter");
const { SpiralMonitoringAdapter } = require("./srvSpiralMonitoringAdapter");
const { SECTION_TYPE } = require("../../srvStatesController/ts/IMachineConfig");
const { default: StatesController } = require("../../srvStatesController/js/srvSectionStateController");

let sleep = require('timers/promises').setTimeout;
// TODO: вынести в отдельный файл
const COMMANDS = {
    GetItem: 'GetItem', //– запрос на выдачу ТМЦ из указанных ячеек;
    GetAll: 'GetAll', // – выдача ТМЦ, открытие всех ячеек (массив Cells в данном случае не учитывается);
    SetItem: 'SetItem', // – загрузка ТМЦ в указанные ячейки;
    SetLiftLevel: 'SetLiftLevel',
    RotateSpiral: 'RotateSpiral',
    OpenDeliveryBox: 'OpenDeliveryBox',
    SetAll: 'SetAll', // – загрузка ТМЦ во все ячейки по загруженной конфигурации;
    GetStatus: 'GetStatus',// – получение статуса аппарата;
    GetWeight: 'GetWeight', 
    Reboot: 'Reboot', //– перезагрузка аппарата;
    SetConfig: 'SetConfig', ///– загрузка конфигурационного файла;
    Maintenance: 'Maintenance', //– перевод аппарата в режим обслуживания
}

/**
 * Класс-фасад спиральной вендинговой секции.
 * Выступает адаптером между внешним прокси-сервисом/брокером сообщений (`srvProxySection`)
 * и низкоуровневым контроллером спиральной секции (`ClassSpiralSection`).
 * Принимает транзакции на выдачу ТМЦ, запускает операцию и формирует стандартизированные ответы о результатах.
 */
class ClassVendingSectionFacade {

    /**
     * Контекст текущей выполняемой транзакции
     * @type {{ order: { ID: string, Cells: import('../../srvProxySection/js/Messages').Cell[] } | null }}
     */
    _Context = { 
        order: null,
    };

    /**
     * Эмиттер событий фасада
     * @type {EventEmitter2}
     */
    #_Events = new EventEmitter2();
    /**
     * Идентификатор и имя целевой секции для сообщений брокера
     * @type {import('../../srvProxySection/js/Messages').TypeTarget}
     */
    _Id = null;

    /**
     * @type {import("../../srvStatesController/ts/IGlobalState").SpiralSectionState}
     */
    #_SectionState = null;
    /**
     * Состояние секции для системы мониторинга и отчетов
     * @type {import("../../srvStatesController/ts/IGlobalMonitoring").SpiralSectionMonitoring}
     */
    #_SectionMonitoring = null;
    /**
     * Адаптер состояния секции (Anti-Corruption Layer)
     * @type {SpiralStateAdapter}
     */
    #_StateAdapter = null;
    /**
     * Адаптер мониторинга моторесурса секции
     * @type {SpiralMonitoringAdapter}
     */
    #_MonitoringAdapter = null;
    /**
     * Экземпляр контроллера механизмов спиральной секции (лифт, хранилище, люк выдачи)
     * @type {ClassSpiralSection}
     */
    #_Section = null;
    /**
     * Декоратор логгера с добавлением TransactionID
     * @type {ClassLoggerDecorator}
     */
    #_Logger = null;

    /**
     * Создает экземпляр фасада спиральной секции.
     * Инкапсулирует связывание StatesController (Config, Monitoring, States) и логики спиральной секции.
     * 
     * @param {object} [param0={}] Параметры инициализации фасада
     * @param {import("./srvSpiralSection").TypeProxyCh} param0.ProxyCh Прокси-канал для работы с шиной ввода-вывода
     * @param {string|number} param0.sectionId ID секции
     * @param {import("../../srvStatesController/js/srvSectionStateController").default} [param0.StatesController] Контроллер глобального состояния автомата
     * @param {ClassLoggerDecorator|import("./srvSpiralSection").TypeProxyLogger} [param0.ProxyLogger] Логгер для записи диагностических сообщений
     * @param {import("../../srvStatesController/ts/IMachineConfig").MachineConfig} [param0.machineConfig] Конфигурация автомата (для тестового режима без StatesController)
     */
    constructor({ ProxyCh, sectionId, StatesController, ProxyLogger, machineConfig } = {}) {
        if (typeof sectionId !== 'string' && typeof sectionId !== 'number') {
            throw new Error('ClassVendingSectionFacade: sectionId обязателен');
        }
        if (!ProxyCh) {
            throw new Error('ClassVendingSectionFacade: ProxyCh обязателен');
        }

        const config = StatesController?.Machine?.Config ?? machineConfig;
        if (!config || !config.Sections) {
            throw new Error('ClassVendingSectionFacade: StatesController.Machine.Config или machineConfig обязателен для инициализации');
        }

        const secIdx = config.Sections.findIndex(s => s.ID == sectionId);
        if (secIdx < 0) {
            throw new Error(`ClassVendingSectionFacade: Секция с ID "${sectionId}" не найдена в конфигурации`);
        }
        const spiralConf = config.Sections[secIdx];

        this._Id = spiralConf.ID;
        this.#_Logger = ProxyLogger;

        // Поиск состояния секции
        const sectionState = StatesController.Machine.States.Sections.find(s => s.ID == sectionId);
        if (!sectionState) {
            throw new Error(`ClassVendingSectionFacade: Состояние секции с ID "${sectionId}" не найдено в StatesController.Machine.States.Sections`);
        }

        // Определение шины питания секции в StatesController.Machine.States.Bus
        const busIdx = config.Power?.Buses?.findIndex(b => b.ID == spiralConf.PowerBus);
        let getBusState = busIdx >= 0 
            ? () => StatesController?.Machine?.States?.Bus?.[busIdx] 
            : null;

        this.#_StateAdapter = new SpiralStateAdapter(sectionState, { getBusState });

        const ch = spiralConf.Channels;

        // Привязка мониторинга моторесурса через примитивный адаптер каналов
        this.#_MonitoringAdapter = new SpiralMonitoringAdapter({
            ProxyCh,
            channels: {
                monBox: ch?.DeliveryBox?.Monitoring,
                monLift: ch?.Lift?.Monitoring,
                monSpirals: ch?.Storage?.Monitoring,
            }
        });

        // Проверка наличия обязательных каналов
        if (!ch?.Door?.Sensor) throw new Error('ClassVendingSectionFacade: отсутствует обязательный канал Channels.Door.Sensor');
        if (!ch?.DeliveryBox?.Lock || !ch?.DeliveryBox?.Optic) {
            throw new Error('ClassVendingSectionFacade: отсутствуют обязательные каналы Channels.DeliveryBox (Lock, Optic)');
        }
        if (!ch?.Storage?.MatrixCtrl || !ch?.Storage?.Tamper) {
            throw new Error('ClassVendingSectionFacade: отсутствуют обязательные каналы Channels.Storage (MatrixCtrl, Tamper)');
        }
        if (!ch?.Lift?.MotorCtrl || !ch?.Lift?.LevelSensor || !ch?.Lift?.BottomTamper || !ch?.Lift?.TopTamper) {
            throw new Error('ClassVendingSectionFacade: отсутствуют обязательные каналы Channels.Lift (MotorCtrl, LevelSensor, BottomTamper, TopTamper)');
        }
        const powerCh = ch?.Power;
        if (!powerCh?.Current || !powerCh?.Voltage || !powerCh?.PsuWork) {
            throw new Error('ClassVendingSectionFacade: отсутствуют обязательные каналы Channels.Power (Current, Voltage, PsuWork)');
        }

        const channels = {
            door: ch.Door.Sensor,
            boxChannels: {
                lock: ch.DeliveryBox.Lock,
                optic: ch.DeliveryBox.Optic
            },
            storageChannels: {
                matrixCtrlChannel: ch.Storage.MatrixCtrl,
                spiralTamperChannels: ch.Storage.Tamper,
                current: powerCh.Current,
                voltage: powerCh.Voltage,
                short: powerCh.Short,
                psuWork: powerCh.PsuWork
            },
            liftChannels: {
                liftMotorCtrl: ch.Lift.MotorCtrl,
                liftLevelSensor: ch.Lift.LevelSensor,
                liftBottomTamper: ch.Lift.BottomTamper,
                liftTopTamper: ch.Lift.TopTamper,
                current: powerCh.Current,
                voltage: powerCh.Voltage,
                short: powerCh.Short,
                psuWork: powerCh.PsuWork
            }
        };

        const opts = {
            storageOpts: {
                busNumber: spiralConf.PowerBus,
                size: { rows: spiralConf.Rows, cols: spiralConf.Cols },
                globalState: StatesController
            },
            liftOpts: {
                maxLevel: spiralConf.Rows,
                busNumber: spiralConf.PowerBus
            }
        };

        this.#_Section = new ClassSpiralSection({
            ProxyCh,
            channels,
            advOpts: opts,
            sectionState,
            stateAdapter: this.#_StateAdapter,
            monitoringAdapter: this.#_MonitoringAdapter,
            ProxyLogger
        });

        this.#_Section.on('result', this.OnSectionResult.bind(this));
    }

    /**
     * Адаптер состояния спиральной секции
     * @returns {SpiralStateAdapter}
     */
    get StateAdapter() { return this.#_StateAdapter; }

    /**
     * Адаптер мониторинга моторесурса спиральной секции
     * @returns {SpiralMonitoringAdapter}
     */
    get MonitoringAdapter() { return this.#_MonitoringAdapter; }

    /**
     * Идентификатор секции
     * @returns {string} Идентификатор секции
     */
    get ID() { return this._Id; }

    /**
     * Эмиттер событий фасада
     * @returns {EventEmitter2}
     */
    get Events() {
        return this.#_Events;
    }

    /**
     * Экземпляр контроллера механизмов спиральной секции
     * @returns {ClassSpiralSection}
     */
    get Section() { return this.#_Section; }

    /**
     * Выполняет поступившую транзакцию (заказ на выдачу ТМЦ).
     * Проверяет отсутствие активной операции, привязывает ID транзакции к логгеру,
     * запускает реальную выдачу через `ClassSpiralSection.Execute` или тестовую симуляцию `_ExecuteMock`.
     * 
     * @param {import('../../srvProxySection/js/Messages').Order} transaction Объект транзакции с описанием заказа
     * @param {object} [param0] Дополнительные параметры
     * @param {boolean} [param0.mock] Флаг выполнения в режиме имитации (mock)
     * @returns {Promise<any>} Промис завершения транзакции
     */
    async PerformTransaction(transaction, param0) {
        const { mock } = param0 ?? {}; 
        const { Command, ID, Cells } = transaction;
        if (this._Context.order) 
            return this.HandleErr(new Error('Выполняется предыдущая операция'));
        this.#_Logger.TransactionID = ID;
        this._Context.order = { ID, Cells };
        if (mock) return this._ExecuteMock(Cells);
        try {
            const cmd = Command.toLowerCase();

            if (cmd === COMMANDS.GetItem.toLowerCase()) {
                return await this.#_Section.Execute(Cells);
            }
            if (cmd === COMMANDS.SetLiftLevel.toLowerCase()) {
                const res = await this.#_Section.ElevateLift(transaction.Level);
                this.OnSectionResult({ ok: true, cell: null });
                return res;
            }
            if (cmd === COMMANDS.RotateSpiral.toLowerCase()) {
                // выполняется вращение только одной спирали
                const targetCell = Cells?.[0] ? { row: Cells[0].row, column: Cells[0].column } : null;
                const res = await this.#_Section.ManualRotateSpiral(Cells[0]);
                this.OnSectionResult({ ok: true, cell: targetCell });
                return res;
            }
            if (cmd === COMMANDS.OpenDeliveryBox.toLowerCase()) {
                const res = await this.#_Section.OpenBox();
                this.OnSectionResult({ ok: true, cell: null });
                return res;
            }
        } catch (e) {
            const targetCell = Cells?.[0] ? { row: Cells[0].row, column: Cells[0].column } : null;
            this.OnSectionResult({ ok: false, cell: targetCell });
            return this.HandleErr(e, `Ошибка при выполнении ${Command}`);
        } finally {
            this._Context.order = null;
        }
    }

    /**
     * Прямой вызов служебных методов спиральной секции в обход очереди транзакций.
     * 
     * @param {...any} args Аргументы, передаваемые в метод `ClassSpiralSection.Invoke`
     * @returns {any} Результат выполнения метода
     */
    Invoke(...args) {
        return this.#_Section.Invoke(...args);
    }

    /**
     * Унифицированный обработчик результатов выдачи единицы товара от спиральной секции.
     * Формирует сообщение ответа на транзакцию и отправляет его брокеру через `SendResponse`.
     * 
     * @param {object} param0 Параметры результата
     * @param {boolean} param0.ok Флаг успешности выдачи единицы товара
     * @param {{ row: number, column: number }} param0.cell Координаты ячейки, из которой производилась выдача
     */
    OnSectionResult({ ok, cell }) {
        const { ID } = this._Context?.order ?? {};
        if (ID) {
            this.SendResponse({
                Response: {
                    ID: crypto.randomUUID(),
                    ParentID: ID,			        // идентификатор транзакции, на которую отвечаем
                    Timestamp: new Date().getTime(),
                    Target: this._Id,
                    Cell: cell,
                    Result:  ok ? 'OK' : 'FAIL'
                }  
            });
        };
    }

    /**
     * Логирует ошибку операции
     * @param {Error|any} e Объект ошибки
     * @param {string} [msg=''] Поясняющее сообщение
     */
    HandleErr(e, msg = '') {
        this.#_Logger?.Log({ level: 'E', msg: `${msg}: ${e?.message ?? e}`.trim() });
    }

    /**
     * Отправляет сообщение ответа на транзакцию подписчикам фасада (генерирует событие `'response'`).
     * 
     * @param {object} msg Объект ответа с телом сообщения
     */
    SendResponse(msg) {
        this.#_Events.emit('response', msg);
    }

    /**
     * Сбрасывает текущий контекст заказа фасада и выполняет сброс спиральной секции в исходное состояние.
     */
    Reset() {
        this._Context.order = null;
        this.#_Section.Reset();
    }

    /**
     * Выполняет программную имитацию (симуляцию) выдачи товаров без задействования актуаторов.
     * Поочередно генерирует успешные события выдачи для каждой ячейки с искусственной задержкой.
     * 
     * @param {import('../../srvProxySection/js/Messages').Cell[]} _cells Список ячеек и количеств для имитации выдачи
     * @returns {Promise<void>}
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

/**
 * Декоратор логгера, обогащающий логируемые данные идентификатором текущей транзакции (`TransactionID`).
 */
class ClassLoggerDecorator {
    /**
     * Идентификатор текущей активной транзакции
     * @type {string|null}
     */
    #_TransactionID

    /**
     * @param {import("./srvSpiralSection").TypeProxyLogger} logger Базовый экземпляр логгера
     */
    constructor(logger) {
        this._logger = logger;
    }

    /**
     * Устанавливает идентификатор активной транзакции
     * @param {string|null} value Идентификатор транзакции
     */
    set TransactionID(value) {
        this.#_TransactionID = value;
    }

    /**
     * Записывает сообщение в лог, добавляя `transactionID` в объект метаданных при его наличии.
     * 
     * @param {object} opts Параметры записи лога
     * @param {string} opts.level Уровень логирования ('I', 'D', 'E', 'error' и др.)
     * @param {string} opts.msg Текст сообщения
     * @param {object} [opts.obj] Дополнительные метаданные для логирования
     */
    Log(opts) {
        return this._logger.Log({ 
            ...opts, 
            obj: this.#_TransactionID ? { ...opts.obj, transactionID: this.#_TransactionID } : opts.obj
        });
    }
}

exports.default = ClassVendingSectionFacade;