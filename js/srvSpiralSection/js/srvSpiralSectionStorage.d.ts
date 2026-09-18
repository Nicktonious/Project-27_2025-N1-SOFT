import { EventEmitter2 } from "eventemitter2";
import { TypeProxyCh, TypeProxyLogger } from "./srvSpiralSection";
import SpiralSectionState from "./srvSpiralSectionStates";
import StatesController from "../../srvStatesController/js/srvSectionStateController";

/**
 * Конфигурация каналов ввода-вывода спирального хранилища
 */
export interface TypeSpiralSectionStorageChannels {
    /** Канал управления матрицей коммутации моторов спиралей */
    matrixCtrlChannel: string;
    /** Массив каналов концевиков (тамперов) спиралей по рядам */
    spiralTamperChannels: string[];
    /** Канал измерения тока потребления */
    current: string;
    /** Канал измерения напряжения питания */
    voltage: string;
    /** Канал сигнала короткого замыкания */
    short: string;
    /** Канал управления питанием ИП (включение/выключение питания) */
    psuWork: string;
    /** Канал мониторинга состояния спиралей */
    monSpirals: string;
}

/**
 * Дополнительные параметры конфигурации спирального хранилища
 */
export interface TypeSpiralSectionStorageOpts {
    /** Номер шины питания */
    busNumber: number;
    /** Размеры матрицы ячеек */
    size: {
        /** Количество рядов (полок) */
        rows: number;
        /** Количество колонок */
        cols: number;
    };
    /** Контроллер глобального состояния автомата */
    globalState: StatesController;
}

/**
 * Опции отдельной ячейки/спирали
 */
export interface TypeSpiralSectionUnitOpts {
    /** Линейный индекс ячейки */
    index: number;
    /** Координаты (ряд и колонка) */
    coords: TypeCoords;
    /** Индекс соответствующего тампера ряда */
    tamperInd: number;
}

/**
 * События FSM спирального хранилища
 */
export interface TypeSpiralSectionUnitEvents {
    /** Команда запуска выдачи */
    DISPENSE_COMMAND: string;
    /** Сигнал срабатывания тампера (выдана 1 единица товара) */
    DISPENSED_SINGLE: string;
    /** Выдача заказа полностью завершена */
    COMPLETED: string;
    /** Таймаут вращения спирали */
    ROTATE_TIMEOUT: string;
    /** Ошибка / сбой */
    FAULT: string;
    /** Результат выдачи единицы товара */
    DISPENSE_RESULT: string;
    /** Восстановление после ошибки */
    RECOVERED: string;
    /** Команда тестирования спирали */
    TEST_COMMAND: string;
    /** Тестирование спирали завершено */
    TEST_DONE: string;
    /** Команда запуска мотора по времени */
    RUN_MOTOR_COMMAND: string;
    /** Вращение мотора по времени завершено */
    RUN_MOTOR_DONE: string;
}

/**
 * Состояние отдельной ячейки/спирали в хранилище
 */
export interface TypeUnit {
    /** Линейный индекс ячейки */
    index: number;
    /** Координаты ячейки (ряд, колонка) */
    coords: TypeCoords;
    /** Вместимость ячейки */
    capacity: number;
    /** Количество загруженных единиц */
    itemsLoaded: number;
    /** Количество оставшихся единиц */
    itemsLeft: number;
    /** Запрошенное количество в текущем заказе */
    itemsRequested?: number;
    /** Количество выданных единиц в текущей сессии */
    itemsDispensed: number;
    /** Статус ячейки (OK, BLOCKED, ERR_TAMPER и др.) */
    status: string;
    /** Индекс тампера ряда */
    tamperInd: number;
    /** Флаг включения мотора */
    isOn?: boolean;
}

/**
 * Контекст текущего выполняемого заказа
 */
export interface TypeOrderContext {
    /** Индекс ячейки, выполняющей выдачу */
    unitIndex: number;
    /** Требуемое количество единиц товара */
    itemsRequested: number;
    /** Фактически выданное количество единиц товара */
    itemsDispensed: number;
    /** Признак ручного режима */
    manual: boolean;
    /** Флаг принудительной отмены заказа */
    aborted?: boolean;
}

/**
 * Промис-задача асинхронной операции
 */
export interface TypeTask {
    res: (value?: any) => void;
    rej: (reason?: any) => void;
}

/**
 * Внутренний контекст спирального хранилища
 */
export interface TypeSpiralSectionContext {
    /** Количество рядов (полок) */
    rows: number;
    /** Количество колонок */
    cols: number;
    /** Данные текущего заказа */
    currentOrder: TypeOrderContext | null;
    /** Массив всех ячеек секции */
    units: TypeUnit[];
    /** Таймер контроля времени полного оборота спирали */
    dispenseTimer?: import('./srvUtils').TypeTimer | null;
    /** Аварийный общий таймер ожидания выдачи */
    fallbackTimer?: import("./srvUtils").TypeTimer | null;
    /** Текущая активная промис-задача */
    currentTask?: TypeTask | null;
}

