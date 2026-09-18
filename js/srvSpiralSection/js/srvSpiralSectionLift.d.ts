import { EventEmitter2 } from "eventemitter2";
import { TypeProxyCh, TypeProxyLogger } from "./srvSpiralSection";
import SpiralSectionState, { LIFT_STATE } from "./srvSpiralSectionStates";
import StatesController from "../../srvStatesController/js/srvSectionStateController";

/**
 * Описание каналов ввода-вывода для управления и мониторинга лифта
 */
export interface TypeSpiralSectionLiftChannels {
    /** Канал шагового управления двигателем лифта */
    liftMotorCtrl?: string;
    /** Канал прямого управления направлением движения двигателя лифта ('UP' | 'DOWN' | 'STOP') */
    liftMotorCtrl2?: string;
    /** Канал концевика нижнего положения лифта */
    liftBottomTamper: string;
    /** Канал концевика верхнего положения лифта (аварийный концевик) */
    liftTopTamper?: string;
    /** Канал оптического/герконового датчика уровня полок */
    liftLevelSensor: string;
    /** Канал измерения тока потребления */
    current: string;
    /** Канал измерения напряжения питания */
    voltage: string;
    /** Канал сигнала короткого замыкания */
    short?: string;
    /** Канал управления питанием ИП (включение/выключение питания) */
    psuWork?: string;
    /** Канал мониторинга состояния лифта */
    monLift?: string;
}

/**
 * Параметры конфигурации лифта
 */
export interface TypeSpiralSectionLiftOpts {
    /** Максимальный уровень (количество полок) */
    maxLevel?: number;
    /** Номер шины питания */
    busNumber: number;
}

/**
 * События лифта для конечного автомата (FSM)
 */
export interface TypeSpiralSectionLiftEvents {
    /** Состояние покоя */
    IDLE: string;
    /** Команда подъема на базовый уровень */
    ELEVATE_TO_BASE_COMMAND: string;
    /** Команда спуска лифта в нижнее положение */
    ELEVATE_TO_BOTTOM_COMMAND: string;
    /** Достигнуто нижнее положение лифта (сработал нижний концевик) */
    BOTTOM_LEVEL_REACHED: string;
    /** Достигнут целевой уровень сбора товара */
    COLLECT_LEVEL_REACHED: string;
    /** Достигнут базовый уровень */
    BASE_LEVEL_REACHED: string;
    /** Команда перемещения лифта на заданный уровень */
    ELEVATE_COMMAND: string;
    /** Таймаут перемещения между уровнями */
    ELEVATE_TIMEOUT: string;
    /** Событие аварии / ошибки */
    FAULT: string;
    /** Восстановление после аварии */
    RECOVERED: string;
    /** Принудительное прерывание операции */
    ABORT: string;
}

/**
 * Интерфейс промис-задачи выполнения операции лифта
 */
export interface TypeTask {
    res: (value?: any) => void;
    rej: (reason?: any) => void;
}

/**
 * Управляемый таймер
 */
export interface TypeTimer {
    set: (timeoutMs?: number) => TypeTimer;
    clear: () => TypeTimer;
    reset: (timeoutMs?: number) => TypeTimer | undefined;
    isActive: () => boolean;
}

/**
 * Буфер скользящего окна измерений (ток/напряжение)
 */
export interface TypeBuffer {
    push: (value: number) => void;
    Filter: () => number;
    Clear: () => void;
}

/**
 * Внутренний контекст состояния лифта
 */
export interface TypeSpiralSectionLiftContext {
    /** Текущий уровень лифта (0 — нижнее положение) */
    currentLevel?: number;
    /** Требуемый целевой уровень */
    requiredLevel?: number;
    /** Текущая асинхронная задача перемещения */
    currentTask?: TypeTask | null;
    /** Таймер контроля времени перемещения на следующий шаг */
    timer?: TypeTimer | null;
    /** Аварийный общий таймер ожидания завершения перемещения */
    fallbackTimer?: TypeTimer | null;
    /** Направление движения: 1 — вверх, -1 — вниз, 0 — остановлен */
    movingDir: -1 | 0 | 1;
    /** Флаг переходного процесса включения мотора (игнорирование проверок тока) */
    motorTransition: boolean;
    /** Текущий заказ (если применим) */
    currentOrder?: any;
}

/**
 * Параметры конструктора ClassSpiralSectionLift
 */
export interface TypeSpiralSectionLiftParams {
    /** Прокси-объект для чтения и установки значений каналов ввода-вывода */
    ProxyCh: TypeProxyCh;
    /** Каналы ввода-вывода, используемые лифтом */
    channels: TypeSpiralSectionLiftChannels;
    /** Опции лифта (номер шины питания, макс. уровень) */
    advOpts: TypeSpiralSectionLiftOpts;
    /** Контроллер глобального состояния автомата (опционально) */
    globalState?: StatesController;
    /** Состояние секции */
    sectionState: SpiralSectionState;
    /** Логгер для записи диагностических сообщений */
    ProxyLogger?: TypeProxyLogger;
}

