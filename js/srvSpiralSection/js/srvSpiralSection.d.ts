import { EventEmitter2 } from "eventemitter2";
import SpiralSectionState from "./srvSpiralSectionStates";

/**
 * Прокси-канал для взаимодействия с шиной данных и каналами ввода-вывода (Modbus / брокер)
 */
export interface TypeProxyCh {
    /** Функция записи значения в канал */
    SetValue: Function;
    /** Функция чтения значения из канала */
    GetValue: Function;
    /** Текущее значение канала */
    Value: any;
    /** Эмиттер событий изменения значений каналов */
    Events: EventEmitter2;
}

/**
 * Прокси-логгер для записи диагностических сообщений и событий
 */
export interface TypeProxyLogger {
    /** Метод записи сообщения в лог */
    Log: (args: { level: string; msg: string; obj?: any }) => void;
}

/**
 * Каналы ввода-вывода отсека (люка) выдачи товара покупателю
 */
export interface TypeDeliveryBoxChannels {
    /** Канал управления электромагнитным замком люка выдачи */
    lock: string;
    /** Канал оптического датчика (фотошторки) зоны выдачи */
    optic: string;
}

/**
 * Конфигурация каналов ввода-вывода спиральной секции
 */
export interface TypeSpiralSectionChannels {
    /** Каналы управления матрицей моторов спиралей и тамперами */
    storageChannels: import('./srvSpiralSectionStorage.d.ts').TypeSpiralSectionStorageChannels;
    /** Каналы управления приводом лифта и его датчиками */
    liftChannels: import('./srvSpiralSectionLift.d.ts').TypeSpiralSectionLiftChannels;
    /** Каналы отсека выдачи товара */
    boxChannels: TypeDeliveryBoxChannels;
    /** Канал датчика сервисной двери секции */
    door: string;
    /** Канал мониторинга состояния отсека выдачи */
    monBox: string;
    /** Канал мониторинга состояния спиралей */
    monSpirals?: string;
    /** Канал мониторинга состояния лифта */
    monLift?: string;
}

/**
 * Дополнительные параметры конфигурации спиральной секции
 */
export interface TypeSpiralSectionOpts {
    /** Параметры конфигурации спирального хранилища */
    storageOpts: import('./srvSpiralSectionStorage.d.ts').TypeSpiralSectionStorageOpts;
    /** Параметры конфигурации привода лифта */
    liftOpts: import('./srvSpiralSectionLift.d.ts').TypeSpiralSectionLiftOpts;
}

/**
 * События FSM (конечного автомата) спиральной секции
 */
export interface TypeSpiralSectionEvents {
    /** Событие старта операции выдачи заказа */
    DISPENSE_START: string;
    /** Событие завершения операции выдачи */
    OPERATION_FINISHED: string;
    /** Событие окончания выгрузки товара покупателю */
    UNLOADING_DONE: string;
    /** Мок-событие старта выдачи для отладки */
    DISPENSE_START_MOCK: string;
    /** Событие принудительного прерывания операции */
    ABORT: string;
}

/**
 * Параметры заказа для выдачи из ячейки
 */
export interface TypeOrder {
    /** Номер ряда (полки) ячейки */
    row: number;
    /** Номер колонки (столбца) ячейки */
    column: number;
    /** Требуемое количество единиц товара для выдачи */
    quantity: number;
}

/**
 * Класс управления спиральной секцией вендингового автомата.
 * Координирует работу лифта, спирального хранилища и отсека выдачи,
 * отслеживает датчики безопасности (дверь, люк выдачи) и управляет жизненным циклом выдачи ТМЦ.
 */
export declare class ClassSpiralSection extends EventEmitter2 {
    /**
     * Константы состояний FSM спиральной секции
     */
    static STATE: {
        /** Состояние ожидания/покоя */
        IDLE: string;
        /** Процесс сбора и выдачи товара со спиралей в лифт */
        DISPENSING: string;
        /** Процесс выдачи собранного товара из лифта пользователю */
        UNLOADING: string;
    };

    /**
     * @param params Параметры инициализации спиральной секции
     */
    constructor(params: {
        ProxyCh: TypeProxyCh;
        channels: TypeSpiralSectionChannels;
        advOpts: TypeSpiralSectionOpts;
        sectionState: SpiralSectionState;
        ProxyLogger?: TypeProxyLogger;
    });

    /**
     * Возвращает данные текущей выполняемой задачи или null, если секция свободна
     */
    get InWork(): any;

    /**
     * Возвращает объект с константами событий FSM секции
     */
    get EVENTS(): TypeSpiralSectionEvents;

    /**
     * Возвращает эмиттер внутренних событий секции
     */
    get Events(): EventEmitter2;