/**
 * Координаты ячейки матрицы
 */
export interface TypeCoords {
    /** Колонка (столбец) */
    col: number;
    /** Ряд (полка) */
    row: number;
}

/**
 * Состояния электрического тока
 */
export interface TypeElectrCurrentState {
    IDLE: string;
    WORK_OK: string;
    STUCK: string;
    SHORT: string;
}

/**
 * Класс управления спиральным хранилищем вендинговой секции.
 * Обеспечивает коммутацию моторов матрицы спиралей, поэтапное включение/выключение,
 * контроль тока потребления и сигналов тамперов, проведение тестирования и выдачи ТМЦ.
 */
export declare class ClassSpiralSectionStorage {
    /**
     * Константы состояний FSM спирального хранилища
     */
    static STATE: {
        readonly IDLE: string;
        readonly DISPENSING: string;
        readonly FAULT: string;
        readonly TESTING: string;
        readonly RUNNING_MOTOR: string;
    };

    /**
     * @param params Параметры инициализации спирального хранилища
     */
    constructor(params: {
        ProxyCh: TypeProxyCh;
        channels: TypeSpiralSectionStorageChannels;
        advOpts: TypeSpiralSectionStorageOpts;
        sectionState: SpiralSectionState;
        ProxyLogger?: TypeProxyLogger;
    });

    /** Номер шины питания */
    _BusNumber: number;
    /** Буфер усреднения значений тока */
    _I_CurrBuffer: any;
    /** Буфер усреднения значений напряжения */
    _V_VoltBuffer: any;
    /** Прокси-логгер для записи диагностических сообщений */
    _ProxyLogger?: TypeProxyLogger;
    /** Счётчик последовательных обнаружений отсутствия питания */
    nopower_count?: number;

    /**
     * Константы событий спирального хранилища для FSM
     */
    get EVENTS(): TypeSpiralSectionUnitEvents;

    /**
     * Эмиттер внутренних событий хранилища ('dispense', 'fail' и др.)
     */
    get Events(): EventEmitter2;

    /**
     * Максимальный уровень (количество рядов/полок в секции)
     */
    get MaxLevel(): number;

    /**
     * Текущее состояние конечного автомата (FSM) хранилища
     */
    get State(): string;

    /**
     * Проверяет доступность ячейки для выдачи (статус OK, ERR_TAMPER или ACTUATOR_NO_POWER).
     * 
     * @param param0 Координаты ячейки (ряд и колонка)
     * @returns true, если ячейка доступна для работы
     */
    IsAvailable(param0: { row: number; column: number }): boolean;

    /**
     * Проверяет ячейку на возможность проведения теста или выдачи:
     * убеждается, что в данном ряду отсутствует короткое замыкание,
     * а статус ячейки является допустимым (OK, ERR_TAMPER_BAD_POS, ACTUATOR_NO_POWER).
     * 
     * @param coords Координаты ячейки
     * @returns true, если ячейку можно тестировать/использовать
     */
    IsCheckable(coords: { row: number; column?: number; col?: number }): boolean;

    /**
     * Генератор-итератор по всем ячейкам указанного ряда (полки).
     * 
     * @param rowIndex Индекс строки (ряда) матрицы (0-based)
     */
    RowIterator(rowIndex: number): Generator<TypeUnit, void, unknown>;

    /**
     * Генератор-итератор по ячейкам указанного ряда (полки).
     * 
     * @param rowIndex Индекс строки (ряда) матрицы (0-based)
     */
    RowIndexIterator(rowIndex: number): Generator<TypeUnit, void, unknown>;

    /**
     * Генератор-итератор по ячейкам указанной колонки (столбца) по всем рядам матрицы.
     * 
     * @param colIndex Индекс столбца матрицы (0-based)
     */
    ColIterator(colIndex: number): Generator<TypeUnit, void, unknown>;

    /**
     * Инициализирует спиральное хранилище: настраивает обработчики событий каналов,
     * запускает мониторинг ИП и принудительно отключает все моторы на старте.
     */
    Init(): void;

    /**
     * Регистрирует обработчики событий каналов тамперов спиралей, тока и напряжения.
     */
    InitEventHandlers(): void;

    /**
     * Инициализирует обработчики сигналов с тамперов спиралей для определения факта выдачи единицы товара.
     * При срабатывании тампера во время активного опроса отправляет событие DISPENSED_SINGLE в FSM.
     */
    SetTamperHandlers(): void;

    /**
     * Устанавливает обработчик канала измерения тока и накапливает данные в буфер `_I_CurrBuffer`.
     */
    SetCurrentHandler(): void;