/**
 * Класс управления вертикальным лифтом спиральной вендинговой секции.
 * Обеспечивает перемещение каретки между полками, контроль датчиков уровня и концевиков,
 * мониторинг потребляемого тока и напряжения, а также обработку аварийных ситуаций.
 */
export declare class ClassSpiralSectionLift {
    /**
     * Константы состояний FSM лифта
     */
    static STATE: {
        readonly IDLE: 'IDLE';
        readonly ELEVATING_TO_COLLECT: 'ELEVATING_TO_COLLECT';
        readonly ELEVATING_TO_BOTTOM: 'ELEVATING_TO_BOTTOM';
        readonly ELEVATING_TO_BASE: 'ELEVATING_TO_BASE';
        readonly FAULT: 'FAULT';
    };

    /**
     * @param params Параметры инициализации лифта
     */
    constructor(params: TypeSpiralSectionLiftParams);

    /** Номер шины питания */
    _BusNumber: number;
    /** Буфер усреднения значений тока */
    _I_CurrBuffer: TypeBuffer;
    /** Буфер усреднения значений напряжения */
    _V_VoltBuffer: TypeBuffer;
    /** Прокси-логгер */
    _ProxyLogger?: TypeProxyLogger;
    /** Счётчик последовательных обнаружений КЗ */
    short_count?: number;
    /** Счётчик последовательных обнаружений отсутствия питания */
    nopower_count?: number;
    /** Счётчик последовательных обнаружений перегрузки */
    overload_count?: number;

    /**
     * Константы событий лифта для FSM
     */
    get EVENTS(): TypeSpiralSectionLiftEvents;

    /**
     * Текущее состояние конечного автомата (FSM) лифта
     */
    get State(): string;

    /**
     * Статус лифта в секции (OK, OVERLOAD, SHORT_CIRCUIT, NO_POWER, ERR_LEVEL, ERR_TAMPER, BLOCKED)
     */
    get Status(): LIFT_STATE | string;

    /**
     * Текущий уровень, на котором находится лифт (0 — нижнее положение / лоток)
     */
    get Level(): number | undefined;

    /**
     * Доступность лифта для выполнения операций (отсутствие КЗ и перегрузки)
     */
    get Available(): boolean;

    /**
     * Эмиттер внутренних событий лифта
     */
    get Events(): EventEmitter2;

    /**
     * Инициализирует лифт: регистрирует обработчики событий каналов и останавливает мотор.
     */
    Init(): void;

    /**
     * Регистрирует слушатели событий каналов (концевики, датчик уровня, ток, напряжение) и запускает мониторинг ИП.
     */
    InitEventHandlers(): void;

    /**
     * Устанавливает обработчик нижнего концевика лифта с фильтрацией дребезга.
     * При срабатывании концевика лифт переходит на уровень 0 и отправляет событие BOTTOM_LEVEL_REACHED в FSM.
     */
    SetBottomTamperHandler(): void;

    /**
     * Устанавливает обработчик верхнего аварийного концевика лифта.
     * При срабатывании генерирует событие FAULT с ошибкой LEVEL_SENSOR_FAIL.
     */
    SetTopTamperHandler(): void;

    /**
     * Устанавливает обработчик датчика уровня полок лифта.
     */
    SetLevelHandler(): void;

    /**
     * Устанавливает обработчик канала измерения тока и записывает значения в буфер `_I_CurrBuffer`.
     */
    SetCurrentHandler(): void;

    /**
     * Устанавливает обработчик канала измерения напряжения и записывает значения в буфер `_V_VoltBuffer`.
     */
    SetVoltageHandler(): void;

    /**
     * Обработчик импульсов датчика уровня полок при перемещении лифта.
     * Изменяет текущий уровень, сбрасывает таймаут и генерирует COLLECT_LEVEL_REACHED при достижении цели.
     * 
     * @param param0 Объект с новым значением датчика уровня
     */
    HandleLevel(param0: { Value: any }): void;

    /**
     * Запускает периодический мониторинг тока и напряжения питания лифта (PSU watch).
     * Отслеживает КЗ, перегрузку по току, пропадание питания и автоматическое восстановление после устранения аварии.
     */
    StartPSUWatch(): void;

    /**
     * Перемещает лифт в крайнее нижнее положение (уровень 0).
     * 
     * @returns Промис, разрешающийся при достижении нижнего концевика или отклоняемый при ошибке/таймауте
     */
    ElevateToBottom(): Promise<void>;

    /**
     * Перемещает лифт на указанный уровень (полку).
     * 
     * @param requiredLevel Целевой уровень полки
     * @returns Промис, разрешающийся при достижении целевого уровня или отклоняемый при ошибке/таймауте
     */
    ElevateToLevel(requiredLevel: number): Promise<void>;