    /**
     * Устанавливает прокси-логгер секции
     */
    set Logger(logger: TypeProxyLogger);

    /**
     * Инициализирует секцию: подключает обработчики событий хранилища,
     * запускает мониторинг двери и отсека выдачи, выставляет начальное состояние доступности.
     */
    Init(): void;

    /**
     * Запускает отслеживание состояния сервисной двери секции;
     * при открытии двери переводит состояние в OPENED и прерывает активную операцию.
     */
    WatchDoor(): void;

    /**
     * Запускает отслеживание открытия отсека выдачи;
     * при открытии фиксирует статус в канале мониторинга и прерывает активную операцию.
     */
    WatchBox(): void;

    /**
     * Принудительно аварийно прерывает текущую операцию выдачи,
     * останавливает приводы лифта и спирального хранилища.
     */
    Abort(): void;

    /**
     * Запускает процесс выдачи списка заказов.
     * Проверяет отсутствие активных задач и состояние IDLE, после чего инициирует транзакцию выдачи.
     * 
     * @param _orders Массив заказов для выдачи
     * @returns Промис, разрешающийся по завершении всей процедуры выдачи
     */
    Execute(_orders: TypeOrder[]): Promise<any>;

    /**
     * Внутренний метод FSM для пошагового выполнения выдачи:
     * проверка безопасности, спуск лифта вниз, тестирование спиралей, сбор товаров по полкам,
     * спуск лифта в положение выдачи и открытие люка покупателю.
     * 
     * @param _orders Массив заказов для выдачи
     * @returns Промис выполнения транзакции FSM
     */
    _Execute(_orders: TypeOrder[]): Promise<any>;

    /**
     * Проверяет, закрыта ли сервисная дверь секции.
     * 
     * @returns true, если дверь закрыта
     */
    IsDoorClosed(): boolean;

    /**
     * Переводит секцию в состояние покоя (IDLE):
     * разрешает промис текущей задачи, сбрасывает флаг прерывания и обновляет доступность секции.
     */
    Idle(): void;

    /**
     * Выполняет полный сброс секции и её подсистем (FSM, лифт, хранилище, отсек выдачи)
     * в исходное состояние, отклоняет активную задачу и возвращает секцию в IDLE.
     */
    Reset(): void;

    /**
     * Обработчик успешной выдачи единицы товара из ячейки: фиксирует результат в контексте транзакции.
     * 
     * @param cell Координаты ячейки (ряд и колонка)
     */
    HandleDispense(cell: { row: number; column: number }): void;

    /**
     * Обработчик сбоя выдачи из ячейки: логирует ошибку и фиксирует неуспешный результат в контексте.
     * 
     * @param cell Координаты ячейки (ряд и колонка)
     * @param fault Объект ошибки/сбоя
     * @param message Дополнительное описание ошибки
     */
    HandleFail(cell: { row: number; column: number }, fault: any, message?: string): void;

    /**
     * Записывает сообщение об ошибке операции в лог через прокси-логгер.
     * 
     * @param e Объект исключения или ошибки
     * @param msg Текстовое описание контекста ошибки
     */
    HandleErr(e: any, msg: string): void;

    /**
     * Вызывает метод управления секцией напрямую (например, вращение спирали 'Rotate').
     * 
     * @param methodName Имя вызываемого метода
     * @param args Аргументы метода
     */
    Invoke(methodName: 'Rotate' | string, ...args: any[]): any;

    /**
     * Запускает процедуру выгрузки (открытия люка выдачи) товара покупателю через отсек выдачи.
     * 
     * @returns Промис завершения выгрузки
     */
    Deliver(): Promise<any>;

    /**
     * Ручной запуск вращения спирали по координатам: на заданное количество товаров или на время.
     * 
     * @param args Параметры вращения: ячейка (ряд, колонка), количество оборотов или длительность работы в мс
     */
    ManualRotateSpiral(args?: { row: number; column: number; quantity?: number; duration?: number }): any;

    /**
     * Выполняет циклический тест перемещения лифта на заданный уровень указанное число раз.
     * 
     * @param fpath Путь к файлу для сохранения результатов теста
     * @param level Целевой уровень перемещения лифта
     * @param times Количество повторений цикла
     */
    Test_1(fpath: string, level: number, times: number): any;

    /**
     * Перемещает лифт на указанный уровень (при уровне 0 опускает в нижнее положение выдачи).
     * 
     * @param level Номер целевого уровня (0 — нижнее положение выдачи)
     */
    ElevateLift(level: number): Promise<void>;

    /**
     * Открывает люк выдачи ТМЦ.
     */
    OpenBox(): Promise<void>;
}