    /**
     * Устанавливает обработчик канала измерения напряжения и накапливает данные в буфер `_V_VoltBuffer`.
     */
    SetVoltageHandler(): void;

    /**
     * Запускает периодический мониторинг тока и напряжения питания спиралей (PSU watch).
     * Отслеживает короткие замыкания (КЗ), перегрузки по току и пропадание питания приводов.
     */
    StartPSUWatch(): void;

    /**
     * Сбрасывает временный статус перегрузки по току (OVERLOAD_I) у ячеек обратно в статус OK.
     */
    ClearOverloadStatus(): void;

    /**
     * Обработчик перехода состояния конечного автомата (FSM).
     * 
     * @param param0 Данные перехода: имя события, текущее и предыдущее состояния
     */
    OnStateChanged(param0: { eventName: string; state: string; prevState: string }): void;

    /**
     * Обработчик события срабатывания тампера при выдаче единицы ТМЦ.
     * Фиксирует выдачу, генерирует событие 'dispense', обновляет счётчики выданного товара
     * и при достижении заказанного количества отправляет COMPLETED в FSM.
     * 
     * @param param Объект с индексом сработавшего тампера
     */
    OnDispensedSingle(param: { tamperInd: number }): Promise<void>;

    /**
     * Обработчик таймаута вращения спирали (товар не был выдан за максимальное время оборота).
     * Переводит FSM в состояние FAULT с ошибкой ERR_TAMPER.
     * 
     * @param param Объект с индексом зависшей ячейки
     */
    OnTimeout(param: { index: number }): Promise<void>;

    /**
     * Обработчик ошибок и аварийных ситуаций спирального хранилища:
     * отключает мотор ячейки, при КЗ пытается перезагрузить источник питания (ИП)
     * и восстановить нормальную работу, генерирует событие 'fail' и отклоняет промис активной задачи.
     * 
     * @param fault Объект ошибки/сбоя (StorageFault)
     */
    OnFault(fault: any): Promise<void>;

    /**
     * Отключает питание приводов спиралей через канал управления источником питания (`psuWork`).
     */
    OffPSU(): void;

    /**
     * Включает питание приводов спиралей через канал управления источником питания (`psuWork`).
     */
    OnPSU(): void;

    /**
     * Переводит хранилище в состояние покоя (IDLE):
     * выключает активный двигатель, сбрасывает таймеры выдачи и разрешает промис задачи.
     */
    Idle(): Promise<void>;

    /**
     * Экстренная остановка приводов спирального механизма.
     */
    EmergencyOff(): void;

    /**
     * Запускает операцию выдачи товара из указанной ячейки спирального механизма.
     * 
     * @param order Параметры заказа: ряд (row), колонка (column) и количество (quantity)
     * @param manual Признак ручного режима выдачи (без фильтрации первого импульса тампера)
     * @returns Промис, разрешающийся по завершении выдачи или отклоняемый при сбое
     */
    Dispense(order: import("./srvSpiralSection").TypeOrder, manual?: boolean): Promise<void>;

    /**
     * Запускает проверку исправности спирального механизма ячейки (проверка цепи и исходного положения тампера).
     * 
     * @param order Параметры ячейки для проверки (row, column)
     * @returns Промис, разрешающийся при успешном прохождении теста
     */
    TestSpiral(order: import("./srvSpiralSection").TypeOrder): Promise<void>;

    /**
     * Включает мотор заданной ячейки на указанное время (в миллисекундах).
     * 
     * @param param Параметры: строка, столбец и длительность вращения
     * @returns Промис выполнения вращения
     */
    RunMotor(param: { row: number; column: number; duration: number }): Promise<void>;

    /**
     * Внутренний метод FSM для выполнения выдачи товара:
     * запускает таймер контроля полного оборота, фазно включает двигатель спирали и включает опрос тампера.
     * 
     * @param order Параметры заказа
     * @param manual Флаг ручного режима
     */
    _Dispense(order: import("./srvSpiralSection").TypeOrder, manual?: boolean): Promise<void>;

    /**
     * Внутренний метод FSM для вращения мотора спирали по таймеру.
     * 
     * @param param Координаты ячейки и длительность вращения
     */
    _RunMotor(param: { row: number; column: number; duration: number }): Promise<void>;

    /**
     * Определяет состояние электрического тока цепи мотора (IDLE, WORK_OK, STUCK/OVERLOAD, SHORT).
     * 
     * @param currVal Необязательное точечное значение тока (по умолчанию берётся фильтрованное значение из буфера)
     * @returns Строковый идентификатор состояния тока
     */
    CheckCurrentState(currVal?: number): string | undefined;