    /**
     * Внутренний метод FSM для перемещения лифта на заданный уровень.
     * Определяет направление (вверх/вниз) и запускает таймер таймаута шага.
     * 
     * @param requiredLevel Целевой уровень
     */
    _ElevateToLevel(requiredLevel: number): Promise<void>;

    /**
     * Обработчик срабатывания таймера таймаута перемещения между уровнями.
     * Отправляет событие ELEVATE_TIMEOUT в FSM.
     */
    OnTimeout(): void;

    /**
     * Обрабатывает таймаут перемещения лифта: проверяет ток потребления
     * и диагностирует причину (механическое заклинивание, обрыв питания, неисправность датчика/концевика или КЗ).
     */
    OnElevateTimeout(): Promise<void>;

    /**
     * Внутренний метод FSM для спуска лифта в нижнее положение.
     * Если лифт уже на концевике, сразу переходит в состояние IDLE, иначе начинает спуск вниз.
     */
    _ElevateToBottom(): Promise<void>;

    /**
     * Запускает движение лифта вверх (команда 'Forward').
     * 
     * @returns Промис выполнения команды движения
     */
    ElevateUp(): Promise<any>;

    /**
     * Запускает движение лифта вниз (команда 'Reverse').
     * 
     * @returns Промис выполнения команды движения
     */
    ElevateDown(): Promise<any>;

    /**
     * Включает привод лифта в заданном направлении ('Forward' или 'Reverse')
     * и проверяет появление рабочего тока потребления в допустимом диапазоне.
     * 
     * @param param0 Объект с параметром cmd ('Forward' | 'Reverse')
     */
    Elevate(param0: { cmd: 'Forward' | 'Reverse' | string }): Promise<void>;

    /**
     * Записывает транзакцию движения лифта в локальный список транзакций и журнал.
     * 
     * @param transName Название транзакции
     */
    LogTransaction(transName: string): void;

    /**
     * Обновляет статус лифта в объекте состояния секции в соответствии с типом аварии.
     * 
     * @param fault Объект ошибки/сбоя
     */
    UpdateStatus(fault: any): void;

    /**
     * Отправляет команду шагового управления двигателем в канал `liftMotorCtrl`.
     * 
     * @param cmd Команда управления
     * @param opts Опции шага
     */
    MotorStep(cmd: string, opts: { step: number }): void;

    /**
     * Останавливает привод лифта и ожидает падения тока до уровня холостого хода.
     * 
     * @returns Промис успешной остановки
     */
    Stop(): Promise<void>;

    /**
     * Немедленно отправляет команду останова 'STOP' на привод лифта без ожидания затухания тока.
     */
    StopForce(): void;

    /**
     * Обрабатывает возникшую аварию/ошибку: останавливает мотор, при КЗ перезагружает источник питания (ИП),
     * переводит FSM в состояние аварии и отклоняет текущую задачу.
     * 
     * @param fault Объект ошибки/сбоя
     */
    OnFault(fault: any): Promise<void>;

    /**
     * Выключает питание лифта через канал управления ИП (`psuWork`).
     */
    OffPSU(): void;

    /**
     * Включает питание лифта через канал управления ИП (`psuWork`).
     */
    OnPSU(): void;

    /**
     * Переводит лифт в состояние покоя (IDLE): останавливает привод, завершает активную задачу и очищает таймеры.
     */
    Idle(): Promise<void>;

    /**
     * Логирует переход состояния конечного автомата (FSM).
     * 
     * @param param0 Объект с именем события, новым и предыдущим состоянием
     */
    OnStateChanged(param0: { eventName: string; state: string; prevState: string }): void;

    /**
     * Классифицирует текущее состояние электрического тока по диапазонам (SHORT, OVERLOAD, IDLE, WORK_OK).
     * 
     * @param currVal Необязательное точечное значение тока. Если не передано, берется усредненное значение из буфера.
     * @returns Имя состояния тока или undefined
     */
    CheckCurrentState(currVal?: number): string | undefined;

    /**
     * Проверяет, находится ли лифт в крайнем нижнем положении (активирован ли нижний концевик).
     */
    InBottomPos(): boolean;

    /**
     * Проверяет наличие признаков короткого замыкания (ток выше допустимого или напряжение ниже критического порога).
     */
    IsShorted(): boolean;

    /**
     * Принудительно прерывает текущую операцию лифта, отправляя команду ABORT в FSM.
     */
    Abort(): void;

    /**
     * Полный сброс состояния лифта: сброс FSM, очистка очередей, буферов и таймеров,
     * остановка двигателя и отклонение незавершенных задач.
     */
    Reset(): void;

    /**
     * Выполняет диагностический циклический тест перемещения лифта между нижним положением и заданным уровнем,
     * сохраняя временные ряды токов и состояний в CSV-файл.
     * 
     * @param fpath Путь к файлу CSV для записи результатов теста
     * @param level Целевой уровень для перемещения
     * @param times Количество циклов перемещения
     */
    Test_1(fpath: string, level: number, times: number): Promise<void>;
}

export default ClassSpiralSectionLift;