    /**
     * Генератор ячеек по заданной области видимости (scope).
     * 
     * @param index Линейный индекс базовой ячейки
     * @param scope Область выборки: 'single' (одна ячейка), 'row' (вся строка), 'col' (вся колонка), 'all' (все ячейки)
     */
    UnitsByScope(index: number, scope: 'single' | 'row' | 'col' | 'all'): Generator<TypeUnit, void, unknown>;

    /**
     * Обновляет контекст хранилища после попытки выдачи:
     * изменяет счётчик выданных товаров и статусы ячеек по указанной области видимости.
     * 
     * @param param0 Объект с индексом целевой ячейки
     * @param param1 Параметры обновления (количество, область действия, статус, исключения)
     */
    UpdateStorageContext(
        param0: { index: number },
        param1: {
            dispensed?: number;
            scope?: 'single' | 'row' | 'col' | 'all';
            status?: string;
            except?: string[];
        }
    ): void;

    /**
     * Возвращает информацию о ячейке/спирали по её индексу.
     * 
     * @param param0 Объект с индексом ячейки
     * @returns Объект статуса ячейки
     */
    GetStorageInfo(param0: { index: number }): any;

    /**
     * Переводит секцию в состояние вывода из эксплуатации (out of service).
     */
    SetOutOfService(): void;

    /**
     * Записывает транзакцию управления приводом в локальный список транзакций и журнал.
     * 
     * @param transName Имя транзакции
     */
    LogTransaction(transName: string): void;

    /**
     * Поэтапное (фазное) включение мотора спирального механизма:
     * шаг 1 (подключение GND) — проверка отсутствия пробоя ключа и КЗ,
     * шаг 2 (подключение V+) — проверка появления рабочего тока потребления.
     * 
     * @param index Линейный индекс мотора ячейки
     */
    MotorOnPhased(index: number): Promise<void>;

    /**
     * Поэтапное (фазное) выключение мотора спирального механизма:
     * шаг 1 — отключение GND с контролем затухания рабочего тока,
     * шаг 2 — отключение V+.
     * 
     * @param index Линейный индекс мотора ячейки
     * @param param1 Дополнительные параметры выключения
     */
    MotorOff(index: number, param1?: { force?: boolean }): Promise<void>;

    /**
     * Выключает все двигатели матрицы одновременно.
     */
    MotorOffAll(): Promise<void>;

    /**
     * Отправляет низкоуровневую команду шага коммутации мотора матрицы в канал `matrixCtrlChannel`
     * и ожидает подтверждения выполнения.
     * 
     * @param cmd Команда ('On' | 'Off')
     * @param param1 Параметры: индекс мотора и номер шага коммутации
     */
    MotorStep(cmd: 'On' | 'Off', param1?: { index?: number; step?: number }): Promise<void>;

    /**
     * Внутренний метод FSM для проведения тестирования позиции спирали:
     * выполняет шаг 1 включения, проверяет ток и положение тампера, затем выключает мотор.
     * 
     * @param coords Координаты ячейки (row, column)
     */
    _TestSpiral(coords: { row: number; column: number }): Promise<void>;

    /**
     * Проверяет наличие признаков короткого замыкания (ток выше допустимого или напряжение ниже минимального порога).
     */
    IsShorted(): boolean;

    /**
     * Преобразует одномерный линейный индекс ячейки в координаты строки и столбца.
     * 
     * @param index Линейный индекс ячейки (0-based)
     * @param _width Опциональная ширина матрицы (количество колонок)
     * @returns Объект с координатами { row, col }
     */
    IndexToPos(index: number, _width?: number): { row: number; col: number };

    /**
     * Преобразует координаты строки и столбца в одномерный линейный индекс ячейки.
     * 
     * @param coords Объект с координатами ячейки { row, col / column }
     * @returns Линейный индекс ячейки (0-based)
     */
    PosToInd(coords: { row: number; col?: number; column?: number }): number;

    /**
     * Вычисляет номер физического уровня (полки) секции по линейному индексу ячейки.
     * 
     * @param index Линейный индекс ячейки
     * @returns Номер уровня (полки)
     */
    GetLevelByIndex(index: number): number;

    /**
     * Обновляет статус ячеек хранилища в зависимости от типа возникшей ошибки
     * (ERR_TAMPER, TAMPER_BAD_POS, ACTUATOR_NO_POWER, BLOCKED, ACTUATOR_SHORT_CIRCUIT, IO_PORT_ERR, IO_TIMEOUT).
     * 
     * @param fault Объект ошибки (StorageFault)
     */
    UpdateStatus(fault: any): void;

    /**
     * Принудительно прерывает текущую операцию выдачи (устанавливает флаг `aborted = true`).
     */
    Abort(): void;

    /**
     * Полный сброс спирального хранилища в исходное состояние:
     * сброс FSM, очистка очередей, буферов, таймеров, сброс счётчиков ячеек и принудительное выключение всех моторов.
     */
    Reset(): void;
}

export default ClassSpiralSectionStorage;